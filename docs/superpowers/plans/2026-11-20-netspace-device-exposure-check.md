# NetSpace 单设备服务暴露检查实施计划

> **For agentic workers:** Follow tasks in order with test-first changes. Each iteration receives its own README entry, verification record, commit, and push.

**Goal:** Add a beginner-friendly, real but non-destructive TCP exposure check for one explicitly authorized, recently observed peer.

**Architecture:** Add a testable fixed-port checker and an asynchronous task state in the loopback service. Resolve the address from the latest stored scan by device key, reject arbitrary targets and stale/self/out-of-range devices, and expose a same-origin protected API. Add a confirmation dialog and clear Chinese result explanations in the selected device details.

**Tech Stack:** Python standard library, unittest, HTML/CSS/ES modules, Playwright Chromium, existing SQLite store, Windows PyInstaller build.

**Spec:** docs/superpowers/specs/2026-11-20-netspace-device-exposure-check-design.md

## Global Constraints

- Never execute an attack or check a real device during development or verification.
- Target only the latest stored IPv4 device record selected by deviceKey; never accept IP, range, or port values from the browser.
- Check only TCP ports 21, 22, 23, 80, 443, 445, and 3389 serially, with a 350 ms per-connection timeout.
- Never send application data, credentials, exploit code, or repeated requests; do not persist or log check results/targets.
- Keep the service bound to 127.0.0.1, preserve existing protections, and require explicit user confirmation for every run.

---

### Task 1: Fixed TCP probe and back-end API

**Files:** Create device_check.py, tests/test_device_check.py; modify app.py, tests/test_app.py.

- [x] Add unit tests proving the checker uses only the fixed port list, classifies connected/refused/timeout outcomes, and closes established sockets; use injected socket factory only.
- [x] Add API tests using a synthetic stored scan and an injected fake checker. Cover explicit confirmation, rejection of extra/arbitrary-target fields, exact same-origin, latest-snapshot membership, stale/self/out-of-range devices, duplicate requests, scan mutual exclusion, cancellation, shutdown, no persistence, and no checker calls on rejection.
- [x] Run targeted tests and verify the new cases fail for missing behavior.
- [x] Implement validation, ephemeral task status, serial background checks, cancellation, fixed port outcomes, and strict request-origin validation.
- [x] Run targeted tests to green and all Python tests.

### Task 2: Beginner UI and browser regression

**Files:** Modify web/index.html, web/app.js, web/style.css; add web/device-check.js and tools/ui_device_check.cjs.

- [x] Add browser tests for visibility only on real current peer detail, authorization checkbox, explicit click, cancellation/status/result copy, and no requests from demo/history or selection alone.
- [x] Run the browser test first and verify it fails because the check UI is absent.
- [x] Implement responsive cyber-style confirmation dialog, accessible progress/results, plain-language explanations, and cancel control.
- [x] Run node tools/ui_smoke.cjs, node tools/ui_upgrade.cjs, and node tools/ui_recovery.cjs; confirm no external requests, JavaScript errors, or small-screen overflow.
- [x] Capture a synthetic fixture screenshot to docs/images/netspace-device-check.png.

### Task 3: Documentation, build and delivery

**Files:** Modify README.md, create docs/verification-1.13.0-2026-11-20.md, version in app.py.

- [x] Document the fixed checks, permission warning, result meanings, privacy, non-goals, screenshot, and 1.13.0 dated changelog.
- [x] Run the complete Python and browser checks, JavaScript syntax checks, git diff --check, and Windows single-file build. Do not run packaged smoke routines that call native LAN discovery.
- [x] Review the diff for destination expansion, shell execution, unintended persistence/logging, or automatic calls. Delivery uses the user's authorized commit and push workflow; the commit is recorded in Git history.
