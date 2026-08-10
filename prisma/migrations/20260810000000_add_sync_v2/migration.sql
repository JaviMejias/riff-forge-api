ALTER TABLE "Song" ADD COLUMN "createdAt" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Song" ADD COLUMN "deletedAt" BIGINT;
ALTER TABLE "Song" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Song" ADD COLUMN "fileVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Song" ADD COLUMN "fileHash" TEXT;
ALTER TABLE "Song" ADD COLUMN "fileSize" BIGINT;
ALTER TABLE "Song" ADD COLUMN "fileMimeType" TEXT;
UPDATE "Song" SET "createdAt" = "dateAdded", "fileVersion" = CASE WHEN "cloudUrl" IS NULL THEN 0 ELSE 1 END;

ALTER TABLE "Karaoke" ADD COLUMN "createdAt" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Karaoke" ADD COLUMN "deletedAt" BIGINT;
ALTER TABLE "Karaoke" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Karaoke" ADD COLUMN "fileVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Karaoke" ADD COLUMN "fileHash" TEXT;
ALTER TABLE "Karaoke" ADD COLUMN "fileSize" BIGINT;
ALTER TABLE "Karaoke" ADD COLUMN "fileMimeType" TEXT;
UPDATE "Karaoke" SET "createdAt" = "dateAdded", "fileVersion" = CASE WHEN "cloudUrl" IS NULL THEN 0 ELSE 1 END;

ALTER TABLE "Playlist" ADD COLUMN "deletedAt" BIGINT;
ALTER TABLE "Playlist" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Playlist" ADD COLUMN "songCloudIds" TEXT NOT NULL DEFAULT '[]';
UPDATE "Playlist" SET "songCloudIds" = COALESCE((SELECT '[' || group_concat('"' || "A" || '"') || ']' FROM "_PlaylistToSong" WHERE "B" = "Playlist"."id"), '[]');

ALTER TABLE "KaraokePlaylist" ADD COLUMN "deletedAt" BIGINT;
ALTER TABLE "KaraokePlaylist" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "KaraokePlaylist" ADD COLUMN "karaokeCloudIds" TEXT NOT NULL DEFAULT '[]';
UPDATE "KaraokePlaylist" SET "karaokeCloudIds" = COALESCE((SELECT '[' || group_concat('"' || "A" || '"') || ']' FROM "_KaraokePlaylistToKaraoke" WHERE "B" = "KaraokePlaylist"."id"), '[]');

ALTER TABLE "CustomChord" ADD COLUMN "createdAt" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "CustomChord" ADD COLUMN "deletedAt" BIGINT;
ALTER TABLE "CustomChord" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
UPDATE "CustomChord" SET "createdAt" = "updatedAt";

CREATE TABLE "SyncChange" ("sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "userId" TEXT NOT NULL, "entityType" TEXT NOT NULL, "entityId" TEXT NOT NULL, "version" INTEGER NOT NULL, "action" TEXT NOT NULL, "payload" TEXT, "createdAt" BIGINT NOT NULL, CONSTRAINT "SyncChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE TABLE "ProcessedSyncOperation" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "userId" TEXT NOT NULL, "deviceId" TEXT NOT NULL, "operationId" TEXT NOT NULL, "result" TEXT NOT NULL, "createdAt" BIGINT NOT NULL, CONSTRAINT "ProcessedSyncOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "Song_userId_deletedAt_idx" ON "Song"("userId", "deletedAt");
CREATE INDEX "Karaoke_userId_deletedAt_idx" ON "Karaoke"("userId", "deletedAt");
CREATE INDEX "Playlist_userId_deletedAt_idx" ON "Playlist"("userId", "deletedAt");
CREATE INDEX "KaraokePlaylist_userId_deletedAt_idx" ON "KaraokePlaylist"("userId", "deletedAt");
CREATE INDEX "CustomChord_userId_deletedAt_idx" ON "CustomChord"("userId", "deletedAt");
CREATE INDEX "SyncChange_userId_sequence_idx" ON "SyncChange"("userId", "sequence");
CREATE INDEX "SyncChange_userId_entityType_entityId_idx" ON "SyncChange"("userId", "entityType", "entityId");
CREATE UNIQUE INDEX "ProcessedSyncOperation_userId_deviceId_operationId_key" ON "ProcessedSyncOperation"("userId", "deviceId", "operationId");
CREATE INDEX "ProcessedSyncOperation_userId_createdAt_idx" ON "ProcessedSyncOperation"("userId", "createdAt");

INSERT INTO "SyncChange" ("userId", "entityType", "entityId", "version", "action", "createdAt") SELECT "userId", 'song', "id", "version", 'upsert', "updatedAt" FROM "Song";
INSERT INTO "SyncChange" ("userId", "entityType", "entityId", "version", "action", "createdAt") SELECT "userId", 'karaoke', "id", "version", 'upsert', "updatedAt" FROM "Karaoke";
INSERT INTO "SyncChange" ("userId", "entityType", "entityId", "version", "action", "createdAt") SELECT "userId", 'playlist', "id", "version", 'upsert', "updatedAt" FROM "Playlist";
INSERT INTO "SyncChange" ("userId", "entityType", "entityId", "version", "action", "createdAt") SELECT "userId", 'karaoke_playlist', "id", "version", 'upsert', "updatedAt" FROM "KaraokePlaylist";
INSERT INTO "SyncChange" ("userId", "entityType", "entityId", "version", "action", "createdAt") SELECT "userId", 'custom_chord', "id", "version", 'upsert', "updatedAt" FROM "CustomChord";
