# Backend hardening: first implementation

This batch establishes isolated tests and closes the initial audio and file-ownership issues. It does not complete the full backend action plan.

## Validation

Run `npm test`. Compilation is written to a temporary directory, and each integration test file uses its own SQLite database and upload directory. Tests do not rebuild tracked `dist/` or use the application database. CI now executes the suite before deployment.

The audio tests simulate yt-dlp and FFmpeg. They exercise real HTTP routes, Prisma transactions, uploads, ownership, and synchronization events without external downloads or native audio tools.

## File ownership

`FileAsset` records the owner of each uploaded, downloaded, or generated file before the client can reference it. Private paths belonging to another user are rejected. Importing an owner's public content creates a new file owned by the importer.

The ownership migration seeds paths referenced by a single user. Legacy paths referenced by multiple users are deliberately left unclaimed and need manual resolution; no user can authorize their processing or removal through an ambiguous reference. A unique legacy owner can also be registered on first access once the table exists.

Removing audio detaches it from the selected karaoke and publishes the sync change. Physical removal is deferred to retention-based cleanup to preserve other references. The test suite exercises cleanup only on isolated fixtures; it never cleans application data.

## Deployment prerequisite

This version requires the new `20261004000000_add_file_ownership` migration. Initial implementation tests did not modify the application database. Subsequently, both pending migrations were applied to the local development database after a consistent backup and rehearsal on a restored copy. The original application records and all 42 uploads were preserved. See [local-validation.md](local-validation.md). Production has not been migrated or deployed.

Before applying it to an existing installation, back up SQLite and uploads, inspect the migration history, and establish a baseline if that database was built using `db push`. Do not blindly run historical migrations against existing tables. See [database-migrations.md](database-migrations.md).

## Migration and build separation

Build now generates Prisma and compiles TypeScript without modifying SQLite. Start only starts the compiled server. `npm run db:migrate` explicitly applies pending migrations with Prisma 5.22. CLI and runtime share an absolute SQLite URL, with relative paths resolved against the Prisma schema directory.

The forward-only `20261004010000_repair_legacy_playlists` migration repairs the reversed song/playlist relation only for untouched version-one rows matching the historical defective value and an initial sync event without a payload. Rows with newer versions, immutable snapshots, different ordered IDs, or tombstones are preserved. Repaired rows get a new version and immutable sync event. Legacy songs belonging to another user or already deleted are excluded. The historical migration is not edited.

Integration tests now apply migrations through Prisma's actual migration history. Docker uses the lockfile with `npm ci` and excludes local databases from its build context. Deployment runs the separate migration step before replacing the API container. None of these changes have been deployed.

## Legacy conflict protection

Legacy song/karaoke metadata edits and deletes now require a server version and perform a conditional database update. Whole-collection writes require a user/type-scoped `X-Collection-Version` token, including tombstones, before omitted items can be deleted. Conflicts return the current owner-scoped snapshot and rejected batches leave no changes or events behind.

File-only multipart uploads also require a version. The coordinated frontend change supplies it, preserves local bytes on 409 and blocks automatic re-upload until the user selects a file again. The sync v2 request/response contract is unchanged. See [legacy-write-conflicts.md](legacy-write-conflicts.md) for the intentionally stricter legacy contracts.

## Private file transport

The static uploads mount is replaced by an authorized GET/HEAD route. Owners can access registered files; anonymous readers can access only files referenced by active public content belonging to the file owner. Ambiguous legacy ownership is denied. Downloads use Bearer headers, no-store caching and session guards; the player creates local blob URLs rather than exposing a private remote URL to the audio element. See [private-files.md](private-files.md).

## Input validation and sync failure handling

Library writes now reject malformed text, names, booleans, dates, and pitch before persistence. Authentication/settings validate their input types. Legacy collection validation preserves batch rollback, and catalog pagination rejects malformed values with a maximum of 200 results.

Sync distinguishes expected per-operation rejections from unexpected internal errors. An injected database failure after entity creation or update now rolls back the full operation batch, events, and receipts. Shared chord-array validation now prevents malformed JSON/vector data from reaching new snapshots and normalizes accepted legacy CSV on explicit writes. See [input-validation.md](input-validation.md) for contracts, compatibility, and remaining work. The suite contains 108 passing tests and uses isolated databases. The chord follow-up detected and preserved concurrent development additions (one song and one karaoke with their sync records); previous application rows and all 42 uploads were unchanged, and no test-fixture users were present in the real database.

## Read-only pagination

Community now accepts validated `page`/`limit` parameters while retaining array responses; pagination metadata is exposed in CORS-readable headers. New owner-scoped `/api/library/:entityType` routes provide paginated sync-shaped records without a whole-collection replacement token. Existing full-list routes remain unchanged to avoid turning a partial response into destructive collection replacement input. See [pagination.md](pagination.md).

The pagination follow-up passes all 126 tests (18 new cases), including TypeScript compilation and isolated HTTP/database integration checks. The real development database and all 42 uploads matched their pre-batch fingerprints. No migration or frontend change was made in this follow-up; loading additional pages in the interface remains pending.

## Bounded audio jobs and output publication

Downloads, YouTube metadata, and new pitch conversion work now share a two-job limit per Node process and a one-job limit per authenticated user. Busy requests receive explicit 429/503 responses with CORS-readable `Retry-After`; no unbounded queue is created. Identical pitch requests still share a job, and owned cache hits or zero pitch require no native capacity.

New pitch output is published only after ownership insertion succeeds, with registration rollback if rename fails. This closes the demonstrated unowned-output leak on a rejected ownership insert; it does not make filesystem publication and database commit fully atomic against crashes. See [audio-jobs.md](audio-jobs.md) for contracts and remaining limitations.

The audio-job follow-up passes all 137 tests (11 new cases), including compilation and real isolated HTTP/SQLite checks with simulated native tools. The real development database and all 42 uploads matched their pre-batch fingerprints. No migration, frontend change, or production deployment was made.

## Import rollback and committed-file preservation

Song/karaoke imports now track their independent public-file copies per request and compensate them when later database writes fail. Exclusive-copy collisions no longer delete an existing destination. Multipart create/update failures after a successful database commit no longer discard the committed upload. Successful import, metadata, and sync contracts are unchanged; historical files are not cleaned up. See [import-rollback.md](import-rollback.md).

The import follow-up passes all 160 tests (23 new cases), including compilation, isolated HTTP/SQLite failures, partial-copy/collision checks, overlapping imports, and post-commit response failures. The real development database and all 42 uploads matched their pre-batch fingerprints. No migration, frontend change, or production deployment was made.

## Protected cleanup and non-mutating preview

Cleanup now preserves files referenced by immutable sync history, retained operation results, current entities (including tombstones), and recent file registrations. It uses the configured upload directory instead of assuming a directory relative to the compiled script. Invalid retained data aborts before deletion, and the default command only reports candidates; actual deletion requires explicit `--apply`. See [cleanup-retention.md](cleanup-retention.md).

The cleanup follow-up passes all 171 tests (11 new cases), including scans beyond the first history/receipt batch and rollback on a cleanup database failure. The real development database and all 42 uploads matched their pre-batch fingerprints. No real cleanup, migration, frontend change or production deployment was performed. Apply still requires a consistent backup and a maintenance window with every writer stopped; filesystem deletion and database updates are not fully atomic.

## Private request diagnostics

Every HTTP response now carries a server-generated, CORS-exposed `X-Request-ID`. Completed 5xx responses and interrupted streams produce one bounded JSON diagnostic record, including route templates, duration and safe error categories without request bodies, credentials, private filenames or raw Prisma errors. Auth, sync and catalog no longer log full exceptions, and previously silent collection/auth failures record safe classifications. Existing error response bodies, statuses and retry headers remain compatible. See [request-diagnostics.md](request-diagnostics.md).

This follow-up passes all 186 tests (15 new cases), including isolated real HTTP/SQLite failures, parser rejections, streaming interruptions and log-sink failure. The real development database and all 42 uploads matched their pre-batch fingerprints. No migration, dependency change, frontend change, process restart or production deployment was performed. These stderr diagnostics are best-effort, not a durable audit log, monitoring service or distributed tracing system.

## Audio file validation before processing and publication

Pitch now validates non-empty regular input and the existing 50 MiB size boundary before native work, including pitch zero. Owned cached results must also be regular and within the size limit. Rendered/downloaded results are inspected without following symlinks and rejected before registration when invalid or oversized. Existing sources and rejected caches are preserved, and missing successful-process output returns an explicit 502. See [audio-file-validation.md](audio-file-validation.md).

This follow-up passes all 205 tests (19 new cases), including exact size boundaries, symlink targets, failed cache regeneration and unexpected filesystem errors. The real development database and all 42 uploads matched their pre-batch fingerprints. Tests use temporary sparse files and mocked native tools; actual codec validity, native process behavior and playback were not verified. No migration, dependency change, frontend change, real cleanup, process restart or production deployment was performed. Post-process size validation does not impose aggregate quotas or cap temporary disk growth while a tool is running.

## Confined catalogue downloads and transfer failure handling

Catalogue downloads now validate relative paths, matching Guitar Pro format/extension, regular-file type and canonical containment inside the configured data root. Final symlinks, traversal and parent links escaping that root are rejected. Download names are bounded and sanitized, and asynchronous transfer errors preserve JSON 404/416/500 contracts without stale attachment headers. Authenticated GET/HEAD/ranges remain supported with private no-store caching. See [catalog-file-downloads.md](catalog-file-downloads.md).

This follow-up passes all 223 tests (18 new cases), including real temporary-file download/range/HEAD handling, rejected traversal, symlinks, Unicode metadata, filesystem failures and interrupted streams. The real development database and all 42 uploads matched their pre-batch fingerprints. No migration, dependency, seed execution, frontend change, cleanup, process restart or deployment was performed. Existing catalogue rows/files are not rewritten. Descriptor-level race protection and Guitar Pro content decoding are outside this correction.

## Remaining technical stages

- Integrate paginated display queries into the frontend without replacing full synchronization/collection contracts; review query indexes and deep-offset costs.
- Add aggregate resource quotas and persistent/distributed job scheduling; the current audio admission limit is process-local, not a queue or storage quota.
- Reconcile interrupted file publication before production capacity guarantees.
- Add backup/recovery procedures, production metrics/log retention/alerting beyond request diagnostics, and account-recovery features.

## Manual/environment validation deferred

The user requested that work requiring their validation be deferred for now. This does not mark the following checks completed:

- Review ambiguous or subsequently edited legacy playlists before any manual repair.
- Validate authenticated playback in a real browser against the deployed API and review proxy/session configuration.
- Verify native subprocess lifecycle/cancellation and real codec behavior in an environment with the installed tools.

No production deployment or automatic cleanup is included in this batch.
