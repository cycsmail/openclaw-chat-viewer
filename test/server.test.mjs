import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SERVER_MODULE_URL = pathToFileURL(path.join(PROJECT_DIR, "server.mjs")).href;

async function importServer(envOverrides = {}) {
  const previous = new Map();
  for (const [key, value] of Object.entries(envOverrides)) {
    previous.set(key, process.env[key]);
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return await import(`${SERVER_MODULE_URL}?test=${Date.now()}-${Math.random()}`);
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-viewer-test-"));
  const mediaDir = path.join(root, "media");
  const mainSessionsDir = path.join(root, "agents", "main", "sessions");
  const financeSessionsDir = path.join(root, "agents", "finance", "sessions");
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.mkdir(mainSessionsDir, { recursive: true });
  await fs.mkdir(financeSessionsDir, { recursive: true });

  const mediaFile = path.join(mediaDir, "scan.txt");
  await fs.writeFile(mediaFile, "scan attachment");

  const activeSessionId = "11111111-1111-1111-1111-111111111111";
  const financeSessionId = "22222222-2222-2222-2222-222222222222";
  const activeFilename = `${activeSessionId}.jsonl`;
  const resetFilename = `${activeSessionId}.jsonl.reset.2026-03-04T01-02-03Z`;
  const financeFilename = `${financeSessionId}.jsonl.deleted.2026-03-05T04-05-06Z`;

  await fs.writeFile(
    path.join(mainSessionsDir, "sessions.json"),
    JSON.stringify({
      "telegram:direct:2009539480": {
        sessionId: activeSessionId,
        updatedAt: Date.parse("2026-03-07T05:00:00.000Z"),
        chatType: "direct",
        origin: {
          provider: "telegram",
          chatType: "direct",
          to: "telegram:2009539480",
          label: "test user"
        },
        lastChannel: "telegram",
        lastTo: "telegram:2009539480",
        model: "gpt-5"
      }
    }, null, 2)
  );
  await fs.writeFile(path.join(financeSessionsDir, "sessions.json"), "{}\n");

  const activePath = path.join(mainSessionsDir, activeFilename);
  const resetPath = path.join(mainSessionsDir, resetFilename);
  const financePath = path.join(financeSessionsDir, financeFilename);

  await writeTranscript(activePath, buildTranscript({
    timestampBase: "2026-03-07T05:00:00.000Z",
    senderId: "2009539480",
    senderName: "test user",
    body: `hello before\n[media attached: scan.txt (text/plain) | ${mediaFile}]`
  }));
  await writeTranscript(resetPath, buildTranscript({
    timestampBase: "2026-03-04T01:02:03.000Z",
    senderId: "2009539480",
    senderName: "test user",
    body: "legacy reset transcript"
  }));
  await writeTranscript(financePath, buildTranscript({
    timestampBase: "2026-03-05T04:05:06.000Z",
    senderId: "2009539480",
    senderName: "test user",
    body: "finance follow-up"
  }));

  return {
    root,
    mediaFile,
    activePath
  };
}

function buildMetadataText(senderId, senderName, body) {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({
      message_id: "786",
      sender_id: senderId,
      sender: senderName,
      timestamp: "Sat 2026-03-07 13:21 GMT+8",
      conversation_label: `${senderName} (id:${senderId})`,
      is_group_chat: false
    }, null, 2),
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    JSON.stringify({
      label: `${senderName} (${senderId})`,
      id: senderId,
      name: senderName
    }, null, 2),
    "```",
    body
  ].join("\n");
}

function buildTranscript({ timestampBase, senderId, senderName, body }) {
  const baseTime = Date.parse(timestampBase);
  return [
    {
      type: "session",
      version: 1,
      id: `session-${senderId}`,
      timestamp: new Date(baseTime).toISOString()
    },
    {
      type: "message",
      id: `user-${senderId}`,
      timestamp: new Date(baseTime + 1_000).toISOString(),
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: buildMetadataText(senderId, senderName, body)
          }
        ]
      }
    },
    {
      type: "message",
      id: `assistant-${senderId}`,
      timestamp: new Date(baseTime + 2_000).toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Reply for ${senderName}`
          }
        ]
      }
    }
  ];
}

async function writeTranscript(filePath, entries) {
  const raw = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await fs.writeFile(filePath, raw);
}

test("archive workflow stitches threads, searches snapshots, exports, and prunes deduplicated history", { concurrency: false }, async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const server = await importServer({
    OPENCLAW_HOME: fixture.root,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });

  const firstRun = await server.runArchive("manual");
  assert.equal(firstRun.snapshotsCreated, 3);
  assert.equal(firstRun.sourcesSkipped, 0);

  await writeTranscript(fixture.activePath, buildTranscript({
    timestampBase: "2026-03-07T06:00:00.000Z",
    senderId: "2009539480",
    senderName: "test user",
    body: `hello after\n[media attached: scan.txt (text/plain) | ${fixture.mediaFile}]`
  }));

  const secondRun = await server.runArchive("manual");
  assert.equal(secondRun.snapshotsCreated, 1);
  assert.equal(secondRun.sourcesSkipped, 2);

  const thirdRun = await server.runArchive("manual");
  assert.equal(thirdRun.snapshotsCreated, 0);
  assert.equal(thirdRun.sourcesSkipped, 3);

  const overview = await server.getOverview();
  assert.equal(overview.liveSessions.length, 3);
  assert.equal(overview.threads.length, 2);
  assert.equal(overview.profiles.length, 1);
  assert.equal(overview.archiveStatus.snapshotCount, 4);

  const mainThread = overview.threads.find((item) => item.agentId === "main");
  assert.ok(mainThread);
  assert.equal(mainThread.snapshotCount, 3);
  assert.equal(mainThread.liveSessionCount, 2);

  const profile = overview.profiles.find((item) => item.telegramId === "2009539480");
  assert.ok(profile);
  assert.equal(profile.threadKeys.length, 2);
  assert.equal(profile.snapshotCount, 4);

  const search = await server.searchArchive("hello after", {
    agentId: "main",
    chatType: "direct",
    variant: "active"
  });
  assert.equal(search.count, 1);
  assert.match(search.results[0].excerpt, /hello after/i);

  const transcript = await server.getArchiveTranscript(search.results[0].snapshotId);
  const userMessage = transcript.transcript.find((item) => item.role === "user");
  assert.ok(userMessage);
  assert.equal(userMessage.attachments.length, 1);
  assert.equal(userMessage.attachments[0].safeMediaPath, fixture.mediaFile);

  const activeSnapshots = mainThread.snapshots.filter((snapshot) => snapshot.variant === "active");
  assert.equal(activeSnapshots.length, 2);
  const snapshotBodies = await Promise.all(activeSnapshots.map(async (snapshot) => ({
    snapshotId: snapshot.snapshotId,
    body: JSON.stringify((await server.getArchiveTranscript(snapshot.snapshotId)).transcript)
  })));
  const beforeSnapshot = snapshotBodies.find((item) => /hello before/i.test(item.body));
  const afterSnapshot = snapshotBodies.find((item) => /hello after/i.test(item.body));
  assert.ok(beforeSnapshot);
  assert.ok(afterSnapshot);

  const diff = await server.diffArchiveSnapshots(beforeSnapshot.snapshotId, afterSnapshot.snapshotId);
  assert.match(diff.diff.removed.join("\n"), /hello before/i);
  assert.match(diff.diff.added.join("\n"), /hello after/i);

  await server.__test.updateAnnotation("sessions", search.results[0].sourceKey, {
    bookmarked: false,
    note: "watch this source"
  });
  await server.__test.updateAnnotation("threads", mainThread.key, {
    bookmarked: true,
    note: "priority thread"
  });

  const annotatedOverview = await server.getOverview();
  const annotatedThread = annotatedOverview.threads.find((item) => item.key === mainThread.key);
  assert.equal(annotatedOverview.dashboard.bookmarkedCount, 1);
  assert.equal(annotatedThread.bookmarked, true);
  assert.equal(annotatedThread.note, "priority thread");

  const exportPayload = await server.buildExportPayload("thread", mainThread.key, "json");
  const parsedExport = JSON.parse(exportPayload.body);
  assert.equal(parsedExport.thread.key, mainThread.key);
  assert.equal(parsedExport.snapshots.length, 3);
  await assert.rejects(() => server.buildExportPayload("thread", mainThread.key, "zip"), /Invalid export format/);

  const prune = await server.pruneArchive(1);
  assert.equal(prune.removedSnapshots, 1);

  const postPruneOverview = await server.getOverview();
  const postPruneThread = postPruneOverview.threads.find((item) => item.key === mainThread.key);
  assert.equal(postPruneOverview.archiveStatus.snapshotCount, 3);
  assert.equal(postPruneThread.snapshotCount, 2);
});

test("security helpers enforce action header and origin checks", { concurrency: false }, async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const server = await importServer({
    OPENCLAW_HOME: fixture.root,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });

  const url = new URL("http://viewer.local/api/overview");

  assert.throws(
    () => server.__test.ensureStateChangingRequest({
      socket: { remoteAddress: "127.0.0.1" },
      headers: {}
    }, url),
    /Missing archive action header/
  );
  assert.throws(
    () => server.__test.ensureStateChangingRequest({
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        "x-openclaw-action": "archive-run",
        origin: "not a url"
      }
    }, url),
    /Origin mismatch/
  );
  assert.throws(
    () => server.__test.ensureStateChangingRequest({
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        "x-openclaw-action": "archive-run",
        origin: "http://other.local"
      }
    }, url),
    /Origin mismatch/
  );
  assert.doesNotThrow(() => server.__test.ensureStateChangingRequest({
    socket: { remoteAddress: "127.0.0.1" },
    headers: {
      "x-openclaw-action": "archive-run",
      origin: "http://viewer.local"
    }
  }, url));
  assert.doesNotThrow(() => server.__test.ensureStateChangingRequest({
    socket: { remoteAddress: "10.0.0.5" },
    headers: {
      "x-openclaw-action": "archive-run",
      origin: "http://viewer.local"
    }
  }, url));

  // requireAdmin checks
  assert.throws(() => server.__test.requireAdmin(null), /Forbidden/);
  assert.throws(() => server.__test.requireAdmin({ role: "viewer" }), /Forbidden/);
  assert.doesNotThrow(() => server.__test.requireAdmin({ role: "admin" }));
});

test("sensitive archive mode encrypts blobs while keeping transcripts readable through the API layer", { concurrency: false }, async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const server = await importServer({
    OPENCLAW_HOME: fixture.root,
    OPENCLAW_MONITOR_NO_LISTEN: "1",
    OPENCLAW_ARCHIVE_MODE: "sensitive",
    OPENCLAW_ARCHIVE_SECRET: "archive-secret"
  });

  const run = await server.runArchive("manual");
  assert.equal(run.snapshotsCreated, 3);

  const indexPath = path.join(fixture.root, "viewer-archive", "index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  const firstBlob = Object.values(index.blobs)[0];
  assert.ok(firstBlob);
  assert.equal(firstBlob.encrypted, true);

  const storedPath = path.join(fixture.root, "viewer-archive", firstBlob.storedRelativePath);
  const stored = await fs.readFile(storedPath, "utf8");
  assert.match(stored, /aes-256-gcm/);
  assert.doesNotMatch(stored, /hello before/);

  const snapshotId = Object.values(index.sources)[0].snapshots[0].snapshotId;
  const transcript = await server.getArchiveTranscript(snapshotId);
  assert.match(JSON.stringify(transcript.transcript), /hello before|legacy reset transcript|finance follow-up/);
});
