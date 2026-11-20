# NetSpace Hacker Style and Security Iteration Plan

> **For agentic workers:** Follow the ordered iterations below. Each iteration ends with verification, a README update, a separate commit on `main`, and a push to `origin/main`.

**Goal:** Give NetSpace a distinctive hacker-style Windows UI, add useful device filtering, and improve browser-side security without changing LAN discovery boundaries.

**Architecture:** Preserve the local Python HTTP service and offline frontend. Use CSS tokens for the new visual system, a client-side status filter over the existing device result, and one shared response header for a restrictive CSP.

**Tech Stack:** Python 3.8 standard library, unittest, HTML/CSS/ES modules, Three.js 0.187.0, Playwright Chromium.

---

### Iteration 1: Hacker console UI (1.2.0)

**Files:** `web/style.css`, `web/index.html`, `web/scene.js`, `app.py`, `tools/packaged_smoke.py`, `README.md`, `docs/images/netspace-demo.png`, `docs/superpowers/specs/2026-11-20-netspace-hacker-iterations-design.md`, `tools/ui_smoke.cjs`.

- [x] Apply a black/green terminal theme with shared CSS tokens, clear focus states, reduced-motion support, and restrained topology grid/scanline styling.
- [x] Update the browser theme color and app version to 1.2.0.
- [x] Run the existing browser smoke check against isolated demo fixtures; verify screenshot, no horizontal overflow at 375px, no external requests and no JS errors.
- [x] Save the synthetic demo screenshot to `docs/images/netspace-demo.png`; update the README version, screenshot description and a dated 1.2.0 iteration entry.
- [x] Run Python tests and `git diff --check`; commit and push `feat: apply hacker console theme`.

### Iteration 2: Device evidence filters (1.3.0)

**Files:** `web/index.html`, `web/app.js`, `web/style.css`, `tools/ui_smoke.cjs`, `README.md`.

Add one labelled native select with `all`, `online`, `resolved`, `cached`, and `unverified` options. Its predicate is exact: `all` accepts every record; other options match `device.status` exactly. Apply status before search, keep selection and detail semantics unchanged, and show visible/total counts whenever either filter is active. Reset filter state when returning to the full device view from demo/replay or changing adapter.

- [x] Extend the Playwright demo fixture check to assert each status filter, combined search/filter behavior, and restoration to all devices.
- [x] Run the new browser assertions first and confirm they fail because the control/behavior is absent.
- [x] Implement the labelled selector and exact status predicate; style its keyboard, hover and disabled states in the hacker theme.
- [x] Run browser recovery and smoke tests, Python unit tests and mobile overflow checks.
- [x] Add a dated 1.3.0 README entry; run `git diff --check`; commit and push `feat: filter devices by discovery evidence`.

### Iteration 3: Content Security Policy (1.3.1)

**Files:** `app.py`, `tests/test_app.py`, `web/index.html` only if the import-map hash requires stable formatting, `README.md`.

Emit this policy from the single response path, using the verified SHA-256 hash of the static import map instead of allowing arbitrary inline scripts: `default-src 'self'; script-src 'self' <import-map-hash>; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. Keep `unsafe-inline` limited to styles because current Three.js scene labels use runtime style properties.

- [x] Add API, static-resource and 404-response tests asserting CSP, same-origin restrictions, exact import-map hash and `object-src 'none'`; new assertions failed before adding the policy.
- [x] Add the CSP header, calculated from the exact import-map payload, and keep it stable with an assertion.
- [x] Run all Python tests and browser UI/recovery/upgrade checks; inspect Chromium console for CSP violations and verify the Three.js canvas loads without external requests.
- [x] Add a dated 1.3.1 README entry describing the mitigation and residual risk accurately.
- [x] Run `git diff --check`; commit and push `security: add restrictive content security policy`.

### Iteration 4: Device review queue (1.4.0)

**Files:** `web/app.js`, `web/index.html`, `web/style.css`, `tools/ui_smoke.cjs`, `tools/ui_upgrade.cjs`, `tools/packaged_smoke.py`, `README.md`, `docs/images/netspace-demo.png`, `docs/verification-1.4.0-2026-11-20.md`.

Define a peer as needing review when it is not the local `self` record and its stored profile does not mark it `known` or `ignored`. Add an accessible checkbox beside discovery-status filtering. Compose it with the existing status selector and search, and propagate its result to visible counts, selected-device behavior, empty states, and 3D topology. Reset the checkbox when changing adapters, entering demo, or entering/leaving historical replay. Seed synthetic demo records with recognized and ignored examples so the review queue has a meaningful composition.

- [x] Extend the browser smoke check first and confirm it fails when the review-queue control is absent.
- [x] Implement the review predicate, checkbox and hacker-theme states; add demo fixtures with known/ignored profiles.
- [x] Verify the combined review/status/search filter and the profile-save transition that removes a recognized record from the queue.
- [x] Run all Python tests, browser smoke/recovery/upgrade checks, Windows build and packaged smoke; refresh and inspect the synthetic README screenshot.
- [x] Add the dated README iteration and verification record; run `git diff --check`; commit and push `feat: add device review queue`.

### Iteration 5: Network change filters and search (1.12.0)

**Files:** `web/index.html`, `web/style.css`, `web/workspace.js`, `tools/ui_upgrade.cjs`, `tools/ui_smoke.cjs`, `tools/packaged_smoke.py`, `build.ps1`, `tests/test_app.py`, `THIRD_PARTY_NOTICES.md`, `README.md`, `docs/images/netspace-events-export.png`, `docs/verification-1.12.0-2026-11-20.md`.

Reuse pinned upstream Fuse.js 7.5.0 for typo-tolerant device-name search. Match IP queries as literal substrings, compose type and text filters, and use the same selected-network result set for rendering and CSV export. Bundle the upstream license for offline Windows distribution.

- [x] Add type filtering and name/IP search, with accessible text describing fuzzy name matching and exact IP matching.
- [x] Verify search/filter composition, CSV parity, empty results, network isolation/reset, unread counts, untrusted text rendering, offline loading, and narrow layouts using synthetic fixtures.
- [x] Add the dated README entry, third-party license attribution, screenshot, and verification record; build and smoke-test Windows distribution.
- [x] Re-run all verification after the final search/attribution adjustments; commit and push `feat: filter and search network changes`.
