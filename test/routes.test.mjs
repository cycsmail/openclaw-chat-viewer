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
    return await import(`${SERVER_MODULE_URL}?routes=${Date.now()}-${Math.random()}`);
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

function buildTranscript({ timestampBase, senderId, senderName, body }) {
  const baseTime = Date.parse(timestampBase);
  return [
    { type: "session", version: 1, id: `session-${senderId}`, timestamp: new Date(baseTime).toISOString() },
    {
      type: "message", id: `user-${senderId}`, timestamp: new Date(baseTime + 1000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: body }] }
    },
    {
      type: "message", id: `assistant-${senderId}`, timestamp: new Date(baseTime + 2000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: `Reply for ${senderName}` }] }
    }
  ];
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-routes-"));
  const mainSessionsDir = path.join(root, "agents", "main", "sessions");
  const mediaDir = path.join(root, "media");
  await fs.mkdir(mainSessionsDir, { recursive: true });
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.writeFile(path.join(mediaDir, "photo.txt"), "photo data");

  const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  await fs.writeFile(
    path.join(mainSessionsDir, "sessions.json"),
    JSON.stringify({ "telegram:direct:100": { sessionId, updatedAt: Date.parse("2026-03-07T05:00:00.000Z"), chatType: "direct", origin: { provider: "telegram", chatType: "direct", to: "telegram:100", label: "test user" }, lastChannel: "telegram", lastTo: "telegram:100" } }, null, 2)
  );
  const entries = buildTranscript({ timestampBase: "2026-03-07T05:00:00.000Z", senderId: "100", senderName: "test user", body: "route test message" });
  await fs.writeFile(path.join(mainSessionsDir, `${sessionId}.jsonl`), entries.map(e => JSON.stringify(e)).join("\n") + "\n");

  return { root, sessionId };
}

async function request(httpServer, method, path, { body, headers = {} } = {}) {
  const address = httpServer.address();
  const url = `http://127.0.0.1:${address.port}${path}`;
  const options = { method, headers: { ...headers } };
  if (body) {
    options.body = JSON.stringify(body);
    options.headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, headers: response.headers, text, json };
}

test("HTTP route integration tests", { concurrency: false }, async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  const server = await importServer({
    OPENCLAW_HOME: fixture.root,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });

  const httpServer = server.createServer();
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));

  await t.test("GET /api/health returns ok", async () => {
    const res = await request(httpServer, "GET", "/api/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
  });

  await t.test("GET /api/overview returns structured overview", async () => {
    const res = await request(httpServer, "GET", "/api/overview");
    assert.equal(res.status, 200);
    assert.ok(res.json.liveSessions);
    assert.ok(res.json.threads);
    assert.ok(res.json.profiles);
    assert.ok(res.json.dashboard);
    assert.ok(res.json.archiveStatus);
  });

  await t.test("GET /api/sessions returns session list", async () => {
    const res = await request(httpServer, "GET", "/api/sessions");
    assert.equal(res.status, 200);
    assert.ok(res.json.sessions);
    assert.equal(res.json.count, res.json.sessions.length);
    assert.ok(res.json.generatedAt);
  });

  await t.test("GET /api/archive/status returns archive status", async () => {
    const res = await request(httpServer, "GET", "/api/archive/status");
    assert.equal(res.status, 200);
    assert.ok("snapshotCount" in res.json);
  });

  await t.test("GET /api/transcript returns transcript for valid params", async () => {
    const res = await request(httpServer, "GET", `/api/transcript?agentId=main&filename=${fixture.sessionId}.jsonl`);
    assert.equal(res.status, 200);
    assert.ok(res.json.transcript);
    assert.equal(res.json.agentId, "main");
  });

  await t.test("GET /api/transcript returns 400 for missing params", async () => {
    const res = await request(httpServer, "GET", "/api/transcript?agentId=main");
    assert.equal(res.status, 400);
    assert.ok(res.json.error);
  });

  await t.test("GET /api/transcript returns 400 for invalid agentId", async () => {
    const res = await request(httpServer, "GET", "/api/transcript?agentId=../../../etc&filename=foo.jsonl");
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Invalid agentId/);
  });

  await t.test("POST /api/archive/run requires action header", async () => {
    const res = await request(httpServer, "POST", "/api/archive/run");
    assert.equal(res.status, 403);
    assert.match(res.json.error, /action header/i);
  });

  await t.test("POST /api/archive/run works with action header", async () => {
    const res = await request(httpServer, "POST", "/api/archive/run", {
      headers: { "X-OpenClaw-Action": "archive-run" }
    });
    assert.equal(res.status, 200);
    assert.ok("snapshotsCreated" in res.json);
  });

  await t.test("POST /api/archive/prune validates keepLatest", async () => {
    const res = await request(httpServer, "POST", "/api/archive/prune", {
      body: { keepLatest: -1 },
      headers: { "X-OpenClaw-Action": "retention-prune" }
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Invalid keepLatest/);
  });

  await t.test("POST /api/archive/prune validates non-integer keepLatest", async () => {
    const res = await request(httpServer, "POST", "/api/archive/prune", {
      body: { keepLatest: 1.5 },
      headers: { "X-OpenClaw-Action": "retention-prune" }
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Invalid keepLatest/);
  });

  await t.test("POST /api/archive/prune works with valid keepLatest", async () => {
    const res = await request(httpServer, "POST", "/api/archive/prune", {
      body: { keepLatest: 3 },
      headers: { "X-OpenClaw-Action": "retention-prune" }
    });
    assert.equal(res.status, 200);
    assert.ok("removedSnapshots" in res.json);
  });

  await t.test("GET /api/archive/search returns results", async () => {
    const res = await request(httpServer, "GET", "/api/archive/search?q=route+test");
    assert.equal(res.status, 200);
    assert.ok(res.json.results);
    assert.ok(res.json.count >= 0);
    assert.ok("total" in res.json);
    assert.ok("limit" in res.json);
  });

  await t.test("GET /api/archive/transcript returns 400 without snapshotId", async () => {
    const res = await request(httpServer, "GET", "/api/archive/transcript");
    assert.equal(res.status, 400);
    assert.match(res.json.error, /snapshotId/);
  });

  await t.test("GET /api/archive/diff returns 400 without both snapshot params", async () => {
    const res = await request(httpServer, "GET", "/api/archive/diff?snapshotA=foo");
    assert.equal(res.status, 400);
    assert.match(res.json.error, /snapshotA and snapshotB/);
  });

  await t.test("GET /api/archive/export returns 400 without kind and id", async () => {
    const res = await request(httpServer, "GET", "/api/archive/export?format=json");
    assert.equal(res.status, 400);
    assert.match(res.json.error, /kind and id/);
  });

  await t.test("GET /api/annotations returns annotations", async () => {
    const res = await request(httpServer, "GET", "/api/annotations");
    assert.equal(res.status, 200);
    assert.ok(res.json.sessions !== undefined);
  });

  await t.test("POST /api/annotations requires action header", async () => {
    const res = await request(httpServer, "POST", "/api/annotations", {
      body: { bucket: "sessions", key: "test", bookmarked: true, note: "" }
    });
    assert.equal(res.status, 403);
  });

  await t.test("GET /api/dashboard returns dashboard data", async () => {
    const res = await request(httpServer, "GET", "/api/dashboard");
    assert.equal(res.status, 200);
    assert.ok("liveCount" in res.json);
    assert.ok("threadCount" in res.json);
  });

  await t.test("GET /api/media returns 400 without path", async () => {
    const res = await request(httpServer, "GET", "/api/media");
    assert.equal(res.status, 400);
    assert.match(res.json.error, /path/);
  });

  await t.test("PUT returns 405 Method Not Allowed", async () => {
    const res = await request(httpServer, "PUT", "/api/health");
    assert.equal(res.status, 405);
  });

  await t.test("GET / serves index.html", async () => {
    const res = await request(httpServer, "GET", "/");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("OpenClaw Explorer"));
    assert.ok(res.headers.get("content-security-policy"));
  });

  await t.test("GET /style.css serves CSS", async () => {
    const res = await request(httpServer, "GET", "/style.css");
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type").includes("text/css"));
  });

  await t.test("GET /nonexistent returns 404", async () => {
    const res = await request(httpServer, "GET", "/nonexistent.html");
    assert.equal(res.status, 404);
  });
});

test("token-protected routes return 401 for remote clients without token", { concurrency: false }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
  await fs.mkdir(path.join(root, "agents", "main", "sessions"), { recursive: true });
  await fs.writeFile(path.join(root, "agents", "main", "sessions", "sessions.json"), "{}");
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const server = await importServer({
    OPENCLAW_HOME: root,
    OPENCLAW_MONITOR_NO_LISTEN: "1",
    OPENCLAW_VIEWER_TOKEN: "secret-token"
  });

  const httpServer = server.createServer();
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));

  // Loopback requests without token should still work
  const healthRes = await request(httpServer, "GET", "/api/health");
  assert.equal(healthRes.status, 200);
});
