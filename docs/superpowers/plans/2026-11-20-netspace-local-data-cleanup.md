# NetSpace Local Data Cleanup Implementation Plan

> **For agentic workers:** Follow these tasks in order. Each task has a focused test cycle; the complete iteration ends with verification, a README entry, one commit, and push.

**Goal:** Let a novice permanently delete all local database records for one selected network while preserving other networks and global settings.

**Architecture:** Add count-only catalogue and atomic database deletion methods, coordinate deletion with scan/check/monitor state, and expose a same-origin API. A separate frontend controller presents per-network counts and requires explicit confirmation; a state revision invalidates cached records across open windows.

**Tech Stack:** Python 3.8 standard library, SQLite, HTML/CSS/ES modules, existing Playwright Chromium fixtures.

**Spec:** `docs/superpowers/specs/2026-11-20-netspace-local-data-cleanup-design.md`

## Global Constraints

- Delete exactly one selected network per request; keep other networks and the global notification setting.
- A deletion must remove events, snapshots, current device facts/profiles, and the network row in one transaction.
- Require an exact same-origin request and `confirmed: true`; never accept client-supplied IPs, table names, or record IDs.
- Reject deletion while discovery, either device check, or periodic discovery is active; block new work while cleanup runs.
- Development and verification use synthetic records only and never discover or connect to real LAN devices.

---

### Task 1: Store inventory and atomic deletion

**Files:** Modify `network_store.py`; test in `tests/test_network_store.py`.

- [x] Add a count-only per-network catalogue with stored-device, snapshot, and event counts.
- [x] Add strict validation and one-transaction deletion in events → scans → devices → networks order.
- [x] Test exact counts, unknown/malformed keys, another network's data, preserved settings, and rollback after a forced device-row delete failure.

### Task 2: Serialized application state and API

**Files:** Modify `app.py`; test in `tests/test_app.py`.

- [x] Add a maintenance conflict error and process data revision to state snapshots.
- [x] Serialize deletion with monitor settings and persistence; reject active scans/checks/monitor; block new scans/checks until completion.
- [x] Invalidate in-memory result and check observations for the deleted network.
- [x] Add read-only count catalogue and same-origin exact-field delete API.
- [x] Test authorization, method/origin/field/key validation, atomic response counts, state invalidation, revision increments, active task and periodic monitor conflicts, and no network probe calls.

### Task 3: Novice-facing cleanup dialog

**Files:** Create `web/data-cleanup.js`; modify `web/index.html`, `web/app.js`, `web/style.css`; test with `tools/ui_data_cleanup.cjs`.

- [x] Add a footer action and accessible hacker-theme dialog listing count-only network records.
- [x] Require a fresh checkbox confirmation for the selected network; disable deletion during active tasks, monitor, loading, or empty catalogue.
- [x] Explain what is removed, what global data remains, and that downloaded backups/exports are unaffected.
- [x] Observe state data-revision changes in `web/app.js` and `web/workspace.js`; invalidate cached result maps, history, events, comparisons, drafts and outstanding reads before refreshing.
- [x] Verify hostile labels are text-only, target ID and confirmation payload are exact, layout fits 320px, and revision changes remove stale data from open views. Capture synthetic desktop and narrow screenshots.

### Task 4: Documentation, release and delivery

**Files:** Modify `README.md`, `tools/packaged_smoke.py`, `tests/test_app.py`; add `docs/verification-1.16.0-2026-11-20.md` and synthetic screenshots.

- [x] Set version 1.16.0 in app, expected test/smoke values, and README header.
- [x] Add novice instructions, consequences, limits, GitHub/reuse note, screenshot, and dated 1.16.0 iteration entry.
- [x] Run all Python tests, cleanup UI test, existing Chromium suites, report/task tests, `git diff --check`, Windows build, and packaged smoke with `--no-network`.
- [x] Review the final diff, commit one iteration as `feat: add per-network local data cleanup`, verify clean state, and push `main`.
