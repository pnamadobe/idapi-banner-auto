/*
 * generate_variations.jsx — the exporter. Opens the template, then for every
 * CSV row swaps the hero image + header/city/legal text and exports one PNG per
 * (size x row), named  <ARTBOARD>_<outputFileName>.png.
 *
 * Frames are located by Script Label (hero/header/city/legal) — the direct
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

#target indesign
#include "united_lib.jsx"

(function () {
    var log = [], warn = [], written = 0, inddWritten = 0;
    var oldUnit = app.scriptPreferences.measurementUnit;
    var oldUIL  = app.scriptPreferences.userInteractionLevel;
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.measurementUnit = MeasurementUnits.PIXELS;

    var doc = null;
    try {
        var tpl = U.file(U.CONFIG.templateRel);
        try { if ($.global.UNITED_TEMPLATE) { var otpl = new File(String($.global.UNITED_TEMPLATE)); if (otpl.exists) tpl = otpl; } } catch (e) {}
        if (!tpl.exists) return "ERROR: template not found: " + tpl.fsName;
        doc = app.open(tpl, false); // open hidden-ish; we never save it

        var csvFile = U.file(U.CONFIG.csvRel);
        try { if ($.global.UNITED_CSV) { var ov = new File(String($.global.UNITED_CSV)); if (ov.exists) csvFile = ov; } } catch (e) {}
        var csv = U.parseCSV(U.readText(csvFile));
        var C = U.CONFIG.cols;

        // ---- page-map: page names come from a CSV, NOT the script or the .indd.
        // Any *.csv with "pagemap" in its name inside the input folder (or an
        // explicit $.global.UNITED_PAGEMAP). Columns: pagenumber,pagename.
        // If none is found, pages fall back to a padded number (01, 02, 03, ...).
        var pageMap = {}, pmName = "(none; padded numbers)";
        var pmFile = null;
        try { if ($.global.UNITED_PAGEMAP) { var pmo = new File(String($.global.UNITED_PAGEMAP)); if (pmo.exists) pmFile = pmo; } } catch (e) {}
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
            }
            pmName = pmFile.name;
        }

        // ---- runtime output options (CONFIG defaults, overridable via $.global) ----
        var fmt = String(U.CONFIG.exportFormat).toLowerCase();
        try { if ($.global.UNITED_FORMAT) fmt = String($.global.UNITED_FORMAT).toLowerCase(); } catch (e) {}
        var wantPNG = (fmt === "png" || fmt === "both");
        var wantJPG = (fmt === "jpg" || fmt === "jpeg" || fmt === "both");
        if (!wantPNG && !wantJPG) { wantPNG = true; fmt = "png"; } // guard typos

        var writeIndd = (U.CONFIG.writeIndd === true);
        try { if ($.global.UNITED_WRITE_INDD != null) { var wv = String($.global.UNITED_WRITE_INDD).toLowerCase(); writeIndd = (wv === "1" || wv === "true" || wv === "yes"); } } catch (e) {}

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

        var outDir = new Folder(U.CONFIG.projectRoot + "/" + U.CONFIG.outputRel);
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

        function setHero(pg, pageName, heroName) {
            if (!heroName) return;
            var f = U.shot(heroName);
            if (!f.exists) { warn.push(pageName + ": hero missing '" + heroName + "'"); return; }
            var frame = U.findByLabel(pg, "hero");
            if (!frame) { warn.push(pageName + ": no 'hero' frame"); return; }
            if (frame.graphics.length > 0) {
                // relink() alone repoints the link AND redraws the new pixels;
                // the extra update() is redundant and forces a full asset reload
                // (which re-runs Content-Credential/CAI verification per image).
                frame.graphics[0].itemLink.relink(f);
            } else {
                frame.place(f);
            }
            frame.fit(FitOptions.FILL_PROPORTIONALLY);
            frame.fit(FitOptions.CENTER_CONTENT);
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

        for (var r = 0; r < csv.rows.length; r++) {
            var row = csv.rows[r];
            var stem = U.trim(row[C.file] || ("row" + (r + 1)));

            for (var i = 0; i < doc.pages.length; i++) {
                var pg = doc.pages.item(i);
                var pageName = pageNameOf(pg, i);

                setHero(pg, pageName, row[C.hero]);
                setText(pg, pageName, "header", row[C.header]);
                setText(pg, pageName, "city",   row[C.city]);

                var base = outDir.fsName + "/" + pageName + "_" + stem;
                if (wantPNG) {
                    app.pngExportPreferences.pageString = pg.name;
                    doc.exportFile(ExportFormat.PNG_FORMAT, new File(base + ".png"), false);
                    written++;
                }
                if (wantJPG) {
                    app.jpegExportPreferences.pageString = pg.name;
                    doc.exportFile(ExportFormat.JPG, new File(base + ".jpg"), false);
                    written++;
                }
            }
            // optional editable source: one .indd per row, all 10 pages populated.
            // saveACopy writes a copy WITHOUT changing the in-memory template's path,
            // so the next row simply overwrites these pages and dumps another copy.
            if (writeIndd) {
                doc.saveACopy(new File(outDir.fsName + "/" + stem + ".indd"));
                inddWritten++;
            }
            log.push(stem);
        }

        // write a run log next to the outputs
        var lf = new File(outDir.fsName + "/_run_log.txt");
        lf.encoding = "UTF-8"; lf.open("w");
        lf.write("rows: " + csv.rows.length + "\nformat: " + fmt + "\npagemap: " + pmName +
                 "\nimages written: " + written + "\nindd written: " + inddWritten +
                 "\n\nrows: " + log.join(", ") +
                 "\n\nwarnings (" + warn.length + "):\n" + (warn.length ? warn.join("\n") : "none") + "\n");
        lf.close();

        return "OK root=" + U.root + " | rows=" + csv.rows.length + " format=" + fmt + " pagemap=" + pmName +
               " images=" + written + " indd=" + inddWritten +
               " | warnings=" + warn.length + (warn.length ? " :: " + warn.join(" ; ") : "");
    } catch (e) {
        return "ERROR: " + e.message + " (line " + e.line + ")";
    } finally {
        if (doc) doc.close(SaveOptions.NO);
        app.scriptPreferences.measurementUnit = oldUnit;
        app.scriptPreferences.userInteractionLevel = oldUIL;
    }
})();
