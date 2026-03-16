# OpenClaw Explorer

Archive-first local viewer for OpenClaw session files.

This is a separate tool, not part of OpenClaw itself. It reads the session data already on your machine, can archive deduplicated snapshots, and shows live sessions and archived history in a browser.

## What it can do

- browse live sessions under `agents/*/sessions`
- archive transcript snapshots into its own local archive
- stitch active, reset, and deleted Telegram conversations into logical threads
- group threads into Telegram-centric profiles
- search archived transcripts with filters
- compare snapshots with a line diff
- export stitched threads or Telegram profiles as JSON, Markdown, or HTML
- show media references found in transcript text
- add bookmarks and notes for sessions, threads, and profiles
- show an operational dashboard for archive growth and stale live sessions

## Data sources

By default the app looks in `~/.openclaw`.

Main files:

- `~/.openclaw/agents/*/sessions/sessions.json`
- `~/.openclaw/agents/*/sessions/*.jsonl`

If your data lives somewhere else, set `OPENCLAW_HOME`.

## Archive behavior

The viewer keeps its own optional archive under:

- `~/.openclaw/viewer-archive`

It stores:

- `index.json`: archive index, run history, blob metadata, and source fingerprints
- `annotations.json`: bookmarks and notes
- `transcripts/...`: archived transcript copies grouped by channel, chat type, Telegram id, and agent

Archive runs are deduplicated. If the same source file has the same content hash, size, and modification time as the last archived version, it is skipped.

The archive supports:

- manual archive runs from the UI
- optional scheduled runs
- optional retention pruning for older versions per source
- optional encrypted blob storage for more sensitive archive copies

## Explorer views

- `Dashboard`: archive growth, thread coverage, agent/variant breakdowns, stale live sessions
- `Live`: current session files and transcripts
- `Threads`: stitched archive threads across active/reset/deleted variants
- `Profiles`: Telegram id rollups across threads and agents
- `Search`: full-text archive search with server-side filtering

## Security model

- by default the server only binds to `127.0.0.1`
- non-loopback binds require `ALLOW_REMOTE_BIND=1`
- remote API access also requires `OPENCLAW_VIEWER_TOKEN`
- state-changing endpoints only accept loopback clients and require an action header
- archive blobs can be encrypted with `OPENCLAW_ARCHIVE_MODE=sensitive`

Static UI assets are still served without a token so a remote browser can load the app shell, but archive data stays behind API token checks.

## Configuration

Optional environment variables:

- `OPENCLAW_HOME`: override the OpenClaw data directory
- `HOST`: bind host, default `127.0.0.1`
- `PORT`: preferred starting port, default `48312`
- `ALLOW_REMOTE_BIND=1`: allow non-loopback binding
- `OPENCLAW_VIEWER_TOKEN`: token required for remote API access
- `OPENCLAW_ARCHIVE_INTERVAL_MINUTES`: scheduled archive interval, for example `720`
- `OPENCLAW_ARCHIVE_KEEP_LATEST`: default keep count for prune operations
- `OPENCLAW_ARCHIVE_MODE=sensitive`: encrypt archive blobs at rest
- `OPENCLAW_ARCHIVE_SECRET`: secret used for sensitive archive mode

## Run it

Recommended:

```bash
./start-viewer.sh
```

Manual start:

```bash
npm start
```

Manual start with a custom data directory:

```bash
OPENCLAW_HOME=/path/to/.openclaw npm start
```

Scheduled archive every 12 hours:

```bash
OPENCLAW_ARCHIVE_INTERVAL_MINUTES=720 npm start
```

Sensitive archive mode:

```bash
OPENCLAW_ARCHIVE_MODE=sensitive OPENCLAW_ARCHIVE_SECRET=change-me npm start
```

If it starts successfully, it prints a URL such as:

```text
OpenClaw Chat Viewer listening on http://127.0.0.1:48312
```

## Test it

```bash
npm test
```

The current test suite covers:

- archive dedupe and retention pruning
- thread/profile stitching
- search, transcript reads, diff, and export generation
- remote-read token checks and loopback-only write protection
- sensitive archive encryption and decryption

## Project files

- `server.mjs`: HTTP routing, security middleware, static file serving, startup lifecycle
- `lib/config.mjs`: constants, env var resolution, shared utilities
- `lib/helpers.mjs`: transcript parsing, metadata extraction, path validation, search, diff, export rendering
- `lib/archive.mjs`: archive index/annotations I/O, blob storage, dedup
- `lib/catalog.mjs`: session loading, thread/profile stitching, search, export, archive runs
- `lib/crypto.mjs`: AES-256-GCM encryption for sensitive archive mode
- `start-viewer.sh`: helper script for locating the OpenClaw directory
- `public/index.html`: page shell
- `public/app.js`: explorer UI logic
- `public/style.css`: styles (light + dark mode)
- `test/`: integration and unit test suites

## Notes

This tool is for local inspection and archiving. Session data may contain sensitive chat history, names, ids, attachments, and internal labels, so treat both the live OpenClaw data and the viewer archive accordingly.
