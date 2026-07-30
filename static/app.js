/* =========================================================================
   SVS 病理图像查看器 —— 前端逻辑（OpenSeadragon + ROI + 项目/标注）
   ========================================================================= */
(function () {
  "use strict";

  // ---------- 全局状态 ----------
  var state = {
    slide: null,          // 当前切片 {name,width,height,mppX,mppY,mppSource}
    mppX: null,           // 当前生效的 µm/px
    roiMode: null,        // null | 6 | 6.5
    roi: { x: 0, y: 0, side: 0 },
    rotation: 0,
  };

  // 缓存：全部切片、全部项目、全部分享
  var allSlides = [];      // [{name,width,height,mpp_x,...}]
  var allProjects = [];    // [{pid,name,note,slides,roi_count,...}]
  var currentAnnotations = null; // 当前切片的标注 {slide, annotations:[{label,count,items}]}
  var annoOverlays = [];   // "显示全部标记"叠加的 overlay DOM
  var annoPanelOpen = false;

  // 临时选择器状态
  var pickerCtx = { targetPid: null, selected: {} };

  // 未归类勾选
  var unfiledChecked = {};

  // 分享创建用的临时切片集（分享选中 / 项目分享）
  var sharePendingSlides = null; // 若非 null，则用此切片集创建分享

  // ---------- DOM ----------
  var viewer = null;
  function $(id) { return document.getElementById(id); }
  var els = {
    currentSlide: $("current-slide"),
    zoomIn: $("zoom-in"),
    zoomOut: $("zoom-out"),
    rotateBtn: $("rotate-btn"),
    roi6: $("roi-6"),
    roi65: $("roi-6-5"),
    saveBtn: $("save-btn"),
    annoBtn: $("anno-btn"),
    annoAllBtn: $("anno-all-btn"),
    resetBtn: $("reset-btn"),
    mppSetter: $("mpp-setter"),
    mppInput: $("mpp-input"),
    mppSetBtn: $("mpp-set-btn"),
    zoomBadge: $("zoom-badge"),
    uploadBtn: $("upload-btn"),
    fileInput: $("file-input"),
    progressWrap: $("progress-wrap"),
    progressBar: $("progress-bar"),
    progressText: $("progress-text"),
    viewerWrap: $("viewer-wrap"),
    dropOverlay: $("drop-overlay"),
    toastContainer: $("toast-container"),
    // 项目
    newProjectBtn: $("new-project-btn"),
    newProjectForm: $("new-project-form"),
    npName: $("np-name"),
    npNote: $("np-note"),
    npConfirm: $("np-confirm"),
    npCancel: $("np-cancel"),
    projectList: $("project-list"),
    unfiledToggle: $("unfiled-toggle"),
    unfiledCount: $("unfiled-count"),
    unfiledBody: $("unfiled-body"),
    unfiledList: $("unfiled-list"),
    unfiledNewProject: $("unfiled-new-project"),
    unfiledShare: $("unfiled-share"),
    // 分享
    shareMgrToggle: $("share-mgr-toggle"),
    shareMgrBody: $("share-mgr-body"),
    shareExpiresSelect: $("share-expires-select"),
    shareExpiresCustom: $("share-expires-custom"),
    shareCreateBtn: $("share-create-btn"),
    shareResult: $("share-result"),
    shareResultUrl: $("share-result-url"),
    shareResultCopy: $("share-result-copy"),
    shareList: $("share-list"),
    // 切片选择器
    pickerMask: $("slide-picker-mask"),
    pickerTitleText: $("picker-title-text"),
    pickerClose: $("picker-close"),
    pickerList: $("picker-list"),
    pickerSelectedCount: $("picker-selected-count"),
    pickerConfirm: $("picker-confirm"),
    // 标注面板
    annoPanel: $("anno-panel"),
    annoPanelTitle: $("anno-panel-title"),
    annoPanelClose: $("anno-panel-close"),
    annoPanelList: $("anno-panel-list"),
  };

  var roiBox = null;
  var dragInfo = null;
  // 底图缩略图层：铺在瓦片层后面的模糊预览，慢网下避免瓦片未到区域变白
  var baseThumbEl = null;

  // ---------- 工具函数 ----------
  function toast(msg, type) {
    type = type || "info";
    var el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = msg;
    els.toastContainer.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 3000);
  }

  function fmtSize(bytes) {
    if (bytes == null) return "-";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
    return (bytes / 1073741824).toFixed(2) + " GB";
  }

  function mppTagClass(src) { return src || "missing"; }

  function clamp(v, lo, hi) {
    if (hi < lo) hi = lo;
    return Math.max(lo, Math.min(hi, v));
  }

  function esc(s) {
    // 简易转义，用于 innerHTML 注入（标题等用户输入）
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // 标注徽章文本（如 "标记 3 · 2 人"）
  function annoBadgeText(slideName) {
    if (!allAnnotationsBySlide) return null;
    var grps = allAnnotationsBySlide[slideName];
    if (!grps || grps.length === 0) return null;
    var total = 0;
    var people = 0;
    grps.forEach(function (g) { total += g.count || 0; people += 1; });
    return "标记 " + total + "·" + people + " 人";
  }

  // 文件名中间截断：保留首尾，中间用 … 连接
  function truncateMiddle(s, max) {
    s = String(s == null ? "" : s);
    if (!max || max < 6) max = 18;
    if (s.length <= max) return s;
    var head = Math.ceil((max - 1) / 2);
    var tail = Math.floor((max - 1) / 2);
    return s.slice(0, head) + "…" + s.slice(s.length - tail);
  }

  // 缓存 annotations_by_slide（从 /api/annotations 拉取全量后缓存）
  var allAnnotationsBySlide = null;
  function loadAnnotationsIndex() {
    return fetch("/api/annotations")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        allAnnotationsBySlide = data.by_slide || {};
      })
      .catch(function () { allAnnotationsBySlide = {}; });
  }

  // 某切片是否属于任一项目
  function isSlideInAnyProject(slideName) {
    for (var i = 0; i < allProjects.length; i++) {
      if (allProjects[i].slides && allProjects[i].slides.indexOf(slideName) >= 0) {
        return true;
      }
    }
    return false;
  }

  // label -> 颜色（哈希着色）
  function labelColor(label) {
    var s = String(label || "");
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    var hue = h % 360;
    return { fill: "hsla(" + hue + ",70%,55%,0.18)", stroke: "hsl(" + hue + ",70%,45%)" };
  }

  // ---------- 初始化 OpenSeadragon ----------
  function initViewer() {
    viewer = OpenSeadragon({
      element: $("viewer"),
      showNavigationControl: false,
      // 慢网下适度限制并发图像请求（略增并发以更快填补空隙）
      imageLoaderLimit: 8,
      // 瓦片未到位时透明：露出后面铺好的缩略图底图，避免白/灰块
      placeholderFillStyle: null,
      compositeOperation: "source-over",
      minZoomImageRatio: 0.5,
      maxZoomPixelRatio: 10,
      // 偏保守选层（默认 0.5 → 0.4）：同屏瓦片更倾向取自同一层，
      // 减少高低层混排的“割裂”接缝，同时降低慢网请求量（轻微变柔，可接受）
      minPixelRatio: 0.4,
      defaultZoomLevel: 0,           // 自适应初始缩放
      immediateRender: false,
      preload: false,
      wrapHorizontal: false,
      wrapVertical: false,
      preserveImageSizeOnResize: true,
      // 滚轮缩放更细腻，便于慢网手动控缩放，避免一次跳太多层
      pixelsPerWheelLine: 40,
      gestureSettingsMouse: {
        scrollToZoom: true,
        clickToZoom: false,
        dblClickToZoom: true,
      },
      gestureSettingsTouch: {
        pinchToZoom: true,
        flickEnabled: false,
      },
      animationTime: 0.3,
      visibilityRatio: 0.1,
      prefixUrl: "",
    });
    // 图外空白区用深色背景，减少慢网下大面积空白的刺眼感
    viewer.container.style.backgroundColor = "#262a30";
    viewer.addHandler("zoom", function () { updateZoomBadge(); syncBaseThumb(); });
    viewer.addHandler("open", onViewerOpen);
    // 底图随平移/缩放实时跟随（animation 每帧触发，跟随最平滑）
    viewer.addHandler("animation", syncBaseThumb);
    viewer.addHandler("rotate", syncBaseThumb);
    // 切片关闭时清理旧底图
    viewer.addHandler("close", clearBaseThumb);
  }

  function onViewerOpen() {
    updateZoomBadge();
    // 打开后把底图缩略图对齐到当前视口
    syncBaseThumb();
    // 打开新切片时清除标注叠加层与面板内容，重置按钮
    clearAnnoOverlays();
    els.annoBtn.disabled = true;
    els.annoAllBtn.disabled = true;
    els.annoPanel.style.display = "none";
    annoPanelOpen = false;
    els.annoAllBtn.classList.remove("active");
    if (state.slide) {
      // 拉取该切片标注
      fetch("/api/annotations?slide=" + encodeURIComponent(state.slide.name))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          currentAnnotations = data;
          var annos = data.annotations || [];
          if (annos.length > 0) {
            els.annoBtn.disabled = false;
            els.annoAllBtn.disabled = false;
          }
        })
        .catch(function () { currentAnnotations = null; });
    }
  }

  function updateZoomBadge() {
    try {
      if (!viewer || !viewer.viewport || !viewer.source) {
        els.zoomBadge.textContent = "100%";
        return;
      }
      var zoom = viewer.viewport.getZoom(true);
      var containerW = viewer.viewport.getContainerSize().x;
      var imgW = viewer.source.dimensions.x;
      // 真实图像缩放 = 视口缩放 × 容器宽 / 图像宽（100% = 1 图像像素对应 1 屏幕像素）
      var imageZoom = (zoom * containerW) / imgW;
      els.zoomBadge.textContent = Math.round(imageZoom * 100) + "%";
    } catch (e) {
      els.zoomBadge.textContent = "100%";
    }
  }

  // ---------- 底图缩略图层（慢网下瓦片未到区域的模糊预览） ----------
  function clearBaseThumb() {
    if (baseThumbEl) {
      if (baseThumbEl.parentNode) baseThumbEl.parentNode.removeChild(baseThumbEl);
      baseThumbEl = null;
    }
  }

  function syncBaseThumb() {
    if (!baseThumbEl || !viewer || !viewer.viewport || !state.slide) return;
    var W = state.slide.width, H = state.slide.height;
    if (!W || !H) return;
    try {
      var tl = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
      var br = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(W, H));
      var left = Math.min(tl.x, br.x);
      var top = Math.min(tl.y, br.y);
      var width = Math.abs(br.x - tl.x);
      var height = Math.abs(br.y - tl.y);
      baseThumbEl.style.left = left + "px";
      baseThumbEl.style.top = top + "px";
      baseThumbEl.style.width = width + "px";
      baseThumbEl.style.height = height + "px";
      // 仅当旋转角为 0/180 时显示底图，避免 90/270 错位（瓦片本身正常旋转显示）
      baseThumbEl.style.display = (state.rotation % 180 === 0) ? "block" : "none";
    } catch (e) {}
  }

  // ---------- 打开切片 ----------
  function openSlide(name) {
    // 切换切片前移除旧底图
    clearBaseThumb();
    var url = "/api/slide/" + encodeURIComponent(name) + "/info";
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (info.error) { toast("打开失败: " + info.error, "error"); return; }
        state.slide = {
          name: info.name,
          width: info.width,
          height: info.height,
          mppX: info.mpp_x,
          mppY: info.mpp_y,
          mppSource: info.mpp_source,
        };
        state.mppX = info.mpp_x;
        state.rotation = 0;
        els.currentSlide.textContent = info.name;
        updateMppSetterVisibility();
        exitRoi();
        // 创建底图缩略图层：铺在瓦片 canvas 之前（下层），慢网下透出模糊预览
        baseThumbEl = document.createElement("img");
        baseThumbEl.className = "osd-base-thumb";
        baseThumbEl.src = "/api/slide/" + encodeURIComponent(name) + "/thumbnail";
        baseThumbEl.alt = "";
        viewer.container.insertBefore(baseThumbEl, viewer.canvas);
        viewer.open("/api/slide/" + encodeURIComponent(name) + ".dzi");
        // 高亮列表项（未归类与项目切片行）
        document.querySelectorAll(".slide-row").forEach(function (it) {
          it.classList.toggle("active", it.dataset.name === name);
        });
      })
      .catch(function (e) { toast("获取切片信息失败: " + e, "error"); });
  }

  // ---------- mpp 设置区显示控制 ----------
  function updateMppSetterVisibility() {
    if (!state.slide) { els.mppSetter.style.display = "none"; return; }
    var src = state.slide.mppSource;
    if (src === "missing" || src === "estimated") {
      els.mppSetter.style.display = "flex";
      els.mppInput.value = state.mppX != null ? state.mppX : "";
    } else {
      els.mppSetter.style.display = "none";
    }
  }

  // ---------- 缩放 / 旋转 / 复位 ----------
  function zoomIn() {
    if (!viewer || !viewer.viewport) return;
    viewer.viewport.zoomBy(1.4);
    viewer.viewport.applyConstraints();
  }
  function zoomOut() {
    if (!viewer || !viewer.viewport) return;
    viewer.viewport.zoomBy(1 / 1.4);
    viewer.viewport.applyConstraints();
  }
  function rotate() {
    if (!viewer || !viewer.viewport) return;
    state.rotation = (state.rotation + 90) % 360;
    viewer.viewport.setRotation(state.rotation);
    updateRoiOverlay();
    refreshAnnoOverlays();
  }
  function reset() {
    if (!viewer || !viewer.viewport) return;
    state.rotation = 0;
    viewer.viewport.setRotation(0);
    viewer.viewport.goHome(true);
  }

  // ---------- ROI 功能 ----------
  function roiSide(sizeMm) {
    if (!state.mppX || state.mppX <= 0) return 0;
    return Math.round((sizeMm * 1000) / state.mppX);
  }

  function toggleRoi(sizeMm) {
    if (!state.slide) { toast("请先打开一个切片", "error"); return; }
    if (!state.mppX || state.mppX <= 0) {
      toast("缺少 mpp（µm/px），请先在工具栏设置 mpp", "error");
      return;
    }
    if (state.slide.mppSource === "estimated") {
      toast("提示：当前 mpp 为估算值，ROI 尺寸仅供参考", "info");
    }
    if (state.roiMode === sizeMm) { exitRoi(); return; }

    var newSide = roiSide(sizeMm);
    if (newSide <= 0) { toast("ROI 尺寸计算失败", "error"); return; }

    var W0 = state.slide.width, H0 = state.slide.height;
    if (newSide > W0 || newSide > H0) {
      var physW = (W0 * state.mppX / 1000).toFixed(1);
      var physH = (H0 * state.mppX / 1000).toFixed(1);
      toast("注意：整张图像仅约 " + physW + "×" + physH + " mm，" +
            sizeMm + "mm 选区已超出图像范围（mpp=" + state.mppX + "）", "info");
    }

    var W = state.slide.width, H = state.slide.height;
    var cx, cy;
    if (state.roiMode != null && state.roi.side > 0) {
      cx = state.roi.x + state.roi.side / 2;
      cy = state.roi.y + state.roi.side / 2;
    } else {
      cx = W / 2; cy = H / 2;
      try {
        var center = viewer.viewport.getCenter();
        var imgPt = viewer.viewport.viewportToImageCoordinates(center);
        cx = imgPt.x; cy = imgPt.y;
      } catch (e) {}
    }
    var x = clamp(cx - newSide / 2, 0, Math.max(0, W - newSide));
    var y = clamp(cy - newSide / 2, 0, Math.max(0, H - newSide));

    state.roiMode = sizeMm;
    state.roi.x = Math.round(x);
    state.roi.y = Math.round(y);
    state.roi.side = newSide;

    createRoiBox();
    updateRoiOverlay();
    updateRoiButtons();
    els.saveBtn.disabled = false;
  }

  function exitRoi() {
    state.roiMode = null;
    if (roiBox && viewer && viewer.currentOverlays) {
      try { viewer.removeOverlay(roiBox); } catch (e) {}
    }
    if (roiBox && roiBox.parentNode) roiBox.parentNode.removeChild(roiBox);
    roiBox = null;
    updateRoiButtons();
    els.saveBtn.disabled = true;
  }

  function updateRoiButtons() {
    els.roi6.classList.toggle("active", state.roiMode === 6);
    els.roi65.classList.toggle("active", state.roiMode === 6.5);
  }

  function createRoiBox() {
    if (roiBox) return;
    roiBox = document.createElement("div");
    roiBox.id = "roi-box";
    var tl = document.createElement("div"); tl.className = "roi-corner tl";
    var tr = document.createElement("div"); tr.className = "roi-corner tr";
    var bl = document.createElement("div"); bl.className = "roi-corner bl";
    var br = document.createElement("div"); br.className = "roi-corner br";
    roiBox.appendChild(tl); roiBox.appendChild(tr);
    roiBox.appendChild(bl); roiBox.appendChild(br);
    var label = document.createElement("div");
    label.className = "roi-label";
    roiBox.appendChild(label);
    roiBox.addEventListener("pointerdown", onRoiPointerDown);
    viewer.container.appendChild(roiBox);
  }

  function updateRoiOverlay() {
    if (!roiBox || !state.slide) return;
    var r = state.roi;
    if (r.side <= 0) return;
    var label = roiBox.querySelector(".roi-label");
    // 仅在 ROI 模式下刷新标签；标注跳转的临时框标签由 showTempRoiBox 自写，
    // 避免 roiMode 为 null 时显示 "nullmm × nullmm"
    if (label && state.roiMode != null) label.textContent = state.roiMode + "mm × " + state.roiMode + "mm";
    var rect = viewer.viewport.imageToViewportRectangle(r.x, r.y, r.side, r.side);
    var existing = viewer.getOverlayById(roiBox);
    if (existing) {
      viewer.updateOverlay(roiBox, rect, OpenSeadragon.Placement.TOP_LEFT);
    } else {
      var opts = { element: roiBox, location: rect,
                   placement: OpenSeadragon.Placement.TOP_LEFT };
      if (state.rotation % 360 !== 0 && OpenSeadragon.OverlayRotationMode &&
          OpenSeadragon.OverlayRotationMode.BOUNDING_BOX) {
        opts.rotationMode = OpenSeadragon.OverlayRotationMode.BOUNDING_BOX;
      }
      viewer.addOverlay(opts);
    }
  }

  // ---------- ROI 拖拽 ----------
  function onRoiPointerDown(e) {
    if (!state.slide) return;
    e.preventDefault(); e.stopPropagation();
    try { roiBox.setPointerCapture(e.pointerId); } catch (err) {}
    dragInfo = {
      pointerId: e.pointerId,
      startRoiX: state.roi.x,
      startRoiY: state.roi.y,
      startImg: viewer.viewport.viewerElementToImageCoordinates(
        new OpenSeadragon.Point(e.clientX - getViewerRect().left,
                                e.clientY - getViewerRect().top)),
    };
    viewer.setMouseNavEnabled(false);
    roiBox.addEventListener("pointermove", onRoiPointerMove);
    roiBox.addEventListener("pointerup", onRoiPointerUp);
    roiBox.addEventListener("pointercancel", onRoiPointerUp);
  }

  function onRoiPointerMove(e) {
    if (!dragInfo) return;
    e.preventDefault(); e.stopPropagation();
    var rect = getViewerRect();
    var curImg = viewer.viewport.viewerElementToImageCoordinates(
      new OpenSeadragon.Point(e.clientX - rect.left, e.clientY - rect.top));
    var grabX = dragInfo.startImg.x - dragInfo.startRoiX;
    var grabY = dragInfo.startImg.y - dragInfo.startRoiY;
    var W = state.slide.width, H = state.slide.height, side = state.roi.side;
    var nx = clamp(Math.round(curImg.x - grabX), 0, Math.max(0, W - side));
    var ny = clamp(Math.round(curImg.y - grabY), 0, Math.max(0, H - side));
    state.roi.x = nx; state.roi.y = ny;
    viewer.updateOverlay(
      roiBox,
      viewer.viewport.imageToViewportRectangle(nx, ny, side, side),
      OpenSeadragon.Placement.TOP_LEFT
    );
  }

  function onRoiPointerUp(e) {
    if (!dragInfo) return;
    e.preventDefault(); e.stopPropagation();
    try { roiBox.releasePointerCapture(dragInfo.pointerId); } catch (err) {}
    roiBox.removeEventListener("pointermove", onRoiPointerMove);
    roiBox.removeEventListener("pointerup", onRoiPointerUp);
    roiBox.removeEventListener("pointercancel", onRoiPointerUp);
    dragInfo = null;
    viewer.setMouseNavEnabled(true);
  }

  function getViewerRect() { return viewer.container.getBoundingClientRect(); }

  // ---------- 保存图片（裁剪） ----------
  function saveCrop() {
    if (!state.slide || state.roiMode == null) return;
    var r = state.roi;
    var name = state.slide.name;
    var url = "/api/slide/" + encodeURIComponent(name) +
      "/crop?x=" + Math.round(r.x) + "&y=" + Math.round(r.y) +
      "&size=" + Math.round(r.side);
    var originalText = els.saveBtn.textContent;
    els.saveBtn.textContent = "导出中...";
    els.saveBtn.disabled = true;
    fetch(url)
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (j) {
            throw new Error(j.error || ("导出失败 " + res.status));
          });
        }
        return res.blob();
      })
      .then(function (blob) {
        var stem = name.replace(/\.[^.]+$/, "");
        var fname = stem + "_" + state.roiMode + "mm_x" + Math.round(r.x) +
          "_y" + Math.round(r.y) + ".png";
        var a = document.createElement("a");
        var objUrl = URL.createObjectURL(blob);
        a.href = objUrl; a.download = fname;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(objUrl); }, 1000);
        toast("已导出: " + fname, "success");
      })
      .catch(function (e) { toast("导出失败: " + e.message, "error"); })
      .finally(function () {
        els.saveBtn.textContent = originalText;
        els.saveBtn.disabled = state.roiMode == null;
      });
  }

  // ---------- 手动设置 mpp ----------
  function setMpp() {
    var v = parseFloat(els.mppInput.value);
    if (!isFinite(v) || v <= 0) { toast("请输入有效的 mpp 数值", "error"); return; }
    state.mppX = v;
    if (state.slide) { state.slide.mppX = v; state.slide.mppSource = "manual"; }
    if (state.roiMode != null) {
      var newSide = roiSide(state.roiMode);
      var W = state.slide.width, H = state.slide.height;
      var cx = state.roi.x + state.roi.side / 2;
      var cy = state.roi.y + state.roi.side / 2;
      var x = clamp(cx - newSide / 2, 0, Math.max(0, W - newSide));
      var y = clamp(cy - newSide / 2, 0, Math.max(0, H - newSide));
      state.roi.x = Math.round(x); state.roi.y = Math.round(y);
      state.roi.side = newSide;
      updateRoiOverlay();
    }
    updateMppSetterVisibility();
    toast("mpp 已设为 " + v + " µm/px", "success");
  }

  // =========================================================================
  // 项目渲染与管理
  // =========================================================================
  function loadAll() {
    // 并行加载切片、项目、分享、标注索引
    return Promise.all([
      fetch("/api/slides").then(function (r) { return r.json(); }),
      fetch("/api/projects").then(function (r) { return r.json(); }),
      fetch("/api/share/list").then(function (r) { return r.json(); }),
      loadAnnotationsIndex(),
    ]).then(function (results) {
      allSlides = results[0] || [];
      allProjects = results[1] || [];
      renderProjects(allProjects);
      renderUnfiled();
      renderShareList((results[2] && results[2].shares) || []);
    }).catch(function (e) {
      toast("加载数据失败: " + e, "error");
    });
  }

  function reloadProjectsAndUnfiled() {
    return Promise.all([
      fetch("/api/projects").then(function (r) { return r.json(); }),
      fetch("/api/slides").then(function (r) { return r.json(); }),
      loadAnnotationsIndex(),
    ]).then(function (results) {
      allProjects = results[0] || [];
      allSlides = results[1] || [];
      renderProjects(allProjects);
      renderUnfiled();
    });
  }

  function reloadShares() {
    return fetch("/api/share/list")
      .then(function (r) { return r.json(); })
      .then(function (data) { renderShareList((data && data.shares) || []); });
  }

  // 渲染单个切片信息块（用于项目行、未归类项、选择器项）
  // 行式版：纯文本 "宽×高 · mpp x.xx"，估算值带 *
  function slideMetaTags(s) {
    var parts = [];
    if (s.width && s.height) {
      parts.push(s.width + "×" + s.height);
    }
    if (s.mpp_x != null) {
      // mpp 保留 3 位小数，避免副行过长被截断
      var mpp = Math.round(s.mpp_x * 1000) / 1000;
      parts.push("mpp " + mpp + (s.mpp_source === "estimated" ? "*" : ""));
    } else {
      parts.push("mpp 缺失");
    }
    return parts.join(" · ");
  }

  function renderProjects(projects) {
    els.projectList.innerHTML = "";
    if (!projects || projects.length === 0) {
      var empty = document.createElement("div");
      empty.className = "proj-empty";
      empty.textContent = "暂无项目，点击「＋ 新建项目」";
      els.projectList.appendChild(empty);
      return;
    }
    projects.forEach(function (p) {
      var row = document.createElement("div");
      row.className = "proj-row";
      row.dataset.pid = p.pid;

      var slideCount = p.slide_count != null ? p.slide_count : (p.slides || []).length;
      var roiCount = p.roi_count || 0;

      // 头部行：chevron + 图标 + 名称/副行 + 计数 + 操作
      var head = document.createElement("div");
      head.className = "proj-head";

      var chevron = document.createElement("span");
      chevron.className = "chevron";
      chevron.textContent = "▸";
      chevron.title = "展开/收起";
      head.appendChild(chevron);

      var icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = "📁";
      head.appendChild(icon);

      var main = document.createElement("div");
      main.className = "ph-main";
      var nameEl = document.createElement("div");
      nameEl.className = "proj-name";
      nameEl.textContent = p.name || "未命名项目";
      var meta = document.createElement("div");
      meta.className = "proj-meta";
      meta.textContent = slideCount + " 切片 · " + roiCount + " 标注" +
        (p.note ? " · " + p.note : "");
      main.appendChild(nameEl);
      main.appendChild(meta);
      head.appendChild(main);

      var countBadge = document.createElement("span");
      countBadge.className = "proj-count";
      countBadge.textContent = String(slideCount);
      head.appendChild(countBadge);

      // 操作按钮（hover 浮现）
      var ops = document.createElement("div");
      ops.className = "proj-ops";
      function opBtn(cls, glyph, title) {
        var b = document.createElement("button");
        b.className = "proj-op " + cls;
        b.textContent = glyph; b.title = title || "";
        return b;
      }
      var shareBtn = opBtn("po-share", "↗", "分享本项目");
      var editBtn = opBtn("po-edit", "✎", "重命名/编辑");
      var addBtn = opBtn("po-add", "＋", "添加切片");
      var delBtn = opBtn("po-del", "🗑", "删除项目");
      ops.appendChild(shareBtn);
      ops.appendChild(editBtn);
      ops.appendChild(addBtn);
      ops.appendChild(delBtn);
      head.appendChild(ops);
      row.appendChild(head);

      shareBtn.addEventListener("click", function (e) { e.stopPropagation(); shareProject(p); });
      editBtn.addEventListener("click", function (e) { e.stopPropagation(); editProject(p); });
      addBtn.addEventListener("click", function (e) { e.stopPropagation(); openSlidePicker(p.pid, p.name); });
      delBtn.addEventListener("click", function (e) { e.stopPropagation(); deleteProject(p); });

      // 展开体：切片行
      var body = document.createElement("div");
      body.className = "proj-body";
      (p.slides || []).forEach(function (sname) {
        body.appendChild(renderSlideRow(sname, false));
      });
      row.appendChild(body);

      // 点击头部（chevron 或名称区）展开/收起
      function toggleExpand(e) {
        if (e.target.closest(".proj-ops")) return; // 操作按钮不触发展开
        row.classList.toggle("expanded");
      }
      chevron.addEventListener("click", toggleExpand);
      main.addEventListener("click", toggleExpand);
      countBadge.addEventListener("click", toggleExpand);

      els.projectList.appendChild(row);
    });
  }

  // 切片行（项目展开体内 / 未归类）。unfiled=true 时显示复选框。
  function renderSlideRow(sname, unfiled) {
    var sinfo = findSlideInfo(sname);
    var row = document.createElement("div");
    row.className = "slide-row";
    row.dataset.name = sname;
    if (state.slide && state.slide.name === sname) row.classList.add("active");

    if (unfiled) {
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "slide-check";
      cb.title = "勾选";
      if (unfiledChecked[sname]) cb.checked = true;
      cb.addEventListener("click", function (ev) { ev.stopPropagation(); });
      cb.addEventListener("change", function () { unfiledChecked[sname] = cb.checked; });
      row.appendChild(cb);
    } else {
      var icon = document.createElement("span");
      icon.className = "sr-icon";
      icon.textContent = "📄";
      row.appendChild(icon);
    }

    var mid = document.createElement("div");
    mid.className = "slide-mid";
    var failed = (unfiled && sinfo && sinfo.error) || (!sinfo);

    // 第一行：文件名（左）+ 标注 pill（右），第二行：meta 独占整行
    var top = document.createElement("div");
    top.className = "slide-top";
    var nameEl = document.createElement("span");
    nameEl.className = "slide-name";
    nameEl.textContent = truncateMiddle(sname, 24) + (failed ? " (读取失败)" : "");
    top.appendChild(nameEl);

    // 标注 pill
    var badgeText = annoBadgeText(sname);
    if (badgeText) {
      var badge = document.createElement("button");
      badge.className = "anno-pill";
      badge.textContent = badgeText;
      badge.title = "查看该切片标注";
      badge.addEventListener("click", function (e) {
        e.stopPropagation();
        openSlide(sname);
        // 打开后自动展开标注面板
        setTimeout(function () { openAnnoPanel(); }, 600);
      });
      top.appendChild(badge);
    }
    mid.appendChild(top);

    var meta = document.createElement("div");
    meta.className = "slide-meta";
    meta.textContent = sinfo
      ? slideMetaTags(sinfo) + (unfiled && sinfo.size_bytes ? " · " + fmtSize(sinfo.size_bytes) : "")
      : "未找到";
    mid.appendChild(meta);
    row.appendChild(mid);

    // 删除按钮（hover 浮现）
    var delBtn = document.createElement("button");
    delBtn.className = "slide-del";
    delBtn.textContent = "×";
    delBtn.title = "删除切片";
    delBtn.addEventListener("click", function (ev) { ev.stopPropagation(); deleteSlide(sname); });
    row.appendChild(delBtn);

    row.addEventListener("click", function () { openSlide(sname); });
    return row;
  }

  function findSlideInfo(name) {
    for (var i = 0; i < allSlides.length; i++) {
      if (allSlides[i].name === name) return allSlides[i];
    }
    return null;
  }

  // ---------- 未归类切片 ----------
  function renderUnfiled() {
    var unfiled = allSlides.filter(function (s) { return !isSlideInAnyProject(s.name); });
    els.unfiledCount.textContent = String(unfiled.length);
    els.unfiledList.innerHTML = "";
    if (unfiled.length === 0) {
      var empty = document.createElement("div");
      empty.className = "unfiled-empty";
      empty.textContent = "无未归类切片";
      els.unfiledList.appendChild(empty);
      return;
    }
    unfiled.forEach(function (s) {
      els.unfiledList.appendChild(renderSlideRow(s.name, true));
    });
  }

  // ---------- 新建项目 ----------
  // 待加入新建项目的切片（来自未归类勾选）；表单确认时带上
  var pendingNewProjectSlides = null;

  function toggleNewProjectForm(show) {
    els.newProjectForm.style.display = show ? "block" : "none";
    if (show) { els.npName.value = ""; els.npNote.value = ""; els.npName.focus(); }
  }

  // slidesArg 为显式传入的切片（如顶部"新建项目"为空数组）；
  // 为空时回退到 pendingNewProjectSlides（未归类勾选预填）
  function createProjectFromForm(slidesArg) {
    var slides = (slidesArg && slidesArg.length) ? slidesArg : (pendingNewProjectSlides || []);
    var name = (els.npName.value || "").trim();
    if (!name) { toast("请输入项目名称", "error"); els.npName.focus(); return; }
    var note = els.npNote.value || "";
    fetch("/api/project/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, note: note, slides: slides }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "创建失败"); });
        return r.json();
      })
      .then(function () {
        toast("项目已创建", "success");
        toggleNewProjectForm(false);
        pendingNewProjectSlides = null;
        unfiledChecked = {};
        reloadProjectsAndUnfiled();
      })
      .catch(function (e) { toast("创建失败: " + e.message, "error"); });
  }

  // ---------- 编辑项目 ----------
  function editProject(p) {
    var name = prompt("项目名称", p.name || "");
    if (name == null) return;
    var note = prompt("备注", p.note || "");
    if (note == null) return;
    fetch("/api/project/" + encodeURIComponent(p.pid), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), note: note }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "更新失败"); });
        return r.json();
      })
      .then(function () { toast("已更新", "success"); reloadProjectsAndUnfiled(); })
      .catch(function (e) { toast("更新失败: " + e.message, "error"); });
  }

  // ---------- 删除项目 ----------
  function deleteProject(p) {
    if (!confirm("确认删除项目「" + (p.name || "") + "」？（仅删除项目，不删除切片文件）")) return;
    fetch("/api/project/" + encodeURIComponent(p.pid), { method: "DELETE" })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "删除失败"); });
        return r.json();
      })
      .then(function () { toast("项目已删除", "success"); reloadProjectsAndUnfiled(); })
      .catch(function (e) { toast("删除失败: " + e.message, "error"); });
  }

  // =========================================================================
  // 切片选择器（添加切片到项目）
  // =========================================================================
  function openSlidePicker(pid, pname) {
    pickerCtx.targetPid = pid;
    pickerCtx.selected = {};
    els.pickerTitleText.textContent = "添加切片到项目" + (pname ? "：" + pname : "");
    els.pickerList.innerHTML = "";
    allSlides.forEach(function (s) {
      var row = document.createElement("label");
      row.className = "picker-item";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = s.name;
      cb.addEventListener("change", function () {
        pickerCtx.selected[s.name] = cb.checked;
        updatePickerCount();
      });
      row.appendChild(cb);
      var info = document.createElement("span");
      info.className = "pi-info";
      info.innerHTML = '<span class="pi-name">' + esc(truncateMiddle(s.name, 30)) + "</span>" +
        '<span class="pi-meta">' + slideMetaTags(s) + "</span>";
      row.appendChild(info);
      els.pickerList.appendChild(row);
    });
    updatePickerCount();
    els.pickerMask.style.display = "flex";
  }

  function updatePickerCount() {
    var n = 0;
    Object.keys(pickerCtx.selected).forEach(function (k) { if (pickerCtx.selected[k]) n++; });
    els.pickerSelectedCount.textContent = "已选 " + n;
  }

  function closeSlidePicker() {
    els.pickerMask.style.display = "none";
    pickerCtx.targetPid = null;
    pickerCtx.selected = {};
  }

  function confirmSlidePicker() {
    var slides = Object.keys(pickerCtx.selected).filter(function (k) { return pickerCtx.selected[k]; });
    if (slides.length === 0) { toast("请至少选择一张切片", "error"); return; }
    var pid = pickerCtx.targetPid;
    if (!pid) return;
    fetch("/api/project/" + encodeURIComponent(pid) + "/slides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slides: slides }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "添加失败"); });
        return r.json();
      })
      .then(function () {
        toast("已添加 " + slides.length + " 张切片", "success");
        closeSlidePicker();
        reloadProjectsAndUnfiled();
      })
      .catch(function (e) { toast("添加失败: " + e.message, "error"); });
  }

  // =========================================================================
  // 分享功能
  // =========================================================================
  function getExpiresHours() {
    var v = els.shareExpiresSelect.value;
    if (v === "custom") {
      var c = parseFloat(els.shareExpiresCustom.value);
      if (!isFinite(c) || c <= 0) return null;
      return c;
    }
    return parseFloat(v);
  }

  // 统一创建分享入口：slides 为要分享的切片名数组
  function doCreateShare(slides) {
    if (!slides || slides.length === 0) { toast("请先选择要分享的切片", "error"); return; }
    var hours = getExpiresHours();
    if (hours == null) { toast("请输入有效的小时数", "error"); return; }
    els.shareCreateBtn.disabled = true;
    els.shareCreateBtn.textContent = "生成中...";
    fetch("/api/share/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slides: slides, expires_hours: hours }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ("创建失败 " + r.status)); });
        return r.json();
      })
      .then(function (data) {
        els.shareResult.style.display = "flex";
        els.shareResultUrl.value = data.url;
        copyText(data.url);
        toast("分享链接已生成并复制", "success");
        sharePendingSlides = null;
        unfiledChecked = {};
        renderUnfiled();
        reloadShares();
      })
      .catch(function (e) { toast("创建失败: " + e.message, "error"); })
      .finally(function () {
        els.shareCreateBtn.disabled = false;
        els.shareCreateBtn.textContent = "分享选中切片";
      });
  }

  // 分享本项目
  function shareProject(p) {
    var slides = p.slides || [];
    if (slides.length === 0) { toast("该项目暂无切片", "error"); return; }
    sharePendingSlides = slides.slice();
    // 展开分享管理区，预填提示
    var shareSec = els.shareMgrBody.closest(".section");
    if (shareSec) shareSec.classList.remove("collapsed");
    els.shareCreateBtn.textContent = "分享项目「" + (p.name || "") + "」（" + slides.length + " 张）";
    toast("已选中项目 " + slides.length + " 张切片，选择时效后点击下方按钮生成链接", "info");
    els.shareResult.style.display = "none";
  }

  // 分享管理区按钮：若有 sharePendingSlides 则用它，否则用未归类勾选
  function onShareCreateClick() {
    var slides;
    if (sharePendingSlides) {
      slides = sharePendingSlides;
    } else {
      slides = Object.keys(unfiledChecked).filter(function (k) { return unfiledChecked[k]; });
    }
    doCreateShare(slides);
  }

  // 未归类"分享选中"
  function onUnfiledShare() {
    var slides = Object.keys(unfiledChecked).filter(function (k) { return unfiledChecked[k]; });
    if (slides.length === 0) { toast("请先勾选未归类切片", "error"); return; }
    doCreateShare(slides);
  }

  function renderShareList(shares) {
    els.shareList.innerHTML = "";
    if (!shares || shares.length === 0) {
      var empty = document.createElement("div");
      empty.className = "share-empty";
      empty.textContent = "暂无分享";
      els.shareList.appendChild(empty);
      return;
    }
    shares.forEach(function (sh) {
      var row = document.createElement("div");
      row.className = "share-row-item";

      // 状态彩色圆点
      var dot = document.createElement("span");
      dot.className = "sr-status-dot " + sh.status;
      dot.title = sh.status === "active" ? "有效" :
                  (sh.status === "expired" ? "已过期" : "已撤销");
      row.appendChild(dot);

      // 中部：token（等宽） + 副行 meta
      var mid = document.createElement("div");
      mid.className = "sr-mid";
      var shortTok = sh.token.length > 8 ? sh.token.slice(0, 8) : sh.token;
      var tokEl = document.createElement("span");
      tokEl.className = "sr-token";
      tokEl.textContent = shortTok;
      tokEl.title = sh.url;
      mid.appendChild(tokEl);

      var meta = document.createElement("span");
      meta.className = "sr-meta";
      var slidesTxt = sh.slides.length + " 张：" + sh.slides.join(", ");
      meta.innerHTML =
        '<span title="' + esc(slidesTxt) + '">' + sh.slides.length + " 张</span>" +
        '<span class="sr-sep">·</span>' +
        "<span>到期 " + fmtExpire(sh.expires_at) + "</span>" +
        '<span class="sr-sep">·</span>' +
        "<span>选区 " + (sh.roi_count || 0) + "</span>";
      mid.appendChild(meta);
      row.appendChild(mid);

      // 操作按钮（hover 浮现）
      var ops = document.createElement("div");
      ops.className = "sr-ops";
      var copyBtn = document.createElement("button");
      copyBtn.className = "sr-btn sr-copy";
      copyBtn.textContent = "⧉";
      copyBtn.title = "复制链接";
      copyBtn.addEventListener("click", function () { copyText(sh.url); });
      ops.appendChild(copyBtn);
      var revBtn = document.createElement("button");
      revBtn.className = "sr-btn sr-revoke";
      revBtn.textContent = "⊘";
      revBtn.title = "撤销";
      revBtn.addEventListener("click", function () { revokeShare(sh.token); });
      if (sh.status !== "active") revBtn.disabled = true;
      ops.appendChild(revBtn);
      row.appendChild(ops);
      els.shareList.appendChild(row);
    });
  }

  function revokeShare(token) {
    if (!confirm("确认撤销该分享？撤销后链接立即失效。")) return;
    fetch("/api/share/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ("撤销失败 " + r.status)); });
        return r.json();
      })
      .then(function () { toast("已撤销", "success"); reloadShares(); })
      .catch(function (e) { toast("撤销失败: " + e.message, "error"); });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function () { toast("已复制到剪贴板", "success"); })
        .catch(function () { fallbackCopy(text); });
    } else { fallbackCopy(text); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("已复制到剪贴板", "success"); }
    catch (e) { toast("复制失败，请手动复制", "error"); }
    document.body.removeChild(ta);
  }
  function fmtExpire(ts) {
    if (!ts) return "-";
    var d = new Date(ts * 1000);
    var p = function (n) { return n < 10 ? "0" + n : n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // =========================================================================
  // 标注面板 + 全部标记叠加（查看器）
  // =========================================================================
  function openAnnoPanel() {
    if (!state.slide || !currentAnnotations) { toast("当前切片暂无标注", "info"); return; }
    annoPanelOpen = true;
    els.annoPanel.style.display = "flex";
    els.annoPanelTitle.textContent = "标注：" + truncateMiddle(state.slide.name, 28);
    renderAnnoPanel(currentAnnotations.annotations || []);
  }

  function closeAnnoPanel() {
    annoPanelOpen = false;
    els.annoPanel.style.display = "none";
  }

  function renderAnnoPanel(groups) {
    els.annoPanelList.innerHTML = "";
    if (!groups || groups.length === 0) {
      var empty = document.createElement("div");
      empty.className = "anno-panel-empty";
      empty.textContent = "暂无标注";
      els.annoPanelList.appendChild(empty);
      return;
    }
    groups.forEach(function (grp) {
      // 分组标题
      var gh = document.createElement("div");
      gh.className = "anno-group-head";
      gh.innerHTML = '<span class="agh-label">' + esc(grp.label) + "</span>" +
        '<span class="agh-count">' + grp.count + " 条</span>";
      els.annoPanelList.appendChild(gh);

      (grp.items || []).forEach(function (it) {
        var row = document.createElement("div");
        row.className = "anno-item";
        var left = document.createElement("div");
        left.className = "ai-info";
        left.innerHTML =
          '<div class="ai-title"><span class="ai-label">' + esc(grp.label) + "</span> · " +
          (it.size_mm != null ? it.size_mm + "mm" : "") + "</div>" +
          '<div class="ai-sub">(' + it.x + "," + it.y + ") " + fmtTime(it.ts) +
          (it.token ? " · 来源 " + String(it.token).slice(0, 6) : "") + "</div>";
        row.appendChild(left);
        row.style.cursor = "pointer";
        row.addEventListener("click", function () { jumpToAnno(it); });
        els.annoPanelList.appendChild(row);
      });
    });
  }

  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts * 1000);
    var p = function (n) { return n < 10 ? "0" + n : n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // 点击标注条目：fitBounds + 临时重建黄色 ROI 框
  function jumpToAnno(it) {
    if (!state.slide || !viewer || !viewer.viewport) return;
    var x = it.x, y = it.y, side = it.side_px;
    try {
      var rect = viewer.viewport.imageToViewportRectangle(x, y, side, side);
      viewer.viewport.fitBounds(rect);
    } catch (e) {}
    // 临时 ROI 框（仅视觉，不进入保存态）
    showTempRoiBox(x, y, side, it.size_mm);
  }

  function showTempRoiBox(x, y, side, sizeMm) {
    if (!viewer || !state.slide) return;
    // 复用 roiBox（若不在 ROI 模式则临时建一个，但不启用保存按钮）
    state.roi.x = Math.round(x);
    state.roi.y = Math.round(y);
    state.roi.side = Math.round(side);
    createRoiBox();
    var lbl = roiBox.querySelector(".roi-label");
    if (lbl && sizeMm != null) lbl.textContent = sizeMm + "mm × " + sizeMm + "mm";
    updateRoiOverlay();
  }

  // "显示全部标记"叠加
  function toggleAnnoAll() {
    if (annoOverlays.length > 0) {
      clearAnnoOverlays();
      els.annoAllBtn.classList.remove("active");
      return;
    }
    if (!state.slide || !currentAnnotations) return;
    var groups = currentAnnotations.annotations || [];
    groups.forEach(function (grp) {
      var color = labelColor(grp.label);
      (grp.items || []).forEach(function (it) {
        addAnnoOverlay(it, grp.label, color);
      });
    });
    els.annoAllBtn.classList.toggle("active", annoOverlays.length > 0);
  }

  function addAnnoOverlay(it, label, color) {
    if (!viewer || !state.slide) return;
    var box = document.createElement("div");
    box.className = "anno-overlay-box";
    box.style.background = color.fill;
    box.style.border = "2px solid " + color.stroke;
    var tag = document.createElement("div");
    tag.className = "anno-overlay-tag";
    tag.textContent = label;
    tag.style.background = color.stroke;
    box.appendChild(tag);
    viewer.container.appendChild(box);
    try {
      var rect = viewer.viewport.imageToViewportRectangle(it.x, it.y, it.side_px, it.side_px);
      viewer.addOverlay({
        element: box,
        location: rect,
        placement: OpenSeadragon.Placement.TOP_LEFT,
      });
      annoOverlays.push(box);
    } catch (e) {
      if (box.parentNode) box.parentNode.removeChild(box);
    }
  }

  function clearAnnoOverlays() {
    if (!viewer) { annoOverlays = []; return; }
    annoOverlays.forEach(function (box) {
      try { viewer.removeOverlay(box); } catch (e) {}
      if (box.parentNode) box.parentNode.removeChild(box);
    });
    annoOverlays = [];
  }

  function refreshAnnoOverlays() {
    if (annoOverlays.length === 0) return;
    // 简化：旋转时移除并重建（位置基于当前视口重新计算）
    if (!state.slide || !currentAnnotations) { clearAnnoOverlays(); return; }
    var groups = currentAnnotations.annotations || [];
    // 记录当前可见性后重建
    clearAnnoOverlays();
    groups.forEach(function (grp) {
      var color = labelColor(grp.label);
      (grp.items || []).forEach(function (it) { addAnnoOverlay(it, grp.label, color); });
    });
    els.annoAllBtn.classList.toggle("active", annoOverlays.length > 0);
  }

  // ---------- 删除切片 ----------
  function deleteSlide(name) {
    if (!confirm("确认删除切片 " + name + " ？")) return;
    fetch("/api/slide/" + encodeURIComponent(name), { method: "DELETE" })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error); });
        if (state.slide && state.slide.name === name) {
          state.slide = null; state.mppX = null; state.roiMode = null;
          els.currentSlide.textContent = "未打开切片";
          updateMppSetterVisibility();
          if (roiBox) exitRoi();
          if (viewer) viewer.close();
        }
        toast("已删除 " + name, "success");
        loadAll();
      })
      .catch(function (e) { toast("删除失败: " + e.message, "error"); });
  }

  // ---------- 上传 ----------
  function uploadFile(file) {
    if (!file) return;
    var formData = new FormData();
    formData.append("file", file);
    var xhr = new XMLHttpRequest();
    els.progressWrap.style.display = "block";
    els.progressBar.style.width = "0%";
    els.progressText.textContent = "0%";
    xhr.upload.addEventListener("progress", function (e) {
      if (e.lengthComputable) {
        var pct = Math.round((e.loaded / e.total) * 100);
        els.progressBar.style.width = pct + "%";
        els.progressText.textContent = pct + "%";
      }
    });
    xhr.addEventListener("load", function () {
      els.progressWrap.style.display = "none";
      var data;
      try { data = JSON.parse(xhr.responseText); } catch (e) { toast("上传响应解析失败", "error"); return; }
      if (xhr.status >= 200 && xhr.status < 300) {
        toast("上传成功: " + data.name, "success");
        loadAll();
        openSlide(data.name);
      } else {
        toast("上传失败: " + (data.error || xhr.status), "error");
      }
    });
    xhr.addEventListener("error", function () {
      els.progressWrap.style.display = "none";
      toast("上传出错（网络）", "error");
    });
    xhr.open("POST", "/api/upload");
    xhr.send(formData);
  }

  // ---------- 拖拽上传 ----------
  function setupDragDrop() {
    var wrap = els.viewerWrap;
    var counter = 0;
    wrap.addEventListener("dragenter", function (e) { e.preventDefault(); counter++; els.dropOverlay.classList.add("active"); });
    wrap.addEventListener("dragover", function (e) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    wrap.addEventListener("dragleave", function (e) { e.preventDefault(); counter--; if (counter <= 0) { counter = 0; els.dropOverlay.classList.remove("active"); } });
    wrap.addEventListener("drop", function (e) {
      e.preventDefault(); counter = 0; els.dropOverlay.classList.remove("active");
      var files = e.dataTransfer.files;
      if (files && files.length > 0) { for (var i = 0; i < files.length; i++) uploadFile(files[i]); }
    });
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    els.zoomIn.addEventListener("click", zoomIn);
    els.zoomOut.addEventListener("click", zoomOut);
    els.rotateBtn.addEventListener("click", rotate);
    els.resetBtn.addEventListener("click", reset);
    els.roi6.addEventListener("click", function () { toggleRoi(6); });
    els.roi65.addEventListener("click", function () { toggleRoi(6.5); });
    els.saveBtn.addEventListener("click", saveCrop);
    els.mppSetBtn.addEventListener("click", setMpp);
    els.mppInput.addEventListener("keydown", function (e) { if (e.key === "Enter") setMpp(); });

    els.uploadBtn.addEventListener("click", function () { els.fileInput.click(); });
    els.fileInput.addEventListener("change", function () {
      if (this.files && this.files[0]) { uploadFile(this.files[0]); this.value = ""; }
    });

    // 标注
    els.annoBtn.addEventListener("click", function () {
      if (annoPanelOpen) { closeAnnoPanel(); } else { openAnnoPanel(); }
    });
    els.annoPanelClose.addEventListener("click", closeAnnoPanel);
    els.annoAllBtn.addEventListener("click", toggleAnnoAll);

    // 新建项目
    els.newProjectBtn.addEventListener("click", function () {
      var showing = els.newProjectForm.style.display !== "none";
      toggleNewProjectForm(!showing);
    });
    els.npConfirm.addEventListener("click", function () { createProjectFromForm([]); });
    els.npCancel.addEventListener("click", function () { toggleNewProjectForm(false); });
    els.npName.addEventListener("keydown", function (e) { if (e.key === "Enter") els.npNote.focus(); });
    els.npNote.addEventListener("keydown", function (e) { if (e.key === "Enter") createProjectFromForm([]); });

    // 未归类
    els.unfiledToggle.addEventListener("click", function () {
      var sec = els.unfiledBody.closest(".section");
      if (sec) sec.classList.toggle("collapsed");
    });
    els.unfiledNewProject.addEventListener("click", function () {
      var slides = Object.keys(unfiledChecked).filter(function (k) { return unfiledChecked[k]; });
      if (slides.length === 0) { toast("请先勾选未归类切片", "error"); return; }
      // 预填并打开表单：这里直接以选中切片创建项目
      toggleNewProjectForm(true);
      // 记录待加入切片，确认时带上
      pendingNewProjectSlides = slides;
      toast("已选中 " + slides.length + " 张，输入名称后确认", "info");
    });

    // 分享
    els.shareExpiresSelect.addEventListener("change", function () {
      els.shareExpiresCustom.style.display = this.value === "custom" ? "inline-block" : "none";
    });
    els.shareCreateBtn.addEventListener("click", onShareCreateClick);
    els.shareResultCopy.addEventListener("click", function () { copyText(els.shareResultUrl.value); });
    els.shareMgrToggle.addEventListener("click", function () {
      var sec = els.shareMgrBody.closest(".section");
      if (sec) sec.classList.toggle("collapsed");
    });

    // 切片选择器
    els.pickerClose.addEventListener("click", closeSlidePicker);
    els.pickerConfirm.addEventListener("click", confirmSlidePicker);
    els.pickerMask.addEventListener("click", function (e) {
      if (e.target === els.pickerMask) closeSlidePicker();
    });
  }

  // ---------- 启动 ----------
  function init() {
    initViewer();
    bindEvents();
    setupDragDrop();
    // 初始折叠区状态（默认展开）
    var unfiledSec = els.unfiledBody.closest(".section");
    var shareSec = els.shareMgrBody.closest(".section");
    if (unfiledSec) unfiledSec.classList.remove("collapsed");
    if (shareSec) shareSec.classList.remove("collapsed");
    loadAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
