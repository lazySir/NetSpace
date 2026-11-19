# Windows Network Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Deliver a Windows app discovering visible LAN devices and rendering an interactive simulated 3D network map.

**Architecture:** A Windows-native collector exposes typed dictionaries to a Python standard-library loopback HTTP server. A local Three.js frontend polls scan progress, renders real devices and inferred subnet links, and offers a clearly separated demo. A frozen executable bundles the Python runtime and offline assets.

**Tech Stack:** Python 3.8+, Windows PowerShell, ctypes SendARP, Three.js modules, HTML/CSS/JavaScript, unittest, PyInstaller.

---

### Task 1: Windows collector
Files: `windows_network.py`, `tests/test_windows_network.py`.
- [x] Write and run failing tests for subnet limits, neighbor filtering and graph evidence.
- [x] Implement `list_interfaces()` and `scan_network(interface_id, progress_callback)` using Windows PowerShell and native ARP.
- [x] Ensure stale cache entries are not counted as online and large subnets have explicit scan limits.
- [x] Run collector tests and a real selected-interface scan.

### Task 2: Local UI
Files: `web/index.html`, `web/style.css`, `web/app.js`, `web/scene.js`, `web/vendor/`.
- [x] Build offline interactive 3D scene and Chinese dashboard with device list and details.
- [x] Implement scan progress polling, adapter selection, search, reset, auto-rotation, JSON export and explicit demo.
- [x] Verify empty, loading, error, real data and demo states in a browser.

### Task 3: Server and launch
Files: `app.py`, `tests/test_app.py`, `start.bat`, `build.ps1`.
- [x] Write and observe failing API tests for health, static serving, scan conflicts, input validation and loopback protections.
- [x] Implement a threaded localhost server with APIs `/api/interfaces`, `/api/state`, `/api/scan`, `/api/shutdown`.
- [x] Add browser launch, graceful exit, port fallback and logging.
- [x] Bundle offline dependencies and create a portable executable.

### Task 4: Review and delivery
Files: `README.md`, `THIRD_PARTY_NOTICES.md`, `dist/`.
- [x] Review requirements and code quality with an independent agent.
- [x] Run all tests, exercise a real scan, visually verify browser interactions and launch packaged executable.
- [x] Provide the executable, source and concise Chinese usage instructions.
