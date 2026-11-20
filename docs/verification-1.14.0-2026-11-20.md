# NetSpace 1.14.0 Verification Record

Date: 2026-11-20

## Scope

This iteration exports existing service-check observations as a local Chinese text report and fixes task identity and delayed-response problems. It introduces no exploit, application payload, scanner dependency, automatic service check, or additional target connection.

The real TCP-connect implementation from 1.13.0 remains available for a user's explicit authorized use. During development, real LAN discovery, device connections and attacks are prohibited. Tests use synthetic adapters, discovery records, fake probes and controlled responses. Loopback HTTP serves application resources and test fixtures only.

## Completed checks

- Python unit tests: 108 passed, including seven new API and task regressions. Both live and latest saved scan identifiers must match the submitted positive integer scanId; old authorization cannot follow a stable MAC/device key to a new IP. Cancellation validates the exact field set and a 32-character lowercase hexadecimal runId before any effect. An old run cannot stop a repeated check of the same device and scan. Progress, terminal states, worker-start errors, close and shutdown retain or cancel the correct internal task.
- Pure report tests: 11 passed. Cover complete, cancelled and error results, seven canonical ports, untested entries, counts derived from observations, network/device/scan/current-address matching, self exclusion, malformed/empty/nonterminal results, unknown or duplicate ports, fixed service labels, name injection, direction controls, time parsing, BOM, CRLF and input immutability.
- In-memory task ordering tests: 3 passed. A delayed cancellation refresh cannot overwrite a newer explicitly started task; destroying a controller prevents pending responses from rendering; an old poll cannot replace cancellation results even for the same run. These tests use fake DOM elements, API functions and timers with network access disabled.
- Targeted browser suite ui_device_check.cjs passed with a standalone loopback static server and intercepted APIs. It downloads both complete and cancelled reports, verifies BOM and actual generation dates, checks the fixed filename and port text, ensures export adds no POST, rejects wrong network or scan results, and holds an old GET while a replacement run starts. The new run remains visible and cancellable after the old response arrives. Expired results remain exportable while new checks stay disabled. Keyboard focus and 320 px layout passed; screenshots were visually inspected.
- Existing browser suites ui_smoke.cjs, ui_upgrade.cjs and ui_recovery.cjs passed against a loopback server with fake adapter, discovery and port-probe providers. They cover CSP, local assets, profiles, history, CSV and safe text, event filters, notifications, backups, reconnect behavior, 3D rendering and narrow layouts. Each browser suite passed on its first run in this iteration.
- Windows build and python tools/packaged_smoke.py --no-network --port 18766 passed. The executable starts without Python on PATH, serves bundled resources byte-for-byte equal to source (including device-check-report.js), keeps one instance, leaves discovery/monitor/service checks idle and exits cleanly. Native-network acceptance was not run.
- JavaScript syntax checks and git diff --check passed. Git's configured LF-to-CRLF conversion notices are informational.

## Reproductions and review

Independent review first reproduced two backend problems with fake probes: an old cancellation could stop a newer run, and a request lacking the user's scanId could resolve a newer IP. New regression tests failed before the fixes and passed afterwards.

Review then reproduced two delayed-response paths: an old progress read could replace a newer task, and a pending cancellation refresh checked its generation only before awaiting the result. The latter also allowed rendering after destruction. A browser regression failed on the former; two of the three in-memory task tests failed on the latter before the product fix. Final review and all three in-memory tests passed after response identity and generation checks were added.

No additional blocking issue was found in the reviewed scope. This is not a claim that NetSpace is free of vulnerabilities.

## Report behavior and limits

- Export only formats matching observations already held in memory; it does not call an API or connect to a target. The filename uses a fixed prefix and the generation date, never a device-provided string.
- Only ended tasks with valid observations can be exported. Cancelled or failed checks keep the available observations and explicitly mark other fixed ports untested. A running task, demo, history, wrong network or new scan cannot borrow a previous result.
- A matching result remains viewable and exportable after its discovery record ages past five minutes; starting a fresh check still requires fresh discovery and authorization.
- Windows text output uses UTF-8 BOM and CRLF. Device names and addresses are bounded single-line text; control characters and direction-changing marks are removed. MAC addresses, custom notes and task cancellation identifiers are omitted.
- The report labels discovery time and report generation time separately. The application does not record the exact check time, so neither field is presented as a check timestamp.
- Downloaded reports contain device names, IP addresses and results and remain in the download folder after application exit. They are separate from SQLite backups and should be reviewed before sharing.
- An accepted TCP connection is an observation, not a vulnerability or a service fingerprint. A timeout is inconclusive. The product still does not authenticate, send application data, exploit vulnerabilities or change device settings.
- Fresh snapshots and matching adapter parameters reduce accidental target changes but do not authenticate a physical device or prevent address reuse.

## Screenshots

- docs/images/netspace-device-check-report.png
- docs/images/netspace-device-check-report-320.png

All screenshot devices, addresses and observations are fictional fixtures. They do not demonstrate a check of a live device.

## Dependencies

No new third-party dependency was added. Existing bundled Three.js, OrbitControls and Fuse.js are reused, together with standard browser Blob downloads and Python's standard library. Prior pinned upstream references and licenses remain documented in README and THIRD_PARTY_NOTICES.md.
