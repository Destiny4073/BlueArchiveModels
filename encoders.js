/*!
 * ModelViewer local — self-contained media encoders.
 *
 * Two independent pieces, neither needs the DOM:
 *   buildMP4()  — wraps WebCodecs H.264 (AVCC) chunks in a minimal ISO BMFF
 *                 file: ftyp + moov + mdat, one chunk holding all samples.
 *   createGIF() — GIF89a writer with a global adaptive palette, LZW and a
 *                 NETSCAPE2.0 loop extension (default: infinite loop).
 *                 Pass loop:false to omit it, or loop:n for n repeats.
 *
 * Exposed as window.ModelViewerEncoders in the browser and as a CommonJS
 * module in Node so the byte-level output can be checked with ffprobe.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    root.ModelViewerEncoders = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
    'use strict';

    // ------------------------------------------------------------- byte helpers
    function bytes(list) { return new Uint8Array(list); }
    function u16(v) { return bytes([(v >>> 8) & 255, v & 255]); }
    function u32(v) {
        return bytes([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
    }
    function i16(v) { return u16(v & 0xffff); }
    function ascii(s) {
        var out = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) { out[i] = s.charCodeAt(i) & 255; }
        return out;
    }
    function join(parts) {
        var size = 0, i;
        for (i = 0; i < parts.length; i++) { size += parts[i].length; }
        var out = new Uint8Array(size), at = 0;
        for (i = 0; i < parts.length; i++) {
            out.set(parts[i], at);
            at += parts[i].length;
        }
        return out;
    }
    /** ISO BMFF box: big-endian size, 4-char type, then payload. */
    function box(type, parts) {
        var size = 8, i;
        for (i = 0; i < parts.length; i++) { size += parts[i].length; }
        var out = new Uint8Array(size);
        var view = new DataView(out.buffer);
        view.setUint32(0, size);
        for (i = 0; i < 4; i++) { out[4 + i] = type.charCodeAt(i) & 255; }
        var at = 8;
        for (i = 0; i < parts.length; i++) {
            out.set(parts[i], at);
            at += parts[i].length;
        }
        return out;
    }

    var UNITY_MATRIX = [
        u32(0x00010000), u32(0), u32(0),
        u32(0), u32(0x00010000), u32(0),
        u32(0), u32(0), u32(0x40000000)
    ];
    var ZERO16 = bytes([0, 0, 0, 0, 0, 0, 0, 0]);

    // ------------------------------------------------------------------- MP4
    /**
     * @param {object} o
     * @param {number} o.width @param {number} o.height
     * @param {Array<{data:Uint8Array,duration?:number,type?:string}>} o.frames
     *        H.264 access units in AVCC (length-prefixed NAL) form, in decode order.
     * @param {Uint8Array} o.avcC  AVCDecoderConfigurationRecord (SPS/PPS).
     * @param {number} [o.timescale=1000000] media timescale (microseconds).
     */
    function buildMP4(o) {
        var frames = o.frames;
        if (!frames || !frames.length) { throw new Error('buildMP4: no frames'); }
        if (!o.avcC || !o.avcC.length) { throw new Error('buildMP4: missing avcC (SPS/PPS)'); }

        var timescale = o.timescale || 1000000;
        var delta = frames[0].duration || Math.round(timescale / (o.fps || 30));
        var duration = 0, i;
        for (i = 0; i < frames.length; i++) { duration += frames[i].duration || delta; }
        var durationMs = Math.round(duration * 1000 / timescale);
        var width = o.width | 0, height = o.height | 0;

        var ftyp = box('ftyp', [
            ascii('isom'), u32(0x200),
            ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41')
        ]);

        var sizeTable = new Uint8Array(frames.length * 4);
        var sizeView = new DataView(sizeTable.buffer);
        var syncSamples = [];
        for (i = 0; i < frames.length; i++) {
            sizeView.setUint32(i * 4, frames[i].data.length);
            if (frames[i].type === 'key') { syncSamples.push(i + 1); }
        }

        var avc1 = box('avc1', [
            join([
                bytes([0, 0, 0, 0, 0, 0]), u16(1),      // reserved + data_reference_index
                u16(0), u16(0),                          // pre_defined, reserved
                u32(0), u32(0), u32(0),                  // pre_defined
                u16(width), u16(height),
                u32(0x00480000), u32(0x00480000),        // 72 dpi
                u32(0),
                u16(1),                                  // frame_count
                new Uint8Array(32),                      // compressorname
                u16(0x0018),                             // depth 24
                i16(-1)
            ]),
            box('avcC', [o.avcC])
        ]);

        var stsd = box('stsd', [u32(0), u32(1), avc1]);
        var stts = box('stts', [u32(0), u32(1), u32(frames.length), u32(delta)]);
        // One chunk contains every sample, so stco needs a single offset.
        var stsc = box('stsc', [u32(0), u32(1), u32(1), u32(frames.length), u32(1)]);
        var stsz = box('stsz', [u32(0), u32(0), u32(frames.length), sizeTable]);

        var stssParts = [u32(0), u32(syncSamples.length)];
        for (i = 0; i < syncSamples.length; i++) { stssParts.push(u32(syncSamples[i])); }

        function buildMoov(chunkOffset) {
            var stco = box('stco', [u32(0), u32(1), u32(chunkOffset)]);
            var stblParts = [stsd, stts, stsc, stsz, stco];
            // Only meaningful when the encoder marked at least one key frame.
            if (syncSamples.length) { stblParts.push(box('stss', stssParts)); }
            var stbl = box('stbl', stblParts);

            var vmhd = box('vmhd', [
                u32(1), u16(0), u16(0), u16(0), u16(0)
            ]);
            var dref = box('dref', [u32(0), u32(1), box('url ', [u32(1)])]);
            var dinf = box('dinf', [dref]);
            var minf = box('minf', [vmhd, dinf, stbl]);

            var mdhd = box('mdhd', [
                u32(0), u32(0), u32(0), u32(timescale), u32(duration),
                u16(0x55c4), u16(0)                      // language 'und'
            ]);
            var hdlr = box('hdlr', [
                u32(0), u32(0), ascii('vide'),
                u32(0), u32(0), u32(0), ascii('VideoHandler\0')
            ]);
            var mdia = box('mdia', [mdhd, hdlr, minf]);

            var tkhd = box('tkhd', [
                u32(0x00000007),                          // v0, enabled|in movie|in preview
                u32(0), u32(0), u32(1), u32(0), u32(durationMs),
                ZERO16,                                   // reserved
                u16(0), u16(0), u16(0), u16(0),          // layer, alt group, volume, reserved
                join(UNITY_MATRIX),
                u32(width << 16), u32(height << 16)      // 16.16 fixed point
            ]);
            var trak = box('trak', [tkhd, mdia]);

            var mvhd = box('mvhd', [
                u32(0), u32(0), u32(0), u32(1000), u32(durationMs),
                u32(0x00010000), u16(0x0100), u16(0),
                ZERO16,
                join(UNITY_MATRIX),
                u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
                u32(2)                                    // next_track_ID
            ]);
            return box('moov', [mvhd, trak]);
        }

        // moov's length is independent of the offset value (a fixed u32), so a
        // first pass measures it and a second pass fills in the real position.
        var moov = buildMoov(0);
        var offset = ftyp.length + moov.length + 8;   // + mdat header
        moov = buildMoov(offset);

        var mdatParts = [];
        for (i = 0; i < frames.length; i++) { mdatParts.push(frames[i].data); }
        return join([ftyp, moov, box('mdat', mdatParts)]);
    }

    // ------------------------------------------------------------------- GIF
    /** GIF delays are centiseconds, so frame rates above 50 get rounded. */
    function delayForFps(fps) { return Math.max(2, Math.round(100 / fps)); }

    /** Median-cut a 5-5-5 histogram into at most `max` palette boxes. */
    function medianCut(entries, max) {
        if (!entries.length) { return [{ items: [] }]; }
        var boxes = [{ items: entries.slice() }];
        while (boxes.length < max) {
            var best = -1, bestScore = 0, bestAxis = 0, i, j;
            for (i = 0; i < boxes.length; i++) {
                var items = boxes[i].items;
                if (items.length < 2) { continue; }
                var lo = [255, 255, 255], hi = [0, 0, 0], total = 0;
                for (j = 0; j < items.length; j++) {
                    var e = items[j], rgb = [e.r, e.g, e.b];
                    for (var c = 0; c < 3; c++) {
                        if (rgb[c] < lo[c]) { lo[c] = rgb[c]; }
                        if (rgb[c] > hi[c]) { hi[c] = rgb[c]; }
                    }
                    total += e.count;
                }
                var spread = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
                var axis = spread[0] >= spread[1] && spread[0] >= spread[2]
                    ? 0 : (spread[1] >= spread[2] ? 1 : 2);
                var score = spread[axis] * Math.log(1 + total);
                if (score > bestScore) { bestScore = score; best = i; bestAxis = axis; }
            }
            if (best < 0 || bestScore <= 0) { break; }

            var list = boxes[best].items;
            var key = ['r', 'g', 'b'][bestAxis];
            list.sort(function (a, b) { return a[key] - b[key]; });
            var sum = 0;
            for (j = 0; j < list.length; j++) { sum += list[j].count; }
            var acc = 0, cut = 0;
            while (cut < list.length - 1 && acc < sum / 2) {
                acc += list[cut].count;
                cut++;
            }
            if (cut < 1) { cut = 1; }
            boxes.splice(best, 1,
                { items: list.slice(0, cut) }, { items: list.slice(cut) });
        }
        return boxes;
    }

    /**
     * GIF LZW, LSB-first bit packing. GIF decoders use "early change": the
     * code width grows one code *after* the dictionary reaches 2^width, checked
     * at the end of each output() rather than when a dictionary entry is added.
     * Getting this one step wrong makes every frame fail to decode.
     */
    function lzw(indices, minCodeSize) {
        var clear = 1 << minCodeSize;          // 256
        var eoi = clear + 1;                   // 257
        var initBits = minCodeSize + 1;        // 9
        var nBits = initBits;
        var maxCode = (1 << nBits) - 1;        // 511
        var freeEnt = eoi + 1;                 // 258
        var clearFlag = false;
        var dict = new Map();
        var out = [], buf = 0, bits = 0;

        function output(code) {
            buf |= code << bits;
            bits += nBits;
            while (bits >= 8) {
                out.push(buf & 0xff);
                buf >>>= 8;
                bits -= 8;
            }
            if (freeEnt > maxCode || clearFlag) {
                if (clearFlag) {
                    nBits = initBits;
                    maxCode = (1 << nBits) - 1;
                    clearFlag = false;
                } else {
                    nBits++;
                    maxCode = nBits === 12 ? 4096 : (1 << nBits) - 1;
                }
            }
        }
        function clearBlock() {
            dict = new Map();
            freeEnt = eoi + 1;
            clearFlag = true;
            output(clear);
        }

        output(clear);
        var ent = indices[0];
        for (var i = 1; i < indices.length; i++) {
            var c = indices[i];
            var key = (ent << 8) | c;
            var found = dict.get(key);
            if (found !== undefined) { ent = found; continue; }
            output(ent);
            ent = c;
            if (freeEnt < 4096) {
                dict.set(key, freeEnt++);
            } else {
                clearBlock();
            }
        }
        output(ent);
        output(eoi);
        if (bits > 0) { out.push(buf & 0xff); }
        return Uint8Array.from(out);
    }

    /**
     * Accumulate RGBA frames, then emit a single-pass GIF89a with one shared
     * 256-colour palette. Frames are kept as 5-5-5 bin indices (2 bytes/px),
     * which is a quarter of the RGBA footprint for long clips.
     *
     * `o.loop`: undefined / true / 0 -> NETSCAPE2.0 with count 0 (infinite);
     * a positive integer -> that many repeats; false / null / 'none' -> omit
     * the extension entirely (the GIF then plays once).
     *
     * @returns {{addFrame:function(Uint8Array):void, finish:function():Uint8Array}}
     */
    function createGIF(o) {
        var width = o.width | 0, height = o.height | 0;
        var delayCs = o.delayCs || delayForFps(o.fps || 20);
        var hist = new Uint32Array(32768);
        var stored = [];
        var hasTransparent = !!o.transparent;
        var TRANSPARENT = 0xffff;
        var loopCount = 0;                          // 0 = loop forever
        if (o.loop === false || o.loop === null || o.loop === 'none') {
            loopCount = null;                       // omit the extension
        } else if (o.loop !== undefined && o.loop !== true) {
            var n = parseInt(o.loop, 10);
            loopCount = isFinite(n) ? Math.max(0, Math.min(65535, n)) : 0;
        }

        function addFrame(rgba) {
            var count = width * height;
            var packed = new Uint16Array(count);
            for (var i = 0; i < count; i++) {
                var at = i * 4;
                if (rgba[at + 3] < 128) {
                    packed[i] = TRANSPARENT;
                    hasTransparent = true;
                    continue;
                }
                var r = rgba[at], g = rgba[at + 1], b = rgba[at + 2];
                var bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
                packed[i] = bin;
                hist[bin]++;
            }
            stored.push(packed);
        }

        function finish() {
            if (!stored.length) { throw new Error('createGIF: no frames'); }
            var entries = [], bin;
            for (bin = 0; bin < 32768; bin++) {
                if (!hist[bin]) { continue; }
                entries.push({
                    bin: bin,
                    count: hist[bin],
                    r: ((bin >> 10) & 31) * 8 + 4,
                    g: ((bin >> 5) & 31) * 8 + 4,
                    b: (bin & 31) * 8 + 4
                });
            }
            // Index 255 is reserved for transparency, so shades are capped at 255.
            var maxColors = hasTransparent ? 255 : 256;
            var palette = new Uint8Array(256 * 3);
            var binToIndex = new Uint8Array(32768);
            var used = 0, i, k;

            // Popularity first: flat cel-shaded areas (skin, hair, white cloth)
            // cover most pixels and must be exact, or they turn into speckles.
            var sorted = entries.slice().sort(function (a, b) { return b.count - a.count; });
            var exact = Math.min(Math.floor(maxColors * 0.6), sorted.length);
            for (i = 0; i < exact; i++) {
                var hot = sorted[i];
                palette[used * 3] = hot.r;
                palette[used * 3 + 1] = hot.g;
                palette[used * 3 + 2] = hot.b;
                binToIndex[hot.bin] = used;
                used++;
            }
            // Median-cut the long tail (anti-aliased edges, gradients) into
            // whatever slots remain.
            var boxes = medianCut(sorted.slice(exact), Math.max(1, maxColors - used));
            for (var bi = 0; bi < boxes.length && used < maxColors; bi++) {
                var items = boxes[bi].items;
                var sr = 0, sg = 0, sb = 0, total = 0;
                for (k = 0; k < items.length; k++) {
                    var e = items[k];
                    sr += e.r * e.count; sg += e.g * e.count; sb += e.b * e.count;
                    total += e.count;
                }
                if (!total) { continue; }
                palette[used * 3] = Math.round(sr / total);
                palette[used * 3 + 1] = Math.round(sg / total);
                palette[used * 3 + 2] = Math.round(sb / total);
                for (k = 0; k < items.length; k++) {
                    binToIndex[items[k].bin] = used;
                }
                used++;
            }

            var parts = [ascii('GIF89a')];
            var lsd = bytes([
                width & 255, (width >> 8) & 255,
                height & 255, (height >> 8) & 255,
                0xf7,                                  // GCT, 8-bit, 256 entries
                hasTransparent ? 255 : 0,            // background colour index
                0                                    // pixel aspect ratio
            ]);
            parts.push(lsd, palette);
            // NETSCAPE2.0 application extension. Count 0 means "loop forever";
            // without this block most players show the GIF exactly once.
            if (loopCount !== null) {
                parts.push(
                    bytes([0x21, 0xff, 0x0b]), ascii('NETSCAPE2.0'),
                    bytes([0x03, 0x01,
                        loopCount & 255, (loopCount >> 8) & 255, 0x00])
                );
            }

            for (var f = 0; f < stored.length; f++) {
                var packed = stored[f];
                var indices = new Uint8Array(width * height);
                for (var p = 0; p < indices.length; p++) {
                    var v = packed[p];
                    indices[p] = v === TRANSPARENT ? 255 : binToIndex[v];
                }
                var gce = bytes([
                    0x21, 0xf9, 0x04,
                    0x08 | (hasTransparent ? 1 : 0),   // disposal=2, transparency
                    delayCs & 255, (delayCs >> 8) & 255,
                    hasTransparent ? 255 : 0,
                    0x00
                ]);
                parts.push(gce);
                var descriptor = bytes([
                    0x2c, 0, 0, 0, 0,
                    width & 255, (width >> 8) & 255,
                    height & 255, (height >> 8) & 255,
                    0
                ]);
                parts.push(descriptor, bytes([8]));   // LZW minimum code size
                var codes = lzw(indices, 8);
                for (var at = 0; at < codes.length; at += 255) {
                    var n = Math.min(255, codes.length - at);
                    parts.push(bytes([n]), codes.subarray(at, at + n));
                }
                parts.push(bytes([0]));               // block terminator
            }
            parts.push(bytes([0x3b]));               // trailer
            return join(parts);
        }

        return {
            addFrame: addFrame,
            finish: finish,
            get frameCount() { return stored.length; },
            get transparent() { return hasTransparent; },
            get loopCount() { return loopCount; }
        };
    }

    return {
        buildMP4: buildMP4,
        createGIF: createGIF,
        delayForFps: delayForFps,
        _lzw: lzw,
        _medianCut: medianCut
    };
});
