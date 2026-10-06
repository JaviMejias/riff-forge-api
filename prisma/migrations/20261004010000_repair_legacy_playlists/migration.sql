-- Only repair untouched legacy rows that still contain the exact defective backfill.
BEGIN IMMEDIATE;
CREATE TEMP TABLE "_LegacyPlaylistRepair" AS
SELECT p."id",
  (SELECT json_group_array("id") FROM (
    SELECT s."id" FROM "_PlaylistToSong" r
    JOIN "Song" s ON s."id" = r."B"
    WHERE r."A" = p."id" AND s."userId" = p."userId" AND s."deletedAt" IS NULL
    ORDER BY s."id"
  )) AS "songCloudIds",
  MAX(p."updatedAt" + 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000) AS "updatedAt"
FROM "Playlist" p
WHERE p."version" = 1 AND p."deletedAt" IS NULL
  AND p."songCloudIds" = COALESCE(
    (SELECT '[' || group_concat('"' || "A" || '"') || ']' FROM "_PlaylistToSong" WHERE "B" = p."id"), '[]')
  AND EXISTS (SELECT 1 FROM "_PlaylistToSong" WHERE "A" = p."id")
  AND EXISTS (SELECT 1 FROM "SyncChange" c WHERE c."entityType" = 'playlist'
    AND c."entityId" = p."id" AND c."userId" = p."userId"
    AND c."version" = 1 AND c."action" = 'upsert' AND c."payload" IS NULL)
  AND NOT EXISTS (SELECT 1 FROM "SyncChange" c WHERE c."entityType" = 'playlist'
    AND c."entityId" = p."id" AND c."userId" = p."userId" AND c."payload" IS NOT NULL);

DELETE FROM "_LegacyPlaylistRepair"
WHERE "songCloudIds" = (SELECT "songCloudIds" FROM "Playlist" WHERE "id" = "_LegacyPlaylistRepair"."id");

UPDATE "Playlist" SET
  "songCloudIds" = (SELECT "songCloudIds" FROM "_LegacyPlaylistRepair" WHERE "id" = "Playlist"."id"),
  "updatedAt" = (SELECT "updatedAt" FROM "_LegacyPlaylistRepair" WHERE "id" = "Playlist"."id"),
  "version" = "version" + 1
WHERE "id" IN (SELECT "id" FROM "_LegacyPlaylistRepair");

INSERT INTO "SyncChange" ("userId", "entityType", "entityId", "version", "action", "payload", "createdAt")
SELECT p."userId", 'playlist', p."id", p."version", 'upsert',
  json_object(
    'entityType', 'playlist', 'entityId', p."id", 'version', p."version",
    'createdAt', p."createdAt", 'updatedAt', p."updatedAt", 'deletedAt', NULL,
    'data', json_object('name', p."name", 'songCloudIds', json(p."songCloudIds"),
      'isPublic', json(CASE WHEN p."isPublic" THEN 'true' ELSE 'false' END))
  ), p."updatedAt"
FROM "Playlist" p JOIN "_LegacyPlaylistRepair" r ON r."id" = p."id";

DROP TABLE "_LegacyPlaylistRepair";
COMMIT;
