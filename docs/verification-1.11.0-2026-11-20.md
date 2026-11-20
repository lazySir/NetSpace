# NetSpace 1.11.0 Verification Record

Date: 2026-11-20

## Results

- `python -m unittest discover -s tests -v`: 84 regression tests passed; the local service reports version 1.11.0.
- `node tools/ui_smoke.cjs`: local database backup download, error/retry behavior, stopped state, layout, CSP, offline resources, and no external requests passed.
- `node tools/ui_upgrade.cjs`: event CSV download includes BOM and stable columns; four event kinds retain correct IP and offline caveat; formula-like/device markup text with commas, quotes and CRLF round-trips safely; exports contain only the selected network's loaded latest 50 records; empty, demo, and historical views disable export; 320 px layout and updated screenshots passed alongside existing CSV and history regressions.
- `node tools/ui_recovery.cjs`: adapter switch and in-flight discovery recovery passed.
- `powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1`: Windows single-file executable and distribution archives built.
- `python tools/packaged_smoke.py`: bundled Windows executable passed native discovery, local SQLite backup integrity and download, persistence across restarts, scheduled discovery, and clean shutdown.
- Python bytecode compilation, JavaScript syntax checks, and `git diff --check`: passed.

## Scope and handling

The network changes tab downloads the latest loaded event records for the selected network as a UTF-8 CSV. The export is created locally and reuses existing CSV quoting and spreadsheet formula-injection protection. It contains event type, timestamp, device name, previous/current IP, network range and export source; event records from other networks are filtered out.

Only up to 50 records are loaded by the existing local API. Empty, demo, historical replay and stopped states disable the control. A “not seen” record is described as an observation, not proof of offline status. The interface tells the user that exported files can contain device names and local IP addresses.
