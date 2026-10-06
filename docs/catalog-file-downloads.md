# Catalogue file download boundaries

Authenticated catalogue downloads now resolve stored file metadata through `catalogFiles.ts` before calling Express's download transport. This is a read-only correction: it does not repair catalogue rows, extract archives or modify existing files.

## Allowed files

`CATALOG_DATA_DIR` optionally selects the data root. The default remains the project's `data/` directory, matching the seed script's existing relative paths such as `catalog/extracted/artist/song.gp5`. It is a data root, not the extracted subdirectory; do not strip the existing `catalog/` prefix from stored records. Relative configuration values resolve against the process working directory, as with `UPLOAD_DIR`; prefer an absolute configured root. This option controls HTTP downloads only, not the seed script's extraction location.

Paths must be non-empty relative strings, no longer than 4,096 characters, without null bytes, absolute POSIX/Windows roots, dot/hidden segments or traversal. Windows separators in legitimate relative legacy paths are normalized. Only the seed script's formats `gp`, `gp3`, `gp4`, `gp5` and `gpx` are accepted, case-insensitively, and the file extension must match the stored format.

The target must be a regular file, not a final symlink or directory. Canonical root/file containment is also checked, preventing a parent symlink from redirecting a download outside the configured root. A parent link that remains within the canonical root may still be accepted. The transport uses the resolved canonical filename.

Invalid or missing physical paths return the existing physical-file 404 message; unknown IDs retain their existing catalogue-record 404. Unexpected inspection errors retain the existing download 500 response rather than being hidden as missing files. These checks reject database/config/archive extensions; they are not a file-content parser, so renamed or malformed Guitar Pro content is not proven valid.

## Transport and failures

Bearer authentication still runs before GET, HEAD, range and conditional file handling. Successful bytes, range support and HEAD content length remain unchanged. Responses are `private, no-store` and vary on Authorization.

Artist/title download labels have separators and control characters replaced and are bounded to 120 Unicode code points, preserving valid Unicode pairs; malformed lone surrogates are replaced. The suffix comes from the validated format. Ordinary filenames remain readable, while untrusted metadata cannot grow the response header without bound or add header control characters.

An explicit transfer callback handles errors after `res.download` starts. Before headers, missing-file errors become JSON 404, invalid ranges JSON 416 and unexpected transfer errors retain `{ "error": "Failed to download tab" }` with status 500. Download-only headers are cleared so that the JSON response does not retain an attachment filename or a stale length/type. A range-error Content-Range remains available.

After headers, the error passes to the safe global handler, which closes the partial stream and records bounded diagnostics rather than trying to append a JSON 500 or logging raw exception text. An already-sent 200 cannot be changed to 500; the client sees an interrupted transfer, and the diagnostic event is `request_aborted`.

## Limits and verification

These pathname checks are not a descriptor-level guarantee against a local actor replacing files between inspection and transmission. Keep the configured data root and parent permissions under server control. No quota, archive extraction guard, content decoder, catalogue migration or automatic repair is introduced here.

Regression tests use temporary SQLite/data directories and real HTTP download/range/HEAD handling, plus controlled asynchronous transfer failures. They verify traversal rejection using a private temporary fixture outside the allowed root, symlink handling, format constraints, Unicode filenames and preserved authentication. No real private file, application catalogue or development upload is opened through the test download endpoint.
