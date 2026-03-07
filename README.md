# OpenClaw Chat Viewer

OpenClaw Chat Viewer is a small local web app for browsing OpenClaw session files and chat history.

It is separate from OpenClaw itself. It does not patch OpenClaw, inject into OpenClaw, or require an OpenClaw source checkout. It reads existing session data from your local OpenClaw state directory and presents it in a browser.

## What It Does

The viewer reads OpenClaw session metadata and transcript files from your local machine and shows:

- all discovered session files across OpenClaw agents
- active sessions
- reset and deleted session history files
- chat transcript entries for a selected session
- filters for agent, session file state, session type, and Telegram id

The viewer is intended for local inspection of OpenClaw conversations.

## What It Reads

By default, the app reads from:

- `~/.openclaw/agents/*/sessions/sessions.json`
- `~/.openclaw/agents/*/sessions/*.jsonl`

If your OpenClaw data is stored somewhere else, you can point the viewer at that directory with `OPENCLAW_HOME`.

## What It Does Not Do

- it does not modify OpenClaw data
- it does not send chat history anywhere by itself
- it does not require a database migration
- it does not require extra npm packages for this project
- it does not expose OpenClaw over the network

The server binds to `127.0.0.1` only, so it is local to the machine unless you deliberately proxy or expose it yourself.
It also refuses non-loopback binds unless you explicitly opt in with `ALLOW_REMOTE_BIND=1`.

## Requirements

To use this project on any machine, you need:

- Node.js installed
- an existing OpenClaw data directory
- session files present under `agents/*/sessions`

## Project Layout

- `server.mjs`: local HTTP server and transcript/session reader
- `public/index.html`: viewer shell
- `public/app.js`: browser-side filtering and transcript rendering
- `public/style.css`: UI styling
- `start-viewer.sh`: launcher script that auto-detects the OpenClaw directory

## Quick Start

### Recommended

Use the startup script:

```bash
cd /path/to/openclaw-chat-viewer
./start-viewer.sh
```

What the script does:

1. checks whether `~/.openclaw` exists
2. if found, prints that it found the directory and uses it
3. if not found, prompts you to enter the OpenClaw directory
4. starts the viewer

When the server starts, it prints a local URL like:

```bash
OpenClaw Chat Viewer listening on http://127.0.0.1:48312
```

Then open that URL in your browser.

### Manual Start

You can also run the server directly:

```bash
cd /path/to/openclaw-chat-viewer
npm start
```

If your OpenClaw data is not in the default location:

```bash
cd /path/to/openclaw-chat-viewer
OPENCLAW_HOME=/path/to/.openclaw npm start
```

## Startup Behavior

The app uses these rules to find OpenClaw data:

1. if `OPENCLAW_HOME` is set, it uses that
2. otherwise it uses `~/.openclaw`

The startup script adds one more layer of convenience:

1. if `OPENCLAW_HOME` is already set and valid, it uses it
2. otherwise it checks `~/.openclaw`
3. if `~/.openclaw` is missing, it asks the user for the directory

## Port Behavior

The viewer binds to:

- host: `127.0.0.1`
- starting port: `48312`

If that port is already in use, it automatically tries the next free port. This avoids hard conflicts with other local services, including OpenClaw-related local servers.

For safety, the server refuses to bind to non-local hosts such as `0.0.0.0` unless you explicitly set:

```bash
ALLOW_REMOTE_BIND=1
```

## UI Guide

The left side of the app shows the session list and filters.

Available filters:

- `Search`: free text search across session metadata and preview text
- `Agent`: filter by OpenClaw agent
- `State`: filter by active, reset, deleted, or other transcript file state
- `Session type`: filter by `group` or `1 on 1 DM`
- `Telegram id`: filter by detected Telegram conversation id

The right side shows:

- details for the selected session file
- transcript entries in order
- role labels such as `user`, `assistant`, and other session events

## Example Usage

### Open the viewer against your default OpenClaw data

```bash
cd /path/to/openclaw-chat-viewer
./start-viewer.sh
```

### Open the viewer against a different OpenClaw data directory

```bash
cd /path/to/openclaw-chat-viewer
OPENCLAW_HOME=/srv/openclaw-data ./start-viewer.sh
```

### Filter only group sessions

In the UI:

- set `Session type` to `Group`

### Filter only direct Telegram chats for one chat id

In the UI:

- set `Session type` to `1 on 1 DM`
- set `Telegram id` to the desired id

## Privacy and Safety Notes

This app is local, but the data it reads can be highly sensitive.

Be careful because:

- session transcripts may include real chat history
- session metadata may include names, channels, Telegram ids, and internal labels
- anyone with local access to the running machine and browser session may be able to see the viewer

Safe default behavior:

- the app listens on `127.0.0.1` only
- it reads local files only
- it does not write back to OpenClaw state

Do not expose this service publicly unless you add proper authentication and understand the risk.

## Troubleshooting

### The viewer starts but shows no sessions

Check:

- your OpenClaw data directory is correct
- `agents/*/sessions` exists under the selected OpenClaw home
- `.jsonl` transcript files are present

### My OpenClaw directory is not in `~/.openclaw`

Run:

```bash
OPENCLAW_HOME=/your/path/to/.openclaw ./start-viewer.sh
```

or:

```bash
OPENCLAW_HOME=/your/path/to/.openclaw npm start
```

### The printed port is not `48312`

That is expected if `48312` is already in use. The viewer automatically moves to the next available port.

### I launched the script but it asks for a directory

That means:

- `OPENCLAW_HOME` is unset or invalid, and
- `~/.openclaw` was not found

Enter the correct OpenClaw directory path when prompted.

### The script says a directory is not a valid OpenClaw home

The launcher now checks for an `agents/` directory inside the selected path. Point it at the OpenClaw state root itself, not at one nested subfolder.

## Development Notes

This repository is intentionally simple:

- no framework build step
- no database layer
- no dependency install required for the app itself

It is designed to stay easy to inspect and easy to run on another machine.

## License / Sharing

Before sharing or making the repo public, remember:

- the code can be public without exposing your chat logs
- your actual OpenClaw session files should not be committed
- keep `.openclaw` data outside this repository

The included `.gitignore` helps prevent accidental commits of local runtime data and exports.
