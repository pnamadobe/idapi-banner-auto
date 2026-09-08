/*
 * united_lib.jsx  — shared config + helpers for the United banner automation.
 *
 * Single source of truth. Both build_template.jsx and generate_variations.jsx
 * #include this file. Everything that changes when moving local -> InDesign
 * Server / cloud API lives in CONFIG or the resolver helpers (U.file / U.shot /
 * U.lockupAsset), so relocating is a one-place edit.
 */

var U = (function () {

    var CONFIG = {
        // ---- the one path to edit when relocating the project ----
        projectRoot: "/Users/pnam/Sandbox/ids-banner-auto-local",

        templateRel: "template/united-template.indd",
        csvRel:      "input/united-variations.csv",
        shotsRel:    "assets/shots",
        brandRel:    "assets/brand",
        outputRel:   "output",

        exportPPI:   72,   // 72 = native pixel dims. 144 = @2x.

        // ---- output options (each overridable per-run via $.global; see run_local.sh) ----
        exportFormat: "jpg",       // "png" | "jpg" | "both"   ($.global.UNITED_FORMAT)
        jpegQuality:  "MAXIMUM",   // LOW | MEDIUM | HIGH | MAXIMUM (JPEG only)
        writeIndd:    true,        // also save an editable .indd per row, next to the images ($.global.UNITED_WRITE_INDD=0 to skip)

        cols: { file: "outputFileName", hero: "hero", city: "city", header: "header" }
    };

    // The reusable United lockup (pill + globe + wordmark) is one asset placed
    // per page. Its intrinsic aspect (w/h) — used to size the lockup frame.
    var LOCKUP_ASPECT = 5.8125;

    // All 10 banner sizes. Geometry in px (top-left origin); font size/leading in pt.
    // lockup {x,y,w}: bottom-left-anchored art; frame height derived from LOCKUP_ASPECT.
    var PAGES = [
        { name: "WEB_LEADERBOARD_1000x320", w: 1000, h: 320,
          header: { x: 51, y: 44, w: 330, h: 80, size: 36, leading: 36 },
          city:   { x: 55, y: 150, w: 320, h: 20, size: 13, leading: 16 },
          lockup: { x: 53, y: 212, w: 344 } },

        { name: "WEB_HP_SLIDER_1440x500", w: 1440, h: 500,
          header: { x: 70, y: 64, w: 760, h: 150, size: 56, leading: 56 },
          city:   { x: 74, y: 210, w: 600, h: 28, size: 20, leading: 24 },
          lockup: { x: 70, y: 360, w: 500 } },

        { name: "WEB_BRAND_PAGE_BANNER_2880x900", w: 2880, h: 900,
          header: { x: 140, y: 110, w: 1700, h: 320, size: 110, leading: 110 },
          city:   { x: 148, y: 404, w: 1200, h: 56, size: 40, leading: 48 },
          lockup: { x: 140, y: 660, w: 900 } },

        { name: "WEB_BILLBOARD_970x250", w: 970, h: 250,
          header: { x: 50, y: 34, w: 640, h: 110, size: 30, leading: 30 },
          city:   { x: 53, y: 120, w: 500, h: 18, size: 12, leading: 15 },
          lockup: { x: 50, y: 174, w: 330 } },

        { name: "WEB_MED_RECTANGLE_300x250", w: 300, h: 250,
          header: { x: 20, y: 20, w: 265, h: 80, size: 22, leading: 22 },
          city:   { x: 22, y: 96, w: 255, h: 14, size: 11, leading: 13 },
          lockup: { x: 20, y: 196, w: 200 } },

        { name: "WEB_HALF_PAGE_300x600", w: 300, h: 600,
          header: { x: 24, y: 26, w: 255, h: 140, size: 28, leading: 28 },
          city:   { x: 26, y: 150, w: 255, h: 18, size: 14, leading: 16 },
          lockup: { x: 24, y: 520, w: 230 } },

        { name: "MOBILE_WINDOW_750x259", w: 750, h: 259,
          header: { x: 44, y: 32, w: 520, h: 100, size: 30, leading: 30 },
          city:   { x: 47, y: 116, w: 400, h: 16, size: 12, leading: 15 },
          lockup: { x: 44, y: 184, w: 300 } },

        { name: "APP_CARD_890x1335", w: 890, h: 1335,
          header: { x: 114, y: 56, w: 540, h: 150, size: 60, leading: 60 },
          city:   { x: 120, y: 243, w: 420, h: 34, size: 24, leading: 28 },
          lockup: { x: 170, y: 1178, w: 550 } },

        { name: "SOCIAL_FEED_1080x1080", w: 1080, h: 1080,
          header: { x: 208, y: 46, w: 620, h: 170, size: 72, leading: 72 },
          city:   { x: 213, y: 240, w: 420, h: 34, size: 24, leading: 28 },
          lockup: { x: 216, y: 918, w: 654 } },

        { name: "SOCIAL_STORY_1080x1920", w: 1080, h: 1920,
          header: { x: 110, y: 120, w: 640, h: 220, size: 76, leading: 76 },
          city:   { x: 116, y: 346, w: 520, h: 36, size: 26, leading: 30 },
          lockup: { x: 110, y: 1740, w: 680 } }
    ];

    var FONTS = {
        header: { family: "Source Sans 3", style: "Bold" },
        city:   { family: "Source Sans 3", style: "Medium" }
    };

    var DEFAULTS = {
        header: "HEADLINE LINE ONE,\nHEADLINE LINE TWO.",
        city:   "City, Region",
        hero:   "square/aurora-borealis-sq.jpg"
    };

    function trim(s) { return String(s).replace(/^\s+|\s+$/g, ""); }

    // Resolve the project root for BOTH local desktop and cloud (InDesign API):
    //   1) explicit override the orchestrator may set before running
    //   2) local desktop — the configured absolute path exists
    //   3) cloud/relocated — derive from this script's own location (…/scripts/<file>)
    //   4) last resort — current working directory
    function computeRoot() {
        try { if ($.global.UNITED_PROJECT_ROOT) return String($.global.UNITED_PROJECT_ROOT); } catch (e) {}
        try { if (new Folder(CONFIG.projectRoot).exists) return CONFIG.projectRoot; } catch (e) {}
        try {
            var self = new File($.fileName);
            if (self && self.parent && self.parent.parent) return self.parent.parent.fsName;
        } catch (e) {}
        return (Folder.current ? Folder.current.fsName : CONFIG.projectRoot);
    }
    var ROOT = computeRoot();

    function file(rel)  { return new File(ROOT + "/" + rel); }
    function shot(name) {
        // Forgiving: accept "name.jpg" or "square/name.jpg" — try shots/ then shots/square/.
        var primary = new File(ROOT + "/" + CONFIG.shotsRel + "/" + name);
        if (primary.exists) return primary;
        var sq = new File(ROOT + "/" + CONFIG.shotsRel + "/square/" + name);
        return sq.exists ? sq : primary; // else primary (non-existent) so caller reports "missing"
    }
    function lockupAsset() { return new File(ROOT + "/" + CONFIG.brandRel + "/united-lockup.png"); }
    function outFile(name) { return new File(ROOT + "/" + CONFIG.outputRel + "/" + name); }

    function readText(f) { f.encoding = "UTF-8"; f.open("r"); var s = f.read(); f.close(); return s; }

    // CSV line-break conventions -> InDesign forced line breaks ("\n").
    // Handles literal backslash-n AND real embedded newlines; trims each line.
    function normalizeBreaks(s) {
        s = String(s).replace(/\\n/g, "\n").replace(/\r\n?/g, "\n");
        var parts = s.split("\n");
        for (var i = 0; i < parts.length; i++) parts[i] = trim(parts[i]);
        return parts.join("\n");
    }

    // Minimal RFC-4180-ish CSV parser: quoted fields, escaped "" quotes,
    // embedded commas and newlines inside quotes. Returns {header, rows[obj]}.
    function parseCSV(text) {
        var rows = [], row = [], field = "", inQ = false, i = 0, c;
        function pushField() { row.push(field); field = ""; }
        function pushRow() { pushField(); rows.push(row); row = []; }
        while (i < text.length) {
            c = text.charAt(i);
            if (inQ) {
                if (c === '"') {
                    if (text.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
                    inQ = false; i++; continue;
                }
                field += c; i++; continue;
            } else {
                if (c === '"') { inQ = true; i++; continue; }
                if (c === ',') { pushField(); i++; continue; }
                if (c === '\r') { if (text.charAt(i + 1) === '\n') i++; pushRow(); i++; continue; }
                if (c === '\n') { pushRow(); i++; continue; }
                field += c; i++; continue;
            }
        }
        if (field !== "" || row.length > 0) pushRow();
        var header = rows.shift() || [];
        for (var h = 0; h < header.length; h++) header[h] = trim(header[h]);
        var out = [];
        for (var r = 0; r < rows.length; r++) {
            if (rows[r].length === 1 && rows[r][0] === "") continue;
            var obj = {};
            for (var k = 0; k < header.length; k++) obj[header[k]] = (k < rows[r].length) ? rows[r][k] : "";
            out.push(obj);
        }
        return { header: header, rows: out };
    }

    // First page item on `container` whose Script Label matches (analog of PSD layer names).
    function findByLabel(container, label) {
        var items = container.allPageItems;
        for (var i = 0; i < items.length; i++) {
            try { if (items[i].label === label) return items[i]; } catch (e) {}
        }
        return null;
    }

    return {
        CONFIG: CONFIG, PAGES: PAGES, FONTS: FONTS, DEFAULTS: DEFAULTS, LOCKUP_ASPECT: LOCKUP_ASPECT, root: ROOT,
        trim: trim, file: file, shot: shot, lockupAsset: lockupAsset, outFile: outFile,
        readText: readText, normalizeBreaks: normalizeBreaks, parseCSV: parseCSV, findByLabel: findByLabel
    };
})();
