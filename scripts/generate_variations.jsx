/*
 * generate_variations.jsx — the exporter. Opens the template, then for every
 * CSV row swaps labeled image/text frames and exports one PNG per (size x row),
 * named <ARTBOARD>_<outputFileName>.png. Every CSV header except the reserved
 * outputFileName column is also the Script Label of the frame it populates.
 *
 * Frames are located by Script Label matching the CSV headers — the direct
 * analog of your PSD layer names. The template file is never modified on disk.
 *
 * Advanced-text handling on show here:
 *   - forced line breaks normalized from CSV ("\n" or real newlines)
 *   - paragraph styles re-applied so type stays on-brand after content swap
 *   - overset (text-too-long) detection reported per output — the thing
 *     Photoshop silently gets wrong.
 *
 * Run:  osascript -> do script (POSIX file ".../generate_variations.jsx") language javascript
 */

// @include "brand_lib.jsx"

(function () {
    var log = [], warn = [], written = 0, inddWritten = 0, pdfWritten = 0, outFiles = [], linkMaps = [];
    // InDesign API return contract: the capability must return a JSON *string*;
    // outputs are declared as workingFolder-relative paths in assetsToBeUploaded.
    // Escape for JSON: backslash + quote AND control chars. InDesign Font.name is
    // "Family\tStyle" (embedded TAB) — a raw tab/newline is illegal inside a JSON
    // string and makes the whole dataURL (result.json) unparseable, so escape them.
    function jesc(s){ return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n") + '"'; }
    function successPkg(files, dataUrl){
        var a = [];
        for (var i = 0; i < files.length; i++) a.push('{"path":' + jesc(files[i]) + '}');
        var s = '{"status":"SUCCESS","assetsToBeUploaded":[' + a.join(",") + ']';
        if (dataUrl) s += ',"dataURL":' + jesc(dataUrl);
        return s + '}';
    }
    function failurePkg(msg){ return '{"status":"FAILURE","errorString":' + jesc(msg) + '}'; }
    var doc = null, oldUnit, oldUIL;
    try {
        oldUnit = app.scriptPreferences.measurementUnit;
        app.scriptPreferences.measurementUnit = MeasurementUnits.PIXELS;
        // userInteractionLevel isn't supported on the InDesign API server (already
        // non-interactive there); guard it so desktop still suppresses dialogs.
        try {
            oldUIL = app.scriptPreferences.userInteractionLevel;
            app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
        } catch (e) {}

        var tpl = U.file(U.CONFIG.templateRel);
        try { if ($.global.BRAND_TEMPLATE) { var otpl = new File(String($.global.BRAND_TEMPLATE)); if (otpl.exists) tpl = otpl; } } catch (e) {}
        if (!tpl.exists) return failurePkg("template not found: " + tpl.fsName + " (root=" + U.root + ")");
        doc = app.open(tpl); // server has no window arg; we never save the template

        // Relink any link that points at a path this machine doesn't have (e.g. the
        // brand lockup placed from a designer's local drive) to the staged copy of the
        // same filename: assets/shots/<name>, else assets/brand/<name>. Swapped heroes
        // are relinked again per CSV row; this only guarantees static art resolves.
        var relinked = 0, missingLinks = []; // missingLinks: {name, label} still unresolved, for the preflight gate
        try {
            for (var mi = 0; mi < doc.links.length; mi++) {
                var ml = doc.links[mi];
                if (ml.status !== LinkStatus.LINK_MISSING) continue;
                var cand = U.shot(ml.name);
                if (!cand.exists) cand = new File(U.root + "/" + U.CONFIG.brandRel + "/" + ml.name);
                if (cand.exists) { ml.relink(cand); relinked++; }
                else {
                    warn.push("link still missing: " + ml.name);
                    var mlabel = "";
                    // the Script Label sits on the placed graphic (brand template) or on its frame (United template)
                    try { mlabel = String(ml.parent.label || ""); } catch (eLb) {}
                    if (!mlabel) { try { mlabel = String(ml.parent.parent.label || ""); } catch (eLb2) {} }
                    missingLinks.push({ name: String(ml.name), label: mlabel });
                }
            }
        } catch (eRel) { warn.push("link preflight: " + eRel.message); }

        // Font preflight: the cloud render box only has the fonts we ship with the
        // job (staged into a "Document Fonts/" folder next to the template). Ask
        // InDesign which fonts the doc needs and whether each is actually present,
        // so a missing/substituted font surfaces as a warning + in result.json
        // instead of silently changing how every banner looks.
        var fontReport = [];
        try {
            for (var fi = 0; fi < doc.fonts.length; fi++) {
                var ft = doc.fonts[fi], stt = ft.status, lbl;
                if (stt === FontStatus.INSTALLED) lbl = "installed";
                else if (stt === FontStatus.SUBSTITUTED) lbl = "substituted";
                else if (stt === FontStatus.NOT_AVAILABLE) lbl = "not_available";
                else lbl = "unknown";
                fontReport.push({ name: String(ft.name), label: lbl });
                if (lbl !== "installed") warn.push("font " + ft.name + " -> " + lbl);
            }
        } catch (eFont) {}

        var csvFile = U.file(U.CONFIG.csvRel);
        try { if ($.global.BRAND_CSV) { var ov = new File(String($.global.BRAND_CSV)); if (ov.exists) csvFile = ov; } } catch (e) {}
        var csv = U.parseCSV(U.readText(csvFile));
        var C = U.CONFIG.cols;

        // ---- page-map: page names come from a CSV, NOT the script or the .indd.
        // Any *.csv with "pagemap" in its name inside the input folder (or an
        // explicit $.global.BRAND_PAGEMAP). Columns: pagenumber,pagename.
        // If none is found, pages fall back to a padded number (01, 02, 03, ...).
        var pageMap = {}, pageHtml5 = {}, pmName = "(none; padded numbers)";
        var pmFile = null;
        try { if ($.global.BRAND_PAGEMAP) { var pmo = new File(String($.global.BRAND_PAGEMAP)); if (pmo.exists) pmFile = pmo; } } catch (e) {}
        if (!pmFile) {
            try {
                var inFolder = U.file(U.CONFIG.csvRel).parent; // the input/ folder
                var cand = inFolder.getFiles(function (ff) { return (ff instanceof File) && /pagemap/i.test(ff.name) && /\.csv$/i.test(ff.name); });
                if (cand && cand.length > 0) pmFile = cand[0];
            } catch (e) {}
        }
        if (pmFile && pmFile.exists) {
            var pm = U.parseCSV(U.readText(pmFile));
            for (var pmr = 0; pmr < pm.rows.length; pmr++) {
                var pn = U.trim(pm.rows[pmr]["pagenumber"]);
                if (pn) pageMap[pn] = U.trim(pm.rows[pmr]["pagename"]);
                if (pn && /^(y|yes|true|1|x)$/i.test(U.trim(pm.rows[pmr]["html5"] || ""))) pageHtml5[pn] = true;
            }
            pmName = pmFile.name;
        }

        // ---- runtime output options (CONFIG defaults, overridable via $.global) ----
        var fmt = String(U.CONFIG.exportFormat).toLowerCase();
        try { if ($.global.BRAND_FORMAT) fmt = String($.global.BRAND_FORMAT).toLowerCase(); } catch (e) {}
        var wantPNG = (fmt === "png" || fmt === "both");
        var wantJPG = (fmt === "jpg" || fmt === "jpeg" || fmt === "both");
        if (!wantPNG && !wantJPG) { wantPNG = true; fmt = "png"; } // guard typos

        var writeIndd = (U.CONFIG.writeIndd === true);
        try { if ($.global.BRAND_WRITE_INDD != null) { var wv = String($.global.BRAND_WRITE_INDD).toLowerCase(); writeIndd = (wv === "1" || wv === "true" || wv === "yes"); } } catch (e) {}
        // Cloud (InDesign API): writeIndd arrives inside the "parameters" script arg
        // (the same JSON that carries workingFolder). Match it anywhere in the blob.
        try {
            var pjW = app.scriptArgs.get("parameters");
            if (pjW) { var mw = pjW.match(/"writeIndd"\s*:\s*(true|false|"[^"]*"|\d+)/i); if (mw) { var wc = String(mw[1]).replace(/"/g, "").toLowerCase(); writeIndd = (wc === "1" || wc === "true" || wc === "yes"); } }
        } catch (e) {}

        // writePdf (cloud "parameters" arg, like writeIndd): also export each row as one multi-page PDF
        var writePdf = false;
        try { if ($.global.BRAND_WRITE_PDF != null) { var pv = String($.global.BRAND_WRITE_PDF).toLowerCase(); writePdf = (pv === "1" || pv === "true" || pv === "yes"); } } catch (e) {}
        try {
            var pjP = app.scriptArgs.get("parameters");
            if (pjP) { var mp = pjP.match(/"writePdf"\s*:\s*(true|false|"[^"]*"|\d+)/i); if (mp) { var pc = String(mp[1]).replace(/"/g, "").toLowerCase(); writePdf = (pc === "1" || pc === "true" || pc === "yes"); } }
        } catch (e) {}

        // PNG prefs — lossless, keeps crisp text edges; larger files.
        app.pngExportPreferences.pngExportRange = PNGExportRangeEnum.EXPORT_RANGE;
        app.pngExportPreferences.exportResolution = U.CONFIG.exportPPI;
        app.pngExportPreferences.antiAlias = true;
        app.pngExportPreferences.transparentBackground = false;

        // JPEG prefs — smaller, lossy, no alpha; fine for full-bleed photo heroes.
        app.jpegExportPreferences.jpegExportRange = ExportRangeOrAllPages.EXPORT_RANGE;
        app.jpegExportPreferences.exportResolution = U.CONFIG.exportPPI;
        app.jpegExportPreferences.antiAlias = true;
        var qmap = { LOW: JPEGOptionsQuality.LOW, MEDIUM: JPEGOptionsQuality.MEDIUM, HIGH: JPEGOptionsQuality.HIGH, MAXIMUM: JPEGOptionsQuality.MAXIMUM };
        app.jpegExportPreferences.jpegQuality = qmap[String(U.CONFIG.jpegQuality).toUpperCase()] || JPEGOptionsQuality.MAXIMUM;

        var outDir = new Folder(U.root + "/" + U.CONFIG.outputRel);
        if (!outDir.exists) outDir.create();

        function styleFor(pageName, role) {
            var grp = doc.paragraphStyleGroups.itemByName(pageName);
            return grp.isValid ? grp.paragraphStyles.itemByName(role) : null;
        }

        function setText(pg, pageName, role, value) {
            if (value === undefined || value === null) return; // column absent -> keep default
            var tf = U.findByLabel(pg, role);
            if (!tf) { warn.push(pageName + ": no '" + role + "' frame"); return; }
            tf.contents = U.normalizeBreaks(value);
            var st = styleFor(pageName, role);
            if (st && st.isValid) tf.texts[0].appliedParagraphStyle = st;
            if (tf.overflows) warn.push(pageName + " '" + role + "' OVERSET (text too long)");
        }

        // The Script Label may sit on the placed graphic itself (brand template: label
        // "hero" is on the Image, its crop frame is "hero-frame") or on a frame that
        // contains a graphic (United template). Resolve to {graphic, frame} either way.
        function resolveImageTarget(item) {
            var isGraphic = false;
            try { isGraphic = (item.itemLink !== undefined && item.itemLink !== null); } catch (e) {}
            if (isGraphic) return { graphic: item, frame: item.parent };
            var g = null;
            try { if (item.graphics && item.graphics.length > 0) g = item.graphics[0]; } catch (e) {}
            return { graphic: g, frame: item };
        }

        function setImage(pg, pageName, role, imageName) {
            if (!imageName) return;
            var f = U.shot(imageName);
            if (!f.exists) { warn.push(pageName + ": " + role + " image missing '" + imageName + "'"); return; }
            var item = U.findByLabel(pg, role);
            if (!item) { warn.push(pageName + ": no '" + role + "' frame"); return; }
            var t = resolveImageTarget(item);
            if (t.graphic) {
                // relink() alone repoints the link AND redraws the new pixels;
                // the extra update() is redundant and forces a full asset reload
                // (which re-runs Content-Credential/CAI verification per image).
                t.graphic.itemLink.relink(f);
            } else {
                t.frame.place(f);
            }
            t.frame.fit(FitOptions.FILL_PROPORTIONALLY);
            t.frame.fit(FitOptions.CENTER_CONTENT);
            // relink() to a different file drops the Script Label from the graphic.
            // When the label lives on the image (brand template), re-apply it or the
            // next CSV row can't find the swappable image.
            if (item !== t.frame) {
                try { if (t.frame.graphics.length > 0) t.frame.graphics[0].label = role; } catch (e) {}
            }
        }

        function setField(pg, pageName, role, value) {
            if (value === undefined || value === null || value === "") return;
            var frame = U.findByLabel(pg, role);
            if (!frame) { warn.push(pageName + ": no '" + role + "' frame"); return; }
            // A value that names an existing image file swaps the picture; anything
            // else is treated as text for a text frame.
            var image = U.shot(value);
            if (image.exists) {
                setImage(pg, pageName, role, value);
                return;
            }
            setText(pg, pageName, role, value);
        }

        // Page name = the page-map entry for this page number (1-based), else a
        // padded page number ("01", "02", ...). Nothing page-specific lives in the
        // script or the .indd — it's all in the page-map CSV.
        function pageNameOf(pg, idx) {
            var key = String(idx + 1);
            if (pageMap[key] && U.trim(pageMap[key])) return U.trim(pageMap[key]);
            var n = idx + 1;
            return (n < 10 ? "0" + n : String(n));
        }

        // ---- Preflight gate (cloud only). The orchestrator sets "preflightGate" in the
        // parameters blob on the first batch; desktop runs never set it, so nothing below
        // runs there. It checks the template + CSV together BEFORE any row is rendered:
        // a CSV image that isn't staged would otherwise be typeset as text by setField.
        // Errors fail the job with errorString "PREFLIGHT:[<findings json>]" (the
        // orchestrator parses it); "preflightOverride" runs the checks but never blocks.
        // Finding shape: {severity, code, message, column?, rows?, rowsTotal?}; rows are
        // CSV row numbers (header = row 1), so the first data row is 2.
        function paramFlag(name) {
            try {
                var pj = app.scriptArgs.get("parameters");
                if (pj) {
                    // The API may hand params over as an escaped JSON string (\"name\":\"1\"), so allow a
                    // backslash before each quote.
                    var m = pj.match(new RegExp('\\\\?"' + name + '\\\\?"\\s*:\\s*(true|false|\\\\?"[^"\\\\]*\\\\?"|\\d+)', "i"));
                    if (m) { var v = String(m[1]).replace(/[\\"]/g, "").toLowerCase(); return (v === "1" || v === "true" || v === "yes"); }
                }
            } catch (e) {}
            return false;
        }

        function findingJson(severity, code, message, rows, column) {
            var s = '{"severity":' + jesc(severity) + ',"code":' + jesc(code) + ',"message":' + jesc(message);
            if (column) s += ',"column":' + jesc(column);
            if (rows && rows.length) s += ',"rows":[' + rows.slice(0, 20).join(",") + '],"rowsTotal":' + rows.length;
            return s + '}';
        }

        function rowsHint(rows) {
            var shown = rows.slice(0, 5).join(", ");
            return " (row" + (rows.length === 1 ? " " : "s ") + shown + (rows.length > 5 ? " and " + (rows.length - 5) + " more" : "") + ")";
        }

        function preflightGate() {
            var errs = [], wrns = [], pageCount = doc.pages.length;
            var fields = [], isField = {}, hi, k;
            for (hi = 0; hi < csv.header.length; hi++) {
                var hf = U.trim(csv.header[hi]);
                if (hf && hf !== C.file && !isField[hf]) { fields.push(hf); isField[hf] = true; }
            }

            // Script Labels present in the template, and which CSV columns drive a picture.
            var labelSet = {}, labelLower = {}, nLabels = 0, imageCol = {};
            for (var pi = 0; pi < pageCount; pi++) {
                var items = doc.pages.item(pi).allPageItems;
                for (var ii = 0; ii < items.length; ii++) {
                    var lb = "";
                    try { lb = String(items[ii].label || ""); } catch (eLab) {}
                    if (!lb) continue;
                    if (!labelSet[lb]) { labelSet[lb] = true; labelLower[lb.toLowerCase()] = lb; nLabels++; }
                    if (isField[lb] && !imageCol[lb]) {
                        try { if (resolveImageTarget(items[ii]).graphic) imageCol[lb] = true; } catch (eImg) {}
                    }
                }
            }

            // 1. every CSV column must name a Script Label (a typo'd header silently does nothing).
            for (hi = 0; hi < fields.length; hi++) {
                if (labelSet[fields[hi]]) continue;
                var near = labelLower[fields[hi].toLowerCase()];
                errs.push(findingJson("error", "INDD_LABEL_UNMATCHED",
                    'CSV column "' + fields[hi] + '" matches no Script Label in the template' + (near ? ' (did you mean "' + near + '"?)' : "") + " - it would be ignored",
                    null, fields[hi]));
            }

            // 2. every image a CSV cell names must be staged. A name that is missing from the
            // staged images is not skipped by setField: it falls through and is typeset as TEXT.
            var imgRe = /\.(jpe?g|png|gif|tiff?|psd|psb|webp|bmp|heic|svg|ai|eps)$/i, shotSeen = {};
            for (hi = 0; hi < fields.length; hi++) {
                var col = fields[hi];
                if (!labelSet[col]) continue; // already reported
                var byVal = {}, order = [];
                for (var rr = 0; rr < csv.rows.length; rr++) {
                    var v = U.trim(csv.rows[rr][col]);
                    if (!v) continue;
                    if (!imageCol[col] && !imgRe.test(v)) continue;
                    if (shotSeen[v] === undefined) { try { shotSeen[v] = U.shot(v).exists; } catch (eShot) { shotSeen[v] = false; } }
                    if (shotSeen[v]) continue;
                    if (!byVal[v]) { byVal[v] = []; order.push(v); }
                    byVal[v].push(rr + 2);
                }
                for (k = 0; k < order.length; k++) {
                    errs.push(findingJson("error", "INDD_IMG_MISSING",
                        col + ': image "' + order[k] + '" was not found among the staged images' + rowsHint(byVal[order[k]]) +
                        (imageCol[col] ? "" : " - it would be typeset as text"),
                        byVal[order[k]], col));
                }
            }

            // 3. the page map must describe every template page, and give each a distinct name
            // (output files are named <page>_<row>, so duplicate names overwrite each other).
            var pmCount = 0, pmMissing = [];
            for (k in pageMap) { if (pageMap.hasOwnProperty(k)) pmCount++; }
            if (pmFile && pmFile.exists && pmCount > 0) {
                for (var pn2 = 1; pn2 <= pageCount; pn2++) { if (!pageMap[String(pn2)] || !U.trim(pageMap[String(pn2)])) pmMissing.push(pn2); }
                if (pmCount !== pageCount) errs.push(findingJson("error", "INDD_PAGEMAP_COUNT",
                    'The page map "' + pmName + '" lists ' + pmCount + " page(s) but the template has " + pageCount, null, null));
                else if (pmMissing.length) errs.push(findingJson("error", "INDD_PAGEMAP_COUNT",
                    'The page map "' + pmName + '" has no name for page number(s) ' + pmMissing.join(", "), null, null));
            }
            var pageSeen = {}, pageDup = [];
            for (var pj2 = 0; pj2 < pageCount; pj2++) {
                var nm = pageNameOf(null, pj2), nmKey = nm.toLowerCase();
                if (pageSeen[nmKey]) pageDup.push(nm); else pageSeen[nmKey] = true;
            }
            if (pageDup.length) errs.push(findingJson("error", "INDD_PAGENAME_DUP",
                "Page name(s) used by more than one page: " + pageDup.join(", ") + " - their output files would overwrite each other", null, null));

            // 4. fonts the render server can't use are substituted on every banner.
            for (var fq = 0; fq < fontReport.length; fq++) {
                var fnm = fontReport[fq].name.replace(/\t/g, " "), flb = fontReport[fq].label;
                if (flb === "not_available" || flb === "substituted") errs.push(findingJson("error", "INDD_FONT_MISSING",
                    'Font "' + fnm + '" is ' + (flb === "substituted" ? "substituted" : "not available") + " on the render server - text set in it would change", null, null));
                else if (flb === "unknown") wrns.push(findingJson("warn", "INDD_FONT_UNKNOWN",
                    'Could not tell whether font "' + fnm + '" is available on the render server', null, null));
            }

            // 5. placed art whose file is gone and isn't a CSV-driven image would stay a missing-link box.
            var linkSeen = {};
            for (var lq = 0; lq < missingLinks.length; lq++) {
                var ln = missingLinks[lq];
                if (linkSeen[ln.name] || (ln.label && isField[ln.label])) continue; // a CSV column swaps it per row
                linkSeen[ln.name] = true;
                errs.push(findingJson("error", "INDD_LINK_MISSING",
                    'The template\'s placed image "' + ln.name + '" is missing and was not found among the staged images', null, null));
            }

            return { errs: errs, wrns: wrns, facts: '{"pages":' + pageCount + ',"labels":' + nLabels + ',"columns":' + fields.length +
                ',"fonts":' + fontReport.length + ',"links":' + doc.links.length + '}' };
        }

        var gateOn = paramFlag("preflightGate"), gateOverride = paramFlag("preflightOverride");
        var gateFindings = [], gateFacts = "";
        if (gateOn) {
            var gres = null;
            try { gres = preflightGate(); } catch (eGate) { warn.push("preflight gate: " + (eGate && eGate.message ? eGate.message : eGate)); }
            if (gres) {
                gateFindings = gres.errs.concat(gres.wrns).slice(0, 40); // errors first, so a cap never hides one
                gateFacts = gres.facts;
                if (gres.errs.length && !gateOverride) return failurePkg("PREFLIGHT:[" + gateFindings.join(",") + "]");
            }
        }

        // ---- HTML5 manifest (cloud, "writeHtml5" in the parameters blob; first batch only).
        // For every page marked html5=yes in the page map, walk the page items back to front:
        // each labelled item becomes an element (box, style, crop) the `ad` block re-creates live;
        // each run of consecutive unlabelled items is exported once as a transparent PNG slice
        // ("static-0", "static-1", ...) with everything else hidden. Runs on the template's own
        // design, before any CSV row is applied. Slices are full-page; the orchestrator places them.
        var html5Json = [];
        function itemLabel(it) {
            var lb = "";
            try { lb = String(it.label || ""); } catch (e) {}
            if (!lb) { try { if (it.graphics && it.graphics.length > 0) lb = String(it.graphics[0].label || ""); } catch (e2) {} }
            return U.trim(lb);
        }
        function hasInnerLabel(it) {
            try { var all = it.allPageItems; for (var q = 0; q < all.length; q++) { if (U.trim(String(all[q].label || ""))) return true; } } catch (e) {}
            return false;
        }
        function colorHex(c) {
            try {
                if (!c || !c.isValid || c.name === "None" || !c.colorValue) return "";
                var v = c.colorValue, rgb;
                if (c.space === ColorSpace.RGB) rgb = [v[0], v[1], v[2]];
                else if (c.space === ColorSpace.CMYK) { var k = 1 - v[3] / 100; rgb = [255 * (1 - v[0] / 100) * k, 255 * (1 - v[1] / 100) * k, 255 * (1 - v[2] / 100) * k]; }
                else return "";
                var h = "#";
                for (var ch = 0; ch < 3; ch++) { var n = Math.max(0, Math.min(255, Math.round(rgb[ch]))); h += (n < 16 ? "0" : "") + n.toString(16); }
                return h;
            } catch (e) { return ""; }
        }
        function boxJson(b, pb) { // geometricBounds [y1,x1,y2,x2] -> page-relative px
            return '{"x":' + (b[1] - pb[1]) + ',"y":' + (b[0] - pb[0]) + ',"w":' + (b[3] - b[1]) + ',"h":' + (b[2] - b[0]) + '}';
        }
        function textStyleJson(tf, label) {
            var parts = [];
            try {
                var t = tf.texts[0];
                var fam = "", sty = "";
                // Each read is separate: in the cloud a font that is not installed can throw on one
                // property and not another, and String(Font) is "[object Font]", never a name.
                var af = null; try { af = t.appliedFont; } catch (eA) {}
                var okName = function (v) { v = String(v || ""); return /^\[object/.test(v) ? "" : v; };
                try { fam = okName(af.fontFamily); } catch (eF) {}
                if (!fam) try { fam = okName(String(af.name).split("\t")[0]); } catch (eF2) {}
                if (!fam) try { fam = okName(String(af).split("\t")[0]); } catch (eF3) {}
                if (!fam) try { fam = okName(String(t.appliedParagraphStyle.appliedFont).split("\t")[0]); } catch (eF4) {}
                try { sty = okName(af.fontStyleName); } catch (eS) {}
                if (!sty) try { sty = okName(String(af.name).split("\t")[1]); } catch (eS2) {}
                if (!sty) try { sty = okName(t.fontStyle); } catch (eS3) {}
                if (fam) parts.push('"font":' + jesc(fam));
                if (/italic|oblique/i.test(sty)) { parts.push('"italic":true'); sty = U.trim(sty.replace(/italic|oblique/ig, "")); }
                if (sty) parts.push('"weight":' + jesc(sty));
                if (typeof t.pointSize === "number") parts.push('"size":' + t.pointSize);
                if (typeof t.leading === "number") parts.push('"lead":' + t.leading);
                var fc = colorHex(t.fillColor); if (fc) parts.push('"color":' + jesc(fc));
                if (t.justification === Justification.CENTER_ALIGN) parts.push('"align":"center"');
                else if (t.justification === Justification.RIGHT_ALIGN) parts.push('"align":"right"');
                if (t.capitalization === Capitalization.ALL_CAPS) parts.push('"caps":true');
                if (t.tracking) parts.push('"track":' + t.tracking);
            } catch (eT) {}
            var bg = colorHex(tf.fillColor);
            if (bg) parts.push('"bg":' + jesc(bg));
            try { if (tf.topLeftCornerOption !== CornerOptions.NONE && tf.topLeftCornerRadius > 0) parts.push('"radius":' + tf.topLeftCornerRadius); } catch (eR) {}
            try {
                var vj = tf.textFramePreferences.verticalJustification;
                if (vj === VerticalJustification.CENTER_ALIGN) parts.push('"valign":"middle"');
                else if (vj === VerticalJustification.BOTTOM_ALIGN) parts.push('"valign":"bottom"');
            } catch (eV) {}
            if (bg && /^cta/i.test(label)) parts.push('"button":true');
            return "{" + parts.join(",") + "}";
        }
        function writeHtml5() {
            var savedT = app.pngExportPreferences.transparentBackground, savedR = app.pngExportPreferences.exportResolution;
            app.pngExportPreferences.transparentBackground = true;
            app.pngExportPreferences.exportResolution = 144;
            try {
                for (var hp = 0; hp < doc.pages.length; hp++) {
                    if (!pageHtml5[String(hp + 1)]) continue;
                    var page = doc.pages.item(hp), pname = pageNameOf(page, hp), pb = page.bounds;
                    // page.pageItems is grouped by object type (groups, rectangles, polygons, text frames), not
                    // stacking order. allPageItems is true z-order, front to back (group children included),
                    // so keep top-level items and reverse to get back to front.
                    var all = page.allPageItems, items = [];
                    // Hidden items (eye off, or on a hidden or non-printing layer) are not part of this
                    // size: they must not come back as live text or be counted as slice art.
                    var shown = function (pi) { try { if (pi.visible === false) return false; var ly = pi.itemLayer; if (ly && (ly.visible === false || ly.printable === false)) return false; } catch (eVis) {} return true; };
                    for (var ai = all.length - 1; ai >= 0; ai--) if (all[ai].parent && all[ai].parent.constructor.name == "Spread" && shown(all[ai])) items.push(all[ai]);
                    var liveCols = null;
                    if (csv.header && csv.header.length) { liveCols = {}; for (var lc = 0; lc < csv.header.length; lc++) liveCols[U.trim(csv.header[lc]).toLowerCase()] = true; }
                    var units = [], run = null;
                    for (var u = 0; u < items.length; u++) {
                        var it = items[u], lb = itemLabel(it);
                        // Only labels that name a CSV column are live; other labelled art (backgrounds,
                        // logos, decorations) is baked into the static slices like unlabelled items.
                        var demoted = !!(lb && liveCols && !liveCols[lb.toLowerCase()]);
                        if (demoted) lb = "";
                        if (lb) { units.push({ label: lb, item: it, z: u }); run = null; continue; }
                        if (!demoted && hasInnerLabel(it)) warn.push(pname + ": HTML5 labelled item inside a group is baked into a static slice");
                        if (!run) { run = { items: [], z: u }; units.push(run); }
                        run.items.push(it);
                    }
                    var slices = [], elements = [], sliceIdx = 0;
                    var relDir = U.CONFIG.outputRel + "/html5/" + pname, dir = new Folder(U.root + "/" + relDir);
                    if (!dir.exists) dir.create();
                    var master = null;
                    for (var s = 0; s < units.length; s++) {
                        var un = units[s];
                        if (un.label) {
                            var tgt = resolveImageTarget(un.item), isText = false;
                            try { isText = un.item.constructor.name === "TextFrame"; } catch (eC) {}
                            var fb = (isText ? un.item : tgt.frame).geometricBounds, ej = '{"label":' + jesc(un.label) + ',"z":' + un.z + ',"box":' + boxJson(fb, pb);
                            // geometricBounds of a rotated frame is its axis-aligned bounding box; the
                            // angle (InDesign: degrees, counter-clockwise) lets the consumer unrotate it.
                            try { var ra = (isText ? un.item : tgt.frame).rotationAngle; if (typeof ra === "number" && Math.abs(ra) >= 0.05) ej += ',"rot":' + Math.round(ra * 100) / 100; } catch (eRot) {}
                            if (isText) ej += ',"kind":"text","style":' + textStyleJson(un.item, un.label);
                            else {
                                ej += ',"kind":"image"';
                                try {
                                    var gb = tgt.graphic.geometricBounds, gw = gb[3] - gb[1], gh = gb[2] - gb[0];
                                    var fx = ((fb[1] + fb[3]) / 2 - gb[1]) / gw * 100, fy = ((fb[0] + fb[2]) / 2 - gb[0]) / gh * 100;
                                    ej += ',"crop":{"fx":' + Math.round(fx * 10) / 10 + ',"fy":' + Math.round(fy * 10) / 10 + '}';
                                } catch (eG) {}
                            }
                            elements.push(ej + "}");
                            continue;
                        }
                        // hide everything that is not in this run, export, restore
                        var hidden = [];
                        for (var a = 0; a < items.length; a++) {
                            var keep = false;
                            for (var b2 = 0; b2 < un.items.length; b2++) { if (un.items[b2] === items[a]) { keep = true; break; } }
                            try { if (!keep && items[a].visible) { items[a].visible = false; hidden.push(items[a]); } } catch (eH) { warn.push(pname + ": HTML5 could not hide an item (locked?)"); }
                        }
                        // master items belong to the back-most slice only
                        if (sliceIdx > 0 && master === null) { try { master = page.appliedMaster; page.appliedMaster = NothingEnum.NOTHING; } catch (eM) { master = false; } }
                        var sname = "static-" + sliceIdx, srel = relDir + "/" + pname + "--" + sname + ".png"; // unique across sizes: the render returns outputs by bare name
                        try {
                            app.pngExportPreferences.pageString = page.name;
                            doc.exportFile(ExportFormat.PNG_FORMAT, new File(U.root + "/" + srel));
                            slices.push('{"name":' + jesc(sname) + ',"file":' + jesc(srel) + ',"z":' + un.z + ',"box":{"x":0,"y":0,"w":' + (pb[3] - pb[1]) + ',"h":' + (pb[2] - pb[0]) + '}}');
                            outFiles.push(srel);
                        } catch (eX) { warn.push(pname + ": HTML5 slice " + sname + " failed: " + eX); }
                        for (var hh = 0; hh < hidden.length; hh++) { try { hidden[hh].visible = true; } catch (eU) {} }
                        sliceIdx++;
                    }
                    if (master) { try { page.appliedMaster = master; } catch (eM2) { warn.push(pname + ": HTML5 could not restore master"); } }
                    html5Json.push(jesc(pname) + ':{"width":' + (pb[3] - pb[1]) + ',"height":' + (pb[2] - pb[0]) + ',"slices":[' + slices.join(",") + '],"elements":[' + elements.join(",") + ']}');
                }
            } finally {
                app.pngExportPreferences.transparentBackground = savedT;
                app.pngExportPreferences.exportResolution = savedR;
            }
        }
        // HTML5 diagnostics for the run log: was it asked for, which pages the pagemap opted in, what came out.
        var h5Asked = paramFlag("writeHtml5"), h5Gated = 0;
        for (var hk in pageHtml5) { if (pageHtml5.hasOwnProperty(hk)) h5Gated++; }
        if (h5Asked) writeHtml5();
        var paramKeys = [];
        try { var pjk = String(app.scriptArgs.get("parameters") || ""), km, kre = /\\?"([A-Za-z0-9_]+)\\?"\s*:/g; while ((km = kre.exec(pjk)) !== null) { if (paramKeys.length < 40) paramKeys.push(km[1]); } } catch (eK) {}
        var h5Diag = "script build: html5-diag-5\nhtml5 requested: " + h5Asked + "\nhtml5 pages in pagemap: " + h5Gated +
                     "\ntemplate pages: " + doc.pages.length + "\nhtml5 pages exported: " + html5Json.length +
                     "\nparameter keys: " + (paramKeys.length ? paramKeys.join(", ") : "(none)") + "\n";

        for (var r = 0; r < csv.rows.length; r++) {
            var row = csv.rows[r];
            var stem = U.trim(row[C.file] || ("row" + (r + 1)));

            for (var i = 0; i < doc.pages.length; i++) {
                var pg = doc.pages.item(i);
                var pageName = pageNameOf(pg, i);

                for (var ci = 0; ci < csv.header.length; ci++) {
                    var field = U.trim(csv.header[ci]);
                    if (!field || field === C.file) continue;
                    setField(pg, pageName, field, row[field]);
                }

                var base = outDir.fsName + "/" + pageName + "_" + stem;
                var relBase = U.CONFIG.outputRel + "/" + pageName + "_" + stem;
                if (wantPNG) {
                    app.pngExportPreferences.pageString = pg.name;
                    doc.exportFile(ExportFormat.PNG_FORMAT, new File(base + ".png"));
                    written++; outFiles.push(relBase + ".png");
                }
                if (wantJPG) {
                    app.jpegExportPreferences.pageString = pg.name;
                    doc.exportFile(ExportFormat.JPG, new File(base + ".jpg"));
                    written++; outFiles.push(relBase + ".jpg");
                }
            }
            // optional editable source: one .indd per row, all 10 pages populated.
            // saveACopy writes a copy WITHOUT changing the in-memory template's path,
            // so the next row simply overwrites these pages and dumps another copy.
            if (writeIndd) {
                // Record where each swapped image's link points in this row's saved copy,
                // so the orchestrator can remap those local links back to AEM URLs.
                var rowLinks = [];
                try {
                    for (var li = 0; li < doc.links.length; li++) {
                        var lk = doc.links[li], lp = String(lk.filePath).replace(/\\+/g, "/");
                        if (lp.indexOf("/" + U.CONFIG.shotsRel + "/") >= 0 || lp.indexOf("/" + U.CONFIG.brandRel + "/") >= 0) rowLinks.push('{"name":' + jesc(lk.name) + ',"path":' + jesc(lp) + '}');
                    }
                } catch (eL) {}
                linkMaps.push(jesc(stem + ".indd") + ':[' + rowLinks.join(",") + ']');
                // Ask InDesign to save a page preview (Preferences > File Handling > Always Save Preview Images).
                // The headless InDesign API currently writes none, so the orchestrator attaches the rendered
                // first page to the .indd as AEM renditions instead (see renditions.js); harmless where honoured.
                try { app.generalPreferences.includePreview = true; } catch (eP) { warn.push("includePreview: " + eP); }
                doc.saveACopy(new File(outDir.fsName + "/" + stem + ".indd"));
                inddWritten++; outFiles.push(U.CONFIG.outputRel + "/" + stem + ".indd");
            }
            // optional multi-page PDF of the whole row (every page/size), for viewing in AEM Assets.
            if (writePdf) {
                try {
                    var pdfFile = new File(outDir.fsName + "/" + stem + ".pdf");
                    app.pdfExportPreferences.pageRange = PageRange.ALL_PAGES;
                    app.pdfExportPreferences.viewPDF = false;
                    var preset = null;
                    try { preset = app.pdfExportPresets.itemByName("[Smallest File Size]"); var pn = preset.name; } catch (eS) { preset = null; }
                    // InDesign Server's exportFile takes the preset as the 3rd argument (no showingOptions flag).
                    if (preset) { try { doc.exportFile(ExportFormat.PDF_TYPE, pdfFile, preset); } catch (ePre) { doc.exportFile(ExportFormat.PDF_TYPE, pdfFile); } }
                    else doc.exportFile(ExportFormat.PDF_TYPE, pdfFile);
                    pdfWritten++; outFiles.push(U.CONFIG.outputRel + "/" + stem + ".pdf");
                } catch (ePdf) { warn.push("pdf " + stem + ": " + ePdf); }
            }
            log.push(stem);
        }

        // write a run log next to the outputs
        var lf = new File(outDir.fsName + "/_run_log.txt");
        lf.encoding = "UTF-8"; lf.open("w");
        var fontLines = [];
        for (var fj = 0; fj < fontReport.length; fj++) fontLines.push(fontReport[fj].name + " [" + fontReport[fj].label + "]");
        lf.write(h5Diag + "rows: " + csv.rows.length + "\nformat: " + fmt + "\npagemap: " + pmName +
                 "\nlinks relinked at open: " + relinked + "\nimages written: " + written + "\nindd written: " + inddWritten + "\npdf written: " + pdfWritten +
                 "\n\nfonts (" + fontReport.length + "):\n" + (fontLines.length ? fontLines.join("\n") : "none") +
                 "\n\nrows: " + log.join(", ") +
                 "\n\nwarnings (" + warn.length + "):\n" + (warn.length ? warn.join("\n") : "none") + "\n");
        lf.close();
        outFiles.push(U.CONFIG.outputRel + "/_run_log.txt");

        // The InDesign API returns the contents of a "response data" JSON file
        // (dataURL, relative to workingFolder) to the caller, and uploads every
        // path in assetsToBeUploaded, handing back their URLs.
        var resultRel = "result.json";
        var rf = new File(U.root + "/" + resultRel);
        rf.encoding = "UTF-8"; rf.open("w");
        var fontsJson = [];
        for (var fk = 0; fk < fontReport.length; fk++) fontsJson.push('{"name":' + jesc(fontReport[fk].name) + ',"status":' + jesc(fontReport[fk].label) + '}');
        var pfJson = gateOn && gateFacts ? ',"preflight":{"facts":' + gateFacts + ',"findings":[' + gateFindings.join(",") + ']}' : "";
        rf.write('{"images":' + written + ',"indd":' + inddWritten + ',"rows":' + csv.rows.length + ',"warnings":' + warn.length + ',"fonts":[' + fontsJson.join(",") + '],"links":{' + linkMaps.join(",") + '}' + pfJson + (html5Json.length ? ',"html5":{' + html5Json.join(",") + '}' : "") + '}');
        rf.close();
        return successPkg(outFiles, resultRel);
    } catch (e) {
        return failurePkg((e && e.message ? e.message : String(e)) + " (line " + (e && e.line) + ")");
    } finally {
        try { if (doc) doc.close(SaveOptions.NO); } catch (e) {}
        try { if (oldUnit !== undefined) app.scriptPreferences.measurementUnit = oldUnit; } catch (e) {}
        try { if (oldUIL !== undefined) app.scriptPreferences.userInteractionLevel = oldUIL; } catch (e) {}
    }
})();
