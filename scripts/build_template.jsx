/*
 * build_template.jsx — constructs brand-template.indd from scratch:
 *   - one page per banner size (mixed page sizes in a single doc)
 *   - a full-bleed "hero" graphic frame (Fill Frame Proportionally)
 *   - the static Brand lockup as a pre-composited full-bleed "overlay" PNG
 *   - live "header" / "city" / "legal" text frames driven by paragraph styles
 *
 * Each swappable frame carries a Script Label (hero/header/city/legal) — the
 * analog of your PSD layer names — so the exporter can find them by label.
 *
 * Run:  osascript -> do script (POSIX file ".../build_template.jsx") language javascript
 */

#target indesign
#include "brand_lib.jsx"

(function () {
    var log = [];
    var oldUnit = app.scriptPreferences.measurementUnit;
    var oldUIL  = app.scriptPreferences.userInteractionLevel;
    app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
    app.scriptPreferences.measurementUnit = MeasurementUnits.PIXELS;

    try {
        var doc = app.documents.add();
        doc.documentPreferences.facingPages = false;
        doc.documentPreferences.intent = DocumentIntentOptions.WEB_INTENT;
        doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.PIXELS;
        doc.viewPreferences.verticalMeasurementUnits   = MeasurementUnits.PIXELS;
        doc.zeroPoint = [0, 0];

        var white = doc.colors.itemByName("UI White");
        if (!white.isValid)
            white = doc.colors.add({ name: "UI White", model: ColorModel.PROCESS,
                                     space: ColorSpace.RGB, colorValue: [255, 255, 255] });

        function setPageSize(pg, w, h) {
            pg.layoutRule = LayoutRuleOptions.OFF;
            pg.resize(CoordinateSpaces.INNER_COORDINATES, AnchorPoint.TOP_LEFT_ANCHOR,
                      ResizeMethods.REPLACING_CURRENT_DIMENSIONS_WITH, [w, h]);
        }

        // paragraph style per (page, role) so the size travels with the style and
        // survives content replacement in the exporter.
        function mkStyle(pageName, role, spec) {
            var grp = doc.paragraphStyleGroups.itemByName(pageName);
            if (!grp.isValid) grp = doc.paragraphStyleGroups.add({ name: pageName });
            var st = grp.paragraphStyles.itemByName(role);
            if (!st.isValid) st = grp.paragraphStyles.add({ name: role });
            var f = U.FONTS[role];
            st.appliedFont = f.family;
            st.fontStyle   = f.style;
            st.pointSize   = spec.size;
            st.leading     = spec.leading;
            st.fillColor   = white;
            st.justification = Justification.LEFT_ALIGN;
            st.hyphenation = false;
            return st;
        }

        function addRect(pg, label, x, y, w, h) {
            var r = pg.rectangles.add();
            r.geometricBounds = [y, x, y + h, x + w];  // top, left, bottom, right
            r.label = label;
            r.strokeWeight = 0;
            r.fillColor = "None";
            return r;
        }

        function addText(pg, role, spec, style, contents, autoHeight) {
            var tf = pg.textFrames.add();
            tf.geometricBounds = [spec.y, spec.x, spec.y + spec.h, spec.x + spec.w];
            tf.label = role;
            var p = tf.textFramePreferences;
            p.insetSpacing = [0, 0, 0, 0];
            p.verticalJustification = VerticalJustification.TOP_ALIGN;
            p.firstBaselineOffset = FirstBaseline.CAP_HEIGHT;
            if (autoHeight) {
                p.autoSizingReferencePoint = AutoSizingReferenceEnum.TOP_LEFT_POINT;
                p.autoSizingType = AutoSizingTypeEnum.HEIGHT_ONLY;
            }
            tf.contents = contents;
            tf.texts[0].appliedParagraphStyle = style;
            return tf;
        }

        for (var i = 0; i < U.PAGES.length; i++) {
            var P = U.PAGES[i];
            var pg = (i === 0) ? doc.pages.item(0) : doc.pages.add();
            setPageSize(pg, P.w, P.h);

            // z-order: hero (bottom) -> lockup -> text (top)
            var hero = addRect(pg, "hero", 0, 0, P.w, P.h);
            hero.place(U.shot(U.DEFAULTS.hero));
            hero.fit(FitOptions.FILL_PROPORTIONALLY);
            hero.fit(FitOptions.CENTER_CONTENT);

            var lockH = Math.round(P.lockup.w / U.LOCKUP_ASPECT);
            var lock = addRect(pg, "lockup", P.lockup.x, P.lockup.y, P.lockup.w, lockH);
            lock.place(U.lockupAsset());
            lock.fit(FitOptions.PROPORTIONALLY);
            lock.fit(FitOptions.CENTER_CONTENT);
            lock.locked = true;

            addText(pg, "header", P.header, mkStyle(P.name, "header", P.header), U.DEFAULTS.header, true);
            addText(pg, "city",   P.city,   mkStyle(P.name, "city",   P.city),   U.DEFAULTS.city,   false);

            var b = pg.bounds; // [top,left,bottom,right]
            log.push(P.name + " -> " + Math.round(b[3] - b[1]) + "x" + Math.round(b[2] - b[0]));
        }

        var tpl = U.file(U.CONFIG.templateRel);
        if (!tpl.parent.exists) tpl.parent.create();
        doc.save(tpl);

        // preview export so we can eyeball the build
        app.pngExportPreferences.pngExportRange = PNGExportRangeEnum.EXPORT_RANGE;
        app.pngExportPreferences.exportResolution = U.CONFIG.exportPPI;
        app.pngExportPreferences.antiAlias = true;
        app.pngExportPreferences.transparentBackground = false;
        var outDir = new Folder(U.CONFIG.projectRoot + "/" + U.CONFIG.outputRel);
        if (!outDir.exists) outDir.create();
        for (var j = 0; j < doc.pages.length; j++) {
            app.pngExportPreferences.pageString = doc.pages.item(j).name;
            doc.exportFile(ExportFormat.PNG_FORMAT,
                new File(outDir.fsName + "/_preview_" + U.PAGES[j].name + ".png"), false);
        }

        doc.close(SaveOptions.YES);
        return "OK | " + log.join("  |  ");
    } catch (e) {
        return "ERROR: " + e.message + " (line " + e.line + ")";
    } finally {
        app.scriptPreferences.measurementUnit = oldUnit;
        app.scriptPreferences.userInteractionLevel = oldUIL;
    }
})();
