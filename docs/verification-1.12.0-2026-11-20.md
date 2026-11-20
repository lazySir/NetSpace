# NetSpace 1.12.0 Verification Record

Date: 2026-11-20

## Results

- python -m unittest discover -s tests -v: 84 regression tests passed; the local service reports version 1.12.0.
- node tools/ui_smoke.cjs: local Fuse.js module, CSP, no external requests, demo isolation, CSV protections, backups, device filters and 320/375 px layouts passed.
- node tools/ui_upgrade.cjs: type filters, typo-tolerant device-name search, literal current/previous IP fragments (including the `.30` / `.130` short-fragment case), filter composition, unchanged network unread totals, visible-result CSV, empty-state export disabling, reset on network switch, hostile text, historical/demo isolation and mobile layouts passed.
- node tools/ui_recovery.cjs: adapter reconnection and in-flight scan recovery passed.
- powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1: Windows single-file executable and distribution archives built. The source package includes the pinned Fuse.js module and full Apache-2.0 license.
- python tools/packaged_smoke.py: bundled app, local Fuse.js asset, distribution license notices, native discovery, persistence, backup and scheduled discovery checks passed.
- JavaScript syntax checks and git diff --check: passed.

## Scope and handling

Search and event-type filtering run locally over the latest loaded records for the selected network. Fuse.js 7.5.0 only scores device names; numeric IP queries use literal contiguous-substring matching across the current and previous address and are not fuzzy-scored. Short fragments may match multiple addresses. The filtered list and CSV share the same result set, while the unread badge continues to count all unread events for the selected network. Switching networks clears both controls.

The browser UI test uses synthetic event names and addresses. Fuse.js is vendored from upstream tag v7.5.0 at commit 45bac9fe2e71fe8c680c861a35a8b226c4ae6d5a, loaded locally, and distributed with its upstream Apache-2.0 license.
