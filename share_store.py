# -*- coding: utf-8 -*-
"""切片分享 —— 共享存储层。

被两个进程并发使用：
- app.py（主应用 :8000，管理员写入）
- share_server.py（分享服务 :38000，读为主，外部用户写入 ROI）

数据文件为单个 JSON，所有读写通过 fcntl.flock 互斥访问，保证一致性。
"""

import json
import os
import secrets
import shutil
import time
from pathlib import Path

import fcntl

# 数据目录与文件路径
SHARE_DATA_DIR = Path(
    os.environ.get("SHARE_DATA_DIR") or (Path.home() / "svs-viewer" / "share-data")
)
SHARE_DATA_DIR.mkdir(parents=True, exist_ok=True)
SHARE_FILE = SHARE_DATA_DIR / "shares.json"

# 空结构骨架
_EMPTY = {"shares": {}, "rois": [], "projects": {}}


def _load_locked(f):
    """在已锁定的文件对象上读取并解析 JSON；损坏则备份重建。"""
    f.seek(0)
    raw = f.read()
    if not raw:
        return _copy_empty()
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("top-level not object")
        data.setdefault("shares", {})
        data.setdefault("rois", [])
        # 向后兼容：旧文件无 projects 时补 {}
        data.setdefault("projects", {})
        if not isinstance(data["shares"], dict):
            data["shares"] = {}
        if not isinstance(data["rois"], list):
            data["rois"] = []
        if not isinstance(data["projects"], dict):
            data["projects"] = {}
        return data
    except (json.JSONDecodeError, ValueError):
        # 损坏：备份后重建
        f.seek(0)
        bak = SHARE_FILE.with_suffix(".json.bak")
        try:
            with open(bak, "w", encoding="utf-8") as bf:
                bf.write(raw)
        except Exception:
            pass
        return _copy_empty()


def _copy_empty():
    """返回一个新的空结构（避免共享引用）。"""
    return {"shares": {}, "rois": [], "projects": {}}


def _save_locked(f, data):
    """在已锁定的文件对象上写入 JSON（先截断）。"""
    f.seek(0)
    f.truncate()
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.flush()
    os.fsync(f.fileno())


def _with_lock(mode, fn):
    """以指定模式打开 SHARE_FILE，加排他锁后执行 fn(file_obj)。

    mode 为 'r+'（读写，要求文件已存在；不存在则先创建）或 'w+'。
    返回 fn 的返回值。
    """
    # 确保文件存在
    if not SHARE_FILE.exists():
        SHARE_FILE.touch()
    with open(SHARE_FILE, mode, encoding="utf-8") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        try:
            return fn(f)
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)


# --------------------------------------------------------------------------- #
# 公共 API
# --------------------------------------------------------------------------- #
def create_share(slides, expires_hours):
    """创建分享：生成 token、写入并返回 share dict（含 token）。"""
    token = secrets.token_urlsafe(18)
    now = time.time()
    expires_at = now + float(expires_hours) * 3600.0
    share = {
        "slides": list(slides),
        "created_at": now,
        "expires_at": expires_at,
        "revoked": False,
        "token": token,
    }

    def _do(f):
        data = _load_locked(f)
        data["shares"][token] = {
            "slides": list(slides),
            "created_at": now,
            "expires_at": expires_at,
            "revoked": False,
        }
        _save_locked(f, data)
        return share

    return _with_lock("r+", _do)


def _is_active(share):
    """判断 share dict 是否仍有效（未撤销且未过期）。"""
    if share.get("revoked"):
        return False
    exp = share.get("expires_at")
    if exp is not None and exp < time.time():
        return False
    return True


def get_share(token):
    """获取有效分享；不存在/已撤销/已过期返回 None。"""
    def _do(f):
        data = _load_locked(f)
        share = data["shares"].get(token)
        if share is None:
            return None
        if not _is_active(share):
            return None
        out = dict(share)
        out["token"] = token
        return out

    return _with_lock("r+", _do)


def _status_of(share):
    if share.get("revoked"):
        return "revoked"
    exp = share.get("expires_at")
    if exp is not None and exp < time.time():
        return "expired"
    return "active"


def list_shares():
    """返回全部分享（含 status 字段），按 created_at 倒序。"""
    def _do(f):
        data = _load_locked(f)
        items = []
        for tok, sh in data["shares"].items():
            out = dict(sh)
            out["token"] = tok
            out["status"] = _status_of(sh)
            items.append(out)
        items.sort(key=lambda x: x.get("created_at", 0), reverse=True)
        return items

    return _with_lock("r+", _do)


def revoke_share(token):
    """撤销分享，返回是否成功。"""
    def _do(f):
        data = _load_locked(f)
        share = data["shares"].get(token)
        if share is None:
            return False
        share["revoked"] = True
        _save_locked(f, data)
        return True

    return _with_lock("r+", _do)


def add_roi(token, slide, x, y, size_mm, side_px, label):
    """为 token 的 share 添加一条 ROI；校验 share 存在且 slide 属于它。

    label（标记人/标签）为必填，去空白后非空，否则抛 ValueError。

    返回新增的 roi dict（含该 token 下的 index，从 0 起按时间顺序）。
    若校验失败抛出 ValueError。
    """
    # label 非空校验（在锁外做即可）
    if not isinstance(label, str):
        raise ValueError("请填写用户名或标签")
    label = label.strip()
    if not label:
        raise ValueError("请填写用户名或标签")

    def _do(f):
        data = _load_locked(f)
        share = data["shares"].get(token)
        if share is None or not _is_active(share):
            raise ValueError("share invalid")
        if slide not in share.get("slides", []):
            raise ValueError("slide not in share")
        roi = {
            "token": token,
            "slide": slide,
            "x": int(x),
            "y": int(y),
            "size_mm": float(size_mm),
            "side_px": int(side_px),
            "label": label,
            "ts": time.time(),
        }
        data["rois"].append(roi)
        _save_locked(f, data)
        # index 为该 token 下按插入顺序的序号
        same_token = [r for r in data["rois"] if r["token"] == token]
        roi_out = dict(roi)
        roi_out["index"] = len(same_token) - 1
        return roi_out

    return _with_lock("r+", _do)


def list_rois(token=None):
    """返回 ROI 列表；可按 token 过滤。每项含 index（该 token 下的序号）。"""
    def _do(f):
        data = _load_locked(f)
        rois = data["rois"]
        if token is not None:
            rois = [r for r in rois if r["token"] == token]
            # 计算 index：原列表中同 token 的顺序序号
            all_same = [r for r in data["rois"] if r["token"] == token]
            idx_map = {}
            for i, r in enumerate(all_same):
                idx_map[id(r)] = i
            out = []
            for r in rois:
                rr = dict(r)
                rr["index"] = idx_map.get(id(r), 0)
                out.append(rr)
            out.sort(key=lambda x: x.get("ts", 0), reverse=True)
            return out
        # 全部：按 token 分组计算 index
        from collections import defaultdict
        counters = defaultdict(int)
        out = []
        for r in rois:
            rr = dict(r)
            rr["index"] = counters[r["token"]]
            counters[r["token"]] += 1
            out.append(rr)
        out.sort(key=lambda x: x.get("ts", 0), reverse=True)
        return out

    return _with_lock("r+", _do)


def delete_roi(token, index):
    """删除该 token 下第 index 条 ROI；返回是否删除成功。"""
    def _do(f):
        data = _load_locked(f)
        same = [i for i, r in enumerate(data["rois"]) if r["token"] == token]
        if index < 0 or index >= len(same):
            return False
        real_i = same[index]
        data["rois"].pop(real_i)
        _save_locked(f, data)
        return True

    return _with_lock("r+", _do)


def roi_count_by_token():
    """返回 {token: count} 计数表。"""
    def _do(f):
        data = _load_locked(f)
        counts = {}
        for r in data["rois"]:
            counts[r["token"]] = counts.get(r["token"], 0) + 1
        return counts

    return _with_lock("r+", _do)


# --------------------------------------------------------------------------- #
# 项目（projects）—— 仅维护切片归属关系，不移动/删除切片文件
# --------------------------------------------------------------------------- #
def create_project(name, note="", slides=None):
    """创建项目。pid=secrets.token_urlsafe(10)。

    slides 在此只做去重，是否为已存在切片由调用方保证。
    返回新建项目 dict（含 pid）。
    """
    pid = secrets.token_urlsafe(10)
    now = time.time()
    # 去重（保序）
    seen = set()
    uniq = []
    for s in slides or []:
        if isinstance(s, str) and s not in seen:
            seen.add(s)
            uniq.append(s)
    project = {
        "name": str(name or "").strip() or "未命名项目",
        "note": str(note or ""),
        "slides": uniq,
        "created_at": now,
    }

    def _do(f):
        data = _load_locked(f)
        data["projects"][pid] = dict(project)
        _save_locked(f, data)
        out = dict(project)
        out["pid"] = pid
        return out

    return _with_lock("r+", _do)


def list_projects():
    """返回全部项目列表，每项附加 pid、slide_count；按 created_at 倒序。"""
    def _do(f):
        data = _load_locked(f)
        items = []
        for pid, proj in data["projects"].items():
            out = dict(proj)
            out["pid"] = pid
            out["slide_count"] = len(out.get("slides", []))
            items.append(out)
        items.sort(key=lambda x: x.get("created_at", 0), reverse=True)
        return items

    return _with_lock("r+", _do)


def get_project(pid):
    """返回单个项目 dict（附加 pid）；不存在返回 None。"""
    def _do(f):
        data = _load_locked(f)
        proj = data["projects"].get(pid)
        if proj is None:
            return None
        out = dict(proj)
        out["pid"] = pid
        return out

    return _with_lock("r+", _do)


def update_project(pid, *, name=None, note=None, slides=None):
    """更新项目字段（仅更新非 None 字段）。slides 传入时去重替换。
    返回更新后的项目 dict；不存在返回 None。
    """
    def _do(f):
        data = _load_locked(f)
        proj = data["projects"].get(pid)
        if proj is None:
            return None
        if name is not None:
            proj["name"] = str(name).strip() or proj.get("name", "未命名项目")
        if note is not None:
            proj["note"] = str(note)
        if slides is not None:
            seen = set()
            uniq = []
            for s in slides:
                if isinstance(s, str) and s not in seen:
                    seen.add(s)
                    uniq.append(s)
            proj["slides"] = uniq
        _save_locked(f, data)
        out = dict(proj)
        out["pid"] = pid
        return out

    return _with_lock("r+", _do)


def add_slides_to_project(pid, slides):
    """向项目追加切片（去重保序）。返回更新后的项目 dict；不存在返回 None。"""
    def _do(f):
        data = _load_locked(f)
        proj = data["projects"].get(pid)
        if proj is None:
            return None
        existing = proj.get("slides", [])
        seen = set(existing)
        for s in slides or []:
            if isinstance(s, str) and s not in seen:
                seen.add(s)
                existing.append(s)
        proj["slides"] = existing
        _save_locked(f, data)
        out = dict(proj)
        out["pid"] = pid
        return out

    return _with_lock("r+", _do)


def remove_slide_from_project(pid, slide):
    """从项目移除某切片。返回更新后的项目 dict；不存在或无该切片返回 None。"""
    def _do(f):
        data = _load_locked(f)
        proj = data["projects"].get(pid)
        if proj is None:
            return None
        slides = proj.get("slides", [])
        if slide not in slides:
            return None
        proj["slides"] = [s for s in slides if s != slide]
        _save_locked(f, data)
        out = dict(proj)
        out["pid"] = pid
        return out

    return _with_lock("r+", _do)


def delete_project(pid):
    """删除项目（仅删项目记录，不动切片文件）。返回是否删除成功。"""
    def _do(f):
        data = _load_locked(f)
        if pid not in data["projects"]:
            return False
        del data["projects"][pid]
        _save_locked(f, data)
        return True

    return _with_lock("r+", _do)


# --------------------------------------------------------------------------- #
# 标注（annotations）汇总 —— 把 rois 按 slide/label 聚合，供管理员查看
# --------------------------------------------------------------------------- #
def _norm_label(label):
    """读旧 roi 缺 label 时视为「未署名」。"""
    if isinstance(label, str) and label.strip():
        return label.strip()
    return "未署名"


def annotations_by_slide():
    """把全部 rois 按 slide 分组聚合。

    返回 {slide: {label: {"label","count","items":[...]}, ...}}，items 含
    token/x/y/size_mm/side_px/ts。结构是嵌套：slide -> label -> group。
    为方便前端，外层每个 slide 的值是按 label 的分组列表。
    """
    def _do(f):
        data = _load_locked(f)
        # slide -> label -> {label, count, items}
        by_slide = {}
        for r in data["rois"]:
            slide = r.get("slide")
            lbl = _norm_label(r.get("label"))
            grp_map = by_slide.setdefault(slide, {})
            grp = grp_map.get(lbl)
            if grp is None:
                grp = {"label": lbl, "count": 0, "items": []}
                grp_map[lbl] = grp
            grp["count"] += 1
            grp["items"].append({
                "token": r.get("token"),
                "x": r.get("x"),
                "y": r.get("y"),
                "size_mm": r.get("size_mm"),
                "side_px": r.get("side_px"),
                "ts": r.get("ts"),
            })
        # 转为 slide -> list[group]（label 按出现顺序）
        result = {}
        for slide, grp_map in by_slide.items():
            result[slide] = list(grp_map.values())
        return result

    return _with_lock("r+", _do)


def annotations_by_project(pid=None):
    """与 annotations_by_slide 同结构，但可选按项目内的 slides 过滤。

    pid=None 时等同于 annotations_by_slide()。
    pid 存在但项目不存在则按空 slides 过滤（返回空）。
    """
    by_slide = annotations_by_slide()
    if pid is None:
        return by_slide
    proj = get_project(pid)
    project_slides = set(proj.get("slides", [])) if proj else set()
    return {
        slide: groups
        for slide, groups in by_slide.items()
        if slide in project_slides
    }
