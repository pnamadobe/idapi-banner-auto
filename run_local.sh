#!/usr/bin/env bash
# Run the exporter against local desktop InDesign with a long Apple-event timeout
# (a full 300-image run far exceeds the default 2-minute timeout).
#
# Usage:
#   bash run_local.sh                       # defaults: PNG, no .indd, full CSV
#   FORMAT=jpg bash run_local.sh            # JPEG instead of PNG (smaller files)
#   FORMAT=both bash run_local.sh           # PNG *and* JPEG
#   WRITE_INDD=1 bash run_local.sh          # also save an editable .indd per row
#   FORMAT=both WRITE_INDD=1 bash run_local.sh
#   CSV=/path/to/other.csv bash run_local.sh
set -euo pipefail
ROOT="/Users/pnam/Sandbox/ids-banner-auto-local"
SCRIPT="$ROOT/scripts/generate_variations.jsx"

# Build a tiny wrapper .jsx that sets any requested globals, then evals the
# exporter. (Passing options as globals keeps generate_variations.jsx the single
# entry point and mirrors how the cloud harness will inject inputs.)
WRAP="${TMPDIR:-/tmp}/united_run_$$.jsx"   # .jsx so InDesign's do-script accepts it
{
  [ -n "${FORMAT:-}" ]     && echo "\$.global.UNITED_FORMAT = '${FORMAT}';"
  [ -n "${WRITE_INDD:-}" ] && echo "\$.global.UNITED_WRITE_INDD = '${WRITE_INDD}';"
  [ -n "${CSV:-}" ]        && echo "\$.global.UNITED_CSV = '${CSV}';"
  [ -n "${TEMPLATE:-}" ]   && echo "\$.global.UNITED_TEMPLATE = '${TEMPLATE}';"
  echo "\$.evalFile(new File('${SCRIPT}'));"
} > "$WRAP"

osascript <<APPLESCRIPT
with timeout of 3600 seconds
  tell application id "com.adobe.InDesign"
    set r to do script (POSIX file "$WRAP") language javascript
    return r
  end tell
end timeout
APPLESCRIPT

rm -f "$WRAP"
