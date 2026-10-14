# Audio Converter

A small Fastify REST API around FFmpeg. Its main use is turning Opus recordings
into M4A/AAC files for speech-to-text systems such as Whisper. No database,
permanent uploads, or deployment platform is required.

All outputs use **mono, 16 kHz audio** for speech processing:

| Target | Encoding | Content-Type |
| --- | --- | --- |
| `m4a` (default) | AAC, 64 kbps | `audio/mp4` |
| `mp3` | MP3, 64 kbps | `audio/mpeg` |
| `wav` | PCM signed 16-bit | `audio/wav` |

## API

`GET /health` returns HTTP 200 with `{"status":"ok"}`.

`POST /convert` accepts `multipart/form-data` with one required `file` and one
optional `target` (`m4a`, `mp3`, or `wav`). Fields can arrive in either order.
The response is the converted binary file, with an attachment filename such
as `converted.m4a`.

```sh
curl --fail-with-body http://localhost:3000/convert \
  -F 'file=@recording.opus' \
  -F 'target=m4a' \
  --output converted.m4a
```

Failures return JSON such as `{"error":"Uploaded file is empty."}`:

| Status | Meaning |
| --- | --- |
| 400 | Missing/empty file, unsupported target, or invalid multipart fields |
| 413 | File exceeds the configured upload limit |
| 415 | Request is not multipart/form-data |
| 422 | FFmpeg cannot decode or convert the uploaded audio |
| 503 | Conversion slots are busy, or FFmpeg is unavailable |
| 504 | Conversion exceeded its deadline |

## Docker

```sh
docker build -t audio-converter .
docker run --rm --name audio-converter \
  -p 127.0.0.1:3000:3000 \
  --memory=512m --cpus=1 \
  audio-converter
```

FFmpeg is included; the application runs as a non-root user. No Compose file is
needed. The server listens on `0.0.0.0` inside the container; the example exposes
it only on your machine's loopback interface.

For Coolify or another Docker network setup, `docker-compose.yaml` keeps the
application on external `coolify` and `backend` networks and gives it the
`audio-converter` alias on `backend`. Override `AUDIO_CONVERTER_COOLIFY_NETWORK`
and `AUDIO_CONVERTER_SHARED_NETWORK` when your network names differ. The
Compose service exposes port 3000 only inside Docker.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Application port (1–65535); adjust Docker's port mapping too |
| `MAX_UPLOAD_BYTES` | `25000000` | File limit: 25 MB; may be lowered |
| `CONVERSION_TIMEOUT_MS` | `60000` | FFmpeg deadline: 60 seconds; may be lowered |
| `MAX_CONCURRENT_CONVERSIONS` | `2` | Active requests (1–16); excess requests get 503, without queuing |
| `TMPDIR` | OS temporary directory | Writable location for per-request temporary directories |

Uploads have a two-minute request-receive timeout. The conversion deadline
starts when FFmpeg starts. Timed-out processes are killed, their temporary
files are removed, and the API remains available. Client disconnects and
graceful shutdown also cancel active work.

## Development and tests

Install Node.js 24 LTS and FFmpeg (including `ffprobe`), then run:

```sh
npm ci
npm test
npm run lint
npm run build
npm start
```

Tests use Node's built-in runner and generate a tiny sine-wave Opus fixture
with FFmpeg. They check real conversions and codecs, errors, temporary file
cleanup, timeouts, disconnections, shutdown, and concurrency limits.
TypeScript 6 is used for compatibility with the TypeScript ESLint tooling.

## Architecture and security

Fastify streams the upload into a random, private request directory. FFmpeg
receives a fixed argument array, writes an output file, and the API streams it
back before deleting the directory. Upload filenames and MIME types are not
trusted; FFmpeg detects the input and requires an audio stream. Metadata and
chapters are removed from outputs.

Common self-contained formats are accepted, including Ogg/Opus, WebM/Matroska,
M4A/MP4, MP3, WAV, FLAC, AAC, AIFF, AMR, ASF/WMA, AU, CAF, AC-3, and E-AC-3.
Playlists, concatenation scripts, and network protocols are blocked. Clients
cannot supply FFmpeg arguments. Each conversion uses one codec thread.

The API has no built-in authentication. Before exposing it to untrusted users,
apply authentication/rate limits where appropriate and Docker CPU, memory, and
storage limits. Keep the base image and FFmpeg updated. Temporary audio is
removed when a request finishes or fails. A forced container kill cannot run
application cleanup, so use ephemeral container storage for temporary audio
rather than a persistent upload volume.

## License

[MIT](LICENSE) for the application. FFmpeg and base-image packages retain their
own licenses.
