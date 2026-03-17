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

test("slugifyMachineName generates valid ids", async () => {
  const server = await importServer({
    OPENCLAW_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "oc-slug-")),
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });
  const slugify = server.__test.slugifyMachineName;

  assert.equal(slugify("Trucking Server"), "trucking-server");
  assert.equal(slugify("  My Machine!!  "), "my-machine");
  assert.equal(slugify("UPPER_CASE_123"), "upper-case-123");
  assert.equal(slugify(""), "");
  assert.equal(slugify("---dashes---"), "dashes");
});

test("addOrUpdateMachine validates profile", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-validate-"));
  const server = await importServer({
    OPENCLAW_HOME: root,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });
  const addOrUpdate = server.__test.addOrUpdateMachine;

  await assert.rejects(() => addOrUpdate(null), { message: "Invalid machine profile" });
  await assert.rejects(() => addOrUpdate({ name: "" }), { message: "Invalid machine profile" });
  await assert.rejects(() => addOrUpdate({ name: "Test" }), { message: "Invalid machine profile" });
  await assert.rejects(() => addOrUpdate({ name: "Test", host: "" }), { message: "Invalid machine profile" });

  await fs.rm(root, { recursive: true, force: true });
});

test("addOrUpdateMachine creates and updates machine profiles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-crud-"));
  const server = await importServer({
    OPENCLAW_HOME: root,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });

  const result = await server.__test.addOrUpdateMachine({
    name: "Trucking",
    host: "192.0.2.10",
    user: "testuser",
    port: 22,
    openclawHome: "~/.openclaw"
  });
  assert.equal(result.id, "trucking");
  assert.equal(result.name, "Trucking");
  assert.equal(result.host, "192.0.2.10");

  const machines = await server.__test.loadMachines();
  assert.ok(machines.some((m) => m.id === "local"), "should have implicit local");
  assert.ok(machines.some((m) => m.id === "trucking"), "should have trucking");

  const updated = await server.__test.addOrUpdateMachine({
    id: "trucking",
    name: "Trucking Updated",
    host: "192.0.2.11"
  });
  assert.equal(updated.name, "Trucking Updated");
  assert.equal(updated.host, "192.0.2.11");

  const machinesAfter = await server.__test.loadMachines();
  assert.equal(machinesAfter.filter((m) => m.id === "trucking").length, 1);

  await fs.rm(root, { recursive: true, force: true });
});

test("removeMachine removes profile and rejects invalid ids", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-rm-"));
  const server = await importServer({
    OPENCLAW_HOME: root,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });

  await server.__test.addOrUpdateMachine({ name: "ToDelete", host: "1.2.3.4" });
  const before = await server.__test.loadMachines();
  assert.ok(before.some((m) => m.id === "todelete"));

  await server.__test.removeMachine("todelete");
  const after = await server.__test.loadMachines();
  assert.ok(!after.some((m) => m.id === "todelete"));

  await assert.rejects(() => server.__test.removeMachine("local"), { message: "Invalid machineId" });
  await assert.rejects(() => server.__test.removeMachine("nonexistent"), { message: "Machine not found" });

  await fs.rm(root, { recursive: true, force: true });
});

test("getMachineCachedAgentsDir returns correct path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-path-"));
  const server = await importServer({
    OPENCLAW_HOME: root,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });

  const agentsDir = server.__test.getMachineCachedAgentsDir("trucking");
  assert.ok(agentsDir.includes("machines"));
  assert.ok(agentsDir.includes("trucking"));
  assert.ok(agentsDir.endsWith("agents"));

  await fs.rm(root, { recursive: true, force: true });
});

test("uploadSessionData writes file to cache directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-upload-"));
  const server = await importServer({
    OPENCLAW_HOME: root,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });

  await server.__test.addOrUpdateMachine({ name: "Upload Target", host: "1.2.3.4" });

  const content = '{"type":"session"}\n{"type":"message"}\n';
  const result = await server.__test.uploadSessionData("upload-target", "main", "test-session.jsonl", content);
  assert.ok(result.ok);

  const written = await fs.readFile(result.path, "utf8");
  assert.equal(written, content);

  await assert.rejects(
    () => server.__test.uploadSessionData("local", "main", "test.jsonl", "data"),
    { message: "Invalid machineId" }
  );

  await fs.rm(root, { recursive: true, force: true });
});

test("key scoping: local keys unchanged, remote keys include machineId", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-keys-"));
  const server = await importServer({
    OPENCLAW_HOME: root,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });

  const buildThreadKey = server.__test.buildThreadKey;
  const buildProfileKey = server.__test.buildProfileKey;

  // Local keys (no machineId or machineId="local") should be unchanged
  const localThread = buildThreadKey({
    agentId: "main",
    chatType: "direct",
    telegramId: "12345"
  });
  assert.equal(localThread, "thread:telegram:main:direct:12345");

  const localThreadWithLocal = buildThreadKey({
    agentId: "main",
    chatType: "direct",
    telegramId: "12345",
    machineId: "local"
  });
  assert.equal(localThreadWithLocal, "thread:telegram:main:direct:12345");

  const localProfile = buildProfileKey("12345");
  assert.equal(localProfile, "profile:telegram:12345");

  const localProfileWithLocal = buildProfileKey("12345", "local");
  assert.equal(localProfileWithLocal, "profile:telegram:12345");

  // Remote keys should include machineId
  const remoteThread = buildThreadKey({
    agentId: "main",
    chatType: "direct",
    telegramId: "12345",
    machineId: "trucking"
  });
  assert.equal(remoteThread, "thread:telegram:trucking:main:direct:12345");

  const remoteProfile = buildProfileKey("12345", "trucking");
  assert.equal(remoteProfile, "profile:telegram:trucking:12345");

  // Session-key based thread
  const remoteSessionThread = buildThreadKey({
    agentId: "main",
    sessionKey: "telegram:direct:12345",
    machineId: "trucking"
  });
  assert.equal(remoteSessionThread, "thread:session-key:trucking:main:telegram:direct:12345");

  // Session-based thread (fallback)
  const remoteSessionFallback = buildThreadKey({
    agentId: "main",
    sessionId: "abc123",
    machineId: "trucking"
  });
  assert.equal(remoteSessionFallback, "thread:session:trucking:main:abc123");

  await fs.rm(root, { recursive: true, force: true });
});

test("loadMachines always includes local entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-local-"));
  const server = await importServer({
    OPENCLAW_HOME: root,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });

  const machines = await server.__test.loadMachines();
  assert.ok(machines.length >= 1);
  assert.equal(machines[0].id, "local");
  assert.equal(machines[0].name, "Local");

  await fs.rm(root, { recursive: true, force: true });
});

test("API endpoints for machines work through createServer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-api-"));
  const server = await importServer({
    OPENCLAW_HOME: root,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });

  // Load machines via the exported function
  const machines = await server.__test.loadMachines();
  assert.ok(Array.isArray(machines));
  assert.ok(machines.some((m) => m.id === "local"));

  // Add a machine
  const added = await server.__test.addOrUpdateMachine({
    name: "API Test",
    host: "192.168.1.100",
    user: "testuser",
    port: 2222
  });
  assert.equal(added.id, "api-test");

  // Verify it persisted
  const afterAdd = await server.__test.loadMachines();
  assert.ok(afterAdd.some((m) => m.id === "api-test"));

  // Remove it
  await server.__test.removeMachine("api-test");
  const afterRemove = await server.__test.loadMachines();
  assert.ok(!afterRemove.some((m) => m.id === "api-test"));

  await fs.rm(root, { recursive: true, force: true });
});

test("remote sessions read from cached agents dir", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oc-remote-"));
  const server = await importServer({
    OPENCLAW_HOME: root,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });

  // Setup a machine and create cached session data
  await server.__test.addOrUpdateMachine({ name: "Remote Box", host: "10.0.0.1" });
  const cacheAgentsDir = server.__test.getMachineCachedAgentsDir("remote-box");
  const sessionsDir = path.join(cacheAgentsDir, "main", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const filename = `${sessionId}.jsonl`;
  const entries = [
    { type: "session", version: 1, id: "s1", timestamp: "2026-03-10T01:00:00.000Z" },
    { type: "message", id: "m1", timestamp: "2026-03-10T01:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello remote" }] } }
  ];
  await fs.writeFile(path.join(sessionsDir, filename), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await fs.writeFile(path.join(sessionsDir, "sessions.json"), "{}\n");

  // Get remote sessions
  const sessions = await server.getRemoteSessions("remote-box");
  assert.ok(sessions.length >= 1);
  assert.equal(sessions[0].machineId, "remote-box");
  assert.ok(sessions[0].id.startsWith("remote-box/"));

  // Get transcript from cached dir
  const transcript = await server.getTranscript("main", filename, cacheAgentsDir);
  assert.ok(transcript.length >= 1);

  await fs.rm(root, { recursive: true, force: true });
});
