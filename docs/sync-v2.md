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

`deviceId`, `operationId` and `entityId` must be UUIDs. `baseVersion` is `0` only for creation and must equal the last server version for edits/deletes. `clientUpdatedAt` is accepted for diagnostics but never orders writes. A client-controlled `userId`, version, timestamp, cursor content, file path or file URL is ignored or rejected.

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

Binary transfer remains multipart through `POST /api/songs`, `PUT /api/songs/:id`, `POST /api/karaokes` and `PUT /api/karaokes/:id`. The sync endpoint never accepts a client file path or URL. After upload commits, sync publishes the current public URL, monotonically increasing `file.version`, SHA-256, byte size and MIME type. Replaced files become orphans and are removed later by `npm run cleanup:sync`; they are not deleted before the database commit.

## Retention

Tombstones are retained indefinitely by default, which prevents an arbitrarily old client from resurrecting a deleted UUID. Idempotency records and orphan files are retained for 90 days by default (minimum 30), controlled by `SYNC_TOMBSTONE_RETENTION_DAYS`. Run `npm run cleanup:sync` from a scheduler. `PURGE_SYNC_TOMBSTONES=true` enables physical tombstone removal after that period, but it must only be used together with a deployment-specific policy that forces every older client through a full resync before uploads are accepted.
