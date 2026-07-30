#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SVS 病理图像查看 Web 应用后端（Flask + OpenSlide + Deep Zoom）。

运行：.venv/bin/python app.py   监听 0.0.0.0:8000
"""

import io
import os
import threading
from collections import OrderedDict
from pathlib import Path

from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    render_template,
    request,
    send_file,
)
from werkzeug.utils import secure_filename

import openslide
from openslide import OpenSlide
from openslide.deepzoom import DeepZoomGenerator

import share_store

app = Flask(__name__)

# 上传目录：默认 ~/svs-viewer/uploads，可用环境变量 UPLOAD_DIR 覆盖（容器内挂载）
UPLOAD_DIR = Path(os.environ.get("UPLOAD_DIR") or (Path.home() / "svs-viewer" / "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# 支持的病理图像扩展名
SUPPORTED_EXTS = {
    "svs", "tif", "tiff", "ndpi", "mrxs", "vms", "vmu", "scn", "bif", "svslide",
}

# 分享服务基础 URL（外部用户访问入口，生产部署用 env 覆盖，如 https://slides.example.com:18767）
SHARE_BASE_URL = os.environ.get(
    "SHARE_BASE_URL", "http://localhost:38000"
).rstrip("/")

# Deep Zoom 参数（512 瓦片降低公网请求数，渐进式 q82 JPEG 降体积并支持模糊→清晰预览）
DZ_TILE_SIZE = 512
DZ_OVERLAP = 1
# JPEG 编码质量，可由环境变量 JPEG_QUALITY 覆盖（默认 82）
JPEG_QUALITY = int(os.environ.get("JPEG_QUALITY") or 82)
# 保留旧名（仅供历史代码引用，实际值与 DZ_* 一致）
TILE_SIZE = DZ_TILE_SIZE
OVERLAP = DZ_OVERLAP

# OpenSlide 对象缓存：name -> {"osr": OpenSlide, "dz": DeepZoomGenerator, "lock": Lock}
_slide_cache: dict = {}
_cache_lock = threading.Lock()

# 瓦片内存缓存（LRU）：大切片瓦片生成是 CPU 密集操作（解压+编码），
# 缓存后平移/缩放往返时秒出，显著减少画面割裂。key=(name, level, x, y)，value=JPEG bytes
TILE_CACHE_MAX = int(os.environ.get("TILE_CACHE_MAX") or 3000)  # ~60KB/片 ≈ 180MB 上限
_tile_cache: "OrderedDict[tuple, bytes]" = OrderedDict()
_tile_cache_lock = threading.Lock()


def _tile_cache_get(key):
    """LRU 命中：取值并移到最新位。"""
    with _tile_cache_lock:
        data = _tile_cache.get(key)
        if data is not None:
            _tile_cache.move_to_end(key)
        return data


def _tile_cache_put(key, data):
    """LRU 写入，超上限淘汰最久未用。"""
    with _tile_cache_lock:
        _tile_cache[key] = data
        _tile_cache.move_to_end(key)
        while len(_tile_cache) > TILE_CACHE_MAX:
            _tile_cache.popitem(last=False)


def _tile_cache_purge(name):
    """切片删除时清掉其全部瓦片缓存。"""
    with _tile_cache_lock:
        stale = [k for k in _tile_cache if k[0] == name]
        for k in stale:
            _tile_cache.pop(k, None)


# --------------------------------------------------------------------------- #
# 辅助函数
# --------------------------------------------------------------------------- #
def _sanitize_name(name: str) -> str:
    """净化文件名：防路径穿越同时保留中文等 Unicode 字符。

    werkzeug 的 secure_filename 会剥离所有非 ASCII 字符（如中文），
    导致纯中文文件名（如"我的切片.svs"）变成仅剩扩展名"svs"。因此：
    - 含非 ASCII 字符时：手动剥离路径分隔符、冒号、控制字符、以及残留的
      点-点（.. 仍可能被解析为父目录引用），保留 Unicode；
    - 纯 ASCII 名：直接用 secure_filename（其路径穿越防护更完整）。
    """
    if not name or "\x00" in name:
        return ""

    has_non_ascii = any(ord(c) > 127 for c in name)

    if not has_non_ascii:
        return secure_filename(name)

    # 含 Unicode：手动清理，保留非 ASCII 字符
    cleaned_chars = []
    for ch in name:
        if ch in "/\\:" or ord(ch) < 32:
            continue
        cleaned_chars.append(ch)
    cleaned = "".join(cleaned_chars).strip().rstrip(".")
    # 防止残留的 ".." 序列被解析为目录跳转（Path() 在无分隔符时不会跳转，
    # 这里做二次保险）
    cleaned = cleaned.replace("..", "")
    return cleaned


def _safe_name(name: str) -> str:
    """校验 name 合法且对应文件存在于 UPLOAD_DIR，防路径穿越。"""
    safe = _sanitize_name(name)
    if not safe or safe != name:
        abort(400, jsonify(error="非法文件名"))
    path = UPLOAD_DIR / safe
    if not path.is_file():
        abort(404, jsonify(error="切片不存在"))
    return safe


def _get_slide(name: str):
    """从缓存获取（或打开）OpenSlide 与 DeepZoomGenerator，返回字典。"""
    with _cache_lock:
        entry = _slide_cache.get(name)
        if entry is not None:
            return entry

    # 缓存未命中：打开（不在全局锁内，避免阻塞其他切片）
    safe = _safe_name(name)
    path = UPLOAD_DIR / safe
    try:
        osr = OpenSlide(str(path))
    except Exception:
        abort(400, jsonify(error="无法打开切片文件"))

    dz = DeepZoomGenerator(
        osr, tile_size=DZ_TILE_SIZE, overlap=DZ_OVERLAP, limit_bounds=True
    )
    entry = {"osr": osr, "dz": dz, "lock": threading.Lock()}
    with _cache_lock:
        # 若并发打开了同一文件，保留先入者
        existing = _slide_cache.get(name)
        if existing is not None:
            try:
                osr.close()
            except Exception:
                pass
            return existing
        _slide_cache[name] = entry
    return entry


def _close_slide(name: str) -> None:
    """关闭并移除缓存中的切片句柄，同时清掉其瓦片缓存。"""
    with _cache_lock:
        entry = _slide_cache.pop(name, None)
    if entry is not None:
        try:
            entry["osr"].close()
        except Exception:
            pass
    _tile_cache_purge(name)


def _to_float(v):
    """安全转 float。"""
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _mpp_from_tiff_resolution(path: Path):
    """从 TIFF 分辨率标签（真实坐标尺）读取 mpp。

    许多扫描仪/转换软件生成的 TIFF 类切片没有厂商 mpp 元数据，
    但写入了标准的 XResolution/YResolution + ResolutionUnit 标签：
    - ResolutionUnit=2（英寸）：mpp(µm/px) = 25400 / XResolution
    - ResolutionUnit=3（厘米）：mpp(µm/px) = 10000 / XResolution
    读取失败或数值不合理时返回 (None, None)。
    """
    try:
        from PIL import Image
        from PIL.TiffTags import TAGS_V2  # noqa: F401  确保标签表初始化

        with Image.open(str(path)) as img:
            tags = getattr(img, "tag_v2", None)
            if not tags:
                return None, None
            x_res = _to_float(tags.get(282))  # XResolution
            y_res = _to_float(tags.get(283))  # YResolution
            unit = tags.get(296, 2)           # ResolutionUnit，默认英寸
            if not x_res or x_res <= 0:
                return None, None
            factor = 25400.0 if unit == 2 else (10000.0 if unit == 3 else None)
            if factor is None:
                return None, None
            mpp_x = factor / x_res
            mpp_y = factor / y_res if y_res and y_res > 0 else mpp_x
            # 合理性检查：病理切片 mpp 一般在 0.1 ~ 2.0 µm/px 之间
            if 0.05 <= mpp_x <= 3.0:
                return mpp_x, mpp_y
    except Exception:
        pass
    return None, None


def _read_metadata(osr: OpenSlide, path: Path) -> dict:
    """读取尺寸与 mpp 等元数据。

    mpp 取值优先级（均为真实坐标尺，最后一个才是估算）：
    1. 厂商元数据 openslide.mpp-x/y（Aperio/滨松等，最可靠）
    2. TIFF 标准分辨率标签 XResolution + ResolutionUnit
    3. 按扫描倍率估算 mpp = 10 / objective-power（标记为 estimated）
    4. 缺失（missing）
    """
    width, height = osr.dimensions
    props = osr.properties
    objective_f = _to_float(props.get("openslide.objective-power"))

    mpp_x_f = _to_float(props.get("openslide.mpp-x"))
    mpp_y_f = _to_float(props.get("openslide.mpp-y"))

    if mpp_x_f is not None and mpp_y_f is not None:
        mpp_source = "metadata"
    else:
        # TIFF 分辨率标签兜底（真实坐标尺）
        tiff_mpp_x, tiff_mpp_y = _mpp_from_tiff_resolution(path)
        if tiff_mpp_x is not None:
            mpp_x_f = mpp_x_f if mpp_x_f is not None else tiff_mpp_x
            mpp_y_f = mpp_y_f if mpp_y_f is not None else tiff_mpp_y
            mpp_source = "tiff-resolution"
        elif objective_f is not None and objective_f > 0:
            # 估算：mpp = 10 / objective-power
            est = 10.0 / objective_f
            mpp_x_f = mpp_x_f if mpp_x_f is not None else est
            mpp_y_f = mpp_y_f if mpp_y_f is not None else est
            mpp_source = "estimated"
        else:
            mpp_x_f = None
            mpp_y_f = None
            mpp_source = "missing"

    return {
        "width": width,
        "height": height,
        "mpp_x": mpp_x_f,
        "mpp_y": mpp_y_f,
        "objective": objective_f,
        "mpp_source": mpp_source,
    }


def _slide_info_dict(name: str) -> dict:
    """构建单个切片的元数据字典（用于列表与 info 接口）。"""
    safe = _safe_name(name)
    path = UPLOAD_DIR / safe
    base = {"name": safe, "size_bytes": path.stat().st_size}
    try:
        entry = _get_slide(safe)
        with entry["lock"]:
            meta = _read_metadata(entry["osr"], path)
    except Exception as e:
        base.update(
            {
                "width": None,
                "height": None,
                "mpp_x": None,
                "mpp_y": None,
                "objective": None,
                "mpp_source": "missing",
                "error": str(e),
            }
        )
        return base
    base.update(meta)
    return base


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/slides")
def api_slides():
    """列出所有切片的元数据。"""
    items = []
    for child in sorted(UPLOAD_DIR.iterdir()):
        if not child.is_file():
            continue
        if child.suffix.lower().lstrip(".") not in SUPPORTED_EXTS:
            continue
        try:
            items.append(_slide_info_dict(child.name))
        except Exception as e:
            # 路径穿越校验等可能抛出 HTTP 异常，这里收集为 error
            items.append(
                {
                    "name": child.name,
                    "size_bytes": child.stat().st_size,
                    "width": None,
                    "height": None,
                    "mpp_x": None,
                    "mpp_y": None,
                    "objective": None,
                    "mpp_source": "missing",
                    "error": str(getattr(e, "description", e)),
                }
            )
    return jsonify(items)


@app.route("/api/upload", methods=["POST"])
def api_upload():
    """流式上传切片文件。"""
    if "file" not in request.files:
        return jsonify(error="缺少 file 字段"), 400

    file = request.files["file"]
    filename = file.filename or ""
    safe = _sanitize_name(filename)
    if not safe:
        return jsonify(error="非法文件名"), 400
    if safe.split(".")[-1].lower() not in SUPPORTED_EXTS:
        return jsonify(error="不支持的文件类型"), 400

    dest = UPLOAD_DIR / safe
    if dest.exists():
        return jsonify(error=f"文件已存在: {safe}"), 409

    # 流式保存
    try:
        file.save(dest)
    except Exception as e:
        try:
            dest.unlink(missing_ok=True)
        except Exception:
            pass
        return jsonify(error=f"保存失败: {e}"), 400

    # 验证能否打开
    try:
        osr = OpenSlide(str(dest))
        osr.close()
    except Exception as e:
        try:
            dest.unlink(missing_ok=True)
        except Exception:
            pass
        return jsonify(error=f"无效的切片文件: {e}"), 400

    return jsonify(name=safe)


@app.route("/api/slide/<name>", methods=["DELETE"])
def api_slide_delete(name):
    """关闭句柄并删除切片。"""
    safe = _safe_name(name)
    _close_slide(safe)
    try:
        (UPLOAD_DIR / safe).unlink()
    except FileNotFoundError:
        pass
    return jsonify(ok=True)


@app.route("/api/slide/<name>/info")
def api_slide_info(name):
    """单个切片元数据。"""
    return jsonify(_slide_info_dict(name))


@app.route("/api/slide/<name>.dzi")
def api_slide_dzi(name):
    """手工生成 Deep Zoom XML。"""
    safe = _safe_name(name)
    entry = _get_slide(safe)
    with entry["lock"]:
        dz = entry["dz"]
        # DZI Size 取最高层（level_count-1）尺寸
        width, height = dz.level_dimensions[-1]

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" '
        f'Url="/api/slide/{safe}_files/" Format="jpeg" '
        f'Overlap="{DZ_OVERLAP}" TileSize="{DZ_TILE_SIZE}">'
        f'<Size Width="{width}" Height="{height}"/>'
        "</Image>"
    )
    resp = Response(xml, mimetype="application/xml")
    # DZI 元数据短期可变（重传/换切片后 URL 不变但尺寸会变），用短缓存
    resp.headers["Cache-Control"] = "max-age=60"
    return resp


@app.route("/api/slide/<name>_files/<int:level>/<int:x>_<int:y>.jpeg")
def api_slide_tile(name, level, x, y):
    """返回 Deep Zoom 单张瓦片 JPEG（512×512、渐进式、q82，带 LRU 缓存）。"""
    safe = _safe_name(name)

    key = (safe, level, x, y)
    cached = _tile_cache_get(key)
    if cached is not None:
        buf = io.BytesIO(cached)
    else:
        entry = _get_slide(safe)
        with entry["lock"]:
            dz = entry["dz"]
            tile = dz.get_tile(level, (x, y))

        # 含 alpha 通道时先转 RGB（JPEG 不支持透明度）
        if tile.mode != "RGB":
            tile = tile.convert("RGB")
        buf = io.BytesIO()
        # 渐进式 JPEG：浏览器可在下载中途显示模糊→清晰的瓦片，便于慢网预览
        tile.save(
            buf,
            format="JPEG",
            quality=JPEG_QUALITY,
            progressive=True,
            optimize=True,
        )
        _tile_cache_put(key, buf.getvalue())
        buf.seek(0)

    resp = send_file(buf, mimetype="image/jpeg")
    # 瓦片内容不变，长期不可变缓存
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/api/slide/<name>/crop")
def api_slide_crop(name):
    """裁剪 level-0 原始像素区域的 PNG 图像并下载。"""
    safe = _safe_name(name)
    entry = _get_slide(safe)

    def _parse_int(key):
        try:
            return int(request.args.get(key, ""))
        except (TypeError, ValueError):
            return None

    x = _parse_int("x")
    y = _parse_int("y")
    size = _parse_int("size")
    if x is None or y is None or size is None:
        return jsonify(error="x/y/size 参数需为整数"), 400
    if x < 0 or y < 0 or size <= 0 or size > 40000:
        return jsonify(error="参数越界（0<=x,y，0<size<=40000）"), 400

    with entry["lock"]:
        osr = entry["osr"]
        width, height = osr.dimensions
        # clamp 到图像边界
        x2 = min(x, max(0, width - 1))
        y2 = min(y, max(0, height - 1))
        max_w = max(0, width - x2)
        max_h = max(0, height - y2)
        size2 = min(size, max_w, max_h)
        if size2 <= 0:
            return jsonify(error="裁剪区域超出图像边界"), 400
        region = osr.read_region((x2, y2), 0, (size2, size2)).convert("RGB")

    buf = io.BytesIO()
    region.save(buf, format="PNG")
    buf.seek(0)

    stem = Path(safe).stem
    download_name = f"{stem}_{x2}_{y2}_{size2}px.png"
    return send_file(
        buf,
        mimetype="image/png",
        as_attachment=True,
        download_name=download_name,
    )


@app.route("/api/slide/<name>/thumbnail")
def api_slide_thumbnail(name):
    """返回缩略图 JPEG。"""
    safe = _safe_name(name)
    entry = _get_slide(safe)
    with entry["lock"]:
        osr = entry["osr"]
        thumb = osr.get_thumbnail((400, 400))
    if thumb.mode != "RGB":
        thumb = thumb.convert("RGB")
    buf = io.BytesIO()
    thumb.save(buf, format="JPEG", quality=90)
    buf.seek(0)
    return send_file(buf, mimetype="image/jpeg")


# --------------------------------------------------------------------------- #
# 分享管理 API（管理员，内网）
# --------------------------------------------------------------------------- #
@app.route("/api/share/create", methods=["POST"])
def api_share_create():
    """创建分享链接。JSON: {slides: [...], expires_hours: number}。"""
    body = request.get_json(silent=True) or {}
    slides = body.get("slides")
    expires_hours = body.get("expires_hours")

    if not isinstance(slides, list) or len(slides) == 0:
        return jsonify(error="slides 不能为空"), 400
    if expires_hours is None:
        return jsonify(error="缺少 expires_hours"), 400
    try:
        expires_hours = float(expires_hours)
    except (TypeError, ValueError):
        return jsonify(error="expires_hours 需为数值"), 400
    if expires_hours < 0.1 or expires_hours > 720:
        return jsonify(error="expires_hours 需在 0.1~720 之间"), 400

    # 校验每个文件存在且扩展名合法
    clean = []
    for name in slides:
        if not isinstance(name, str):
            return jsonify(error="slides 含非法文件名"), 400
        safe = _sanitize_name(name)
        if not safe or safe != name:
            return jsonify(error=f"非法文件名: {name}"), 400
        if safe.split(".")[-1].lower() not in SUPPORTED_EXTS:
            return jsonify(error=f"不支持的文件类型: {name}"), 400
        if not (UPLOAD_DIR / safe).is_file():
            return jsonify(error=f"切片不存在: {name}"), 400
        clean.append(safe)

    share = share_store.create_share(clean, expires_hours)
    url = SHARE_BASE_URL + "/s/" + share["token"]
    return jsonify(token=share["token"], url=url, expires_at=share["expires_at"])


@app.route("/api/share/list")
def api_share_list():
    """列出全部分享，附加 url 与 roi_count。"""
    shares = share_store.list_shares()
    roi_counts = share_store.roi_count_by_token()
    for sh in shares:
        sh["url"] = SHARE_BASE_URL + "/s/" + sh["token"]
        sh["roi_count"] = roi_counts.get(sh["token"], 0)
    return jsonify(shares)


@app.route("/api/share/revoke", methods=["POST"])
def api_share_revoke():
    """撤销分享。JSON: {token}。"""
    body = request.get_json(silent=True) or {}
    token = body.get("token")
    if not token:
        return jsonify(error="缺少 token"), 400
    ok = share_store.revoke_share(token)
    if not ok:
        return jsonify(error="分享不存在"), 404
    return jsonify(ok=True)


@app.route("/api/share/rois")
def api_share_rois():
    """列出全部 ROI（管理员查看）。"""
    rois = share_store.list_rois()
    return jsonify(rois)


# --------------------------------------------------------------------------- #
# 项目管理 API（管理员，内网）
# --------------------------------------------------------------------------- #
def _validate_slide_names(names):
    """校验切片名列表：均需合法、扩展名受支持、文件存在。

    返回 (clean_list, error_str)；成功时 error_str 为 None。
    """
    if not isinstance(names, list):
        return None, "slides 需为数组"
    clean = []
    for name in names:
        if not isinstance(name, str):
            return None, "slides 含非法文件名"
        safe = _sanitize_name(name)
        if not safe or safe != name:
            return None, "非法文件名: " + name
        if safe.split(".")[-1].lower() not in SUPPORTED_EXTS:
            return None, "不支持的文件类型: " + name
        if not (UPLOAD_DIR / safe).is_file():
            return None, "切片不存在: " + name
        clean.append(safe)
    return clean, None


@app.route("/api/project/create", methods=["POST"])
def api_project_create():
    """创建项目。JSON: {name, note?, slides?}。"""
    body = request.get_json(silent=True) or {}
    name = body.get("name", "")
    note = body.get("note", "")
    slides = body.get("slides", [])
    if not isinstance(name, str) or not name.strip():
        return jsonify(error="name 不能为空"), 400
    clean, err = _validate_slide_names(slides if isinstance(slides, list) else [])
    if err:
        return jsonify(error=err), 400
    proj = share_store.create_project(name=name.strip(), note=note or "", slides=clean)
    return jsonify(proj)


@app.route("/api/projects")
def api_projects():
    """列出全部项目，附加 roi_count（项目内切片的标注总数）。"""
    projects = share_store.list_projects()
    # 一次性取 annotations_by_slide，按项目 slides 汇总
    by_slide = share_store.annotations_by_slide()

    def _count_for(slides):
        total = 0
        for s in slides:
            for grp in by_slide.get(s, []):
                total += grp.get("count", 0)
        return total

    out = []
    for p in projects:
        item = dict(p)
        item["roi_count"] = _count_for(p.get("slides", []))
        out.append(item)
    return jsonify(out)


@app.route("/api/project/<pid>")
def api_project_detail(pid):
    """单个项目详情，含每张切片的标注摘要。"""
    proj = share_store.get_project(pid)
    if proj is None:
        return jsonify(error="项目不存在"), 404
    by_slide = share_store.annotations_by_slide()
    project_slides = set(proj.get("slides", []))
    slide_annotations = [
        {"slide": s, "annotations": by_slide.get(s, [])}
        for s in proj.get("slides", [])
    ]
    return jsonify(project=proj, slide_annotations=slide_annotations)


@app.route("/api/project/<pid>", methods=["PATCH"])
def api_project_update(pid):
    """更新项目字段。JSON: {name?, note?, slides?}。"""
    body = request.get_json(silent=True) or {}
    slides = body.get("slides")
    if slides is not None:
        clean, err = _validate_slide_names(slides)
        if err:
            return jsonify(error=err), 400
        slides = clean
    proj = share_store.update_project(
        pid,
        name=body.get("name"),
        note=body.get("note"),
        slides=slides,
    )
    if proj is None:
        return jsonify(error="项目不存在"), 404
    return jsonify(proj)


@app.route("/api/project/<pid>/slides", methods=["POST"])
def api_project_add_slides(pid):
    """向项目追加切片。JSON: {slides: [...]}。"""
    body = request.get_json(silent=True) or {}
    slides = body.get("slides")
    clean, err = _validate_slide_names(slides)
    if err:
        return jsonify(error=err), 400
    proj = share_store.add_slides_to_project(pid, clean)
    if proj is None:
        return jsonify(error="项目不存在"), 404
    return jsonify(proj)


@app.route("/api/project/<pid>/slide/<name>", methods=["DELETE"])
def api_project_remove_slide(pid, name):
    """从项目移除某切片（仅解除归属，不删文件）。"""
    safe = _sanitize_name(name)
    if not safe or safe != name:
        return jsonify(error="非法文件名"), 400
    proj = share_store.remove_slide_from_project(pid, safe)
    if proj is None:
        return jsonify(error="项目不存在或无该切片"), 404
    return jsonify(proj)


@app.route("/api/project/<pid>", methods=["DELETE"])
def api_project_delete(pid):
    """删除项目（不删切片文件）。"""
    ok = share_store.delete_project(pid)
    if not ok:
        return jsonify(error="项目不存在"), 404
    return jsonify(ok=True)


@app.route("/api/annotations")
def api_annotations():
    """返回标注（按 slide 或 project 过滤），供查看器加载某切片的标记。

    查询参数：
      - slide=<name>：只返回该切片的标注分组
      - project=<pid>：只返回该项目内切片的标注
    同时传 slide 与 project 时，slide 优先（且需属于项目）。
    """
    slide = request.args.get("slide")
    project = request.args.get("project")

    if slide:
        safe = _sanitize_name(slide)
        if not safe or safe != slide:
            return jsonify(error="非法文件名"), 400
        by_slide = share_store.annotations_by_slide()
        return jsonify({"slide": safe, "annotations": by_slide.get(safe, [])})

    if project:
        by_slide = share_store.annotations_by_project(project)
        return jsonify({"project": project, "by_slide": by_slide})

    # 默认返回全部
    return jsonify({"by_slide": share_store.annotations_by_slide()})


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        threaded=True,
    )
