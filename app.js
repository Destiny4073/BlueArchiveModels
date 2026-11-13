/*!
 * Local console for the ModelViewer gadget.
 *
 * It writes the exact same HTML the wiki templates emit
 *   <div class="model-viewer" data-src="…" …>
 *     <div class="model-viewer-controls" data-controls="…"></div>
 *   </div>
 * and then fires mw.hook('wikipage.content'), which is what MediaWiki does
 * after rendering a page. The gadget takes over from there.
 */
(function () {
    'use strict';

    var mw = window.mw;
    var host = document.getElementById('viewerHost');
    var modelSelect = document.getElementById('modelSelect');
    var urlInput = document.getElementById('urlInput');
    var formatSelect = document.getElementById('formatSelect');
    var snippet = document.getElementById('snippet');
    var eventLog = document.getElementById('eventLog');
    var statusPill = document.getElementById('statusPill');
    var currentModel = document.getElementById('currentModel');
    var applyBtn = document.getElementById('applyBtn');
    var viewerCard = document.getElementById('viewerCard');

    var CONTROL_NAMES = [
        'model', 'anim', 'play', 'scrub', 'speed', 'loop',
        'outline', 'outline-width', 'autorotate', 'shading', 'grid',
        'reset', 'fullscreen'
    ];
    var DEFAULT_CONTROLS = CONTROL_NAMES.slice();
    // No built-in model names anywhere: the first discovered entry is selected
    // on load, and ?model=<name> picks a specific one from that list.

    /**
     * Mirrors bluearchive.wiki's Module:ModelViewer DEFAULTS. The decisive one
     * is `shading: 'unlit'`: Blue Archive textures already contain the game's
     * baked cel shading, so PBR lighting over them blows out white cloth/hair.
     * `preload` stays eager here (one viewer on the page, not a hundred).
     */
    var DEFAULTS = {
        height: '480', fov: '35', background: '', camera: '0,5,1',
        cameraControl: 'orbit', shading: 'unlit', environment: 'neutral',
        toneMapping: 'aces', exposure: '1', preload: 'eager',
        hideParts: 'optional',
        autorotate: false, grid: false,
        animDefault: 'Cafe_Reaction', speed: '100', autoplay: true, loop: true,
        outline: true, outlineColor: '#000000', outlineWidth: '25'
    };

    /** One-click lighting comparisons. `unlit` is what the wiki ships. */
    var LIGHT_PRESETS = {
        wiki: { shading: 'unlit', environment: 'neutral', toneMapping: 'aces', exposure: '1' },
        pbr: { shading: 'shaded', environment: 'neutral', toneMapping: 'aces', exposure: '1' },
        soft: { shading: 'shaded', environment: 'none', toneMapping: 'none', exposure: '0.55' }
    };

    var LABELS = 'model=模型,anim=动画,play=播放,scrub=进度,speed=速度,loop=循环,' +
        'outline=描边,autorotate=自动旋转,shading=着色,grid=网格,reset=重置视角,fullscreen=全屏';

    /** The active model: { label, url, format, mtl, models } */
    var source = null;
    var objectUrls = [];
    var dirty = false;

    // ---------------------------------------------------------------- helpers
    function $(id) { return document.getElementById(id); }

    function escapeAttr(value) {
        return String(value)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function addLog(tag, message, kind) {
        var row = document.createElement('div');
        row.className = 'log-row' + (kind ? ' ' + kind : '');
        var time = document.createElement('span');
        time.className = 'log-time';
        time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        var tagEl = document.createElement('span');
        tagEl.className = 'log-tag';
        tagEl.textContent = tag;
        var msg = document.createElement('span');
        msg.className = 'log-msg';
        msg.textContent = message;
        row.append(time, tagEl, msg);
        eventLog.appendChild(row);
        while (eventLog.children.length > 80) {
            eventLog.removeChild(eventLog.firstChild);
        }
        eventLog.scrollTop = eventLog.scrollHeight;
    }

    function setStatus(text, kind) {
        statusPill.textContent = text;
        statusPill.className = 'status-pill' + (kind ? ' ' + kind : '');
    }

    function markDirty() {
        dirty = true;
        applyBtn.classList.add('dirty');
    }

    function clearDirty() {
        dirty = false;
        applyBtn.classList.remove('dirty');
    }

    function releaseObjectUrls() {
        objectUrls.forEach(function (url) {
            setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
        });
        objectUrls = [];
    }

    function formatFromName(name) {
        var ext = String(name).split('.').pop().toLowerCase();
        return { glb: 'glb', gltf: 'gltf', fbx: 'fbx', obj: 'obj', stl: 'stl', dae: 'dae' }[ext] || '';
    }

    function humanSize(bytes) {
        return bytes >= 1048576
            ? (bytes / 1048576).toFixed(1) + ' MB'
            : Math.max(1, Math.round(bytes / 1024)) + ' KB';
    }

    // ------------------------------------------------------------------ model
    /**
     * Model discovery, two modes:
     *
     *  remote (default on *.github.io) — the model library (hundreds of MB)
     *  stays in the repository's `main` branch while this site is deployed
     *  from a pages branch / Pages artifact that ships code only. A single
     *  GitHub Contents API call lists the whole directory (up to 1000
     *  entries), so ~100-300 models cost exactly one request. The result is
     *  cached in sessionStorage because unauthenticated API calls are limited
     *  to 60/hour/IP.
     *
     *  local — models/manifest.json + ./models/, used for local development
     *  and as a fallback when the remote directory cannot be listed. The repo
     *  ships no model binaries: an empty/missing manifest yields zero models
     *  and a clear hint, never a fake built-in list.
     *
     * Model bytes are fetched through a configurable list of ghproxy prefixes
     * in front of raw.githubusercontent.com. A HEAD probe picks the first
     * reachable source once per session; the winner is cached and reused.
     * All URL construction is relative to the document, so a project site at
     * https://user.github.io/<repo>/ needs no changes.
     */
    var MODEL_EXT = /\.(glb|gltf|fbx|obj|stl|dae)$/i;
    var DEFAULT_CONFIG = {
        mode: 'remote', repo: '', repoCandidates: [], branch: 'main', dir: '',
        defaultModel: '', apiBase: 'https://api.github.com',
        probe: true, cacheMinutes: 10,
        sources: [
            { id: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
            { id: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
            { id: 'ghfast.top', prefix: 'https://ghfast.top/' },
            { id: 'raw.githubusercontent.com', prefix: '' }
        ]
    };
    var REMOTE = { config: null, models: [], origin: '', sourceId: '', dir: '' };
    var forcedSource = '';

    function qs(name) {
        return new URLSearchParams(location.search).get(name) || '';
    }

    /** Account name of a project/user Pages site; custom domains have none. */
    function inferOwner() {
        var m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
        return m ? m[1] : '';
    }

    /** <owner>.github.io/<repo>/ -> "<owner>/<repo>" (models live in main). */
    function inferRepo(owner) {
        var first = location.pathname.split('/').filter(Boolean)[0];
        return first && owner ? owner + '/' + first : '';
    }

    /**
     * Resolve a repo entry. "<owner>/BlueArchiveModels" and a bare repo name
     * both resolve inside the Pages account, which is exactly where a fork of
     * the model library lives. A fully qualified "owner/repo" is used as is.
     * Custom domains have no owner, so the placeholder resolves to nothing
     * unless ?owner= is supplied.
     */
    function expandRepo(value, owner) {
        var s = String(value || '').trim();
        if (!s) { return ''; }
        if (/<owner>/i.test(s)) {
            return owner ? s.replace(/<owner>/gi, owner) : '';
        }
        if (s.indexOf('/') === -1) { return owner ? owner + '/' + s : ''; }
        return s;
    }

    function loadConfig() {
        return fetch('./models.config.json', { cache: 'no-store' })
            .then(function (res) {
                if (!res.ok) { throw new Error('config HTTP ' + res.status); }
                return res.json();
            })
            .catch(function () { return {}; })
            .then(function (file) {
                var cfg = Object.assign({}, DEFAULT_CONFIG, file || {});
                if (!Array.isArray(cfg.sources) || !cfg.sources.length) {
                    cfg.sources = DEFAULT_CONFIG.sources;
                }
                // URL overrides: custom domains, forked repos, testing.
                var owner = qs('owner') || inferOwner();
                var primary = expandRepo(
                    qs('repo') || cfg.repo || inferRepo(owner), owner);
                var extras = (Array.isArray(cfg.repoCandidates) ? cfg.repoCandidates : [])
                    .map(function (r) { return expandRepo(r, owner); });
                // Try the site's own repo first, then any explicitly listed
                // candidate (e.g. a fork of the model library under the same
                // account). The first repo that actually lists models wins.
                cfg.repos = [primary].concat(extras).filter(function (r, i, all) {
                    return r && all.indexOf(r) === i;
                });
                cfg.repo = cfg.repos[0] || '';
                cfg.branch = qs('branch') || cfg.branch || 'main';
                if (qs('dir')) { cfg.dir = qs('dir'); }
                cfg.apiBase = qs('api') || cfg.apiBase;
                if (qs('prefix')) { cfg.sources = [{ id: 'custom', prefix: qs('prefix') }]; }
                if (qs('probe') === '0') { cfg.probe = false; }
                return cfg;
            });
    }

    function cacheKey(cfg) {
        return [(cfg.repos || [cfg.repo]).join(','), cfg.branch,
            cfg.dir, cfg.apiBase].join('|');
    }
    function cacheGet(key) {
        try {
            var raw = sessionStorage.getItem(key);
            if (!raw) { return null; }
            var obj = JSON.parse(raw);
            return obj.expires && obj.expires < Date.now() ? null : obj.value;
        } catch (e) { return null; }
    }
    function cacheSet(key, value, minutes) {
        try {
            sessionStorage.setItem(key, JSON.stringify({
                expires: Date.now() + minutes * 60000, value: value
            }));
        } catch (e) { /* private mode / quota */ }
    }
    function cacheDrop(prefix) {
        try {
            Object.keys(sessionStorage).forEach(function (key) {
                if (key.indexOf(prefix) === 0) { sessionStorage.removeItem(key); }
            });
        } catch (e) { /* ignore */ }
    }

    function withTimeout(promise, ms) {
        return new Promise(function (resolve, reject) {
            var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
            promise.then(function (v) { clearTimeout(t); resolve(v); },
                function (e) { clearTimeout(t); reject(e); });
        });
    }

    /** One request per directory; no custom headers means no CORS preflight. */
    function listContents(cfg, dir) {
        var url = cfg.apiBase.replace(/\/$/, '') + '/repos/' + cfg.repo
            + '/contents/' + dir.split('/').map(encodeURIComponent).join('/')
            + '?ref=' + encodeURIComponent(cfg.branch);
        return withTimeout(fetch(url, { cache: 'no-store' }), 12000)
            .then(function (res) {
                if (!res.ok) { throw new Error('contents HTTP ' + res.status); }
                return res.json();
            })
            .then(function (items) {
                if (!Array.isArray(items)) { throw new Error('not a directory'); }
                return items.filter(function (it) {
                    return it.type === 'file' && MODEL_EXT.test(it.name);
                }).map(function (it) {
                    return { name: it.name, path: it.path, size: it.size || 0 };
                }).sort(function (a, b) { return a.name.localeCompare(b.name, 'en'); });
            });
    }

    /** Fallback when models live in nested subdirectories. */
    function listTree(cfg) {
        var url = cfg.apiBase.replace(/\/$/, '') + '/repos/' + cfg.repo
            + '/git/trees/' + encodeURIComponent(cfg.branch) + '?recursive=1';
        return withTimeout(fetch(url, { cache: 'no-store' }), 12000)
            .then(function (res) {
                if (!res.ok) { throw new Error('tree HTTP ' + res.status); }
                return res.json();
            })
            .then(function (data) {
                return (data.tree || []).filter(function (it) {
                    return it.type === 'blob' && MODEL_EXT.test(it.path);
                }).map(function (it) {
                    return { name: it.path.split('/').pop(), path: it.path, size: it.size || 0 };
                }).sort(function (a, b) { return a.path.localeCompare(b.path, 'en'); });
            });
    }

    function discoverRemote(cfg, force) {
        var key = 'mv.list.' + cacheKey(cfg);
        if (!force) {
            var cached = cacheGet(key);
            if (cached && cached.models && cached.models.length) {
                return Promise.resolve(cached);
            }
        }
        var repos = (cfg.repos && cfg.repos.length) ? cfg.repos : [cfg.repo];
        /** Probe one repository: models/ -> repo root -> recursive tree. */
        function discoverOne(c) {
            var dirs = c.dir ? [c.dir] : ['models', ''];
            function step(i) {
                if (i >= dirs.length) { return Promise.resolve(null); }
                return listContents(c, dirs[i])
                    .then(function (models) {
                        return models.length
                            ? { models: models, dir: dirs[i], origin: 'GitHub Contents API' }
                            : step(i + 1);
                    })
                    .catch(function () { return step(i + 1); });
            }
            return step(0).then(function (found) {
                if (found) { return found; }
                return listTree(c).then(function (models) {
                    return models.length
                        ? { models: models, dir: '', origin: 'GitHub Trees API' }
                        : null;
                }).catch(function () { return null; });
            });
        }
        function tryRepo(i) {
            if (i >= repos.length) { return Promise.resolve(null); }
            var c = Object.assign({}, cfg, { repo: repos[i] });
            return discoverOne(c).then(function (found) {
                if (!found) { return tryRepo(i + 1); }
                found.repo = repos[i];
                return found;
            });
        }
        return tryRepo(0).then(function (found) {
            if (found) { cacheSet(key, found, cfg.cacheMinutes || 10); }
            return found;
        });
    }

    function localFallback() {
        var live = qs('scan') === '1'
            ? fetch('./api/models', { cache: 'no-store' }).then(function (res) {
                if (!res.ok) { throw new Error('no live scan'); }
                return res.json();
            })
            : Promise.reject(new Error('static'));
        return live.catch(function () {
            return fetch('./models/manifest.json', { cache: 'no-store' })
                .then(function (res) {
                    if (!res.ok) { throw new Error('manifest HTTP ' + res.status); }
                    return res.json();
                });
        }).then(function (list) {
            return {
                models: (list || []).map(function (m) {
                    return { name: m.name, path: m.name, size: m.size || 0, local: true };
                }),
                dir: '', origin: qs('scan') === '1' ? '本地实时扫描' : '本地 models/manifest.json'
            };
        }).catch(function () {
            // Never invent model names: the site has no bundled models, so a
            // missing manifest means an empty list plus an actionable hint.
            return { models: [], dir: '', origin: '没有可用模型' };
        });
    }

    function fetchModelList(force) {
        return loadConfig().then(function (cfg) {
            REMOTE.config = cfg;
            if (cfg.mode === 'remote' && cfg.repos.length && qs('scan') !== '1') {
                return discoverRemote(cfg, force).then(function (found) {
                    // Raw URLs must point at the repo that actually had models,
                    // not the site repo that was probed first.
                    if (found && found.repo) { cfg.repo = found.repo; }
                    return found;
                });
            }
            return localFallback();
        }).then(function (found) { return found || localFallback(); });
    }

    /** Canonical raw.githubusercontent.com URL for one model. */
    function rawModelUrl(cfg, model) {
        var path = (model.path || model.name).split('/').map(encodeURIComponent).join('/');
        return 'https://raw.githubusercontent.com/' + cfg.repo + '/'
            + encodeURIComponent(cfg.branch) + '/' + path;
    }

    function sourceCandidates(cfg, model) {
        var raw = rawModelUrl(cfg, model);
        var ghPath = cfg.repo + '@' + cfg.branch + '/'
            + (model.path || model.name).split('/').map(encodeURIComponent).join('/');
        return cfg.sources.map(function (s) {
            return {
                id: s.id,
                url: s.type === 'jsdelivr' ? (s.prefix || '') + ghPath : (s.prefix || '') + raw
            };
        });
    }

    /** HEAD is a CORS-safelisted simple request, so no OPTIONS preflight. */
    function headOk(url, expected) {
        var ctl = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctl) { ctl.abort(); } }, 6000);
        var opts = { method: 'HEAD', mode: 'cors', cache: 'no-store' };
        if (ctl) { opts.signal = ctl.signal; }
        return fetch(url, opts).then(function (res) {
            clearTimeout(timer);
            if (!res.ok) { return false; }
            // A Git LFS pointer or an HTML error page is only a few hundred
            // bytes; reject it instead of handing garbage to GLTFLoader.
            var len = parseInt(res.headers.get('content-length') || '0', 10);
            if (expected > 2048 && len > 0 && len < 1024) { return false; }
            return true;
        }).catch(function () { clearTimeout(timer); return false; });
    }

    function resolveModelUrl(cfg, model) {
        var all = sourceCandidates(cfg, model);
        if (!all.length) { return Promise.resolve({ id: '', url: rawModelUrl(cfg, model) }); }
        var pick = forcedSource
            ? all.filter(function (s) { return s.id === forcedSource; }) : [];
        var list = pick.length ? pick : all;
        if (!cfg.probe) { return Promise.resolve(list[0]); }
        var srcKey = 'mv.src.' + cacheKey(cfg);
        var winner = forcedSource ? null : cacheGet(srcKey);
        var ordered = list.slice();
        if (winner) {
            var first = ordered.filter(function (s) { return s.id === winner; });
            if (first.length) {
                ordered = first.concat(ordered.filter(function (s) { return s.id !== winner; }));
            }
        }
        function step(i) {
            if (i >= ordered.length) { return list[0]; }
            return headOk(ordered[i].url, model.size).then(function (ok) {
                if (!ok) { return step(i + 1); }
                cacheSet(srcKey, ordered[i].id, cfg.cacheMinutes || 10);
                return ordered[i];
            });
        }
        return step(0);
    }

    function findModel(name) {
        return REMOTE.models.find(function (m) { return m.name === name; });
    }

    /** Rebuild the dropdown from the cached full list + a text filter. */
    function renderOptions(filter) {
        var keep = modelSelect.selectedOptions[0] && modelSelect.selectedOptions[0].dataset.name;
        var needle = (filter || '').trim().toLowerCase();
        modelSelect.replaceChildren();
        REMOTE.models.forEach(function (model) {
            if (needle && model.name.toLowerCase().indexOf(needle) === -1) { return; }
            var option = document.createElement('option');
            option.value = model.local
                ? './models/' + encodeURIComponent(model.name)
                : (model.path || model.name);
            option.textContent = model.name
                + (model.size ? '  ·  ' + humanSize(model.size) : '');
            option.dataset.name = model.name;
            option.dataset.size = model.size || 0;
            option.dataset.local = model.local ? '1' : '';
            modelSelect.appendChild(option);
        });
        if (keep) {
            var match = Array.from(modelSelect.options)
                .find(function (o) { return o.dataset.name === keep; });
            if (match) { modelSelect.value = match.value; }
        }
        if (!modelSelect.selectedOptions.length && modelSelect.options.length) {
            modelSelect.selectedIndex = 0;
        }
    }

    function updateSourceInfo() {
        var el = $('sourceInfo');
        if (!el) { return; }
        var cfg = REMOTE.config || {};
        var remoteMiss = !REMOTE.models.length
            && cfg.mode === 'remote' && (cfg.repos || []).length > 0;
        if (remoteMiss) {
            el.textContent = '⚠ ' + (cfg.repos || []).join(' / ') + '@' + cfg.branch
                + ' 没列出任何模型。本站点不内置模型文件，请确认仓库是 public、模型在 '
                + cfg.branch + ' 分支，检查 models.config.json 的 repo / repoCandidates，'
                + '或用 ?repo=<owner>/<repo> 指定；也可以直接「选择本地文件」或填写模型 URL。';
            el.className = 'source-info error';
        } else if (!REMOTE.models.length) {
            el.textContent = '⚠ 没有任何可用模型（' + REMOTE.origin + '）。'
                + '把模型放进 models/ 并运行 npm run scan，或用「选择本地文件」/填写模型 URL。';
            el.className = 'source-info error';
        } else if (/^(本地|没有)/.test(REMOTE.origin)) {
            el.textContent = REMOTE.origin + ' · ' + REMOTE.models.length + ' 个模型（同源）';
            el.className = 'source-info local';
        } else {
            el.textContent = cfg.repo + '@' + cfg.branch + ' · ' + REMOTE.models.length
                + ' 个模型 · ' + REMOTE.origin + ' · 加速源 '
                + (REMOTE.sourceId || '自动探测中');
            el.className = 'source-info remote';
        }
    }

    function buildSourceSelect() {
        var sel = $('sourceSelect');
        if (!sel || !REMOTE.config) { return; }
        var prev = sel.value;
        sel.replaceChildren();
        var auto = document.createElement('option');
        auto.value = '';
        auto.textContent = '自动（逐个探测可用源）';
        sel.appendChild(auto);
        if (!REMOTE.models.length || REMOTE.models[0].local) {
            var local = document.createElement('option');
            local.value = 'local';
            local.textContent = REMOTE.models.length
                ? '本地 models/（同源）' : '（无可用模型）';
            sel.appendChild(local);
            sel.value = 'local';
            sel.disabled = true;
            return;
        }
        sel.disabled = false;
        REMOTE.config.sources.forEach(function (s) {
            var o = document.createElement('option');
            o.value = s.id;
            o.textContent = s.id;
            sel.appendChild(o);
        });
        var valid = Array.from(sel.options).some(function (o) { return o.value === prev; });
        sel.value = forcedSource || (valid ? prev : '');
    }

    function loadModelList(preferred, force) {
        return fetchModelList(force).then(function (found) {
            REMOTE.models = found.models;
            REMOTE.origin = found.origin;
            REMOTE.dir = found.dir;
            updateSourceInfo();
            renderOptions($('modelFilter') ? $('modelFilter').value : '');
            if (preferred) {
                var match = Array.from(modelSelect.options)
                    .find(function (o) { return o.dataset.name === preferred; });
                if (match) { modelSelect.value = match.value; }
            }
            buildSourceSelect();
            if (!source) {
                // ?model=X.glb picks from the discovered list; a full URL or a
                // path with slashes is handed straight to the viewer.
                var initial = qs('model')
                    || (REMOTE.config && REMOTE.config.defaultModel) || '';
                if (initial && /[/\\]|^https?:/.test(initial)) { useUrl(initial); return; }
                if (initial) {
                    var wanted = Array.from(modelSelect.options)
                        .find(function (o) { return o.dataset.name === initial; });
                    if (wanted) { modelSelect.value = wanted.value; }
                }
                // No hard-coded default: renderOptions() already selects the
                // first discovered entry. An empty list loads nothing at all.
                useSelectedModel();
            }
            addLog('list', REMOTE.origin + ' · ' + REMOTE.models.length + ' 个模型');
            if (REMOTE.config && REMOTE.config.mode === 'remote'
                && !REMOTE.models.length) {
                addLog('error', '远端模型仓库未命中：'
                    + (REMOTE.config.repos || []).join(' / ') + '@'
                    + REMOTE.config.branch + '，请检查 repo / repoCandidates', 'error');
            }
        }).catch(function (error) {
            addLog('error', '模型列表读取失败：' + error.message, 'error');
        });
    }

    function setSource(next) {
        source = next;
        currentModel.textContent = next.label;
        urlInput.value = /^https?:|^blob:/.test(next.url) ? next.url : '';
    }

    function useSelectedModel() {
        releaseObjectUrls();
        var option = modelSelect.selectedOptions[0];
        if (!option) { return; }
        var model = findModel(option.dataset.name) || {
            name: option.dataset.name,
            path: option.value,
            size: parseInt(option.dataset.size, 10) || 0,
            local: true
        };
        if (model.local || !REMOTE.config || REMOTE.config.mode !== 'remote') {
            setSource({
                label: model.name,
                url: './models/' + encodeURIComponent(model.name),
                format: '', mtl: '', models: ''
            });
            buildViewer();
            return;
        }
        // Resolve the fastest reachable mirror before mounting the viewer:
        // GLTFLoader only takes one src, so the fallback has to happen here.
        setStatus('连接模型源…');
        resolveModelUrl(REMOTE.config, model).then(function (chosen) {
            REMOTE.sourceId = chosen.id;
            updateSourceInfo();
            addLog('source', (chosen.id || 'raw') + ' · ' + model.name
                + (model.size ? ' · ' + humanSize(model.size) : ''));
            setSource({
                label: model.name, url: chosen.url,
                format: '', mtl: '', models: ''
            });
            buildViewer();
        });
    }

    function useUrl(rawUrl) {
        if (!rawUrl.trim()) { return; }
        releaseObjectUrls();
        var url = rawUrl.trim();
        setSource({
            label: url.split('/').pop().split('?')[0] || url,
            url: url,
            format: formatSelect.value === 'auto' ? formatFromName(url.split('?')[0]) : formatSelect.value,
            mtl: '', models: ''
        });
        buildViewer();
    }

    function useFiles(fileList) {
        var files = Array.from(fileList);
        if (!files.length) { return; }
        releaseObjectUrls();

        var models = files.filter(function (f) { return formatFromName(f.name); });
        var materials = files.filter(function (f) { return /\.mtl$/i.test(f.name); });
        if (!models.length) {
            addLog('error', '未识别的 3D 模型文件（支持 glb/gltf/fbx/obj/stl/dae）', 'error');
            return;
        }
        var urls = models.map(function (f) {
            var url = URL.createObjectURL(f);
            objectUrls.push(url);
            return url;
        });
        var mtlUrl = '';
        if (materials.length) {
            mtlUrl = URL.createObjectURL(materials[0]);
            objectUrls.push(mtlUrl);
        }
        setSource({
            label: models.map(function (f) { return f.name; }).join(' + '),
            url: urls[0],
            format: formatFromName(models[0].name),
            mtl: mtlUrl,
            models: urls.length > 1 ? urls.slice(1).join(',') : ''
        });
        formatSelect.value = formatFromName(models[0].name) || 'auto';
        addLog('file', '已选择本地文件：' + models.map(function (f) { return f.name; }).join(', '));
        buildViewer();
    }

    // ----------------------------------------------------------------- viewer
    function collectAttrs() {
        var attrs = {
            src: source.url,
            labels: LABELS
        };
        if (source.format) { attrs.format = source.format; }
        if (source.mtl) { attrs.mtl = source.mtl; }
        if (source.models) { attrs.models = source.models; }

        attrs.height = $('height').value.trim();
        attrs.fov = $('fov').value.trim();
        attrs.exposure = $('exposure').value.trim();
        attrs.speed = $('speed').value.trim();
        attrs.background = $('background').value.trim();
        attrs.camera = $('camera').value.trim();
        attrs['anim-default'] = $('animDefault').value.trim();
        attrs['outline-color'] = $('outlineColor').value.trim();
        attrs['outline-width'] = $('outlineWidth').value.trim();
        attrs['hide-parts'] = $('hideParts').value.trim();
        attrs['camera-control'] = $('cameraControl').value;
        attrs.shading = $('shading').value;
        attrs.environment = $('environment').value;
        attrs['tone-mapping'] = $('toneMapping').value;
        attrs.preload = $('preload').value;
        attrs.autorotate = $('autorotate').checked ? '1' : '0';
        attrs.grid = $('grid').checked ? '1' : '0';
        attrs.autoplay = $('autoplay').checked ? '1' : '0';
        attrs.loop = $('loop').checked ? '1' : '0';
        attrs.outline = $('outline').checked ? '1' : '0';

        Object.keys(attrs).forEach(function (key) {
            if (attrs[key] === '' || attrs[key] === null || attrs[key] === undefined) {
                delete attrs[key];
            }
        });
        return attrs;
    }

    function selectedControls() {
        return CONTROL_NAMES.filter(function (name) {
            return $('ctl-' + name).checked;
        });
    }

    function buildViewer() {
        if (!source) { return; }

        var previous = host.querySelector('.model-viewer');
        if (previous && previous.modelViewer && typeof previous.modelViewer.dispose === 'function') {
            try { previous.modelViewer.dispose(); } catch (error) { /* not mounted yet */ }
        }

        var attrs = collectAttrs();
        var controls = selectedControls();
        var container = document.createElement('div');
        container.className = 'model-viewer';
        Object.keys(attrs).forEach(function (key) {
            container.setAttribute('data-' + key, attrs[key]);
        });
        if (controls.length) {
            var row = document.createElement('div');
            row.className = 'model-viewer-controls';
            row.setAttribute('data-controls', controls.join(','));
            container.appendChild(row);
        }

        host.replaceChildren(container);
        setStatus('加载中…');
        addLog('mount', source.label + ' · ' + (attrs.format || formatFromName(source.label) || 'auto'));

        // Equivalent HTML, useful when copying this into a wiki page.
        var lines = ['<div class="model-viewer"'];
        Object.keys(attrs).forEach(function (key) {
            if (key !== 'labels') {
                lines.push('  data-' + key + '="' + escapeAttr(attrs[key]) + '"');
            }
        });
        lines[lines.length - 1] += '>';
        if (controls.length) {
            lines.push('  <div class="model-viewer-controls" data-controls="' +
                escapeAttr(controls.join(',')) + '"></div>');
        }
        lines.push('</div>');
        snippet.textContent = lines.join('\n');

        // This is the exact hook MediaWiki fires after rendering page content.
        mw.hook('wikipage.content').fire(document);
        clearDirty();
    }

    // ------------------------------------------------------------------ setup
    function buildControlChecks() {
        var box = document.getElementById('controlChecks');
        CONTROL_NAMES.forEach(function (name) {
            var label = document.createElement('label');
            var input = document.createElement('input');
            input.type = 'checkbox';
            input.id = 'ctl-' + name;
            input.checked = DEFAULT_CONTROLS.indexOf(name) !== -1;
            input.addEventListener('change', buildViewer);
            label.appendChild(input);
            label.appendChild(document.createTextNode(name));
            box.appendChild(label);
        });
    }

    function resetDefaults() {
        Object.keys(DEFAULTS).forEach(function (key) {
            var el = $(key);
            if (!el) { return; }
            if (el.type === 'checkbox') { el.checked = DEFAULTS[key]; }
            else { el.value = DEFAULTS[key]; }
        });
        CONTROL_NAMES.forEach(function (name) { $('ctl-' + name).checked = true; });
        setPresetActive('wiki');
        formatSelect.value = 'auto';
        urlInput.value = '';
        // Reset to the configured preference, else the first discovered
        // model. No hard-coded model names live in the code.
        var preferred = REMOTE.config && REMOTE.config.defaultModel;
        var match = preferred && Array.from(modelSelect.options)
            .find(function (o) { return o.dataset.name === preferred; });
        modelSelect.selectedIndex = match
            ? match.index : (modelSelect.options.length ? 0 : -1);
        useSelectedModel();
    }

    function bindDragAndDrop() {
        var depth = 0;
        viewerCard.addEventListener('dragenter', function (event) {
            event.preventDefault();
            depth++;
            viewerCard.classList.add('dragging');
        });
        viewerCard.addEventListener('dragover', function (event) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        });
        viewerCard.addEventListener('dragleave', function () {
            depth = Math.max(0, depth - 1);
            if (!depth) { viewerCard.classList.remove('dragging'); }
        });
        viewerCard.addEventListener('drop', function (event) {
            event.preventDefault();
            depth = 0;
            viewerCard.classList.remove('dragging');
            if (event.dataTransfer.files.length) {
                useFiles(event.dataTransfer.files);
            }
        });
    }

    function setPresetActive(name) {
        document.querySelectorAll('.preset-btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.preset === name);
        });
    }

    function applyLightPreset(name, silent) {
        var preset = LIGHT_PRESETS[name];
        if (!preset) { return; }
        Object.keys(preset).forEach(function (key) { $(key).value = preset[key]; });
        setPresetActive(name);
        if (silent) { return; }
        addLog('preset', '光照预设 → ' + name + '（shading=' + preset.shading +
            ', exposure=' + preset.exposure + '）');
        buildViewer();
    }

    function bindEvents() {
        modelSelect.addEventListener('change', useSelectedModel);
        document.querySelectorAll('.preset-btn').forEach(function (btn) {
            btn.addEventListener('click', function () { applyLightPreset(btn.dataset.preset); });
        });
        ['shading', 'environment', 'toneMapping', 'exposure'].forEach(function (id) {
            $(id).addEventListener('change', function () { setPresetActive(''); });
        });
        $('refreshModels').addEventListener('click', function () {
            var keep = modelSelect.selectedOptions[0]
                && modelSelect.selectedOptions[0].dataset.name;
            cacheDrop('mv.list.');
            cacheDrop('mv.src.');
            loadModelList(keep, true).then(function () {
                addLog('list', '已强制刷新：' + REMOTE.origin + ' · '
                    + REMOTE.models.length + ' 个模型');
            });
        });
        var filter = $('modelFilter');
        if (filter) {
            filter.addEventListener('input', function () { renderOptions(filter.value); });
        }
        var sourceSel = $('sourceSelect');
        if (sourceSel) {
            sourceSel.addEventListener('change', function () {
                forcedSource = sourceSel.value === 'local' ? '' : sourceSel.value;
                cacheDrop('mv.src.');
                useSelectedModel();
            });
        }
        $('fileInput').addEventListener('change', function (event) {
            useFiles(event.target.files);
            event.target.value = '';
        });
        urlInput.addEventListener('change', function () { useUrl(urlInput.value); });
        urlInput.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') { useUrl(urlInput.value); }
        });
        formatSelect.addEventListener('change', function () {
            if (source && urlInput.value) { useUrl(urlInput.value); }
            else { markDirty(); }
        });
        applyBtn.addEventListener('click', buildViewer);
        $('resetBtn').addEventListener('click', resetDefaults);

        document.querySelectorAll('.sidebar input, .sidebar select').forEach(function (el) {
            if (el === modelSelect || el === urlInput || el === formatSelect ||
                el.id === 'fileInput' || el.id === 'modelFilter' ||
                el.id === 'sourceSelect' || el.id.indexOf('ctl-') === 0) {
                return;
            }
            el.addEventListener('change', markDirty);
            el.addEventListener('input', markDirty);
        });

        ['ready', 'statusChange', 'animChange', 'modelChange'].forEach(function (name) {
            window.ModelViewerHooks.on('modelViewer.' + name, function () {
                var args = Array.prototype.slice.call(arguments);
                switch (name) {
                    case 'ready':
                        setStatus('已就绪', 'ready');
                        addLog('ready', 'viewer ready · 模型已在场景中', 'ready');
                        break;
                    case 'statusChange':
                        if (args[0] === 'none') {
                            setStatus('已就绪', 'ready');
                        } else {
                            setStatus(args[1] || '加载中…', args[0] === 'error' ? 'error' : undefined);
                            addLog('status', args[0] + ' · ' + args[1],
                                args[0] === 'error' ? 'error' : undefined);
                        }
                        break;
                    case 'animChange':
                        addLog('anim', '动画切换 → #' + args[1]);
                        break;
                    case 'modelChange':
                        addLog('model', '模型载入完成 → #' + args[1], 'ready');
                        break;
                }
            });
        });

        bindDragAndDrop();
    }

    function reportModuleState() {
        var badge = document.getElementById('moduleBadge');
        var states = window.ModelViewerHooks.moduleStates();
        var name = Object.keys(states).find(function (key) { return key.indexOf('ModelViewer') !== -1; });
        if (name && states[name] === 'ready') {
            badge.textContent = 'gadget: ' + name;
            badge.classList.add('ok');
            addLog('boot', '原版 gadget 已注册：' + name, 'ready');
        } else {
            badge.textContent = 'gadget: 未注册';
            badge.classList.add('warn');
            addLog('error', 'gadget 未注册，请检查浏览器控制台', 'error');
        }
        if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('importmap')) {
            addLog('error', '当前浏览器不支持 import maps，需要 Chrome/Edge 89+ 或 Firefox 108+', 'error');
        }
    }

    buildControlChecks();
    bindEvents();
    reportModuleState();
    addLog('boot', '页面已就绪 · Three.js r185 由公共 CDN 提供 · 模型按需跨源加载');
    // ?light=wiki|pbr|soft lets a lighting variant be linked / screenshotted
    // directly. Silent: loadModelList() is what performs the first mount.
    var lightParam = new URLSearchParams(window.location.search).get('light');
    if (lightParam && LIGHT_PRESETS[lightParam]) { applyLightPreset(lightParam, true); }

    function showCdnState(state) {
        var badge = document.getElementById('cdnBadge');
        if (badge) {
            badge.textContent = 'three.js: ' + state.label
                + (state.degraded ? '（探测失败）' : '');
            badge.classList.add(state.degraded ? 'warn' : 'ok');
            badge.title = state.base + '\n' + state.reason + '\n点击切换到下一个 CDN 源';
            badge.style.cursor = 'pointer';
            badge.addEventListener('click', function () {
                var list = window.__MV_CDN__.sources;
                var i = list.findIndex(function (s) { return s.id === state.id; });
                window.__MV_CDN__.switchTo(list[(i + 1) % list.length].id);
            });
        }
        addLog('boot', 'Three.js r185 ← ' + state.label + ' · ' + state.base
            + (state.degraded ? ' · 所有源探测失败，可能加载不出来' : ''),
            state.degraded ? 'error' : 'ready');
    }

    // The import map is installed by cdn.config.js only after a mirror has
    // been chosen. Mounting the viewer (which triggers the first import())
    // before that would freeze a wrong/absent map, so wait for `ready`.
    var cdn = window.__MV_CDN__;
    if (cdn && cdn.ready) {
        cdn.ready.then(function (state) {
            showCdnState(state);
            loadModelList();
        });
    } else {
        addLog('error', 'cdn.config.js 未加载：缺少 import map，3D 查看器无法初始化', 'error');
        loadModelList();
    }
})();
