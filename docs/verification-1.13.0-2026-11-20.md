# NetSpace 1.13.0 Verification Record

Date: 2026-11-20

## Validation results

- `python -m unittest discover -s tests -v`: 101 tests passed. All service probes use injected substitutes or patched socket connectors. Source-address binding and backend propagation, origin/field validation, duplicate JSON keys, snapshot identity/freshness, network changes, rejected address classes, concurrency, cancellation, shutdown and worker-start recovery are covered.
- `node tools/ui_device_check.cjs`: passed with a standalone loopback static fixture server and intercepted APIs. Covers explicit single-run consent, the exact POST fields, results, cancellation, errors, delayed responses, network/device/scan identity, changed IP, five-minute expiry, demo/history/self/scanning/stopped states, keyboard focus and 320 px layout. An already authorized check remains viewable/cancellable after its discovery record expires; a fresh check is disabled.
- Existing browser suites `ui_smoke.cjs`, `ui_upgrade.cjs` and `ui_recovery.cjs`: passed against a loopback server with fake providers and browser API fixtures. These retain CSP, offline assets, safe text/CSV, profiles, history, event filters, notification, backup and reconnection coverage. The first concurrent `ui_upgrade.cjs` run timed out waiting for initial history options; its isolated rerun passed with no product change. The cause of that one timeout was not established.
- Windows build and `python tools/packaged_smoke.py --no-network --port 18766`: passed. The executable starts without Python on PATH, serves bundled resources identical to source, preserves a single instance, keeps discovery/monitor/check idle, and shuts down. The final UI was rebuilt and rechecked using byte-for-byte packaged/source asset comparisons.
- JavaScript syntax checks and `git diff --check`: passed; Git only reports the configured LF-to-CRLF conversion notices.
- The native-network path of `tools/packaged_smoke.py` was deliberately not run. Previous versions' results are not evidence of a 1.13.0 native-network test.

## No real-device network testing

All development verification for this iteration uses synthetic adapters, discovery records, service results, and injected connection substitutes. No real discovery scan or TCP connection to a device is performed by these tests. The new feature contains a real TCP-connect implementation for authorized use after installation; the screenshot and automated tests do not demonstrate a live device check.

Screenshot: `docs/images/netspace-device-check.png`. The device name, address, and results are fabricated test fixtures.

## Verified behavior and limits

- No check starts automatically; opening the dialog alone makes no connection attempt. Every new run requires a fresh explicit authorization checkbox.
- The browser submits a network identifier, device identifier, and authorization; it cannot provide an arbitrary address or port list.
- The server resolves only another device from the current process's latest discovery result, no older than five minutes. It revalidates the current adapter's IP address, prefix length, gateway, and MAC.
- Targets must be inside both the current adapter subnet and discovery scope and within RFC 1918 ranges. Public, loopback, link-local, multicast, reserved, network/broadcast, and local-machine addresses are rejected.
- The fixed TCP port list is 21, 22, 23, 80, 443, 445, and 3389. Connection substitutes verify the selected source address, timeout, and immediate socket closure without sending application data.
- Outcomes distinguish accepted connection, refused connection, no response before timeout, and unavailable due to other errors. An accepted connection is not a vulnerability finding or service fingerprint.
- Only one check runs at a time; progress, cancellation, service shutdown, discovery concurrency, stale selections, adapter changes, demo and historical views are covered using substitutes. Results retain networkId, deviceKey and scanId, preventing a previous address's results from following the device into a new snapshot.
- Names and messages render as text, CSP and offline loading remain intact, and the dialog is usable on desktop and narrow screens.
- Results remain process memory only and are not inserted into SQLite profiles, events, scan history, or backups.

## Product meaning and limits

The feature attempts a TCP connection to seven common service ports on one selected, authorized private-network device, then closes each successful connection. It does not authenticate, send application payloads, exploit vulnerabilities, alter device settings, or identify the software behind a port. The target may log the connection attempts. A timeout does not prove that a port is closed, and an open port does not prove that a device is vulnerable or compromised. Default discovery does not perform port checks.

Matching adapter parameters and recent observations do not authenticate the physical target. A network move that retains identical adapter parameters or reuse of an address cannot be fully distinguished by this feature. These checks reduce accidental target changes; they do not provide cryptographic identity.

Independent code review found and prompted fixes for adapter changes, result identity loss, and the expiry/cancel UI boundary. Final review found no blocking issue within the reviewed scope; this is not a claim that the application is free of vulnerabilities.

## GitHub and official-source review

- Existing bundled dependencies remain Three.js 0.187.0 with OrbitControls (MIT) and Fuse.js 7.5.0 (Apache-2.0, upstream commit `45bac9fe2e71fe8c680c861a35a8b226c4ae6d5a`). Their upstream licenses are already vendored and distributed.
- The new check uses Python's standard-library socket API and introduces no scanner dependency. Official API: <https://docs.python.org/3.8/library/socket.html#socket.create_connection>. CPython runtime notices remain part of the distribution.
- Nmap is a design reference, not an integrated dependency or copied implementation. Official TCP-connect description: <https://nmap.org/book/scan-methods-connect-scan.html>. Reviewed upstream commit: <https://github.com/nmap/nmap/tree/bb81d1392145080d93ff50d91e1598bdde5248e3>; its LICENSE is NPSL 0.95. Official licensing page: <https://nmap.org/book/man-legal.html>. The limited seven-port feature does not require bundling Nmap or Npcap, and their redistribution conditions are not assumed to be ordinary GPL terms.
- OWASP Secure Headers is a future reference, not an implemented webpage audit: <https://github.com/OWASP/secure-headers-project/tree/0e7ad7d75ee45e02b55d1b426c4c5e43ef8b7de0>, Apache-2.0. No HTTP content is fetched by this TCP-only check.

The source review fetched official GitHub files and documentation only. GitHub REST requests were rate-limited, so upstream identities were checked with read-only `git ls-remote` and pinned raw files instead. No scanning tool was installed or executed for this review.
