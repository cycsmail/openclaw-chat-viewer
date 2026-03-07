import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.HOME || "", ".openclaw");
const ROOT_DIR = path.resolve(OPENCLAW_HOME);
const AGENTS_DIR = path.join(ROOT_DIR, "agents");
const PUBLIC_DIR = path.join(__dirname, "public");
const HOST = process.env.HOST || "127.0.0.1";
const BASE_PORT = Number(process.env.PORT || 48312);
const MAX_PORT_ATTEMPTS = 25;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function buildHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

function resolveBindHost(configuredHost) {
  if (LOOPBACK_HOSTS.has(configuredHost)) {
    return configuredHost;
  }
  if (process.env.ALLOW_REMOTE_BIND === "1") {
    return configuredHost;
  }
  throw new Error(`Refusing to bind to non-loopback host "${configuredHost}" without ALLOW_REMOTE_BIND=1`);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, buildHeaders("application/json; charset=utf-8"));
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, buildHeaders(contentType));
  res.end(text);
}

function parseVariant(filename) {
  if (filename.endsWith(".jsonl")) {
    return "active";
  }
  if (filename.includes(".jsonl.reset.")) {
    return "reset";
  }
  if (filename.includes(".jsonl.deleted.")) {
    return "deleted";
  }
  if (filename.endsWith(".jsonl.lock")) {
    return "lock";
  }
  return "other";
}

function isTranscriptFile(filename) {
  return filename.endsWith(".jsonl") || filename.includes(".jsonl.reset.") || filename.includes(".jsonl.deleted.");
}

function extractSessionId(filename) {
  const match = filename.match(/^([0-9a-f-]+)\.jsonl/);
  return match ? match[1] : filename;
}

function extractTelegramId(...values) {
  for (const value of values) {
    if (typeof value !== "string" || !value) {
      continue;
    }
    const telegramTarget = value.match(/telegram:([-\d]+)/);
    if (telegramTarget) {
      return telegramTarget[1];
    }
    const sessionKeyTarget = value.match(/telegram:(?:direct|group|slash):([-\d]+)/);
    if (sessionKeyTarget) {
      return sessionKeyTarget[1];
    }
  }
  return null;
}

function summarizeContentNode(node) {
  if (!node) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(summarizeContentNode).filter(Boolean).join("\n");
  }
  if (typeof node !== "object") {
    return "";
  }
  if (typeof node.text === "string" && node.text.trim()) {
    return node.text.trim();
  }
  if (typeof node.thinking === "string" && node.thinking.trim()) {
    return `[thinking] ${node.thinking.trim()}`;
  }
  if (node.type === "toolCall") {
    return `[toolCall] ${node.name || "tool"} ${JSON.stringify(node.arguments || {})}`;
  }
  if (node.type === "toolResult") {
    return `[toolResult] ${node.toolName || "tool"}`;
  }
  return "";
}

function summarizeMessage(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  if (entry.type === "message" && entry.message) {
    const role = entry.message.role || entry.type;
    const body = summarizeContentNode(entry.message.content).trim();
    return body ? `${role}: ${body}` : role;
  }
  if (entry.type === "thinking_level_change") {
    return `thinking -> ${entry.thinkingLevel || "unknown"}`;
  }
  if (entry.type === "custom") {
    return `custom: ${entry.customType || "event"}`;
  }
  if (entry.type === "session") {
    return "session started";
  }
  return entry.type || "event";
}

function toMessageView(entry) {
  const base = {
    id: entry.id || null,
    timestamp: entry.timestamp || null,
    entryType: entry.type || "unknown"
  };
  if (entry.type === "message" && entry.message) {
    return {
      ...base,
      role: entry.message.role || "unknown",
      api: entry.message.api || null,
      provider: entry.message.provider || null,
      model: entry.message.model || null,
      summary: summarizeContentNode(entry.message.content),
      raw: entry.message
    };
  }
  if (entry.type === "session") {
    return {
      ...base,
      role: "session",
      summary: "session started",
      raw: {
        type: entry.type,
        version: entry.version,
        id: entry.id,
        timestamp: entry.timestamp
      }
    };
  }
  return {
    ...base,
    role: entry.type || "event",
    summary: summarizeMessage(entry),
    raw: entry
  };
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function readTranscriptEntries(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({
        type: "parse_error",
        timestamp: null,
        rawLine: line
      });
    }
  }
  return entries;
}

function resolveSessionsDir(agentId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    throw new Error("Invalid agentId");
  }
  const resolved = path.resolve(path.join(AGENTS_DIR, agentId, "sessions"));
  if (!resolved.startsWith(`${AGENTS_DIR}${path.sep}`)) {
    throw new Error("Invalid agentId");
  }
  return resolved;
}

export async function getSessions() {
  const agentNames = await fs.readdir(AGENTS_DIR).catch(() => []);
  const sessions = [];

  for (const agentId of agentNames) {
    const sessionsDir = path.join(AGENTS_DIR, agentId, "sessions");
    const stat = await fs.stat(sessionsDir).catch(() => null);
    if (!stat?.isDirectory()) {
      continue;
    }

    const indexPath = path.join(sessionsDir, "sessions.json");
    const indexJson = await readJson(indexPath, {});
    const activeById = new Map();
    for (const [sessionKey, meta] of Object.entries(indexJson)) {
      if (meta && typeof meta === "object" && meta.sessionId) {
        activeById.set(meta.sessionId, {
          sessionKey,
          ...meta
        });
      }
    }

    const files = await fs.readdir(sessionsDir).catch(() => []);
    for (const filename of files) {
      if (!isTranscriptFile(filename)) {
        continue;
      }
      const fullPath = path.join(sessionsDir, filename);
      const fileStat = await fs.stat(fullPath).catch(() => null);
      if (!fileStat?.isFile()) {
        continue;
      }

      const entries = await readTranscriptEntries(fullPath).catch(() => []);
      const sessionEntry = entries.find((entry) => entry.type === "session") || null;
      const messageEntries = entries.filter((entry) => entry.type === "message");
      const lastEntry = [...entries].reverse().find(Boolean) || null;
      const lastMessage = [...messageEntries].reverse().find(Boolean) || null;
      const sessionId = extractSessionId(filename);
      const variant = parseVariant(filename);
      const activeMeta = activeById.get(sessionId) || null;

      sessions.push({
        id: `${agentId}:${filename}`,
        agentId,
        filename,
        sessionId,
        sessionKey: activeMeta?.sessionKey || null,
        variant,
        active: Boolean(activeMeta && variant === "active"),
        startedAt: sessionEntry?.timestamp || null,
        updatedAt: activeMeta?.updatedAt ? new Date(activeMeta.updatedAt).toISOString() : (lastEntry?.timestamp || new Date(fileStat.mtimeMs).toISOString()),
        updatedAtMs: activeMeta?.updatedAt || fileStat.mtimeMs,
        chatType: activeMeta?.chatType || activeMeta?.origin?.chatType || null,
        channel: activeMeta?.origin?.provider || activeMeta?.lastChannel || null,
        telegramId: extractTelegramId(activeMeta?.origin?.to, activeMeta?.lastTo, activeMeta?.sessionKey, activeMeta?.origin?.from),
        originLabel: activeMeta?.origin?.label || null,
        deliveryTo: activeMeta?.origin?.to || activeMeta?.lastTo || null,
        model: activeMeta?.model || null,
        messageCount: messageEntries.length,
        eventCount: entries.length,
        lastRole: lastMessage?.message?.role || null,
        lastSnippet: summarizeMessage(lastMessage || lastEntry).slice(0, 280),
        sizeBytes: fileStat.size
      });
    }
  }

  sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return sessions;
}

export async function getTranscript(agentId, filename) {
  const sessionsDir = resolveSessionsDir(agentId);
  if (path.basename(filename) !== filename || !isTranscriptFile(filename)) {
    throw new Error("Invalid path");
  }
  const target = path.resolve(path.join(sessionsDir, filename));
  if (!target.startsWith(`${sessionsDir}${path.sep}`)) {
    throw new Error("Invalid path");
  }
  const entries = await readTranscriptEntries(target);
  return entries.map(toMessageView);
}

async function serveStatic(req, res, pathname) {
  const localPath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(path.join(PUBLIC_DIR, `.${localPath}`));
  if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`) && resolved !== PUBLIC_DIR) {
    sendText(res, 403, "Forbidden");
    return;
  }
  const ext = path.extname(resolved);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  }[ext] || "application/octet-stream";

  try {
    const content = await fs.readFile(resolved);
    res.writeHead(200, buildHeaders(contentType));
    res.end(content);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function formatClientError(error) {
  if (!(error instanceof Error)) {
    return "Unknown error";
  }
  if (error.message === "Invalid path" || error.message === "Invalid agentId") {
    return error.message;
  }
  if ("code" in error && error.code === "ENOENT") {
    return "Requested file was not found";
  }
  return "Internal server error";
}

export function createServer() {
  return http.createServer(async (req, res) => {
  if (!req.url) {
    sendText(res, 400, "Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${BASE_PORT}`}`);

  try {
    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/sessions") {
      const sessions = await getSessions();
      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        count: sessions.length,
        sessions
      });
      return;
    }

    if (url.pathname === "/api/transcript") {
      const agentId = url.searchParams.get("agentId");
      const filename = url.searchParams.get("filename");
      if (!agentId || !filename) {
        sendJson(res, 400, { error: "agentId and filename are required" });
        return;
      }
      const transcript = await getTranscript(agentId, filename);
      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        agentId,
        filename,
        transcript
      });
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, {
      error: formatClientError(error)
    });
  }
  });
}

function canListen(host, port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      resolve(false);
    });
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

async function findAvailablePort(host, basePort) {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = basePort + offset;
    if (await canListen(host, port)) {
      return port;
    }
  }
  throw new Error(`No free port found from ${basePort} to ${basePort + MAX_PORT_ATTEMPTS - 1}`);
}

if (process.env.OPENCLAW_MONITOR_NO_LISTEN !== "1" && process.argv[1] === __filename) {
  const bindHost = resolveBindHost(HOST);
  const port = await findAvailablePort(bindHost, BASE_PORT);
  const server = createServer();
  server.listen(port, bindHost, () => {
    console.log(`OpenClaw Chat Viewer listening on http://${bindHost}:${port}`);
  });
}
