-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "uiStorage" TEXT
);

-- CreateTable
CREATE TABLE "Song" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "artist" TEXT,
    "album" TEXT,
    "type" TEXT,
    "cloudUrl" TEXT,
    "textContent" TEXT,
    "originalKey" TEXT,
    "tuning" TEXT,
    "strummingPattern" TEXT,
    "capo" TEXT,
    "dateAdded" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Song_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Karaoke" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "artist" TEXT,
    "youtubeUrl" TEXT,
    "cloudUrl" TEXT,
    "hasLocalAudio" BOOLEAN NOT NULL DEFAULT false,
    "pitchShift" REAL,
    "textContent" TEXT,
    "dateAdded" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Karaoke_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Playlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Playlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KaraokePlaylist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "KaraokePlaylist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CustomChord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "root" TEXT NOT NULL,
    "frets" TEXT NOT NULL,
    "fingers" TEXT NOT NULL,
    "baseFret" INTEGER NOT NULL,
    "barres" TEXT,
    "updatedAt" BIGINT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "CustomChord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CatalogTab" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artist" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "_KaraokePlaylistToKaraoke" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_KaraokePlaylistToKaraoke_A_fkey" FOREIGN KEY ("A") REFERENCES "Karaoke" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_KaraokePlaylistToKaraoke_B_fkey" FOREIGN KEY ("B") REFERENCES "KaraokePlaylist" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_PlaylistToSong" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_PlaylistToSong_A_fkey" FOREIGN KEY ("A") REFERENCES "Playlist" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_PlaylistToSong_B_fkey" FOREIGN KEY ("B") REFERENCES "Song" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "CatalogTab_artist_title_idx" ON "CatalogTab"("artist", "title");

-- CreateIndex
CREATE UNIQUE INDEX "_KaraokePlaylistToKaraoke_AB_unique" ON "_KaraokePlaylistToKaraoke"("A", "B");

-- CreateIndex
CREATE INDEX "_KaraokePlaylistToKaraoke_B_index" ON "_KaraokePlaylistToKaraoke"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_PlaylistToSong_AB_unique" ON "_PlaylistToSong"("A", "B");

-- CreateIndex
CREATE INDEX "_PlaylistToSong_B_index" ON "_PlaylistToSong"("B");
