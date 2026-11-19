# NetSpace 1.3.1 Verification Record

Date: 2026-11-20

## Results

- `python -m unittest discover -s tests -v`: 79 tests passed.
- `node tools/ui_smoke.cjs`: passed CSP response assertions, import-map and module loading, Three.js scene rendering, device filters, demo/export flows, adapter switching, reduced-motion mode, 375 px layout and offline-resource checks. Chromium reported no CSP violations, JavaScript errors or external requests.
- `node tools/ui_recovery.cjs`: passed adapter-disconnect, adapter-replacement and in-flight scan recovery checks.
- `node tools/ui_upgrade.cjs`: passed profile persistence, safe-text rendering, monitoring, events, history isolation, replay and keyboard/mobile checks.
- `powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1`: successfully produced the standalone Windows executable and distribution archives.
- `python tools/packaged_smoke.py`: passed packaged runtime without Python on PATH; validated CSP headers and bundled assets, real local discovery, inferred graph links, persisted profiles/history/settings across restart, scheduled scans and clean shutdown. The verification scan observed 3 local records and emitted no warnings.
- `python -m py_compile app.py tests/test_app.py tools/packaged_smoke.py` and `git diff --check`: passed.

## Scope and limits

The CSP is browser-side defense in depth. It narrows script, connection, object, frame and form capabilities; it does not replace input validation, OS protections, or careful handling of local network data. The packaged discovery check runs against the network connected to the verification machine and does not establish that every peer is visible on every Wi-Fi, VLAN, or router configuration.
