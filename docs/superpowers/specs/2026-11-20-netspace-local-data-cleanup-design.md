# NetSpace Local Network Data Cleanup

## Context

NetSpace stores recent discovery snapshots, device facts and profiles, network-change events, and global notification settings in one local SQLite database. Snapshot/event retention limits exist, but users cannot inspect the per-network record counts or remove all identifying database records for one network. Deleting only snapshots would leave IP addresses, MAC addresses, hostnames and profile notes in the current device table.

## Design

Add a local-data cleanup dialog reachable from the main footer. It loads a count-only catalogue of saved networks and lets the user choose exactly one. The dialog names the affected data, shows device-record/snapshot/event counts, requires a fresh confirmation checkbox, and explains that downloaded reports and backups are separate files and are not deleted.

The server exposes a read-only cleanup catalogue and a same-origin-only POST deletion endpoint. The request has exactly `networkId` and `confirmed: true`. The store validates the opaque 32-character network key, verifies the row exists, counts and deletes that network's events, snapshots, devices/profiles and network row in one SQLite transaction. It leaves other networks and global settings untouched.

Deletion is serialized with profile updates and scan persistence. A maintenance flag blocks new discovery and checks during the transaction. Cleanup is rejected while a discovery/check task or periodic discovery is active. Lock order is monitor-settings lock, persistence lock, then state lock; no monitor snapshot is read while the state lock is held. On success, in-memory observations tied to that network are cleared and a process-wide data revision increments. Browser windows periodically read the local state revision, invalidate cached records/replays/drafts on change, and refresh their catalogue.

## User-visible behavior and limits

- This is a permanent per-network deletion; it is not a selective event clear or a reversible archive action.
- Profiles for the selected network are deleted with its device records. Global notification settings and other networks remain.
- Browser downloads, manually saved database backups, and copied/exported files are outside the database and remain on disk.
- Clearing a current network removes its in-memory discovery result so it cannot continue to authorize later device checks.
- No discovery or target connection is initiated by the cleanup flow.

## Validation

Use synthetic network/device data to test count accuracy, strict target and confirmation validation, required same-origin Origin, cross-network isolation, settings preservation, atomic rollback, active-task and monitor exclusion, maintenance/start races, state revision, and stale browser-cache invalidation. Run existing Python and Chromium suites, Windows build, and packaged `--no-network` smoke test. Refresh README with a dated 1.16.0 entry and synthetic screenshot.
