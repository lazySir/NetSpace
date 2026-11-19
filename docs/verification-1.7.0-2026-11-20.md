# NetSpace 1.7.0 Verification Record

Date: 2026-11-20

## Results

- `python -m unittest discover -s tests -v`: 81 regression tests passed.
- `node tools/ui_upgrade.cjs`: validates added, missing, IP-changed and unchanged device outcomes; identical snapshots; self-comparison disabled state; same-network and scan identity checks; hostile device names rendered as plain text; manual and automatic network changes; delayed requests cancelled after switching networks or entering demo mode; and the 375 px history comparison layout.
- `node tools/ui_smoke.cjs`: validates CSP, no external resources, offline 3D resources, existing device workflows and 375 px responsive layout.
- `node tools/ui_recovery.cjs`: validates adapter disconnect/reselection and in-flight discovery recovery.
- `powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1`: builds the versioned Windows single-file executable and source/Windows archives.
- `python tools/packaged_smoke.py`: validates the bundled runtime, native network discovery, history/profile persistence across restarts, scheduled discovery and clean shutdown.
- `python -m py_compile app.py tools/packaged_smoke.py`, `node --check web/app.js`, `node --check web/workspace.js`, `node --check tools/ui_upgrade.cjs`, and `git diff --check`: passed.

The browser regression also removes a selected snapshot from retained history and verifies that the selection falls back while the stale comparison summary and detail rows clear.

## Scope and interpretation

Comparison reads two stored snapshots for the currently selected network, validates both network and scan identities, and matches devices by the stable local `deviceKey`. It classifies records as added, missing from the later snapshot, IP changed, or unchanged. A device missing from a later snapshot is not confirmed offline. No new discovery probes, database tables, external requests, or real-world location claims are added. The history comparison screenshot uses synthetic browser fixtures, not a real network scan.
