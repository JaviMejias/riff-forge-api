# Import rollback and committed-file preservation

## Demonstrated defects

Creating a song or karaoke from another owner's public content makes an independent file copy. Previously, ownership registration, entity creation, and sync-event persistence happened in a database transaction, but the filesystem copy was not compensated when a later entity or event insert failed. SQLite correctly rolled back the rows while the new unowned copy remained on disk.

The copy failure handler also unconditionally unlinked its destination. With an exclusive-copy name collision (`EEXIST`), that destination was an existing file the request had not created. A deterministic collision test demonstrated that the previous handler removed it.

Finally, multipart create/update handlers discarded uploaded files for any caught error, including a response failure after the database transaction had already committed. Such a response error must not undo a successful file write.

## Correction

- `resolveFileReference` now requires a request-local `pendingCopies` set and adds only newly copied URLs after a successful exclusive copy. Reusing an owned file does not add it, and private foreign references are still rejected before copying.
- Song and karaoke create handlers compensate their pending copies when the transaction fails, including failures in ownership insertion, entity creation, or sync-event insertion. Cleanup resolves URLs through the existing upload-path validator and does not traverse directories.
- An exclusive-copy `EEXIST` failure leaves the existing destination untouched. Other copy errors keep the previous best-effort removal of a partially created destination.
- Create/update handlers mark success immediately after the transaction resolves. A subsequent serialization or response error is forwarded without discarding committed copies or multipart uploads.
- Each request has its own tracking set: a failed import does not discard another request's successful copy.

Successful response formats, owner isolation, public-import copying, versions, file hashes/sizes, and sync-event contracts are unchanged. The original public file and previously owned references are not cleanup targets. Nothing here repairs or deletes historical orphaned files.

## Verification

`npm test` compiles the backend and passes all 160 tests, including 23 new import/file-lifecycle cases. HTTP tests use isolated SQLite databases and temporary uploads; SQLite triggers inject real insert failures. Coverage includes entity, event, and ownership rejection, owned-file reuse, exclusive-copy collisions, partial copy errors, successful imports with matching metadata/sync snapshots, private-reference rejection, and overlapping successful/failed requests. Direct controller tests inject post-commit response failures for imports and multipart create/update operations.

The real development database fingerprint and all 42 upload fingerprints matched their pre-batch values. No frontend change, schema migration, cleanup of application files, or production deployment was performed.

## Remaining limitations

This is best-effort compensation for request failures, not a distributed filesystem/database transaction. Process crashes, ambiguous commit outcomes, or failed unlink operations can still require reconciliation. Existing retention rules for historical sync files remain in place; no blanket deletion should be used to reclaim storage. Aggregate quotas, persistent jobs, operational metrics, and a separately reviewed reconciliation process remain pending.
