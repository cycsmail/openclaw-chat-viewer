# OpenClaw Chat Viewer

Small local viewer for OpenClaw session files.

This is a separate tool, not part of OpenClaw itself. It reads the session data already on your machine and shows it in a browser so you can inspect conversations more easily.

## What it shows

- sessions found under `agents/*/sessions`
- active, reset, and deleted transcript files
- basic session metadata
- transcript entries for the selected session
- filters for agent, state, session type, and Telegram id

## What it reads

By default the app looks in `~/.openclaw`.

Main files:

- `~/.openclaw/agents/*/sessions/sessions.json`
- `~/.openclaw/agents/*/sessions/*.jsonl`

If your data lives somewhere else, set `OPENCLAW_HOME`.

## What it does not do

- it does not modify your OpenClaw data
- it does not upload anything
- it does not need a database
- it does not require a build step

The server binds to `127.0.0.1` by default. It will refuse non-loopback binds unless you explicitly set `ALLOW_REMOTE_BIND=1`.

## Run it

Recommended:

```bash
./start-viewer.sh
```

The script will:

- use `OPENCLAW_HOME` if it is already set and valid
- otherwise use `~/.openclaw` if present
- otherwise ask you for the OpenClaw directory

Manual start:

```bash
npm start
```

Manual start with a custom data directory:

```bash
OPENCLAW_HOME=/path/to/.openclaw npm start
```

When it starts, it prints a local URL such as:

```text
OpenClaw Chat Viewer listening on http://127.0.0.1:48312
```

If `48312` is busy, it will move to the next free port.

## Requirements

- Node.js
- an existing OpenClaw data directory with `agents/*/sessions`

## Project files

- `server.mjs`: local HTTP server and session reader
- `start-viewer.sh`: helper script for locating the OpenClaw directory
- `public/index.html`: page shell
- `public/app.js`: filtering and transcript rendering
- `public/style.css`: styles

## Notes

This tool is for local inspection. Session data may contain sensitive chat history, names, ids, and internal labels, so treat it accordingly.

If the viewer starts but shows nothing, the usual cause is that `OPENCLAW_HOME` points to the wrong directory or the expected `agents/*/sessions` files are not there.
