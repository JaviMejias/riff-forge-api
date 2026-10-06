# Private request diagnostics

## Request correlation

The first HTTP middleware generates a fresh UUID v4 and sends it as `X-Request-ID`, before body parsing, rate limiting and authentication. Incoming request IDs are ignored; clients cannot choose a value that will be written to the diagnostic log. CORS exposes this header alongside the existing exposed headers. Error/success JSON bodies and existing status codes are unchanged.

When investigating a browser-visible failure, copy its response `X-Request-ID` from the network panel and look for the same `requestId` in the backend's stderr output. Restart the development server (or rebuild before starting compiled code) to load this source change; it does not replace or restart an already-running process automatically.

## Failure records

Completed HTTP responses with status 500 or greater emit one JSON record with event `request_failed`. Connections closed before the response finishes emit `request_aborted`, including client cancellations; these are not automatically server failures. The record contains only:

- UTC timestamp, level and event.
- Server-generated request ID and HTTP method.
- A fixed application scope and an application-defined route template, or `unmatched` when no template is available.
- Response status (null for an abort before headers), elapsed duration in milliseconds, a fixed error category and an optional constrained error code.

Route parameters, filenames, URL queries, IP addresses, identities, cookies, authorization headers, request/response bodies, email addresses, passwords, song text, error messages, stacks and Prisma query metadata are not included. Error categories are bounded; codes are limited to Prisma-style `P` plus four digits and a small allowlist of system codes. Arbitrary error names/codes are not logged. A normal direct 500 with no recorded exception is `unclassified`.

Controllers record safe classifications without logging a second entry. This replaces raw exception logging in auth, sync and catalog, and covers previously silent auth/library collection errors. Global Express error handling preserves existing JSON parser, multipart and `HttpError` responses. If headers were already sent, it closes the partial response without forwarding the raw exception to Express's default logger; the aborted record captures the safe category instead.

Successful responses and completed 4xx rejections do not produce diagnostic records. This is intentional to limit noise and sensitive data collection; it is not an audit trail of authentication or user activity. A 503 capacity rejection is a logged HTTP failure, not evidence of a database outage.

## Limits and remaining operations work

Logs go to the process's existing stderr sink. No log file, external service, dependency, database table or migration is added. A synchronous sink failure is caught to preserve the HTTP response, but logging is best-effort: delivery, retention, rotation, aggregation and alerting are not guaranteed. The script/CLI task logs are outside this HTTP middleware and have not been redesigned here.

Duration covers HTTP response handling, not isolated database/subprocess timings. IDs are local to each request, not distributed tracing. The health endpoint remains its existing liveness response; database readiness checks, metrics, durable job records, storage quotas and production alerting remain separate work. No new public diagnostic endpoint is exposed.

The regression tests run real HTTP/SQLite failures on temporary databases and files, plus controlled streaming failures and a broken log sink. They verify request-ID correlation, CORS, retained response contracts and exclusion of a private fixture string. No real account, development database, upload or production service is changed by these tests.
