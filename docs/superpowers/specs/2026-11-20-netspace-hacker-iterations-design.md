# NetSpace Hacker UI and Iterative Hardening

## Context

NetSpace already provides Windows-only LAN discovery, persistent device records, history, monitoring and an offline Three.js topology. The current interface is dark and responsive, but its blue/cyan palette reads like a conventional monitoring dashboard rather than the requested hacker-style network console. Existing discovery evidence and safety boundaries must remain explicit.

## Design

Keep the current three-column workflow and all existing behavior. Establish a black/green terminal-console visual system through shared CSS tokens, a restrained grid/scanline treatment in the topology viewport, brighter status/focus feedback, green Three.js node materials and monospace emphasis for addresses and telemetry. Avoid flashing, matrix-rain animation, color-only status cues and layout changes that harm mobile or keyboard use. Refresh the README screenshot using only the application's synthetic demo data.

Then add a discovery-status filter for all devices, confirmed-online devices, resolved-but-not-confirmed devices, cached records, and unverified devices. The filter composes with current search, updates visible counts, and does not relabel evidence.

Finally, strengthen loopback HTTP responses with a Content Security Policy that permits the bundled same-origin modules and the exact static import map, blocks external connections and plugin/object content, and works with the existing inline positioning styles. Preserve current Origin/Host protections and offline behavior.

## Validation and delivery

Each iteration receives its own README entry, fresh relevant tests and an independent commit on `main`, then is pushed to `origin/main`. UI changes are checked in Chromium at desktop and 375px widths with reduced motion and synthetic fixtures. Security changes are tested on both JSON and HTML responses and exercised by Chromium to prove the import map and 3D modules still load. Python tests, browser checks and git diff checks run before each commit.

The security review reports evidence and residual exposure; it must never claim that all vulnerabilities are eliminated. This application intentionally scans only the user's selected local network and does not infer real-world device locations.
