# NetSpace 1.5.0 Verification Record

Date: 2026-11-20

## Results

- `python -m unittest discover -s tests -v`: 81 tests passed. Added coverage proves that worker thread startup failure does not leave discovery stuck, and that NaN or infinite durations cannot reach SQLite persistence.
- `node tools/ui_upgrade.cjs`: passed the explicit browser permission request, default/no prompt on page load, granted and denied permission states, in-page fallback after denial, privacy-safe notification text, duplicate suppression, mute behavior, and existing profile/history workflows. Notification behavior was tested with a controlled Chromium Notification API fixture; the Windows notification-center presentation itself depends on browser and Windows notification settings and was not visually verified in this run.
- `node tools/ui_smoke.cjs`: passed content security policy, no external resources, simulated topology, review queue, filtering, export and 375 px layout checks. Updated the README screenshot from synthetic demo data.
- `node tools/ui_recovery.cjs`: passed adapter disconnect/reselection and in-flight scan recovery checks.
- `powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1`: built `dist/NetSpace.exe` and Windows/source archives.
- `python tools/packaged_smoke.py`: passed standalone startup without Python on `PATH`, bundled resource and security-header checks, duplicate launch handling, local discovery, profile/settings/history persistence across executable restart, scheduled discovery, and shutdown. The observed local scan returned 3 records and 2 inferred links without warnings.
- `python -m py_compile app.py network_store.py tests/test_app.py tests/test_network_store.py tools/packaged_smoke.py`, `node --check tools/ui_upgrade.cjs`, and `git diff --check`: passed.

## Notification scope

Desktop notifications require a deliberate user action to request browser permission. Both the granted and denied permission paths were exercised; denial leaves the in-page notice available. Notifications contain only the number of newly discovered devices, not a device name, IP address, or MAC address. If permission is unavailable or denied, NetSpace uses its in-page notice. Browser notifications run while the NetSpace page remains open; they do not continue after closing the browser. The existing reminder mute switch continues to suppress notifications.
