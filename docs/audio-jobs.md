# Bounded audio work

The API previously allowed unrelated downloads and pitch conversions to spawn expensive native work without a shared concurrency bound. The general HTTP rate limiter does not limit how many long-running requests overlap. This follow-up introduces a small, process-local admission limit without changing successful response bodies or adding a job-queue dependency.

## Limits and covered routes

`src/services/audioJobs.ts` permits at most two active audio work pipelines per Node process and one per authenticated user within that process. These are fixed conservative limits, not measured hardware capacity or storage quotas.

The shared limit covers:

- `POST /api/karaokes/download-audio`.
- `POST /api/youtube/extract` (the alternate downloader route).
- `GET /api/karaokes/youtube-metadata` (also launches yt-dlp).
- New native conversion work from `POST /api/karaokes/process-pitch`.

Slots are reserved synchronously before starting native work and released in `finally`. They remain occupied through fallback conversion, output validation, ownership registration, and failure cleanup. No pending queue is accumulated. Invalid URLs and unauthenticated requests do not launch native processes. Pitch ownership validation remains before conversion admission.

Identical in-flight pitch requests still share their existing promise, rather than starting a second conversion. Owned, existing pitch results and pitch zero do not need a native job slot. File ownership checks are not bypassed by these fast paths.

## Busy responses

A user with an active job receives HTTP 429:

```json
{
  "error": "Ya tienes un trabajo de audio en curso. Inténtalo de nuevo en unos segundos.",
  "code": "audio_job_limit",
  "retryAfterSeconds": 5
}
```

When both slots belong to other users, the API returns HTTP 503 with `code: audio_capacity_exceeded` and `retryAfterSeconds: 5`. Both responses include `Retry-After: 5`, exposed through CORS. The interval is a suggested delay, not a completion guarantee: a retry can still receive a busy response.

The request is rejected, not accepted for later execution. Clients should report that the operation is busy and may retry deliberately after the suggested interval. No frontend retry loop or interface change is included. Successful downloader, metadata, and pitch response formats remain unchanged; these errors also do not change legacy write-conflict statuses or sync contracts.

## Pitch output publication

New pitch output is kept at its unique temporary path until ownership registration succeeds. Registration and the subsequent rename run within a Prisma transaction: a failed ownership insert does not publish the converted file, and a failed rename rolls back the ownership record. The job's `finally` removes its temporary output. No existing user audio is deleted by this correction.

This is not a distributed filesystem/database transaction. A process crash or database commit failure after a successful rename can still require reconciliation. Automatic cleanup of previously orphaned files is not performed here.

## Verification and remaining scope

The subsequent file-validation follow-up checks regular-file type and the existing 50 MiB size boundary for pitch inputs, owned cache hits, rendered results and downloader output. It refuses symlinks and validates new output before publication, while preserving original files and invalid existing caches. See [audio-file-validation.md](audio-file-validation.md) for response statuses and limitations; these are not aggregate storage quotas or a hard cap on temporary rendering disk use.

`npm test` compiles the backend and passes all 137 tests, including 11 new audio-job cases. The tests exercise real HTTP routes, isolated SQLite databases, and temporary upload directories. Native tools are mocked and held behind deterministic gates to verify overlapping requests, shared limits across routes/users, duplicate pitch requests, cache reuse, fallback, timeouts, synchronous failures, and CORS. A SQLite trigger rejects real ownership inserts to verify cleanup and subsequent recovery; a simulated rename failure verifies ownership rollback.

The development database fingerprint and all 42 upload fingerprints matched their pre-batch values. No real migration, cleanup, frontend edit, or production deployment was performed.

Remaining work includes aggregate per-account storage/download quotas, persistent/distributed jobs, job status/cancellation, resource metrics, and reconciliation after interrupted publication. Each Node worker or replica has its own two-job limit, so this does not enforce an installation-wide bound. Disconnecting the HTTP client does not cancel native work; the slot remains held until the existing timeout or normal completion. Native subprocess trees, codec threading, and real FFmpeg/yt-dlp behavior need separate integration verification before production capacity claims.
