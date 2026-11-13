/*!
 * Minimal MediaWiki host shim for the ModelViewer gadget.
 *
 * The original gadget is published as a ResourceLoader module:
 *   (function (mw) { mw.loader.impl(function () {
 *       return [ "ext.gadget.store.ModelViewer@<hash>", scriptFn, { css: [...] }, {}, {}, null ];
 *   }); })(mediaWiki);
 *
 * Locally there is no MediaWiki, so this file provides just the four things
 * the gadget actually touches: mw.loader.impl (register + inject CSS + run
 * the script), mw.loader.using (Codex styles), mw.hook (event bus) and mw.log.
 * Nothing is emulated beyond that; the viewer itself is the unmodified gadget.
 */
(function () {
    'use strict';

    /** name -> array of callbacks */
    var hooks = new Map();

    function hook(name) {
        if (!hooks.has(name)) {
            hooks.set(name, []);
        }
        var list = hooks.get(name);
        return {
            add: function () {
                for (var i = 0; i < arguments.length; i++) {
                    if (typeof arguments[i] === 'function') {
                        list.push(arguments[i]);
                    }
                }
                return this;
            },
            fire: function () {
                var args = arguments;
                list.slice().forEach(function (fn) {
                    try {
                        fn.apply(null, args);
                    } catch (error) {
                        console.error('[mw.hook:' + name + ']', error);
                    }
                });
                return this;
            },
            remove: function (fn) {
                var at = list.indexOf(fn);
                if (at !== -1) {
                    list.splice(at, 1);
                }
                return this;
            }
        };
    }

    function injectCss(moduleName, payload) {
        if (!payload) {
            return;
        }
        var chunks = Array.isArray(payload)
            ? payload
            : (Array.isArray(payload.css) ? payload.css : (typeof payload === 'string' ? [payload] : []));
        if (!chunks.length) {
            return;
        }
        var style = document.createElement('style');
        style.setAttribute('data-mw-module', moduleName || 'unknown');
        style.textContent = chunks.join('\n');
        document.head.appendChild(style);
    }

    var modules = new Map();

    function implement(factory) {
        var batch;
        try {
            batch = factory();
        } catch (error) {
            console.error('[mw.loader.impl] factory failed', error);
            return;
        }
        // A single module is a flat array; a batch of modules is keyed by name.
        var entries = (Array.isArray(batch) && typeof batch[0] === 'string')
            ? [batch]
            : Object.keys(batch || {}).map(function (k) { return batch[k]; });

        entries.forEach(function (entry) {
            if (!Array.isArray(entry)) {
                return;
            }
            var name = entry[0];
            var script = entry[1];
            injectCss(name, entry[2]);
            modules.set(name, 'ready');
            if (typeof script === 'function') {
                // The gadget's script function ignores the ResourceLoader
                // arguments ($ / jQuery / require / module) and closes over mw.
                try {
                    script();
                } catch (error) {
                    console.error('[mw.loader.impl] module ' + name + ' failed', error);
                    modules.set(name, 'error');
                }
            }
        });
    }

    var log = function () {
        console.log.apply(console, ['[ModelViewer]'].concat(Array.prototype.slice.call(arguments)));
    };
    log.warn = function () {
        console.warn.apply(console, ['[ModelViewer]'].concat(Array.prototype.slice.call(arguments)));
    };
    log.error = function () {
        console.error.apply(console, ['[ModelViewer]'].concat(Array.prototype.slice.call(arguments)));
    };

    var mw = {
        loader: {
            impl: implement,
            // 'codex-styles' is a MediaWiki-only module; the equivalent rules
            // live in codex-shim.css, so this resolves immediately.
            using: function () { return Promise.resolve(); },
            load: function () {},
            getState: function (name) { return modules.get(name) || 'unknown'; },
            getModuleNames: function () { return Array.from(modules.keys()); }
        },
        hook: hook,
        log: log,
        config: new Map(),
        message: function (key) {
            return { exists: function () { return false; }, plain: function () { return key; }, text: function () { return key; } };
        }
    };

    window.mediaWiki = mw;
    window.mw = mw;

    /** Exposed for the local UI to observe viewer lifecycle events. */
    window.ModelViewerHooks = {
        on: function (name, fn) { return hook(name).add(fn); },
        fire: function (name) {
            var args = Array.prototype.slice.call(arguments, 1);
            return hook(name).fire.apply(null, args);
        },
        moduleStates: function () { return Object.fromEntries(modules); }
    };
})();
