# Sync API v2

`POST /api/sync/v2` synchronizes the authenticated user's private library. Send the JWT in `Authorization: Bearer <token>`. The JSON body is limited to 1 MiB and 100 operations; pages contain at most 200 changes.

## Request

```json
{
  "deviceId": "251977d8-18cd-4d98-82fd-672101b1543a",
  "cursor": null,
  "limit": 100,
  "operations": [
    {
      "operationId": "121b0697-f697-49f4-8bd8-e3f496df06dd",
      "entityType": "song",
      "entityId": "155ec544-967f-486f-b300-4a760ae6f173",
      "action": "upsert",
      "baseVersion": 0,
      "clientUpdatedAt": 1710000000000,
      "data": {
        "name": "Blackbird",
        "artist": "The Beatles",
        "textContent": "...",
        "originalKey": "G"
      }
    }
  ]
}
```

`deviceId`, `operationId` and `entityId` must be UUID strings. `baseVersion` is an integer number from 0 through 2147483647; `0` is only for creation and edits/deletes must match the last server version. Optional `clientUpdatedAt` must be a nonnegative numeric timestamp, accepted for diagnostics but never used to order writes. A client-controlled `userId`, version, server timestamp, cursor content, file path or file URL is ignored or rejected.

Names cannot be blank, metadata booleans must be JSON booleans, and dates/pitch are validated before writing. See [input-validation.md](input-validation.md) for the stricter field-type rules and legacy multipart compatibility.

Allowed data fields:

- `song`: `name`, `artist`, `album`, `type`, `textContent`, `originalKey`, `tuning`, `strummingPattern`, `capo`, `isPublic`, `dateAdded`.
- `karaoke`: `name`, `artist`, `youtubeUrl`, `hasLocalAudio`, `pitchShift`, `textContent`, `isPublic`, `dateAdded`.
- `custom_chord`: `name`, `root`, `frets`, `fingers`, `baseFret`, `barres`, `isPublic`.
- `playlist`: `name`, ordered `songCloudIds`, `isPublic`.
- `karaoke_playlist`: `name`, ordered `karaokeCloudIds`, `isPublic`.

Playlist references must be active entities owned by the authenticated user. References to deleted items are ignored when reading legacy playlists, while new writes reject them.

## Response

```json
{
  "acknowledgedOperationIds": ["121b0697-f697-49f4-8bd8-e3f496df06dd"],
  "rejectedOperations": [],
  "changes": [
    {
      "entityType": "song",
      "entityId": "155ec544-967f-486f-b300-4a760ae6f173",
      "version": 1,
      "createdAt": 1786381200000,
      "updatedAt": 1786381200000,
      "deletedAt": null,
      "data": {
        "name": "Blackbird",
        "artist": "The Beatles",
        "textContent": "...",
        "file": {
          "url": "/uploads/file-1786381200000-123.gp5",
          "version": 1,
          "hash": "0d4f...",
          "size": 24576,
          "mimeType": "application/octet-stream"
        }
      }
    }
  ],
  "nextCursor": "MS5zaWduYXR1cmU",
  "hasMore": false
}
```

The cursor is opaque and HMAC-protected. Persist `nextCursor` only after applying the whole response locally. When `hasMore` is true, call again with that cursor and normally no new operations. The cursor advances to the final change actually included in the page. Change payloads are immutable snapshots, so pagination cannot rewrite an earlier event with a later entity state.

## Idempotency and conflicts

Idempotency is scoped by user, device and operation ID. Retrying an accepted operation acknowledges it without applying it again; retrying a rejected valid operation returns the stored rejection.

The server rejects an edit or delete when `baseVersion` differs from the current version and returns `reason: "conflict"` plus `serverEntity`. The client should replace its local entity with that state, let the user merge if appropriate, then submit a new operation with a new `operationId` and the returned version. Tombstones cannot be resurrected; restoring content requires a new entity UUID. Other reasons are `validation_error`, `forbidden` and `not_found`.

Valid operations in a request are handled in one database transaction. Expected per-operation validation/conflict failures are recorded without preventing independent valid operations. An unexpected database failure rolls back the batch, including acknowledgements.

## Files

Binary transfer remains multipart through `POST /api/songs`, `PUT /api/songs/:id`, `POST /api/karaokes` and `PUT /api/karaokes/:id`. The sync endpoint never accepts a client file path or URL. After upload commits, sync publishes the current file URL, monotonically increasing `file.version`, SHA-256, byte size and MIME type. Replaced files are not deleted before the database commit. A replaced version remains protected while a retained immutable sync snapshot or operation result references it; it is not automatically an orphan.

## Retention

Legacy metadata, binary uploads and collection writes now require version preconditions. The frontend sends the known entity version with file uploads and preserves local bytes on conflict without automatic replacement. See [legacy-write-conflicts.md](legacy-write-conflicts.md). This does not change the sync v2 contract above.

Tombstones are retained indefinitely by default, which prevents an arbitrarily old client from resurrecting a deleted UUID. Expired idempotency records and genuinely unreferenced old files become cleanup candidates after 90 days by default (minimum 30), controlled by `SYNC_TOMBSTONE_RETENTION_DAYS`. Recent file registrations are also protected even if their file modification time is old. Sync history is not purged by this script, so its referenced file versions remain retained indefinitely.

`npm run cleanup:sync` is a non-mutating preview. Physical cleanup requires `-- --apply`, a consistent backup and a maintenance window with all writers stopped; it is not concurrent garbage collection. Malformed retained snapshots or results abort before deletion. `PURGE_SYNC_TOMBSTONES=true` only enables physical tombstone removal together with explicit apply, and must only be used with a deployment-specific policy forcing every older client through a full resync before uploads are accepted. The backend does not enforce such a policy yet. See [cleanup-retention.md](cleanup-retention.md) for limits and recovery considerations.
