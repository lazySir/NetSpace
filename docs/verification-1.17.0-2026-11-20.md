# NetSpace 1.17.0 verification

Date: 2026-11-20
Platform: Windows 10, Python 3.8.7, headless Chromium
Scope: manual discovery at startup, synthetic demo shortcut and regression coverage.

## Behavior and evidence

- Before the implementation, the new idle-start browser test failed because opening the page issued one `/api/scan` request with `{interfaceId: 'A'}`.
- After the implementation, idle open and reload, adapter changes, and entering/leaving both demo entry points issue no discovery requests. An explicit discovery click sends exactly one request for the selected adapter.
- Completed reload does not initiate another scan; existing scan recovery, explicit retry, and conflict-join scenarios remain covered.
- Disconnected startup keeps discovery disabled while the demo remains available. Re-reading an empty adapter list makes one adapter request and no discovery request.
- A focused 320 px assertion reproduced the collapsed monitor interval dropdown before the CSS fix. The interval selector now has a nonshrinking 92 px minimum; surrounding controls wrap instead.
- All browser API requests in the startup, recovery and smoke fixtures are intercepted. Screenshots contain fabricated adapters and devices. No real device discovery, port connection or attack was performed.
- The packaged `--no-network` smoke verifies the executable and bundled resources without enumerating adapters or starting discovery. It does not execute browser JavaScript; the idle-start browser regression above is the evidence for page behavior.

## Verification results

| Check | Result |
| --- | --- |
| `python -m unittest discover -s tests -q` | PASS — 131 tests |
| `node tools/test_device_check_report.cjs` | PASS — 11 checks |
| `node tools/test_device_check_tasks.cjs` | PASS — 3 checks |
| `node tools/ui_recovery.cjs` | PASS — passive startup, disconnected demo and 4 existing recovery scenarios |
| `node tools/ui_smoke.cjs` | PASS — explicit discovery, CSP, offline assets, export and layout checks |
| `node tools/ui_upgrade.cjs` | PASS — scan polling, history, events, cleanup and cross-window invalidation |
| `node tools/ui_device_check.cjs` | PASS — consent, fixed results, task isolation, report, expiry and 320 px layout |
| `git diff --check` | PASS |
| `build.ps1 -OutputDirectory artifacts/release-1.17.0` | PASS — single-file executable, Windows ZIP and source ZIP |
| `python tools/packaged_smoke.py --exe artifacts/release-1.17.0/NetSpace.exe --no-network --port 18766` | PASS — bundled runtime, matching offline resources, single instance, idle tasks and clean shutdown |

The recovery and smoke runs used `NETSPACE_URL=http://127.0.0.1:18765`. The device-check regression used `NETSPACE_DOC_IMAGES=artifacts/verification-1.17.0/device-check`; the upgrade regression used `NETSPACE_DOC_IMAGES=artifacts/ui-upgrade-stability`. These output directories hold only generated validation artifacts.

## Review and screenshots

Read-only review found no concrete blocking security or functional defect in the startup changes. Explicit retry may start discovery after adapters become available; the README describes this behavior.

The scan-controls fixture now holds completion until disabled controls have been checked. The notification fixture waits for mark-read completion before capturing its toast baseline and changing mute state. These explicit completion barriers replace timing assumptions; no notification production code changed. Regression image output can be directed to a separate directory through `NETSPACE_DOC_IMAGES`, avoiding unrelated documentation image rewrites.

- `docs/images/netspace-manual-start.png` — synthetic desktop startup page.
- `docs/images/netspace-manual-start-320.png` — synthetic 320 px startup page.
