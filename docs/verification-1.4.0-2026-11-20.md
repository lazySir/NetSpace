# NetSpace 1.4.0 Verification Record

Date: 2026-11-20

## Results

- `python -m unittest discover -s tests -v`: 79 tests passed.
- `node tools/ui_smoke.cjs`: passed the CSP and offline-resource checks, the hacker-style layout, status/search composition, new review queue, topology filtering, demo isolation, export, adapter reset, camera controls, reduced-motion mode and 375 px layout.
- `node tools/ui_recovery.cjs`: passed adapter replacement and in-flight scan recovery.
- `node tools/ui_upgrade.cjs`: passed profile save and safe text handling, including removing a newly recognized device from the review queue; monitoring, events, history isolation, replay and keyboard/mobile checks also passed.
- `powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1`: rebuilt `dist/NetSpace.exe` and distribution archives with the 1.4.0 version.
- `python tools/packaged_smoke.py`: passed the standalone runtime, bundled resources and CSP headers, local discovery, inferred graph links, restart persistence, scheduled discovery and clean shutdown. The verification scan observed 3 local records and emitted no warnings.
- `python -m py_compile app.py tests/test_app.py tools/packaged_smoke.py` and `git diff --check`: passed.

## Review queue semantics

The queue is a local review aid. It excludes the local computer and includes peers whose profile is neither marked `known` nor `ignored`. A profile decision remains local and does not claim that the peer is online or identify a person.
