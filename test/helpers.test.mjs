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
    return await import(`${SERVER_MODULE_URL}?helpers=${Date.now()}-${Math.random()}`);
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

let server;
let helperFixtureRoot;
test.before(async () => {
  helperFixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-helpers-"));
  await fs.mkdir(path.join(helperFixtureRoot, "agents", "main", "sessions"), { recursive: true });
  await fs.mkdir(path.join(helperFixtureRoot, "media"), { recursive: true });
  await fs.writeFile(path.join(helperFixtureRoot, "agents", "main", "sessions", "sessions.json"), "{}");
  server = await importServer({
    OPENCLAW_HOME: helperFixtureRoot,
    OPENCLAW_MONITOR_NO_LISTEN: "1"
  });
});
test.after(async () => {
  if (helperFixtureRoot) {
    await fs.rm(helperFixtureRoot, { recursive: true, force: true });
  }
});

test("parseVariant extracts variant from filenames", () => {
  const { parseVariant } = server.__test;
  assert.equal(parseVariant("abc.jsonl"), "active");
  assert.equal(parseVariant("abc.jsonl.reset.2026-03-04T01-02-03Z"), "reset");
  assert.equal(parseVariant("abc.jsonl.deleted.2026-03-05T04-05-06Z"), "deleted");
  assert.equal(parseVariant("abc.jsonl.lock"), "lock");
  assert.equal(parseVariant("abc.txt"), "other");
});

test("isTranscriptFile identifies transcript files correctly", () => {
  const { isTranscriptFile } = server.__test;
  assert.equal(isTranscriptFile("abc.jsonl"), true);
  assert.equal(isTranscriptFile("abc.jsonl.reset.2026-03-04T00-00-00Z"), true);
  assert.equal(isTranscriptFile("abc.jsonl.deleted.2026-03-04T00-00-00Z"), true);
  assert.equal(isTranscriptFile("sessions.json"), false);
  assert.equal(isTranscriptFile("notes.txt"), false);
  assert.equal(isTranscriptFile(".hidden.jsonl"), true);
});

test("extractSessionId extracts UUID from filenames", () => {
  const { extractSessionId } = server.__test;
  assert.equal(extractSessionId("11111111-1111-1111-1111-111111111111.jsonl"), "11111111-1111-1111-1111-111111111111");
  assert.equal(extractSessionId("11111111-1111-1111-1111-111111111111.jsonl.reset.2026-03-04T01-02-03Z"), "11111111-1111-1111-1111-111111111111");
  assert.equal(extractSessionId("nosession.jsonl"), "nosession.jsonl");
});

test("extractTelegramId extracts IDs from various formats", () => {
  const { extractTelegramId } = server.__test;
  assert.equal(extractTelegramId("telegram:2009539480"), "2009539480");
  assert.equal(extractTelegramId("telegram:direct:2009539480"), "2009539480");
  assert.equal(extractTelegramId(null, undefined, "telegram:2009539480"), "2009539480");
  assert.equal(extractTelegramId("no-match"), null);
  assert.equal(extractTelegramId(), null);
});

test("sanitizeArchiveSegment strips unsafe characters", () => {
  const { sanitizeArchiveSegment } = server.__test;
  assert.equal(sanitizeArchiveSegment("hello-world_1", "default"), "hello-world_1");
  assert.equal(sanitizeArchiveSegment("a/b\\c:d", "default"), "a-b-c-d");
  assert.equal(sanitizeArchiveSegment("../../../etc/passwd", "default"), "..-..-..-etc-passwd");
  assert.equal(sanitizeArchiveSegment("", "default"), "default");
  assert.equal(sanitizeArchiveSegment(null, "default"), "default");
  assert.equal(sanitizeArchiveSegment("a".repeat(200), "default").length, 120);
});

test("resolveSessionsDir rejects invalid agentIds", () => {
  const { resolveSessionsDir } = server.__test;
  assert.throws(() => resolveSessionsDir("../../../etc"), /Invalid agentId/);
  assert.throws(() => resolveSessionsDir("has spaces"), /Invalid agentId/);
  assert.throws(() => resolveSessionsDir(""), /Invalid agentId/);
  assert.throws(() => resolveSessionsDir("a".repeat(101)), /Invalid agentId/);
  assert.doesNotThrow(() => resolveSessionsDir("main"));
  assert.doesNotThrow(() => resolveSessionsDir("agent-1_test"));
});

test("resolveMediaPath rejects path traversal", () => {
  const { resolveMediaPath } = server.__test;
  assert.equal(resolveMediaPath("../../etc/passwd"), null);
  assert.equal(resolveMediaPath("/absolute/path"), null);
  assert.equal(resolveMediaPath(null), null);
  assert.equal(resolveMediaPath(""), null);
});

test("splitSearchTerms handles various inputs", () => {
  const { splitSearchTerms } = server.__test;
  assert.deepEqual(splitSearchTerms("hello world"), ["hello", "world"]);
  assert.deepEqual(splitSearchTerms("  HELLO  "), ["hello"]);
  assert.deepEqual(splitSearchTerms(""), []);
  assert.deepEqual(splitSearchTerms(null), []);
  assert.deepEqual(splitSearchTerms("  "), []);
});

test("diffLines identifies removed and added lines", () => {
  const { diffLines } = server.__test;
  const result = diffLines(["a", "b", "c"], ["a", "x", "c"]);
  assert.deepEqual(result.removed, ["b"]);
  assert.deepEqual(result.added, ["x"]);
  assert.equal(result.beforeCount, 3);
  assert.equal(result.afterCount, 3);

  const empty = diffLines([], []);
  assert.deepEqual(empty.removed, []);
  assert.deepEqual(empty.added, []);

  const allNew = diffLines([], ["a", "b"]);
  assert.deepEqual(allNew.added, ["a", "b"]);
  assert.deepEqual(allNew.removed, []);
});

test("parseTranscriptEntries handles valid and invalid JSONL", () => {
  const { parseTranscriptEntries } = server.__test;
  const entries = parseTranscriptEntries('{"type":"session"}\n{"type":"message"}\nnot json\n');
  assert.equal(entries.length, 3);
  assert.equal(entries[0].type, "session");
  assert.equal(entries[1].type, "message");
  assert.equal(entries[2].type, "parse_error");
  assert.equal(entries[2].rawLine, "not json");

  const empty = parseTranscriptEntries("");
  assert.equal(empty.length, 0);

  const nullInput = parseTranscriptEntries(null);
  assert.equal(nullInput.length, 0);
});

test("toMessageView handles various entry types", () => {
  const { toMessageView } = server.__test;
  const msg = toMessageView({
    type: "message",
    id: "m1",
    timestamp: "2026-03-07T05:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "hello" }] }
  });
  assert.equal(msg.role, "user");
  assert.equal(msg.entryType, "message");
  assert.ok(msg.summary.includes("hello"));

  const session = toMessageView({
    type: "session",
    version: 1,
    id: "s1",
    timestamp: "2026-03-07T05:00:00.000Z"
  });
  assert.equal(session.role, "session");
  assert.equal(session.entryType, "session");

  const parseErr = toMessageView({
    type: "parse_error",
    rawLine: "bad data"
  });
  assert.equal(parseErr.entryType, "parse_error");
});

test("formatClientError returns known error messages and hides unknown ones", () => {
  const { formatClientError } = server.__test;
  assert.equal(formatClientError(new Error("Invalid path")), "Invalid path");
  assert.equal(formatClientError(new Error("Invalid agentId")), "Invalid agentId");
  assert.equal(formatClientError(new Error("some internal detail")), "Internal server error");
  assert.equal(formatClientError("not an error"), "Unknown error");
  const enoent = new Error("file not found");
  enoent.code = "ENOENT";
  assert.equal(formatClientError(enoent), "Requested file was not found");
});

test("statusCodeForError maps errors to HTTP status codes", () => {
  const { statusCodeForError } = server.__test;
  assert.equal(statusCodeForError(new Error("Invalid path")), 400);
  assert.equal(statusCodeForError(new Error("Invalid agentId")), 400);
  assert.equal(statusCodeForError(new Error("Archive writes require a loopback client")), 403);
  assert.equal(statusCodeForError(new Error("Viewer token required for remote access")), 401);
  assert.equal(statusCodeForError(new Error("Invalid viewer token")), 401);
  assert.equal(statusCodeForError(new Error("Archive snapshot not found")), 404);
  assert.equal(statusCodeForError(new Error("Request body too large")), 413);
  assert.equal(statusCodeForError(new Error("unknown error")), 500);
  assert.equal(statusCodeForError("not an error"), 500);
  const enoent = new Error("no such file");
  enoent.code = "ENOENT";
  assert.equal(statusCodeForError(enoent), 404);
});

test("buildThreadKey uses telegramId when available", () => {
  const { buildThreadKey } = server.__test;
  const withTelegram = buildThreadKey({ agentId: "main", telegramId: "12345", chatType: "direct" });
  assert.match(withTelegram, /telegram/);
  assert.match(withTelegram, /12345/);

  const withSessionKey = buildThreadKey({ agentId: "main", sessionKey: "key1" });
  assert.match(withSessionKey, /session-key/);

  const fallback = buildThreadKey({ agentId: "main", sessionId: "sid1" });
  assert.match(fallback, /session/);
});

test("buildProfileKey includes telegramId", () => {
  const { buildProfileKey } = server.__test;
  assert.equal(buildProfileKey("12345"), "profile:telegram:12345");
});

test("extractAttachmentsFromText finds media attachments", () => {
  const { extractAttachmentsFromText } = server.__test;
  const text = "[media attached: scan.txt (text/plain) | /some/path/scan.txt]";
  const attachments = extractAttachmentsFromText(text);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].kind, "media-attached");
  assert.equal(attachments[0].label, "scan.txt");

  const inline = "check this MEDIA:/some/file.png out";
  const inlineAttachments = extractAttachmentsFromText(inline);
  assert.equal(inlineAttachments.length, 1);
  assert.equal(inlineAttachments[0].kind, "media-inline");

  assert.deepEqual(extractAttachmentsFromText(""), []);
  assert.deepEqual(extractAttachmentsFromText(null), []);
});
