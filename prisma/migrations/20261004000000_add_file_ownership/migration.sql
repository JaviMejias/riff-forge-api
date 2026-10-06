CREATE TABLE "FileAsset" (
  "cloudUrl" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "createdAt" BIGINT NOT NULL,
  CONSTRAINT "FileAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "FileAsset_userId_idx" ON "FileAsset" ("userId");

-- Shared legacy paths have no unambiguous owner and must not be claimed.
INSERT INTO "FileAsset" ("cloudUrl", "userId", "createdAt")
SELECT "cloudUrl", MIN("userId"), MIN("dateAdded")
FROM (
  SELECT "cloudUrl", "userId", "dateAdded" FROM "Song" WHERE "cloudUrl" IS NOT NULL
  UNION ALL
  SELECT "cloudUrl", "userId", "dateAdded" FROM "Karaoke" WHERE "cloudUrl" IS NOT NULL
)
WHERE "cloudUrl" LIKE '/uploads/%'
GROUP BY "cloudUrl"
HAVING COUNT(DISTINCT "userId") = 1;
