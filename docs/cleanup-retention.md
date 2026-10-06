# Cleanup retention and safe operation

## Preview first

Build the current backend before using its compiled cleanup command. `npm run cleanup:sync` (or `npm run cleanup:sync -- --dry-run`) only prints a JSON report; it does not delete database rows or files. Unknown flags and combining `--apply` with `--dry-run` are rejected.

The report lists candidate filenames, expired operation receipts and optional tombstones, together with deletion counts. A preview is a point-in-time report, not authorization or a guarantee that a later run has the same candidates.

## What remains protected

- Song and karaoke file references, including soft-deleted entities.
- File URLs in every retained immutable `SyncChange` snapshot.
- File URLs in retained `ProcessedSyncOperation.serverEntity` results.
- Recently registered `FileAsset` paths, even when their file modification time is old.
- Files with a recent modification time, directories and symlinks. Cleanup does not recurse into directories or follow symlink targets.

History and receipt scans use bounded batches of 200 records. Malformed retained JSON, invalid file references or unsupported snapshot shapes abort before any deletion instead of treating uncertain data as unreferenced. Legacy null snapshot payloads are accepted; expired receipts do not need their result parsed because they are no longer retained.

`SYNC_TOMBSTONE_RETENTION_DAYS` defaults to 90, with a minimum of 30 days. Non-integer, negative and unsafe values are rejected. This is also the operation-receipt retention window: after an expired receipt is removed, replay deduplication for that operation is no longer guaranteed. Only old regular files without any protected reference become deletion candidates. Sync history is not pruned, so historical file versions can remain indefinitely. This is not a storage quota or a complete history-compaction policy.

## Applying cleanup

Do not run apply against an active application. Before considering `npm run cleanup:sync -- --apply`:

1. Arrange a maintenance window and stop every database/upload writer, including API instances, audio workers and other cleanup processes.
2. Take and verify a consistent backup of the database and uploads together.
3. Preview using the same configuration and review the candidates. Resolve malformed retained data rather than deleting history merely to bypass the guard.
4. Apply only with explicit operator approval; keep the backup and report for reconciliation.

The script rechecks candidate file type and modification time before unlinking, but reference scans do not lock out concurrent writers. There is no distributed lock or concurrent garbage-collection guarantee. Do not schedule destructive cleanup without the maintenance and backup policy above.

Database receipt/tombstone deletion runs in a transaction before file removal. A database failure at this stage rolls back that transaction and removes no files. Filesystem deletion and subsequent `FileAsset` deletion are not atomic: later errors or crashes can leave a partial cleanup or stale asset registration, and no success report is guaranteed on error. Keep writers stopped, inspect the error and reconcile against the backup before resuming; do not blindly restore database state without its matching files.

Tombstones remain indefinitely unless `PURGE_SYNC_TOMBSTONES=true` and `--apply` are both provided. Physical purge additionally requires a deployment policy forcing old clients through a full resync before accepting uploads. This backend does not yet enforce that policy; leave purge disabled without it. References collected before purge remain protected for that run, and retained history continues protecting its files afterward.

## Verification

The cleanup tests use temporary SQLite databases and upload directories, including immutable historical references, retained receipts beyond the first scan batch, recent registrations, malformed retained data, symlinks, dry-run, explicit apply and database rollback. Neither real application cleanup nor production deployment is part of this correction.
