# Input validation and sync failures

This batch validates external field types without changing database schema, account identities, JWT lifetime, or the frontend. It does not finish the full backend action plan.

## Library metadata

Song and karaoke creates require a nonblank name. Partial edits may omit it, but cannot replace it with an empty name or null. Optional text fields accept strings or null; song type accepts `gp`, `text`, or null.

`dateAdded` accepts a nonnegative integral timestamp within JavaScript's date range (0 through 8640000000000000). Canonical decimal strings remain compatible with multipart and legacy JSON responses. Booleans, null, fractions, exponent strings, and objects are rejected. Zero is preserved instead of replaced with the current time.

Legacy writes accept boolean values and the strings `true`/`false`. Sync metadata requires actual JSON booleans. Karaoke pitch uses the same -24 to 24 validator in both paths. Explicit zero and null are preserved; legacy empty pitch remains compatible.

Invalid metadata returns HTTP 400 with `code: validation_error` and `field`. Rejected creates and edits leave rows, versions, file ownership, and sync changes intact. Staged multipart files are removed after rejection.

## Authentication and collections

Login and signup require nonempty string credentials before querying Prisma or calling bcrypt. Optional signup name must be a string or null. Settings require an object-valued `uiStorage`; malformed values cannot replace existing preferences. Password policy and email normalization are unchanged.

Legacy collection writes validate booleans, creation dates, and chord field types before replacing the collection. Invalid references are rejected, including null or numeric reference lists. The existing whole-batch transaction preserves prior updates, omitted items, and events on rejection.

Chord arrays are now validated and normalized on writes as described below. This follow-up does not migrate or repair the application database.

## Sync and catalog

Sync UUID fields must be strings, not coercible arrays. Base versions are integer numbers from 0 to 2147483647. Optional `clientUpdatedAt` must be a numeric timestamp. Invalid operation envelopes are rejected without creating operation receipts.

Expected validation and forbidden-reference errors remain per-operation rejections. Unexpected failures during operation application abort the transaction and return HTTP 500 `sync_failed`, rolling back entity writes, events, and receipts. Tests inject a SQLite trigger failure on a change insert after an entity create/update to verify this boundary.

Catalog defaults remain page 1 and limit 50. Page and limit must be positive decimal integers; limit is capped by validation at 200. Repeated query parameters and offsets exceeding Prisma's 32-bit range return 400. Space/underscore search behavior is preserved.

## Chord-array validation follow-up

The backend previously accepted arbitrary strings and malformed elements as frets/fingers/barres. The frontend parses serialized fields as JSON, so accepted malformed data could interrupt synchronization or chord rendering.

Frets and fingers accept arrays, JSON-array strings, and legacy decimal text separated by commas (including single-element text). New writes store canonical JSON-array strings. Vectors contain at most six elements, matching the current six-string frontend. Frets are integer numbers from -1 through 2147483647; -1 means muted. Fingers are integer numbers from 0 through 5; an empty finger vector remains valid for unknown fingering. Nonempty finger vectors must match the fret-vector length.

Barres accept null or arrays/JSON-array strings with at most six entries. Entries are positive integer frets, or objects with integer `fret`, `fromString`, and `toString`. String references range from 1 through 6, must differ, and cannot exceed the available fret-vector length. Either string direction is accepted. The validator checks representation and references; it does not infer musical correctness or physically playable fret spans.

Partial sync edits validate the merged stored/input arrays before writing. Valid historical CSV is normalized as part of an explicit edit without changing note values. Invalid historical fields must be supplied in corrected form before another snapshot is created. Existing rows and immutable historical events are not changed by a read or migrated automatically.

Legacy whole-collection writes use the same normalizer. Rejected writes preserve omitted chords, versions, snapshots, and events. Retrying a rejected operation still returns its stored rejection; corrected data needs a new operation ID.

## Verification and remaining work

`npm test`: 108 tests pass, including the preceding 21 validation/rollback tests and 10 chord-array tests. Tests compile into temporary output and use temporary SQLite databases and upload directories. The preceding validation batch left the real database and uploads unchanged.

During the chord-array follow-up, the final read-only fingerprint detected concurrent additions in the real development database: one song, one karaoke, two sync events, and two operation receipts. Comparison with the previously restored backup found no modifications or deletions of earlier application rows. None of the test-fixture users exists in the real database, and SQLite integrity is `ok`. All 42 uploads retain their original byte fingerprints. The concurrent additions were preserved; no restore, repair, or cleanup of the real database was performed.

Remaining work includes pagination of private/community lists, resource quotas and job scheduling, observability, recovery procedures, and real native-audio/deployed-proxy verification. No migrations, cleanup, deployment, commit, or push were performed in these validation batches.
