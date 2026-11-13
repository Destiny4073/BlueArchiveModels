/*!
 * Public-CDN loader for Three.js r185 (ModelViewer).
 *
 * The ~9.4 MB vendor/three/ tree is intentionally NOT shipped. The original
 * Miraheze gadget already expects three from a CDN; this file just picks a
 * healthy, fast public mirror and installs the import map *before* any module
 * is resolved. It is a classic (non-module) script in <head>, so it runs
 * synchronously; app.js waits on __MV_CDN__.ready before mounting the viewer.
 *
 * Why not ghproxy / raw.githubusercontent.com for these files?
 *   Those return `Content-Type: text/plain`. Browsers apply strict MIME
 *   checking to ES modules and REFUSE to execute them. Model binaries (.glb)
 *   are fetched as ArrayBuffer and are unaffected, which is why ghproxy is
 *   fine for models but NOT for three.module.js / addons / decoder scripts.
 *   jsDelivr (+ its mirrors) and unpkg send application/javascript + CORS.
 *
 * All URLs are version-pinned to three@0.185.1 to match the gadget's API.
 */
(function () {
    'use strict';

    var VERSION = 'three@0.185.1';
    var PROBE = 'package.json';           // tiny file present in the npm package
    var PROBE_TIMEOUT = 2600;
    var CACHE_KEY = 'modelviewer.cdn.v1';
    var CACHE_TTL = 7 * 24 * 3600 * 1000;

    var DEFAULT_SOURCES = [
        { id: 'jsdmirror', label: 'jsDelivr 国内镜像', base: 'https://cdn.jsdmirror.com/npm/' + VERSION + '/' },
        { id: 'onmicrosoft', label: 'jsDelivr 镜像 2', base: 'https://jsd.onmicrosoft.cn/npm/' + VERSION + '/' },
        { id: 'fastly', label: 'jsDelivr Fastly', base: 'https://fastly.jsdelivr.net/npm/' + VERSION + '/' },
        { id: 'jsdelivr', label: 'jsDelivr 官方', base: 'https://cdn.jsdelivr.net/npm/' + VERSION + '/' },
        { id: 'gcore', label: 'jsDelivr Gcore', base: 'https://gcore.jsdelivr.net/npm/' + VERSION + '/' },
        { id: 'unpkg', label: 'unpkg', base: 'https://unpkg.com/' + VERSION + '/' }
    ];
    // Optional override for self-hosted mirrors / automated tests. Define
    // window.__MV_CDN_SOURCES__ = [{id,label,base}, ...] BEFORE this script.
    var SOURCES = (Array.isArray(window.__MV_CDN_SOURCES__)
        && window.__MV_CDN_SOURCES__.length)
        ? window.__MV_CDN_SOURCES__ : DEFAULT_SOURCES;

    // Offline escape hatch: keep vendor/three/ on your own machine, then open
    // ?cdn=local. This source is never probed automatically (it is not public).
    var LOCAL = {
        id: 'local', label: '本地 vendor/three（离线）',
        base: new URL('./vendor/three/', document.baseURI).href
    };

    var ALL = SOURCES.concat([LOCAL]);
    var state = {
        id: SOURCES[0].id, label: SOURCES[0].label, base: SOURCES[0].base,
        degraded: false, probed: false, reason: ''
    };

    function find(id) {
        for (var i = 0; i < ALL.length; i++) { if (ALL[i].id === id) { return ALL[i]; } }
        return null;
    }

    function readCache() {
        try {
            var v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
            if (v && v.id && Date.now() - v.t < CACHE_TTL && find(v.id)) { return v.id; }
        } catch (e) { /* storage disabled / private mode */ }
        return null;
    }

    function writeCache(id) {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ id: id, t: Date.now() })); }
        catch (e) { /* ignore */ }
    }

    /** Resolve with the first source that answers a small CORS request. */
    function probe(source, timeoutMs) {
        return new Promise(function (resolve) {
            var controller = typeof AbortController !== 'undefined'
                ? new AbortController() : null;
            var timer = setTimeout(function () {
                if (controller) { controller.abort(); }
                resolve(false);
            }, timeoutMs);
            var opts = { cache: 'no-store', mode: 'cors' };
            if (controller) { opts.signal = controller.signal; }
            fetch(source.base + PROBE, opts).then(function (res) {
                clearTimeout(timer);
                var type = res.headers.get('content-type') || '';
                // A captive portal / error page can answer 200 with HTML.
                resolve(res.ok && type.indexOf('text/html') === -1);
            }, function () {
                clearTimeout(timer);
                resolve(false);
            });
        });
    }

    /** Race every mirror; first healthy response wins (fastest mirror). */
    function race(order, timeoutMs) {
        return new Promise(function (resolve) {
            var settled = false;
            var remaining = order.length;
            var overall = setTimeout(function () {
                if (!settled) { settled = true; resolve(null); }
            }, timeoutMs + 250);
            if (!remaining) { clearTimeout(overall); resolve(null); return; }
            order.forEach(function (source) {
                probe(source, timeoutMs).then(function (ok) {
                    if (ok && !settled) {
                        settled = true; clearTimeout(overall); resolve(source);
                    }
                    if (--remaining === 0 && !settled) {
                        settled = true; clearTimeout(overall); resolve(null);
                    }
                });
            });
        });
    }

    function installMap(base) {
        var map = document.createElement('script');
        map.type = 'importmap';
        map.id = 'model-viewer-importmap';
        map.textContent = JSON.stringify({
            imports: {
                three: base + 'build/three.module.min.js',
                'three/addons/': base + 'examples/jsm/'
            }
        });
        // Safe: this runs in <head>, before any module has been resolved.
        (document.head || document.documentElement).appendChild(map);
        window.__MV_CDN_BASE__ = base;
        // Reflect the *chosen* source, not the pre-probe default.
        document.documentElement.setAttribute('data-mv-cdn', state.id);
    }

    var forcedId = new URLSearchParams(location.search).get('cdn');
    var forced = forcedId ? find(forcedId) : null;

    var ready = (function () {
        if (forced) {
            state.id = forced.id; state.label = forced.label; state.base = forced.base;
            state.reason = forced.id === 'local'
                ? '?cdn=local（本地离线副本）' : '?cdn=' + forced.id + '（手动指定）';
            installMap(state.base);
            return Promise.resolve(state);
        }
        // A previously healthy mirror goes first, but every mirror is still
        // raced so a dead cached entry cannot break the page.
        var cached = readCache();
        var order = SOURCES.slice();
        if (cached) {
            order.sort(function (a, b) { return (a.id === cached ? -1 : b.id === cached ? 1 : 0); });
        }
        return race(order, PROBE_TIMEOUT).then(function (winner) {
            if (winner) {
                state.id = winner.id; state.label = winner.label; state.base = winner.base;
                state.reason = '自动探测最快可用源';
                writeCache(winner.id);
            } else {
                state.degraded = true;
                state.reason = '所有公共 CDN 探测均失败，回退默认源；可用 ?cdn= 手动指定';
            }
            state.probed = true;
            installMap(state.base);
            return state;
        });
    })();

    window.__MV_CDN__ = {
        version: VERSION,
        sources: ALL,
        state: state,
        ready: ready,
        /** Open the same page pinned to a specific source. */
        switchTo: function (id) {
            var url = new URL(location.href);
            if (id) { url.searchParams.set('cdn', id); }
            else { url.searchParams.delete('cdn'); }
            location.href = url.href;
        }
    };
    document.documentElement.setAttribute('data-mv-cdn', state.id);
})();
