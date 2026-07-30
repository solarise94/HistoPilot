/* =========================================================================
   切片分享页 —— 前端逻辑（OpenSeadragon + ROI + 选区保存）
   ========================================================================= */
(function () {
  "use strict";

  // ---------- token 与 API 前缀 ----------
  // token 从 location.pathname（/s/<token>）解析
  var TOKEN = window.__SHARE_TOKEN__ || "";
  if (!TOKEN) {
    var m = location.pathname.match(/\/s\/([^/]+)/);
    if (m) TOKEN = decodeURIComponent(m[1]);
  }
  var API = "/s/" + encodeURIComponent(TOKEN);

  // ---------- 全局状态 ----------
  var state = {
    slides: [],          // 该分享的切片集
    slide: null,         // 当前切片
    mppX: null,
    roiMode: null,
    roi: { x: 0, y: 0, side: 0 },
    rotation: 0,
  };

  var viewer = null;
  var roiBox = null;
  var dragInfo = null;
  // 底图缩略图层：铺在瓦片层后面的模糊预览，慢网下避免瓦片未到区域变白
  var baseThumbEl = null;

  // ---------- DOM ----------
  function $(id) { return document.getElementById(id); }
  var els = {
    invalidMask: $("invalid-mask"),
    currentSlide: $("current-slide"),
    slideChips: $("slide-chips"),
    zoomIn: $("zoom-in"),
    zoomOut: $("zoom-out"),
    rotateBtn: $("rotate-btn"),
    roi6: $("roi-6"),
    roi65: $("roi-6-5"),
    saveRoiBtn: $("save-roi-btn"),
    exportBtn: $("export-btn"),
    resetBtn: $("reset-btn"),
    mppSetter: $("mpp-setter"),
    mppInput: $("mpp-input"),
    mppSetBtn: $("mpp-set-btn"),
    zoomBadge: $("zoom-badge"),
    roiLabel: $("roi-label"),
    panelToggle: $("roi-panel-toggle"),
    panel: $("roi-panel"),
    panelClose: $("roi-panel-close"),
    panelList: $("roi-panel-list"),
    toastContainer: $("toast-container"),
  };

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

  function clamp(v, lo, hi) {
    if (hi < lo) hi = lo;
    return Math.max(lo, Math.min(hi, v));
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
    viewer.addHandler("open", function () { updateZoomBadge(); syncBaseThumb(); });
    // 底图随平移/缩放实时跟随（animation 每帧触发，跟随最平滑）
    viewer.addHandler("animation", syncBaseThumb);
    viewer.addHandler("rotate", syncBaseThumb);
    // 切片关闭时清理旧底图
    viewer.addHandler("close", clearBaseThumb);
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

  // ---------- 加载切片集 ----------
  function loadSlides() {
    fetch(API + "/api/slides")
      .then(function (r) {
        if (r.status === 404) { showInvalid(); throw new Error("invalid"); }
        return r.json();
      })
      .then(function (slides) {
        state.slides = slides || [];
        renderChips();
        if (state.slides.length === 0) {
          els.currentSlide.textContent = "无可用切片";
          return;
        }
        openSlide(state.slides[0].name);
      })
      .catch(function (e) {
        if (e.message !== "invalid") toast("加载切片失败: " + e, "error");
      });
  }

  function showInvalid() {
    els.invalidMask.style.display = "flex";
  }

  function renderChips() {
    if (state.slides.length <= 1) {
      els.slideChips.style.display = "none";
      return;
    }
    els.slideChips.style.display = "flex";
    els.slideChips.innerHTML = "";
    state.slides.forEach(function (s) {
      var chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = s.name;
      chip.title = s.name + (s.error ? "（读取失败）" : "");
      chip.dataset.name = s.name;
      if (state.slide && state.slide.name === s.name) {
        chip.classList.add("active");
      }
      chip.addEventListener("click", function () { openSlide(s.name); });
      els.slideChips.appendChild(chip);
    });
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
    var info = null;
    for (var i = 0; i < state.slides.length; i++) {
      if (state.slides[i].name === name) { info = state.slides[i]; break; }
    }
    if (!info) { toast("切片不在分享中", "error"); return; }
    if (info.error || !info.width) {
      toast("切片无法读取: " + (info.error || "未知错误"), "error");
      return;
    }

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

    // 高亮 chip
    var chips = els.slideChips.querySelectorAll(".chip");
    chips.forEach(function (c) {
      c.classList.toggle("active", c.dataset.name === name);
    });

    // 创建底图缩略图层：铺在瓦片 canvas 之前（下层），慢网下透出模糊预览
    baseThumbEl = document.createElement("img");
    baseThumbEl.className = "osd-base-thumb";
    baseThumbEl.src = API + "/api/slide/" + encodeURIComponent(name) + "/thumbnail";
    baseThumbEl.alt = "";
    viewer.container.insertBefore(baseThumbEl, viewer.canvas);

    viewer.open(API + "/api/slide/" + encodeURIComponent(name) + ".dzi");
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
            sizeMm + "mm 选区已超出图像范围", "info");
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
    els.saveRoiBtn.disabled = false;
    els.exportBtn.disabled = false;
  }

  function exitRoi() {
    state.roiMode = null;
    if (roiBox && viewer && viewer.currentOverlays) {
      try { viewer.removeOverlay(roiBox); } catch (e) {}
    }
    if (roiBox && roiBox.parentNode) {
      roiBox.parentNode.removeChild(roiBox);
    }
    roiBox = null;
    updateRoiButtons();
    els.saveRoiBtn.disabled = true;
    els.exportBtn.disabled = true;
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
    if (label) label.textContent = state.roiMode + "mm × " + state.roiMode + "mm";

    var rect = viewer.viewport.imageToViewportRectangle(r.x, r.y, r.side, r.side);
    var existing = viewer.getOverlayById(roiBox);
    if (existing) {
      viewer.updateOverlay(roiBox, rect, OpenSeadragon.Placement.TOP_LEFT);
    } else {
      var opts = {
        element: roiBox,
        location: rect,
        placement: OpenSeadragon.Placement.TOP_LEFT,
      };
      if (state.rotation % 360 !== 0 &&
          OpenSeadragon.OverlayRotationMode &&
          OpenSeadragon.OverlayRotationMode.BOUNDING_BOX) {
        opts.rotationMode = OpenSeadragon.OverlayRotationMode.BOUNDING_BOX;
      }
      viewer.addOverlay(opts);
    }
  }

  // 用指定的图像坐标重建 ROI 框（跳转账使用）
  function rebuildRoi(x, y, side, sizeMm) {
    if (!state.slide) return;
    state.roiMode = sizeMm;
    state.roi.x = Math.round(x);
    state.roi.y = Math.round(y);
    state.roi.side = Math.round(side);
    createRoiBox();
    updateRoiOverlay();
    updateRoiButtons();
    els.saveRoiBtn.disabled = false;
    els.exportBtn.disabled = false;
  }

  // ---------- ROI 拖拽 ----------
  function onRoiPointerDown(e) {
    if (!state.slide) return;
    e.preventDefault();
    e.stopPropagation();
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
    e.preventDefault();
    e.stopPropagation();
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
    e.preventDefault();
    e.stopPropagation();
    try { roiBox.releasePointerCapture(dragInfo.pointerId); } catch (err) {}
    roiBox.removeEventListener("pointermove", onRoiPointerMove);
    roiBox.removeEventListener("pointerup", onRoiPointerUp);
    roiBox.removeEventListener("pointercancel", onRoiPointerUp);
    dragInfo = null;
    viewer.setMouseNavEnabled(true);
  }

  function getViewerRect() {
    return viewer.container.getBoundingClientRect();
  }

  // ---------- 保存选区 ----------
  function saveRoi() {
    if (!state.slide || state.roiMode == null) return;
    // label 必填校验
    var label = (els.roiLabel.value || "").trim();
    if (!label) {
      toast("请填写标记人或标签", "error");
      try { els.roiLabel.focus(); } catch (e) {}
      return;
    }
    var r = state.roi;
    fetch(API + "/api/roi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slide: state.slide.name,
        x: Math.round(r.x),
        y: Math.round(r.y),
        size_mm: state.roiMode,
        side_px: Math.round(r.side),
        label: label,
      }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (j) {
            throw new Error(j.error || ("保存失败 " + res.status));
          });
        }
        return res.json();
      })
      .then(function () {
        toast("选区已保存", "success");
        loadRoiPanel();
      })
      .catch(function (e) { toast("保存失败: " + e.message, "error"); });
  }

  // ---------- 导出图片（裁剪） ----------
  function exportCrop() {
    if (!state.slide || state.roiMode == null) return;
    var r = state.roi;
    var name = state.slide.name;
    var url = API + "/api/slide/" + encodeURIComponent(name) +
      "/crop?x=" + Math.round(r.x) + "&y=" + Math.round(r.y) +
      "&size=" + Math.round(r.side);

    var originalText = els.exportBtn.textContent;
    els.exportBtn.textContent = "导出中...";
    els.exportBtn.disabled = true;

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
        a.href = objUrl;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(objUrl); }, 1000);
        toast("已导出: " + fname, "success");
      })
      .catch(function (e) { toast("导出失败: " + e.message, "error"); })
      .finally(function () {
        els.exportBtn.textContent = originalText;
        els.exportBtn.disabled = state.roiMode == null;
      });
  }

  // ---------- 手动设置 mpp ----------
  function setMpp() {
    var v = parseFloat(els.mppInput.value);
    if (!isFinite(v) || v <= 0) { toast("请输入有效的 mpp 数值", "error"); return; }
    state.mppX = v;
    if (state.slide) {
      state.slide.mppX = v;
      state.slide.mppSource = "manual";
    }
    if (state.roiMode != null) {
      var newSide = roiSide(state.roiMode);
      var W = state.slide.width, H = state.slide.height;
      var cx = state.roi.x + state.roi.side / 2;
      var cy = state.roi.y + state.roi.side / 2;
      var x = clamp(cx - newSide / 2, 0, Math.max(0, W - newSide));
      var y = clamp(cy - newSide / 2, 0, Math.max(0, H - newSide));
      state.roi.x = Math.round(x);
      state.roi.y = Math.round(y);
      state.roi.side = newSide;
      updateRoiOverlay();
    }
    updateMppSetterVisibility();
    toast("mpp 已设为 " + v + " µm/px", "success");
  }

  // ---------- 选区面板 ----------
  function loadRoiPanel() {
    fetch(API + "/api/rois")
      .then(function (r) {
        if (!r.ok) throw new Error("加载选区失败");
        return r.json();
      })
      .then(function (rois) {
        renderRoiPanel(rois || []);
      })
      .catch(function (e) { toast(e.message, "error"); });
  }

  function renderRoiPanel(rois) {
    els.panelToggle.textContent = "选区(" + rois.length + ")";
    if (rois.length === 0) {
      els.panelList.innerHTML = '<div class="roi-panel-empty">暂无选区</div>';
      return;
    }
    els.panelList.innerHTML = "";
    rois.forEach(function (r, i) {
      var item = document.createElement("div");
      item.className = "roi-panel-item";

      var label = (r.label && String(r.label).trim()) || "未署名";

      var info = document.createElement("div");
      info.className = "ri-info";
      var title = document.createElement("div");
      title.className = "ri-title";
      // label 粗体 + 尺寸
      var lblEl = document.createElement("span");
      lblEl.className = "ri-label";
      lblEl.textContent = label;
      title.appendChild(lblEl);
      var szEl = document.createElement("span");
      szEl.textContent = " · " + r.size_mm + "mm";
      title.appendChild(szEl);
      var sub = document.createElement("div");
      sub.className = "ri-sub";
      sub.textContent = "(" + r.x + "," + r.y + ") " + fmtTime(r.ts);
      info.appendChild(title);
      info.appendChild(sub);

      // 点击条目 → 跳转
      info.style.cursor = "pointer";
      info.addEventListener("click", function () { jumpToRoi(r); });

      var del = document.createElement("button");
      del.className = "ri-del";
      del.textContent = "×";
      del.title = "删除";
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        deleteRoi(r.index);
      });

      item.appendChild(info);
      item.appendChild(del);
      els.panelList.appendChild(item);
    });
  }

  function deleteRoi(index) {
    fetch(API + "/api/roi/" + index, { method: "DELETE" })
      .then(function (r) {
        if (!r.ok) {
          return r.json().then(function (j) {
            throw new Error(j.error || "删除失败");
          });
        }
        return r.json();
      })
      .then(function () {
        toast("已删除选区", "success");
        loadRoiPanel();
      })
      .catch(function (e) { toast(e.message, "error"); });
  }

  // 跳转到指定 ROI：切到对应切片，OSD open 后居中并重建选区框
  function jumpToRoi(r) {
    var needSwitch = !(state.slide && state.slide.name === r.slide);
    if (needSwitch) {
      // 一次性监听 open 完成后定位
      var handler = function () {
        viewer.removeHandler("open", handler);
        doJump(r);
      };
      viewer.addHandler("open", handler);
      openSlide(r.slide);
    } else {
      doJump(r);
    }
  }

  function doJump(r) {
    rebuildRoi(r.x, r.y, r.side_px, r.size_mm);
    try {
      var rect = viewer.viewport.imageToViewportRectangle(r.x, r.y, r.side_px, r.side_px);
      viewer.viewport.fitBounds(rect);
    } catch (e) {}
    // 隐藏面板
    els.panel.style.display = "none";
  }

  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts * 1000);
    var p = function (n) { return n < 10 ? "0" + n : n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    els.zoomIn.addEventListener("click", zoomIn);
    els.zoomOut.addEventListener("click", zoomOut);
    els.rotateBtn.addEventListener("click", rotate);
    els.resetBtn.addEventListener("click", reset);

    els.roi6.addEventListener("click", function () { toggleRoi(6); });
    els.roi65.addEventListener("click", function () { toggleRoi(6.5); });

    els.saveRoiBtn.addEventListener("click", saveRoi);
    els.exportBtn.addEventListener("click", exportCrop);
    els.mppSetBtn.addEventListener("click", setMpp);
    els.mppInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") setMpp();
    });

    // 选区面板开关
    els.panelToggle.addEventListener("click", function () {
      var showing = els.panel.style.display !== "none";
      els.panel.style.display = showing ? "none" : "flex";
      if (!showing) loadRoiPanel();
    });
    els.panelClose.addEventListener("click", function () {
      els.panel.style.display = "none";
    });
  }

  // ---------- 启动 ----------
  function init() {
    initViewer();
    bindEvents();
    loadSlides();
    loadRoiPanel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
