# Read-only library and community pagination

These routes paginate display queries, not synchronization snapshots or whole-collection writes. All routes require a Bearer JWT.

## Query parameters

- `page`: positive decimal integer, default `1`.
- `limit`: positive decimal integer, default `50`, maximum `200`.
- Empty, repeated, structured, fractional, signed, exponential, or unsafe numeric values return HTTP 400 with `code: validation_error` and the invalid `field`.
- Page and computed offset must fit Prisma's signed 32-bit range. The server reads at most `limit + 1` rows to determine whether another page exists; it does not count the entire result set.
- Clients must keep the same `limit` while advancing pages. A page beyond the available results returns an empty list.

## Private library

`GET /api/library/:entityType?page=1&limit=50`

Supported types: `song`, `karaoke`, `custom_chord`, `playlist`, `karaoke_playlist`. Unknown types return 404. Only active records owned by the authenticated account are eligible, including that account's private and public records. Ordering is `updatedAt DESC, id ASC`.

The response is an object:

```json
{
  "items": [],
  "page": 1,
  "limit": 50,
  "hasMore": false,
  "nextPage": null
}
```

Each item uses the existing sync entity representation: `entityType`, `entityId`, `version`, `createdAt`, `updatedAt`, `deletedAt`, and `data`. Song/karaoke data includes the existing file metadata representation. Account credentials/settings and raw ownership fields are not included. File URLs still require the existing file-access checks when downloaded.

Responses use `Cache-Control: private, no-store` and `Vary: Authorization`. Reading a page does not create sync events or operation receipts. **There is no `X-Collection-Version` header:** a partial page is not a complete collection and must not be used to replace one.

The existing `/api/songs`, `/api/karaokes`, `/api/chords`, `/api/playlists`, and `/api/karaoke-playlists` GET responses remain full arrays. In particular, existing collection GET-to-POST workflows are not silently truncated. Their original scalability limitation remains until clients adopt an appropriate paginated display flow; full replacement and sync flows need their own complete-state contracts.

## Community

`GET /api/community/songs`, `/api/community/karaokes`, and `/api/community/chords` accept the same query parameters and retain their **array** response. Existing callers without parameters still receive at most 50 records. The existing cache-busting `t` parameter remains harmless.

Only active public records are selected before pagination. Songs and karaokes order by `dateAdded DESC, id ASC`; chords order by `updatedAt DESC, id ASC`. Embedded author information remains limited to `id` and `name`.

Pagination information is supplied in headers:

- `X-Has-More`: `true` or `false`.
- `X-Next-Page`: the next page number, or an empty value on the final page.

Both headers are exposed through CORS alongside the existing `ETag` and `X-Collection-Version` headers.

## Consistency and rollout limits

The ID tie-break gives deterministic ordering for an unchanged dataset. Offset pagination is not a frozen snapshot: inserts, edits, or deletions between requests can move records and cause repeats or omissions. Use sync v2's immutable change stream for cross-device/offline synchronization, not these display routes. Deep offsets and sorting still have database costs; indexes, quotas, and resource management require separate work.

This batch changes the backend only. The current frontend does not request further community pages or consume the new library endpoints yet. It therefore gains no visible "load more" control from this change alone. No schema migration, application-data cleanup, or production deployment is included.

## Verification

`npm test` compiles the backend and passes all 126 tests, including 18 pagination cases. Tests use temporary databases and uploads. Coverage includes two-page reads, owner isolation, private/tombstone filtering, tied ordering, defaults, the 200-row limit, exact final pages, empty pages, malformed inputs, authentication, CORS, read-only behavior, and preservation of legacy full-list responses. A partial page without a full-collection token cannot authorize legacy replacement.

The real development database fingerprint and all 42 upload fingerprints matched their pre-batch values after verification. Native audio processing and production browser integration are not validated by this pagination batch.
