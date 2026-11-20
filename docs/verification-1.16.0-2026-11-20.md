# NetSpace 1.16.0 verification

Date: 2026-11-20
Platform: Windows 10, Python 3.8.7
Scope: per-network local data cleanup; test data and browser API responses were synthetic. No real device discovery, port connection, or network attack was performed.

## Results

| Check | Result |
| --- | --- |
| `python -m unittest discover -s tests -v` | PASS — 131 tests |
| `node tools/test_device_check_report.cjs` | PASS — 11 checks; no network operations |
| `node tools/test_device_check_tasks.cjs` | PASS — 3/3 checks; no network operations |
| `node tools/ui_upgrade.cjs` | PASS — Chromium regression for cleanup confirmation, hostile labels, cross-window revision invalidation, stale history responses, and existing history/event workflows |
| `node tools/ui_device_check.cjs` | PASS — Chromium regression; APIs mocked, no scans or target connections |
| `node tools/ui_smoke.cjs` | PASS — CSP, local assets, accessibility/layout and export smoke checks |
| `node tools/ui_recovery.cjs` | PASS — 4 adapter switching, scan recovery and polling scenarios |
| `git diff --check` | PASS |
| `build.ps1 -OutputDirectory artifacts/release-1.16.0` | PASS — Windows single-file executable and source archive created |
| `python tools/packaged_smoke.py --exe artifacts/release-1.16.0/NetSpace.exe --no-network --port 18766` | PASS — bundled runtime, offline resources, duplicate-launch guard, idle network features and clean shutdown |

The packaged smoke used `--no-network`; it did not enumerate interfaces or contact network devices. The security review found no concrete blocking issue in the cleanup feature.

## Screenshot fixtures

`docs/images/netspace-data-cleanup.png` and `docs/images/netspace-data-cleanup-320.png` show the cleanup dialog using fabricated network labels and record counts.
