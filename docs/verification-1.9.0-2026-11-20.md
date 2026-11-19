# NetSpace 1.9.0 Verification Record

Date: 2026-11-20

## Results

- `python -m unittest discover -s tests -v`: 81 regression tests passed.
- `node tools/ui_smoke.cjs`: filtered device CSV, source marker, UTF-8 BOM, formula injection and quote handling, empty results, 320/375 px layouts, CSP, offline resources, and browser errors passed.
- `node tools/ui_upgrade.cjs`: same-network snapshot comparison export passed with CSV field parsing, change category and address checks, formula-like names/groups, multiline quoted notes, empty-diff disabling, stale network and demo isolation, and 320/375 px layouts.
- `node tools/ui_recovery.cjs`: adapter disconnect/reselection and in-flight discovery recovery passed.
- `powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1`: Windows single-file executable and distribution archives built.
- `python tools/packaged_smoke.py`: the rebuilt Windows executable served bundled assets, including `/csv.js` and `/identity.js`, and passed native discovery, persistence across restarts, scheduled discovery, and clean shutdown.
- `python -m py_compile app.py tools/packaged_smoke.py`, JavaScript syntax checks, and `git diff --check`: passed.

## Scope and interpretation

The history pane can export the completed comparison between two saved snapshots from the same local network. Each changed device gets one row containing source, export time, network range, both scan times, change kind, name, MAC, stable record identity, start/target addresses, prior/current status where applicable, group, notes, and an offline-status caveat for devices absent from the target snapshot. The identity column uses the same stable key → normalized MAC → IP fallback as the comparison itself. Unchanged devices are omitted. The button is disabled when there is no comparison, there are no changes, the selection is stale, the app is stopped, or demo mode is active.

The export is generated in the browser and reuses the existing UTF-8 BOM, CSV quote escaping, and spreadsheet formula prefix handling. Browser verification parses the produced rows, retains explicitly quoted empty values, rejects malformed quote shapes in its parser, and checks every row retains all 16 columns, including embedded CRLF notes and trailing empty cells. It makes no additional API request and adds no database fields, network discovery, or third-party dependency.
