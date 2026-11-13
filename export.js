/*!
 * ModelViewer local — animation export with optional live camera recording.
 *
 * Renders the live Viewer's own scene (so shading, outline, hidden parts and
 * materials are exactly what the page is showing) into an offscreen WebGL
 * canvas of any width x height, one deterministic frame at a time. Frame i is
 * always the clip at t = i / fps, so frame rate and duration are exact and the
 * clip is sampled once (no duplicated frames). GIF output loops forever by
 * default via NETSCAPE2.0; MP4 has no container-level loop flag. The camera
 * keeps its vertical FOV, so the output width only widens/narrows the
 * horizontal field of view.
 *
 * Two camera modes:
 *  - live (default): frames are paced in real time and each frame copies the
 *    on-screen Viewer's camera, which OrbitControls moves while the user
 *    drags. The drag therefore becomes a camera move in the exported video.
 *  - fixed: the camera is cloned once, then every frame is rendered as fast
 *    as the encoder allows (the original offline behaviour).
 *
 * Small outputs are rendered at 2–4x both dimensions (chosen from the short
 * edge) and box-filtered down through a reusable mip chain. MSAA alone has too
 * few samples at 64–128 px; supersampling also smooths the thin outline and
 * the GIF palette's edges.
 *
 * MP4: WebCodecs H.264 -> encoders.buildMP4().
 * GIF: encoders.createGIF() -> GIF89a with a NETSCAPE2.0 loop extension
 *      (default: infinite; the panel can turn it off).
 */
(function () {
    'use strict';

    var E = window.ModelViewerEncoders;
    var H264_CODECS = ['avc1.640028', 'avc1.4d4028', 'avc1.42002a', 'avc1.42001f'];
    var MAX_FRAMES = 1200;
    var MAX_RENDER_SIZE = 4096;
    var DEFAULT_BG = '#1b2028';

    var state = {
        running: false, cancelled: false, last: null,
        live: false, cameraMoves: 0
    };
    var el = {};

    function $(id) { return document.getElementById(id); }
    function yieldToUI() { return new Promise(function (r) { setTimeout(r, 0); }); }

    function viewer() {
        var container = document.querySelector('#viewerHost .model-viewer');
        return container && container.modelViewer ? container.modelViewer : null;
    }

    /**
     * Wait on animation frames rather than a bare timer: the page Viewer's own
     * render loop (and OrbitControls damping) must keep running while we pace
     * the recording, or a drag would never reach the camera we sample.
     * A timer fallback keeps the loop alive in background tabs where rAF stops.
     */
    function nextFrame() {
        return new Promise(function (resolve) {
            var settled = false;
            var timer = setTimeout(function () {
                if (!settled) { settled = true; resolve(); }
            }, 40);
            requestAnimationFrame(function () {
                if (!settled) { settled = true; clearTimeout(timer); resolve(); }
            });
        });
    }

    async function waitUntil(target) {
        // 600 frames is a hard ceiling (~10 s at 60 Hz) in case rAF never fires.
        for (var guard = 0; performance.now() < target && guard < 600; guard++) {
            await nextFrame();
        }
    }

    /**
     * Copy the live camera's pose into the offscreen camera. OrbitControls
     * writes position + quaternion (via lookAt) and zoom; copying the controls'
     * target is unnecessary because the quaternion already encodes it.
     * fov is vertical, so only `aspect` changes with the output shape.
     * Returns true when the pose differs from the previous exported frame.
     */
    var lastPose = null;
    function syncCamera(v, camera, aspect) {
        var src = v.camera;
        camera.position.copy(src.position);
        camera.quaternion.copy(src.quaternion);
        camera.up.copy(src.up);
        camera.zoom = src.zoom;
        camera.fov = src.fov;
        camera.near = src.near;
        camera.far = src.far;
        camera.aspect = aspect;               // vertical fov is shared
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);

        var pose = [src.position.x, src.position.y, src.position.z,
            src.quaternion.x, src.quaternion.y, src.quaternion.z,
            src.quaternion.w, src.zoom];
        var moved = false;
        if (lastPose) {
            for (var i = 0; i < pose.length; i++) {
                if (Math.abs(pose[i] - lastPose[i]) > 1e-5) { moved = true; break; }
            }
        }
        lastPose = pose;
        return moved;
    }

    /** Floating badge over the canvas: makes it obvious that dragging records. */
    function setRecording(active, text) {
        var badge = $('cameraRecBadge');
        if (!badge) { return; }
        badge.hidden = !active;
        if (text) { badge.textContent = text; }
    }

    // ---------------------------------------------------------- dimensions
    var MIN_DIM = 16, MAX_DIM = 2048;
    var MAX_RENDER_PIXELS = 4096 * 4096;      // guard against huge GL buffers

    function clampDim(value, fallback) {
        var n = parseInt(value, 10);
        if (!isFinite(n)) { n = fallback; }
        return Math.max(MIN_DIM, Math.min(MAX_DIM, n));
    }
    /** H.264 needs even dimensions; meta always shows the real output size. */
    function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

    // --------------------------------------------------- supersampling / AA
    /**
     * Rendering straight at 64–128 px gives MSAA too few samples and leaves
     * hard staircase edges (especially on the 1–2 px outline). Render both
     * dimensions at an integer multiple instead and box-filter down; small
     * exports benefit most, large ones already have enough pixels. "auto"
     * picks the multiplier from the SHORT edge, so wide but short clips still
     * get the smoothing they need.
     */
    function resolveScale(width, height, pref) {
        var scale;
        if (pref === 'off' || pref === 1 || pref === '1') {
            scale = 1;
        } else if (pref === undefined || pref === null || pref === ''
            || pref === 'auto') {
            var shortEdge = Math.min(width, height);
            scale = shortEdge <= 128 ? 4 : (shortEdge <= 320 ? 2 : 1);
        } else {
            scale = Math.max(1, Math.min(4, Math.round(parseFloat(pref) || 1)));
        }
        // Cap by the longest allowed axis and by total pixel budget. Never go
        // below 1: the output itself still has to fit in the render buffer.
        var cap = Math.min(MAX_RENDER_SIZE / width, MAX_RENDER_SIZE / height,
            Math.sqrt(MAX_RENDER_PIXELS / (width * height)));
        scale = Math.max(1, Math.min(scale, cap));
        var rw = even(Math.round(width * scale));
        var rh = even(Math.round(height * scale));
        return {
            scale: Math.min(rw / width, rh / height),
            renderWidth: rw, renderHeight: rh
        };
    }

    /**
     * A reusable mip chain. Halving repeatedly is a proper box filter; one
     * giant drawImage downscale tends to be bilinear and keeps the jaggies.
     * The final link writes into the export canvas itself.
     */
    function downsampleChain(rw, rh, width, height, targetCtx) {
        var chain = [], from = { w: rw, h: rh };
        while (from.w > width * 2 || from.h > height * 2) {
            var to = {
                w: Math.max(width, even(Math.round(from.w / 2))),
                h: Math.max(height, even(Math.round(from.h / 2)))
            };
            if (to.w >= from.w && to.h >= from.h) { break; }
            var c = document.createElement('canvas');
            c.width = to.w; c.height = to.h;
            var cx = c.getContext('2d');
            cx.imageSmoothingEnabled = true;
            cx.imageSmoothingQuality = 'high';
            chain.push({ ctx: cx, canvas: c, from: from, to: to });
            from = to;
        }
        targetCtx.imageSmoothingEnabled = true;
        targetCtx.imageSmoothingQuality = 'high';
        chain.push({
            ctx: targetCtx, canvas: targetCtx.canvas,
            from: from, to: { w: width, h: height }
        });
        return chain;
    }

    function safeName(value) {
        return String(value || '').replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5.]+/g, '_').slice(0, 64);
    }

    // ----------------------------------------------------------- AVCC helpers
    /** Split one AVCC (4-byte length prefixed) access unit into its NALs. */
    function avccNals(data) {
        var nals = [], at = 0;
        while (at + 4 <= data.length) {
            var size = (data[at] << 24) | (data[at + 1] << 16)
                | (data[at + 2] << 8) | data[at + 3];
            if (size <= 0 || at + 4 + size > data.length) { break; }
            nals.push(data.subarray(at + 4, at + 4 + size));
            at += 4 + size;
        }
        return nals;
    }

    /** Fall back to in-band SPS/PPS when VideoEncoder omits decoderConfig. */
    function avcCFromChunk(data) {
        var nals = avccNals(data);
        var sps = null, pps = null;
        for (var i = 0; i < nals.length; i++) {
            var type = nals[i][0] & 0x1f;
            if (type === 7 && !sps) { sps = nals[i]; }
            if (type === 8 && !pps) { pps = nals[i]; }
        }
        if (!sps || !pps) { return null; }
        var out = new Uint8Array(11 + sps.length + pps.length);
        var view = new DataView(out.buffer);
        var at = 0;
        out[at++] = 1;
        out[at++] = sps[1]; out[at++] = sps[2]; out[at++] = sps[3];
        out[at++] = 0xff;                 // 4-byte NAL lengths
        out[at++] = 0xe1;                 // 1 SPS
        view.setUint16(at, sps.length); at += 2;
        out.set(sps, at); at += sps.length;
        out[at++] = 1;                    // 1 PPS
        view.setUint16(at, pps.length); at += 2;
        out.set(pps, at);
        return out;
    }

    // ------------------------------------------------------------- MP4 setup
    async function pickH264Config(width, height, fps, bitrate) {
        if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
            throw new Error('当前浏览器不支持 WebCodecs，无法编码 MP4。请改用 Chrome / Edge 94+，或选择 GIF。');
        }
        var attempts = [];
        for (var i = 0; i < H264_CODECS.length; i++) {
            attempts.push({ codec: H264_CODECS[i], avc: { format: 'avc' } });
            attempts.push({ codec: H264_CODECS[i] });
        }
        for (var a = 0; a < attempts.length; a++) {
            var config = Object.assign({
                width: width, height: height, bitrate: bitrate,
                framerate: fps, latencyMode: 'quality'
            }, attempts[a]);
            try {
                var result = await VideoEncoder.isConfigSupported(config);
                if (result && result.supported) { return config; }
            } catch (error) { /* try the next codec string */ }
        }
        throw new Error('当前浏览器无法编码 H.264（WebCodecs 配置均不受支持），请改用 GIF。');
    }

    // ----------------------------------------------------------------- meta
    function currentClip() {
        var v = viewer();
        if (!v || !v.animation || !v.animation.available) { return null; }
        var anim = v.animation;
        var index = anim.currentIndex;
        var entry = anim.entries ? anim.entries[index] : null;
        if (index < 0 || !entry) { return null; }
        return { anim: anim, index: index, name: entry.name || ('Clip ' + (index + 1)), duration: anim.duration };
    }

    function exportSettings() {
        // `exportSize` is only a fallback for older embedded copies of the UI.
        var legacy = $('exportSize');
        var wField = $('exportWidth') || legacy;
        var hField = $('exportHeight') || legacy;
        var width = even(clampDim(wField && wField.value, 512));
        var height = even(clampDim(hField && hField.value, 512));
        var fps = Math.max(1, Math.min(60, parseInt($('exportFps').value, 10) || 30));
        var live = !$('exportLiveCamera') || $('exportLiveCamera').checked;
        var loop = !$('exportGifLoop') || $('exportGifLoop').checked;
        var speed = parseFloat($('exportSpeed') && $('exportSpeed').value) || 1;
        speed = Math.max(0.25, Math.min(2, speed));
        return {
            format: $('exportFormat').value,
            width: width, height: height, size: width,   // size = legacy alias
            fps: fps, live: live, speed: speed, loop: loop,
            aa: $('exportAA') ? $('exportAA').value : 'auto'
        };
    }

    function updateMeta() {
        var s = exportSettings();
        var clip = currentClip();
        var meta = $('exportMeta');
        if (!clip || !clip.duration) {
            meta.textContent = '等待模型加载，或当前模型没有可导出的动画。';
            $('exportBtn').disabled = true;
            return;
        }
        var frames = Math.max(1, Math.ceil(clip.duration * s.fps));
        $('exportBtn').disabled = state.running || frames > MAX_FRAMES;
        var aa = resolveScale(s.width, s.height, s.aa);
        var dims = s.width + '×' + s.height;
        var ratio = s.width === s.height
            ? '1:1' : (s.width / s.height).toFixed(3) + ':1';
        var lines = [
            '当前动画：' + clip.name + ' · ' + clip.duration.toFixed(2) + ' s · ' + frames + ' 帧',
            '输出：' + dims + ' · ' + ratio + ' · ' + s.fps + ' fps · 单遍采样（不复制帧）',
            '抗锯齿：' + (aa.scale > 1
                ? aa.renderWidth + '×' + aa.renderHeight + ' 超采样 → 缩小至 '
                    + dims + '（' + aa.scale.toFixed(1) + '×）'
                : '关闭，按 ' + dims + ' 直接渲染（MSAA）'),
            s.live
                ? '视角：实时跟随鼠标运镜 · 录制约 '
                    + (clip.duration / s.speed).toFixed(1) + ' s（' + s.speed
                    + '× 速度），期间拖动右侧画布即录进视频'
                : '视角：固定（导出开始时锁定），快速离线渲染'
        ];
        if (s.format === 'gif') {
            var delay = E.delayForFps(s.fps);
            lines.push('GIF 帧延迟以 1/100 秒计：实际 ' + (100 / delay).toFixed(2)
                + ' fps；' + (s.loop
                    ? 'NETSCAPE2.0 无限循环'
                    : '不写循环块，只播放一次'));
        } else if (typeof VideoEncoder === 'undefined') {
            lines.push('⚠ 当前浏览器不支持 WebCodecs，MP4 不可用，请选 GIF。');
        }
        var bg = ($('background') && $('background').value.trim()) || '';
        var wantAlpha = s.format === 'gif' && !bg
            && $('exportTransparent') && $('exportTransparent').checked;
        lines.push('背景：' + (bg || (wantAlpha
            ? '透明（GIF 仅 1-bit 透明，边缘会略粗糙）'
            : DEFAULT_BG + '（与页面画布一致）')));
        if (frames > MAX_FRAMES) {
            lines.push('⚠ 帧数超过上限 ' + MAX_FRAMES + '，请降低帧率。');
        }
        meta.textContent = lines.join('\n');
    }

    function setProgress(done, total, phase) {
        var wrap = $('exportProgress');
        wrap.hidden = false;
        var pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
        $('exportBarFill').style.width = pct + '%';
        $('exportProgressText').textContent = phase + ' · ' + done + '/' + total + ' (' + pct + '%)';
    }

    function setBusy(busy) {
        document.querySelector('.sidebar').classList.toggle('busy', busy);
        $('exportBtn').disabled = busy || !currentClip();
        $('exportCancel').disabled = !busy;
        ['exportWidth', 'exportHeight', 'exportLockRatio'].forEach(function (id) {
            if ($(id)) { $(id).disabled = busy; }
        });
        document.querySelectorAll('.ratio-btn').forEach(function (btn) {
            btn.disabled = busy;
        });
        $('exportFps').disabled = busy;
        $('exportFormat').disabled = busy;
        $('exportTransparent').disabled = busy;
        if ($('exportGifLoop')) { $('exportGifLoop').disabled = busy; }
        if ($('exportLiveCamera')) { $('exportLiveCamera').disabled = busy; }
        if ($('exportAA')) { $('exportAA').disabled = busy; }
        syncLiveControls();
    }

    function syncLiveControls() {
        var live = $('exportLiveCamera') && $('exportLiveCamera').checked;
        if ($('exportSpeed')) { $('exportSpeed').disabled = state.running || !live; }
    }

    function download(blob, name) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }

    // ------------------------------------------------------------------ run
    /**
     * @param {object} [overrides] {format, width, height, fps, loop,
     *        download:false}. `size:N` is still accepted as a square shorthand;
     *        `loop:false` omits the GIF NETSCAPE2.0 block. The overrides exist
     *        so the export can be driven headlessly in tests.
     * @returns {Promise<{blob,name,format,frames,width,height,fps,duration}>}
     */
    async function run(overrides) {
        if (state.running) { throw new Error('已有导出任务在进行中'); }
        var opts = Object.assign(exportSettings(), overrides || {});
        var v = viewer();
        if (!v || !v.three || !v.scene || !v.camera || !v.renderer) {
            throw new Error('查看器尚未就绪，请等待模型加载完成');
        }
        var anim = v.animation;
        if (!anim || !anim.available || anim.currentIndex < 0 || !anim.duration) {
            throw new Error('当前没有选中的动画可导出');
        }
        var THREE = v.three;
        // Legacy `size` shorthand wins only when no explicit width/height given.
        var width = opts.width, height = opts.height;
        if (overrides && overrides.size !== undefined
            && overrides.width === undefined && overrides.height === undefined) {
            width = height = overrides.size;
        }
        width = even(clampDim(width, 512));
        height = even(clampDim(height, 512));
        var aspect = width / height;
        var fps = Math.max(1, Math.min(60, opts.fps));
        var duration = anim.duration;
        var frameCount = Math.max(1, Math.ceil(duration * fps));
        if (frameCount > MAX_FRAMES) {
            throw new Error('帧数 ' + frameCount + ' 超过上限 ' + MAX_FRAMES + '，请降低帧率');
        }
        var frameDurationUs = Math.round(1000000 / fps);
        var clipName = (anim.entries[anim.currentIndex]
            && anim.entries[anim.currentIndex].name) || ('Clip' + anim.currentIndex);
        var modelName = ($('currentModel') && $('currentModel').textContent.trim()) || 'model';
        var baseName = safeName(modelName.replace(/\.[^.]+$/, '')) + '_'
            + safeName(clipName) + '_' + width + 'x' + height + '_' + fps + 'fps';
        var bg = ($('background') && $('background').value.trim()) || '';
        var isGif = opts.format === 'gif';
        var wantAlpha = opts.transparent !== undefined
            ? !!opts.transparent
            : !!($('exportTransparent') && $('exportTransparent').checked);
        // The page shows a transparent canvas over a dark stage; an opaque
        // render matches exactly what the user sees and avoids the speckling
        // that semi-transparent AA edges cause in a 256-colour palette.
        var transparent = isGif && !bg && wantAlpha;
        var clearColor = bg || (transparent ? '' : DEFAULT_BG);
        // GIF loop policy: true/0 = infinite, false = play once, n = n repeats.
        var loop = opts.loop === undefined ? true : opts.loop;
        var live = !!opts.live;
        var speed = Math.max(0.25, Math.min(2, parseFloat(opts.speed) || 1));
        var aa = resolveScale(width, height, opts.aa);
        var renderWidth = aa.renderWidth, renderHeight = aa.renderHeight;

        state.running = true;
        state.cancelled = false;
        state.live = live;
        state.cameraMoves = 0;
        lastPose = null;
        setBusy(true);
        setProgress(0, frameCount, live ? '准备录制' : '准备渲染');
        if (live) {
            // The page's render loop must stay alive: it is what runs
            // controls.update() and therefore turns a drag into a camera pose.
            try { v.start(); } catch (error) { /* already running */ }
            setRecording(true, '● 运镜录制中 · 拖动右侧画布可改变视角');
        }

        // Keep the mixer still so only our own seek() moves the animation.
        var wasLoop = anim.loop, wasPlaying = anim.playing;
        var savedFraction = duration ? anim.time / duration : 0;
        var origBackground = v.scene.background;
        var camera = null, renderer = null, encoder = null, chunks = null, avcC = null;
        var flat = null;
        try {
            anim.setLoop(false);
            anim.playing = false;

            // A separate renderer keeps the on-screen viewer untouched. Three.js
            // uploads this scene's textures into the new context on first draw.
            var glCanvas = document.createElement('canvas');
            glCanvas.width = renderWidth; glCanvas.height = renderHeight;
            renderer = new THREE.WebGLRenderer({
                // Supersampling replaces MSAA; stacking both only wastes VRAM.
                canvas: glCanvas, antialias: aa.scale <= 1, alpha: true,
                preserveDrawingBuffer: true
            });
            renderer.setPixelRatio(1);
            renderer.setSize(renderWidth, renderHeight, false);
            renderer.outputColorSpace = v.renderer.outputColorSpace;
            renderer.toneMapping = v.renderer.toneMapping;
            renderer.toneMappingExposure = v.renderer.toneMappingExposure;
            // In live mode the on-screen canvas shows the very frames being
            // captured, so give its scene the same background as the output.
            v.scene.background = (live && !transparent && clearColor)
                ? new THREE.Color(clearColor) : null;
            if (clearColor) {
                renderer.setClearColor(new THREE.Color(clearColor), 1);
            } else {
                renderer.setClearColor(0x000000, 0);
            }

            // fov is vertical: the model keeps the same height as on the page
            // and only the horizontal field changes with the output width.
            // Live mode re-syncs this pose from the page Viewer every frame.
            camera = v.camera.clone();
            if (live) {
                syncCamera(v, camera, aspect);
            } else {
                camera.aspect = aspect;
                camera.updateProjectionMatrix();
            }

            var ctx = document.createElement('canvas').getContext('2d',
                { willReadFrequently: true });
            ctx.canvas.width = width; ctx.canvas.height = height;
            // Resizing a canvas resets its 2D state, so build the chain after.
            var chain = downsampleChain(renderWidth, renderHeight,
                width, height, ctx);

            if (isGif) {
                flat = E.createGIF({
                    width: width, height: height, fps: fps,
                    transparent: transparent, loop: loop
                });
            } else {
                var bitrate = Math.min(24000000,
                    Math.max(2000000, Math.round(width * height * fps * 0.22)));
                var config = await pickH264Config(width, height, fps, bitrate);
                chunks = [];
                avcC = null;
                encoder = new VideoEncoder({
                    output: function (chunk, meta) {
                        var data = new Uint8Array(chunk.byteLength);
                        chunk.copyTo(data);
                        chunks.push({
                            data: data,
                            type: chunk.type,
                            duration: frameDurationUs
                        });
                        if (!avcC && meta && meta.decoderConfig
                            && meta.decoderConfig.description) {
                            avcC = new Uint8Array(meta.decoderConfig.description);
                        }
                        if (!avcC && chunk.type === 'key') {
                            avcC = avcCFromChunk(data);
                        }
                    },
                    error: function (error) { throw error; }
                });
                encoder.configure(config);
            }

            // Live mode paces the frames against the wall clock so the clip's
            // whole duration is available for dragging. The frame's animation
            // time stays deterministic (i / fps) regardless of any jitter.
            var frameMs = 1000 / fps / speed;
            var startWall = performance.now();
            for (var i = 0; i < frameCount; i++) {
                if (state.cancelled) { throw new Error('已取消'); }
                if (live) {
                    await waitUntil(startWall + i * frameMs);
                    if (state.cancelled) { throw new Error('已取消'); }
                    if (syncCamera(v, camera, aspect)) { state.cameraMoves++; }
                    if (i % 5 === 0) {
                        setRecording(true, '● 运镜录制中 · 拖动改变视角 · '
                            + (i / fps).toFixed(1) + ' / ' + duration.toFixed(1) + ' s'
                            + (state.cameraMoves ? ' · 已捕获 ' + state.cameraMoves + ' 帧运镜' : ''));
                    }
                }
                anim.seek((i / fps) / duration);
                renderer.render(v.scene, camera);
                renderer.getContext().flush();
                var src = renderer.domElement;
                for (var c = 0; c < chain.length; c++) {
                    var link = chain[c];
                    link.ctx.clearRect(0, 0, link.to.w, link.to.h);
                    link.ctx.drawImage(src,
                        0, 0, link.from.w, link.from.h,
                        0, 0, link.to.w, link.to.h);
                    src = link.canvas;
                }
                var image = ctx.getImageData(0, 0, width, height);

                if (isGif) {
                    flat.addFrame(image.data);
                } else {
                    var frame = new VideoFrame(ctx.canvas, {
                        timestamp: i * frameDurationUs,
                        duration: frameDurationUs
                    });
                    encoder.encode(frame, { keyFrame: i === 0 });
                    frame.close();
                    if (encoder.encodeQueueSize > 8) { await encoder.flush(); }
                }
                if (live || i % 3 === 0 || i === frameCount - 1) {
                    setProgress(i + 1, frameCount, live ? '运镜录制' : '渲染帧');
                }
                await yieldToUI();
            }

            var blob, name;
            if (isGif) {
                setProgress(frameCount, frameCount, '量化与 LZW 编码');
                await yieldToUI();
                var gifBytes = flat.finish();
                blob = new Blob([gifBytes], { type: 'image/gif' });
                name = baseName + (transparent ? '_alpha' : '')
                    + (loop === false ? '_once' : '') + '.gif';
            } else {
                setProgress(frameCount, frameCount, '等待 H.264 编码');
                await encoder.flush();
                encoder.close();
                encoder = null;
                if (!chunks.length) { throw new Error('视频编码器没有输出任何帧'); }
                if (!avcC) { avcC = avcCFromChunk(chunks[0].data); }
                var mp4Bytes = E.buildMP4({
                    width: width, height: height, fps: fps,
                    frames: chunks, avcC: avcC
                });
                blob = new Blob([mp4Bytes], { type: 'video/mp4' });
                name = baseName + '.mp4';
            }

            var result = {
                blob: blob, name: name, format: opts.format,
                frames: frameCount, width: width, height: height,
                fps: fps, duration: duration, clip: clipName,
                bytes: blob.size, live: live, speed: speed,
                loop: isGif ? loop : null,
                cameraMoves: state.cameraMoves,
                aa: aa.scale,
                renderWidth: renderWidth, renderHeight: renderHeight,
                renderSize: renderWidth            // legacy alias
            };
            state.last = result;
            if (opts.download !== false) { download(blob, name); }
            setProgress(frameCount, frameCount, '完成 · ' + (blob.size / 1048576).toFixed(2) + ' MB');
            return result;
        } finally {
            // Always give the live viewer its state back, even on cancel/error.
            setRecording(false);
            try {
                if (encoder) { encoder.close(); }
                if (renderer) {
                    renderer.dispose();
                    renderer.forceContextLoss();
                }
                v.scene.background = origBackground;
                anim.setLoop(wasLoop);
                anim.loop = wasLoop;
                if (duration) { anim.seek(savedFraction); }
                anim.playing = wasPlaying;
                if (viewer() === v) { v.start(); }
            } catch (error) { /* viewer may have been rebuilt mid-export */ }
            state.running = false;
            setBusy(false);
            updateMeta();
        }
    }

    // ------------------------------------------------------- ratio helpers
    var lockedRatio = null;

    function currentRatio() {
        var s = exportSettings();
        return s.width / s.height;
    }

    /** Highlight the shortcut whose ratio matches the two dimension fields. */
    function setRatioState(ratio) {
        document.querySelectorAll('.ratio-btn[data-ratio]').forEach(function (btn) {
            var r = parseFloat(btn.getAttribute('data-ratio'));
            btn.classList.toggle('active', !!ratio && Math.abs(r - ratio) < 0.002);
        });
    }

    /** Presets keep the height (and thus the vertical framing) fixed. */
    function applyRatio(ratio) {
        var h = even(clampDim($('exportHeight').value, 512));
        var w = even(Math.round(h * ratio));
        if (w > MAX_DIM) {
            w = even(MAX_DIM);
            h = even(Math.round(w / ratio));
        }
        $('exportWidth').value = w;
        $('exportHeight').value = h;
        lockedRatio = w / h;
        setRatioState(ratio);
        var hint = $('ratioHint');
        if (hint) { hint.textContent = '以「高度」为基准换算宽度'; }
        updateMeta();
    }

    function matchPreviewRatio() {
        var host = document.querySelector('#viewerHost .model-viewer')
            || $('viewerHost');
        if (!host || !host.clientWidth || !host.clientHeight) { return; }
        applyRatio(host.clientWidth / host.clientHeight);
        setRatioState(null);
        var s = exportSettings();
        var hint = $('ratioHint');
        if (hint) {
            hint.textContent = '预览 ' + host.clientWidth + '×' + host.clientHeight
                + ' → 输出 ' + s.width + '×' + s.height;
        }
    }

    function syncLockedDimension(source) {
        var lock = $('exportLockRatio');
        if (!lock || !lock.checked) { return; }
        if (!lockedRatio || !isFinite(lockedRatio)) { lockedRatio = currentRatio(); }
        var r = lockedRatio;
        var rawW = even(clampDim($('exportWidth').value, 512));
        var rawH = even(clampDim($('exportHeight').value, 512));
        var w = rawW, h = rawH;
        if (source === 'width') { h = even(Math.round(w / r)); }
        else { w = even(Math.round(h * r)); }
        if (w > MAX_DIM) { w = even(MAX_DIM); h = even(Math.round(w / r)); }
        if (h > MAX_DIM) { h = even(MAX_DIM); w = even(Math.round(h * r)); }
        // Only write the OTHER field back: rewriting the field being typed in
        // would fight with the user's keystrokes.
        if (source === 'width') {
            if (w !== rawW) { $('exportWidth').value = w; }
            $('exportHeight').value = h;
        } else {
            if (h !== rawH) { $('exportHeight').value = h; }
            $('exportWidth').value = w;
        }
    }

    // --------------------------------------------------------------- wiring
    function bind() {
        el.format = $('exportFormat');
        el.width = $('exportWidth');
        el.height = $('exportHeight');
        el.fps = $('exportFps');
        if (!el.format) { return; }

        [el.format, el.fps, $('background'), $('exportTransparent'),
            $('exportGifLoop'), $('exportLiveCamera'), $('exportSpeed'),
            $('exportAA')].forEach(function (input) {
            if (!input) { return; }
            input.addEventListener('change', function () {
                syncLiveControls();
                updateMeta();
            });
            input.addEventListener('input', updateMeta);
        });

        [el.width, el.height].forEach(function (input, idx) {
            if (!input) { return; }
            var which = idx === 0 ? 'width' : 'height';
            function changed() {
                syncLockedDimension(which);
                setRatioState(currentRatio());
                updateMeta();
            }
            input.addEventListener('input', changed);
            input.addEventListener('change', changed);
        });

        var lock = $('exportLockRatio');
        if (lock) {
            lock.addEventListener('change', function () {
                lockedRatio = lock.checked ? currentRatio() : null;
                updateMeta();
            });
        }
        document.querySelectorAll('.ratio-btn[data-ratio]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                applyRatio(parseFloat(btn.getAttribute('data-ratio')));
            });
        });
        if ($('ratioPreview')) {
            $('ratioPreview').addEventListener('click', matchPreviewRatio);
        }
        syncLiveControls();
        $('exportBtn').addEventListener('click', function () {
            run().then(function (result) {
                $('exportProgressText').textContent = '已导出 ' + result.name
                    + '（' + result.frames + ' 帧）';
            }).catch(function (error) {
                $('exportProgress').hidden = false;
                $('exportProgressText').textContent = '导出失败：' + error.message;
            });
        });
        $('exportCancel').addEventListener('click', function () {
            state.cancelled = true;
            $('exportProgressText').textContent = '正在取消…';
        });
        if (window.ModelViewerHooks) {
            ['ready', 'modelChange', 'animChange'].forEach(function (name) {
                window.ModelViewerHooks.on('modelViewer.' + name, updateMeta);
            });
        }
        updateMeta();
        setInterval(function () { if (!state.running) { updateMeta(); } }, 2500);
    }

    // Testing / console access: run({format:'gif', width:320, height:180,
    // fps:12, live:false, aa:'off', download:false}) returns the Blob and its
    // metadata. `size:N` remains a square shorthand; `loop:false` makes a
    // single-play GIF, while the default writes an infinite loop block.
    window.__modelViewerExport = {
        run: run,
        state: state,
        meta: updateMeta,
        settings: exportSettings,
        get last() { return state.last; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();
