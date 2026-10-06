# Audio file type and size validation

Audio downloads and pitch processing now inspect the terminal file entry with `lstat`, not a symlink-following `stat`. This extends the regular-file requirement already used by the authorized download route to native processing, its cache and output publication.

## Pitch input and cache

Ownership validation still happens first. A missing, directory or symlink input returns 404 without launching FFmpeg. Empty input returns 400. Files above the existing 50 MiB limit (52,428,800 bytes, described as 50 MB in the existing error text) return 413, including pitch zero. Non-empty small sources remain eligible; the minimum-size threshold for rendered output is not imposed on source files.

An owned cache entry must also be a regular file within the size limit before reuse. A symlink or directory cache entry returns 404; an oversized cache returns 413. These invalid existing entries and their ownership records are not automatically deleted or overwritten. Missing and short regular cache files can still be regenerated, as before. Files belonging to another owner remain forbidden before exposing their size.

Unexpected inspection failures, such as denied filesystem access, remain internal errors instead of being treated as a cache miss or missing source.

## Output publication

Successful FFmpeg completion is not enough to publish a result: its output must be a regular file of at least 1,000 bytes and no more than 50 MiB. Missing, short or symlink output returns 502; oversized output returns 413. These checks happen before ownership registration and rename. A failed regeneration preserves an already-existing cache and the original source.

Both YouTube downloader routes share the same checks: missing, empty or non-regular output returns 502, and output above the size limit returns 413 before registration. Existing successful response bodies are unchanged. Exact-boundary output remains accepted.

Failure cleanup only unlinks the request's new output path; for a symlink this removes the link, not its target. It does not recursively delete directories. Unexpected non-regular directory entries or failed cleanup may still require operator reconciliation. Job slots remain occupied through cleanup and are released by the existing `finally` path.

## What this does not guarantee

These are file-type and post-process size checks, not codec/content validation. A sufficiently large regular file is not necessarily playable audio. The tests use sparse temporary fixture files and mocked FFmpeg/yt-dlp; no native codec behavior or real playback was verified by this change.

The final size check is not a hard cap on temporary disk consumption while conversion runs. It does not implement per-account/installation storage quotas, duration probing of local inputs, disk reservations, distributed admission or native subprocess cancellation. Existing timeouts and process-local job limits remain unchanged.

Checking a pathname is also not a descriptor-level guarantee against a local filesystem actor replacing it between inspection and use. Keep the configured upload directory and its parent permissions under server control. Filesystem publication and database commit still require the previously documented crash-recovery/reconciliation policy.

No existing application files were cleaned up, and no migration, dependency, frontend or deployment change is required by this correction.
