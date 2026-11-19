# NetSpace 1.8.0 Verification Record

Date: 2026-11-20

## Results

- `python -m unittest discover -s tests -v`: 81 regression tests passed.
- `node tools/ui_smoke.cjs`: validates a filtered demo CSV download, UTF-8 BOM, correct source marker, exclusion of hidden devices, disabled empty-result export, ASCII and full-width formula-like values after leading whitespace, format controls or NUL, quote escaping, CSP, offline assets and 375 px layout.
- `node tools/ui_upgrade.cjs`: validates CSV export labels historical snapshots separately from current discovery, alongside history-comparison, source identity, stale-response and hostile-name cases.
- `node tools/ui_recovery.cjs`: validates adapter disconnect/reselection and in-flight discovery recovery.
- `powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1`: builds the versioned Windows single-file executable and source/Windows archives.
- `python tools/packaged_smoke.py`: validates the bundled runtime, including `/csv.js`, native network discovery, persistence across restarts, scheduled discovery and clean shutdown.
- `python -m py_compile app.py tools/packaged_smoke.py`, `node --check web/app.js`, `node --check web/workspace.js`, `node --check web/csv.js`, `node --check tools/ui_smoke.cjs`, `node --check tools/ui_upgrade.cjs`, and `git diff --check`: passed.

## Scope and interpretation

CSV export is a user-triggered local download of the currently visible device rows. Each row includes source, export time, scan time, network scope, device name and identity, status, profile fields and discovery evidence. Demo, historical and current-discovery sources are labeled distinctly. The UTF-8 BOM supports common Windows spreadsheet import behavior. CSV cells are quoted with embedded quotes doubled; text beginning with ASCII or full-width spreadsheet formula triggers after optional whitespace/format characters or NUL is prefixed with an apostrophe. No additional network requests, discovery probes, database fields or dependencies are introduced.

