# NetSpace 1.6.0 Verification Record

Date: 2026-11-20

## Results

- python -m unittest discover -s tests -v: 81 tests passed. The v1.5.0 worker-start recovery and finite-duration persistence checks remain green.
- node tools/ui_smoke.cjs: passed the profile-group filter on live fixture data and synthetic demo data, including grouped and ungrouped options, composition with review/status/search filters, 3D node visibility, adapter reset, CSP, no external resources, responsive layout and export.
- node tools/ui_upgrade.cjs: passed adding a group after saving a profile, changing the group, clearing it, removing unused options, filtering cleared profiles as ungrouped, and preserving existing profile/history/notification workflows.
- node tools/ui_recovery.cjs: passed adapter disconnect/reselection and in-flight scan recovery checks.
- powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1: built the v1.6.0 Windows single-file executable and Windows/source archives.
- python tools/packaged_smoke.py: passed the bundled-runtime checks, startup without Python on PATH, Windows native discovery, profile/settings/history persistence across restarts, scheduled discovery and shutdown. This run discovered 3 records and 2 inferred links without warnings.
- python -m py_compile app.py tools/packaged_smoke.py, node --check web/app.js, node --check tools/ui_smoke.cjs, node --check tools/ui_upgrade.cjs, and git diff --check: passed.

## Scope

The group filter is derived from profiles already present in the selected result. It is local-only, does not add discovery traffic, and does not claim physical location or network-port topology. Empty groups are represented by “未分组”. Changing a profile updates the options without changing historical snapshots.
