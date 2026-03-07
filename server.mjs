import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.HOME || "", ".openclaw");
const ROOT_DIR = path.resolve(OPENCLAW_HOME);
const AGENTS_DIR = path.join(ROOT_DIR, "agents");
const PUBLIC_DIR = path.join(__dirname, "public");
const ARCHIVE_DIR = path.join(ROOT_DIR, "viewer-archive");
const ARCHIVE_INDEX_PATH = path.join(ARCHIVE_DIR, "index.json");
const ANNOTATIONS_PATH = path.join(ARCHIVE_DIR, "annotations.json");
const HOST = process.env.HOST || "127.0.0.1";
const MAX_PORT_ATTEMPTS = 25;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const BASE_PORT = resolveBasePort(process.env.PORT);
const ARCHIVE_INTERVAL_MINUTES = resolveArchiveInterval(process.env.OPENCLAW_ARCHIVE_INTERVAL_MINUTES);
const ARCHIVE_INTERVAL_MS = ARCHIVE_INTERVAL_MINUTES > 0 ? ARCHIVE_INTERVAL_MINUTES * 60_000 : 0;
const ARCHIVE_KEEP_LATEST = resolveKeepLatest(process.env.OPENCLAW_ARCHIVE_KEEP_LATEST);
const ARCHIVE_MODE = resolveArchiveMode(process.env.OPENCLAW_ARCHIVE_MODE);
const ARCHIVE_SECRET = process.env.OPENCLAW_ARCHIVE_SECRET || "";
const VIEWER_AUTH_TOKEN = process.env.OPENCLAW_VIEWER_TOKEN || process.env.VIEWER_AUTH_TOKEN || "";
let archiveRunPromise = null;
let archiveIntervalHandle = null;

function buildHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

function resolveBasePort(configuredPort) {
  if (!configuredPort) {
    return 48312;
  }
  const parsed = Number(configuredPort);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed;
  }
  return 48312;
}

function resolveArchiveInterval(configuredInterval) {
  if (!configuredInterval) {
    return 0;
  }
  const parsed = Number(configuredInterval);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 7 * 24 * 60) {
    return parsed;
  }
  return 0;
}

function resolveKeepLatest(configuredKeepLatest) {
  if (!configuredKeepLatest) {
    return 0;
  }
  const parsed = Number(configuredKeepLatest);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000) {
    return parsed;
  }
  return 0;
}

function resolveArchiveMode(configuredMode) {
  if (configuredMode === "sensitive") {
    return "sensitive";
  }
  return "standard";
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

function hashContent(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function createAnnotationsStore() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    sessions: {},
    threads: {},
    profiles: {}
  };
}

function getArchiveKeyMaterial() {
  if (ARCHIVE_MODE !== "sensitive") {
    return null;
  }
  if (!ARCHIVE_SECRET) {
    throw new Error("Sensitive archive mode requires OPENCLAW_ARCHIVE_SECRET");
  }
  return scryptSync(ARCHIVE_SECRET, "openclaw-chat-viewer-archive", 32);
}

function encryptArchiveBlob(raw) {
  const key = getArchiveKeyMaterial();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    mode: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64")
  });
}

function decryptArchiveBlob(stored) {
  const payload = JSON.parse(stored);
  if (!payload || payload.mode !== "aes-256-gcm") {
    throw new Error("Invalid encrypted archive payload");
  }
  const key = getArchiveKeyMaterial();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

function sanitizeArchiveSegment(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 120) || fallback;
}

function normalizePathSlashes(value) {
  return String(value || "").split(path.sep).join("/");
}

function createArchiveIndex() {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    lastRun: null,
    lastSuccessfulRunAt: null,
    settings: {
      archiveDir: ARCHIVE_DIR,
      intervalMinutes: ARCHIVE_INTERVAL_MINUTES
    },
    blobs: {},
    sources: {}
  };
}

async function loadArchiveIndex() {
  const index = await readJson(ARCHIVE_INDEX_PATH, null);
  if (!index || typeof index !== "object") {
    return createArchiveIndex();
  }
  return {
    ...createArchiveIndex(),
    ...index,
    blobs: index.blobs && typeof index.blobs === "object" ? index.blobs : {},
    sources: index.sources && typeof index.sources === "object" ? index.sources : {}
  };
}

async function saveArchiveIndex(index) {
  const payload = {
    ...index,
    updatedAt: new Date().toISOString(),
    settings: {
      archiveDir: ARCHIVE_DIR,
      intervalMinutes: ARCHIVE_INTERVAL_MINUTES
    }
  };
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const tempPath = `${ARCHIVE_INDEX_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2));
  await fs.rename(tempPath, ARCHIVE_INDEX_PATH);
}

async function loadAnnotations() {
  const annotations = await readJson(ANNOTATIONS_PATH, null);
  if (!annotations || typeof annotations !== "object") {
    return createAnnotationsStore();
  }
  return {
    ...createAnnotationsStore(),
    ...annotations,
    sessions: annotations.sessions && typeof annotations.sessions === "object" ? annotations.sessions : {},
    threads: annotations.threads && typeof annotations.threads === "object" ? annotations.threads : {},
    profiles: annotations.profiles && typeof annotations.profiles === "object" ? annotations.profiles : {}
  };
}

async function saveAnnotations(annotations) {
  const payload = {
    ...annotations,
    updatedAt: new Date().toISOString()
  };
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const tempPath = `${ANNOTATIONS_PATH}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2));
  await fs.rename(tempPath, ANNOTATIONS_PATH);
}

function buildArchiveSourceKey(agentId, filename) {
  return normalizePathSlashes(path.join("agents", agentId, "sessions", filename));
}

function buildArchivedRelativePath(session, hash) {
  const channel = sanitizeArchiveSegment(session.channel || "unknown-channel", "unknown-channel");
  const chatType = sanitizeArchiveSegment(session.chatType || "unknown-chat", "unknown-chat");
  const telegramId = sanitizeArchiveSegment(session.telegramId || "unknown-telegram", "unknown-telegram");
  const agentId = sanitizeArchiveSegment(session.agentId, "unknown-agent");
  const sessionId = sanitizeArchiveSegment(session.sessionId || extractSessionId(session.filename), "unknown-session");
  const variant = sanitizeArchiveSegment(session.variant || "unknown", "unknown");
  const extension = ARCHIVE_MODE === "sensitive" ? ".jsonl.enc" : ".jsonl";
  return path.join("transcripts", channel, chatType, telegramId, agentId, `${sessionId}--${variant}--${hash.slice(0, 12)}${extension}`);
}

async function ensureArchiveBlob(index, hash, raw, preferredRelativePath) {
  const existing = index.blobs[hash];
  const relativePath = existing?.storedRelativePath || preferredRelativePath;
  const target = path.join(ARCHIVE_DIR, relativePath);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isFile()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const payload = ARCHIVE_MODE === "sensitive" ? encryptArchiveBlob(raw) : raw;
    await fs.writeFile(target, payload);
  }
  if (!existing) {
    index.blobs[hash] = {
      hash,
      storedRelativePath: relativePath,
      sizeBytes: Buffer.byteLength(raw),
      firstSeenAt: new Date().toISOString(),
      encrypted: ARCHIVE_MODE === "sensitive",
      refCount: 0
    };
  }
  return relativePath;
}

function findExistingSnapshot(sourceEntry, fingerprint) {
  if (!sourceEntry || !Array.isArray(sourceEntry.snapshots)) {
    return null;
  }
  return sourceEntry.snapshots.find((snapshot) => snapshot.fingerprint === fingerprint) || null;
}

function summarizeArchiveStatus(index) {
  const sources = Object.values(index.sources || {});
  const snapshots = sources.flatMap((source) => Array.isArray(source.snapshots) ? source.snapshots : []);
  const telegramIds = new Set(snapshots.map((snapshot) => snapshot.telegramId).filter(Boolean));
  return {
    archiveDir: ARCHIVE_DIR,
    enabled: ARCHIVE_INTERVAL_MINUTES > 0,
    intervalMinutes: ARCHIVE_INTERVAL_MINUTES,
    lastRun: index.lastRun || null,
    lastSuccessfulRunAt: index.lastSuccessfulRunAt || null,
    sourceCount: sources.length,
    snapshotCount: snapshots.length,
    storedBlobCount: Object.keys(index.blobs || {}).length,
    telegramIdCount: telegramIds.size
  };
}

function countBookmarkedAnnotations(annotations) {
  return ["sessions", "threads", "profiles"]
    .flatMap((bucket) => Object.values(annotations?.[bucket] || {}))
    .filter((value) => value?.bookmarked === true)
    .length;
}

function ensureStateChangingRequest(req, url) {
  const remoteAddress = req.socket?.remoteAddress || "";
  const isLoopback = isLoopbackAddress(remoteAddress);
  if (!isLoopback) {
    throw new Error("Archive writes require a loopback client");
  }
  if (typeof req.headers["x-openclaw-action"] !== "string" || !req.headers["x-openclaw-action"]) {
    throw new Error("Missing archive action header");
  }
  if (req.headers.origin) {
    let origin;
    try {
      origin = new URL(req.headers.origin);
    } catch {
      throw new Error("Origin mismatch");
    }
    if (origin.host !== url.host) {
      throw new Error("Origin mismatch");
    }
  }
}

function getRequestToken(req, url) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  const headerToken = req.headers["x-viewer-token"];
  if (typeof headerToken === "string" && headerToken) {
    return headerToken;
  }
  return "";
}

function requireViewerAccess(req, url) {
  const remoteAddress = req.socket?.remoteAddress || "";
  if (isLoopbackAddress(remoteAddress)) {
    return;
  }
  if (!VIEWER_AUTH_TOKEN) {
    throw new Error("Viewer token required for remote access");
  }
  const supplied = getRequestToken(req, url);
  const expected = Buffer.from(VIEWER_AUTH_TOKEN, "utf8");
  const actual = Buffer.from(supplied, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Invalid viewer token");
  }
}

async function parseJsonRequestBody(req, limitBytes = 64 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > limitBytes) {
      throw new Error("Request body too large");
    }
  }
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
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

function flattenMessageText(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((node) => node && typeof node === "object" && node.type === "text" && typeof node.text === "string")
    .map((node) => node.text)
    .join("\n");
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

function extractJsonBlock(text, heading) {
  if (typeof text !== "string" || !text) {
    return null;
  }
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedHeading}:\\s*\`\`\`json\\s*([\\s\\S]*?)\\s*\`\`\``);
  const match = text.match(pattern);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractTelegramIdFromLabel(label) {
  if (typeof label !== "string" || !label) {
    return null;
  }
  const match = label.match(/id:([-\d]+)/);
  return match ? match[1] : null;
}

function deriveTranscriptOrigin(entries) {
  for (const entry of entries) {
    if (entry?.type !== "message" || entry?.message?.role !== "user") {
      continue;
    }
    const text = flattenMessageText(entry.message.content);
    if (!text.includes("Conversation info (untrusted metadata)")) {
      continue;
    }

    const conversation = extractJsonBlock(text, "Conversation info (untrusted metadata)");
    const sender = extractJsonBlock(text, "Sender (untrusted metadata)");
    if (!conversation && !sender) {
      continue;
    }

    const isGroupChat = conversation?.is_group_chat === true;
    const telegramId = isGroupChat
      ? extractTelegramIdFromLabel(conversation?.conversation_label) || extractTelegramIdFromLabel(conversation?.group_subject)
      : String(conversation?.sender_id || sender?.id || "").trim() || null;

    return {
      channel: "telegram",
      chatType: isGroupChat ? "group" : "direct",
      telegramId,
      originLabel: conversation?.conversation_label || sender?.label || conversation?.sender || null,
      deliveryTo: telegramId ? `telegram:${telegramId}` : null,
      sessionKey: telegramId ? `telegram:${isGroupChat ? "group" : "direct"}:${telegramId}` : null
    };
  }

  return null;
}

function resolveMediaPath(candidatePath) {
  if (typeof candidatePath !== "string" || !candidatePath) {
    return null;
  }
  const resolved = path.resolve(candidatePath);
  const mediaRoot = path.join(ROOT_DIR, "media");
  if (resolved === mediaRoot || resolved.startsWith(`${mediaRoot}${path.sep}`)) {
    return resolved;
  }
  return null;
}

function extractAttachmentsFromText(text) {
  if (typeof text !== "string" || !text) {
    return [];
  }

  const attachments = [];
  const attachedPattern = /\[media attached:\s*([^\]|]+?)(?:\s+\(([^)]+)\))?\s*\|\s*([^\]]+)\]/g;
  let match;
  while ((match = attachedPattern.exec(text)) !== null) {
    const sourcePath = match[3]?.trim() || match[1]?.trim();
    attachments.push({
      kind: "media-attached",
      label: path.basename(sourcePath || match[1] || "attachment"),
      mimeType: match[2] || null,
      sourcePath,
      safeMediaPath: resolveMediaPath(sourcePath)
    });
  }

  const inlinePattern = /MEDIA:([^\s]+)/g;
  while ((match = inlinePattern.exec(text)) !== null) {
    const sourcePath = match[1].trim();
    attachments.push({
      kind: "media-inline",
      label: path.basename(sourcePath),
      mimeType: null,
      sourcePath,
      safeMediaPath: resolveMediaPath(sourcePath)
    });
  }

  return attachments;
}

function extractAttachments(content) {
  const text = flattenMessageText(content);
  const attachments = extractAttachmentsFromText(text);
  for (const node of Array.isArray(content) ? content : []) {
    if (!node || typeof node !== "object") {
      continue;
    }
    if (node.type === "image" && typeof node.mimeType === "string") {
      attachments.push({
        kind: "embedded-image",
        label: `embedded-image.${node.mimeType.split("/").pop() || "bin"}`,
        mimeType: node.mimeType,
        sourcePath: null,
        safeMediaPath: null
      });
    }
  }
  return attachments;
}

function toMessageView(entry) {
  const base = {
    id: entry.id || null,
    timestamp: entry.timestamp || null,
    entryType: entry.type || "unknown"
  };
  if (entry.type === "message" && entry.message) {
    const summary = summarizeContentNode(entry.message.content);
    return {
      ...base,
      role: entry.message.role || "unknown",
      api: entry.message.api || null,
      provider: entry.message.provider || null,
      model: entry.message.model || null,
      summary,
      attachments: extractAttachments(entry.message.content),
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

function parseTranscriptEntries(raw) {
  const lines = String(raw || "").split("\n").filter(Boolean);
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

async function readTranscriptEntries(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return parseTranscriptEntries(raw);
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
      const transcriptOrigin = deriveTranscriptOrigin(entries);
      const updatedAtMs = Math.max(
        toTimestampMs(activeMeta?.updatedAt),
        toTimestampMs(lastEntry?.timestamp),
        fileStat.mtimeMs
      );

      const sessionRecord = {
        id: `${agentId}:${filename}`,
        agentId,
        filename,
        sourceKey: buildArchiveSourceKey(agentId, filename),
        sessionId,
        sessionKey: activeMeta?.sessionKey || transcriptOrigin?.sessionKey || null,
        variant,
        active: Boolean(activeMeta && variant === "active"),
        startedAt: sessionEntry?.timestamp || null,
        updatedAt: new Date(updatedAtMs).toISOString(),
        updatedAtMs,
        chatType: activeMeta?.chatType || activeMeta?.origin?.chatType || transcriptOrigin?.chatType || null,
        channel: activeMeta?.origin?.provider || activeMeta?.lastChannel || transcriptOrigin?.channel || null,
        telegramId:
          extractTelegramId(activeMeta?.origin?.to, activeMeta?.lastTo, activeMeta?.sessionKey, activeMeta?.origin?.from) ||
          transcriptOrigin?.telegramId,
        originLabel: activeMeta?.origin?.label || transcriptOrigin?.originLabel || null,
        deliveryTo: activeMeta?.origin?.to || activeMeta?.lastTo || transcriptOrigin?.deliveryTo || null,
        model: activeMeta?.model || null,
        messageCount: messageEntries.length,
        eventCount: entries.length,
        lastRole: lastMessage?.message?.role || null,
        lastSnippet: summarizeMessage(lastMessage || lastEntry).slice(0, 280),
        sizeBytes: fileStat.size
      };
      sessionRecord.threadKey = buildThreadKey(sessionRecord);
      sessions.push(sessionRecord);
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

export async function getArchiveStatus() {
  const index = await loadArchiveIndex();
  return summarizeArchiveStatus(index);
}

export async function runArchive(mode = "manual") {
  if (archiveRunPromise) {
    return archiveRunPromise;
  }

  archiveRunPromise = (async () => {
    const startedAt = new Date().toISOString();
    const sessions = await getSessions();
    const index = await loadArchiveIndex();
    const summary = {
      mode,
      startedAt,
      completedAt: null,
      filesSeen: sessions.length,
      snapshotsCreated: 0,
      sourcesSkipped: 0,
      blobsWritten: 0,
      sourceErrors: []
    };

    for (const session of sessions) {
      const sourceKey = buildArchiveSourceKey(session.agentId, session.filename);
      try {
        const sessionsDir = resolveSessionsDir(session.agentId);
        const fullPath = path.resolve(path.join(sessionsDir, session.filename));
        if (!fullPath.startsWith(`${sessionsDir}${path.sep}`)) {
          throw new Error("Invalid source path");
        }

        const [raw, fileStat] = await Promise.all([
          fs.readFile(fullPath, "utf8"),
          fs.stat(fullPath)
        ]);

        const hash = hashContent(raw);
        const fingerprint = `${hash}:${fileStat.size}:${Math.trunc(fileStat.mtimeMs)}`;
        const sourceEntry = index.sources[sourceKey] || {
          sourceKey,
          agentId: session.agentId,
          filename: session.filename,
          sourcePath: sourceKey,
          latestFingerprint: null,
          latestSnapshotId: null,
          lastSeenAt: null,
          snapshots: []
        };

        const existingSnapshot = findExistingSnapshot(sourceEntry, fingerprint);
        if (existingSnapshot) {
          sourceEntry.latestFingerprint = fingerprint;
          sourceEntry.latestSnapshotId = existingSnapshot.snapshotId;
          sourceEntry.lastSeenAt = new Date().toISOString();
          index.sources[sourceKey] = sourceEntry;
          summary.sourcesSkipped += 1;
          continue;
        }

        const blobAlreadyPresent = Boolean(index.blobs[hash]);
        const storedRelativePath = await ensureArchiveBlob(index, hash, raw, buildArchivedRelativePath(session, hash));
        if (!blobAlreadyPresent) {
          index.blobs[hash].refCount = 1;
          summary.blobsWritten += 1;
        } else {
          index.blobs[hash].refCount = Number(index.blobs[hash].refCount || 0) + 1;
        }

        const archivedAt = new Date().toISOString();
        const snapshotId = `${sanitizeArchiveSegment(session.sessionId || extractSessionId(session.filename), "session")}--${session.variant}--${hash.slice(0, 12)}--${Math.trunc(fileStat.mtimeMs)}`;
        const snapshot = {
          snapshotId,
          fingerprint,
          hash,
          archivedAt,
          storedRelativePath,
          sizeBytes: fileStat.size,
          sourceMtimeMs: fileStat.mtimeMs,
          agentId: session.agentId,
          filename: session.filename,
          sessionId: session.sessionId,
          sessionKey: session.sessionKey,
          variant: session.variant,
          channel: session.channel,
          chatType: session.chatType,
          telegramId: session.telegramId,
          originLabel: session.originLabel,
          startedAt: session.startedAt,
          updatedAt: session.updatedAt
        };

        sourceEntry.latestFingerprint = fingerprint;
        sourceEntry.latestSnapshotId = snapshotId;
        sourceEntry.lastSeenAt = archivedAt;
        sourceEntry.snapshots.push(snapshot);
        index.sources[sourceKey] = sourceEntry;
        summary.snapshotsCreated += 1;
      } catch (error) {
        summary.sourceErrors.push({
          agentId: session.agentId,
          filename: session.filename,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    summary.completedAt = new Date().toISOString();
    index.lastRun = summary;
    if (!summary.sourceErrors.length) {
      index.lastSuccessfulRunAt = summary.completedAt;
    }
    await saveArchiveIndex(index);
    return {
      ...summary,
      status: await getArchiveStatus()
    };
  })();

  try {
    return await archiveRunPromise;
  } finally {
    archiveRunPromise = null;
  }
}

export async function maybeRunScheduledArchive(trigger) {
  if (ARCHIVE_INTERVAL_MS <= 0) {
    return null;
  }

  const index = await loadArchiveIndex();
  const lastSuccessfulMs = index.lastSuccessfulRunAt ? Date.parse(index.lastSuccessfulRunAt) : 0;
  if (lastSuccessfulMs && Date.now() - lastSuccessfulMs < ARCHIVE_INTERVAL_MS) {
    return {
      skipped: true,
      reason: "not_due",
      status: summarizeArchiveStatus(index)
    };
  }

  return runArchive(`scheduled:${trigger}`);
}

function toTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function compareNewestFirst(a, b) {
  return (toTimestampMs(b.updatedAt) || toTimestampMs(b.archivedAt) || b.sourceMtimeMs || 0) -
    (toTimestampMs(a.updatedAt) || toTimestampMs(a.archivedAt) || a.sourceMtimeMs || 0);
}

function getArchiveSnapshots(index) {
  const snapshots = [];
  for (const [sourceKey, source] of Object.entries(index.sources || {})) {
    for (const snapshot of Array.isArray(source.snapshots) ? source.snapshots : []) {
      snapshots.push({
        ...snapshot,
        sourceKey
      });
    }
  }
  snapshots.sort(compareNewestFirst);
  return snapshots;
}

function buildThreadKey(record) {
  if (record.telegramId) {
    return `thread:telegram:${record.agentId}:${record.chatType || "unknown"}:${record.telegramId}`;
  }
  if (record.sessionKey) {
    return `thread:session-key:${record.agentId}:${record.sessionKey}`;
  }
  return `thread:session:${record.agentId}:${record.sessionId || record.filename || "unknown"}`;
}

function buildProfileKey(telegramId) {
  return `profile:telegram:${telegramId}`;
}

function getAnnotationValue(annotations, bucket, key) {
  return annotations?.[bucket]?.[key] || null;
}

function normalizeAnnotationInput(payload) {
  const bookmarked = payload?.bookmarked === true;
  const note = typeof payload?.note === "string" ? payload.note.trim().slice(0, 4000) : "";
  return {
    bookmarked,
    note
  };
}

async function updateAnnotation(bucket, key, payload) {
  if (!["sessions", "threads", "profiles"].includes(bucket)) {
    throw new Error("Invalid annotation bucket");
  }
  if (typeof key !== "string" || !key) {
    throw new Error("Invalid annotation key");
  }
  const annotations = await loadAnnotations();
  const nextValue = normalizeAnnotationInput(payload);
  if (!nextValue.bookmarked && !nextValue.note) {
    delete annotations[bucket][key];
  } else {
    annotations[bucket][key] = {
      ...nextValue,
      updatedAt: new Date().toISOString()
    };
  }
  await saveAnnotations(annotations);
  return annotations;
}

async function readArchiveBlobText(index, snapshot) {
  const blob = index.blobs?.[snapshot.hash];
  const relativePath = blob?.storedRelativePath || snapshot.storedRelativePath;
  if (!relativePath) {
    throw new Error("Archive blob path missing");
  }
  const target = path.resolve(path.join(ARCHIVE_DIR, relativePath));
  if (!target.startsWith(`${ARCHIVE_DIR}${path.sep}`)) {
    throw new Error("Invalid archive blob path");
  }
  const stored = await fs.readFile(target, "utf8");
  if (blob?.encrypted) {
    return decryptArchiveBlob(stored);
  }
  return stored;
}

function buildMessageLines(entries) {
  return entries.map((entry) => {
    const view = toMessageView(entry);
    const timestamp = view.timestamp || "-";
    return `${timestamp} | ${view.role || view.entryType}: ${view.summary || ""}`.trim();
  });
}

function buildSearchableText(snapshot, entries) {
  const metadata = [
    snapshot.agentId,
    snapshot.channel,
    snapshot.chatType,
    snapshot.telegramId,
    snapshot.originLabel,
    snapshot.sessionKey,
    snapshot.filename,
    snapshot.variant
  ].filter(Boolean).join(" ");
  return `${metadata}\n${buildMessageLines(entries).join("\n")}`;
}

function splitSearchTerms(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function buildSearchExcerpt(text, terms) {
  if (!text) {
    return "";
  }
  if (!terms.length) {
    return text.slice(0, 220);
  }
  const lower = text.toLowerCase();
  const positions = terms
    .map((term) => lower.indexOf(term))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b);
  const first = positions[0] ?? 0;
  const start = Math.max(0, first - 90);
  const end = Math.min(text.length, first + 190);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function matchesArchiveFilters(snapshot, filters) {
  if (filters.agentId && snapshot.agentId !== filters.agentId) {
    return false;
  }
  if (filters.telegramId && snapshot.telegramId !== filters.telegramId) {
    return false;
  }
  if (filters.chatType && snapshot.chatType !== filters.chatType) {
    return false;
  }
  if (filters.variant && snapshot.variant !== filters.variant) {
    return false;
  }
  const timestamp = toTimestampMs(snapshot.updatedAt || snapshot.archivedAt || snapshot.startedAt);
  if (filters.dateFrom && timestamp && timestamp < Date.parse(filters.dateFrom)) {
    return false;
  }
  if (filters.dateTo && timestamp && timestamp > Date.parse(filters.dateTo) + 86_399_999) {
    return false;
  }
  return true;
}

function buildThreadSummary(thread, annotations) {
  const annotation = getAnnotationValue(annotations, "threads", thread.key);
  return {
    ...thread,
    bookmarked: annotation?.bookmarked === true,
    note: annotation?.note || ""
  };
}

function buildProfileSummary(profile, annotations) {
  const annotation = getAnnotationValue(annotations, "profiles", profile.key);
  return {
    ...profile,
    bookmarked: annotation?.bookmarked === true,
    note: annotation?.note || ""
  };
}

function buildArchiveCatalog(index, liveSessions, annotations) {
  const snapshots = getArchiveSnapshots(index);
  const threadsMap = new Map();
  const profilesMap = new Map();
  const agentBreakdown = new Map();
  const variantBreakdown = new Map();
  const archiveByDay = new Map();

  const ensureThread = (record) => {
    const key = buildThreadKey(record);
    if (!threadsMap.has(key)) {
      threadsMap.set(key, {
        key,
        label: record.originLabel || record.sessionKey || record.telegramId || record.sessionId || record.filename,
        agentId: record.agentId,
        channel: record.channel || null,
        chatType: record.chatType || null,
        telegramId: record.telegramId || null,
        snapshotCount: 0,
        liveSessionCount: 0,
        messageCount: 0,
        eventCount: 0,
        firstSeenAt: record.startedAt || record.updatedAt || record.archivedAt || null,
        lastSeenAt: record.updatedAt || record.archivedAt || record.startedAt || null,
        latestSnapshotId: null,
        latestLiveSessionId: null,
        agents: new Set(),
        variants: new Set(),
        originLabels: new Set(),
        snapshots: [],
        liveSessions: []
      });
    }
    return threadsMap.get(key);
  };

  const ensureProfile = (record) => {
    if (!record.telegramId) {
      return null;
    }
    const key = buildProfileKey(record.telegramId);
    if (!profilesMap.has(key)) {
      profilesMap.set(key, {
        key,
        telegramId: record.telegramId,
        labels: new Set(),
        agents: new Set(),
        chatTypes: new Set(),
        threadKeys: new Set(),
        snapshotCount: 0,
        liveSessionCount: 0,
        messageCount: 0,
        firstSeenAt: record.startedAt || record.updatedAt || record.archivedAt || null,
        lastSeenAt: record.updatedAt || record.archivedAt || record.startedAt || null
      });
    }
    return profilesMap.get(key);
  };

  for (const snapshot of snapshots) {
    const thread = ensureThread(snapshot);
    thread.snapshotCount += 1;
    thread.messageCount += Number(snapshot.messageCount || 0);
    thread.eventCount += Number(snapshot.eventCount || 0);
    thread.latestSnapshotId ||= snapshot.snapshotId;
    thread.firstSeenAt = [thread.firstSeenAt, snapshot.startedAt, snapshot.updatedAt, snapshot.archivedAt].filter(Boolean).sort()[0] || thread.firstSeenAt;
    thread.lastSeenAt = [thread.lastSeenAt, snapshot.updatedAt, snapshot.archivedAt, snapshot.startedAt].filter(Boolean).sort().at(-1) || thread.lastSeenAt;
    thread.agents.add(snapshot.agentId);
    thread.variants.add(snapshot.variant || "unknown");
    if (snapshot.originLabel) {
      thread.originLabels.add(snapshot.originLabel);
    }
    thread.snapshots.push({
      snapshotId: snapshot.snapshotId,
      sourceKey: snapshot.sourceKey,
      sessionId: snapshot.sessionId,
      sessionKey: snapshot.sessionKey,
      filename: snapshot.filename,
      variant: snapshot.variant,
      updatedAt: snapshot.updatedAt,
      archivedAt: snapshot.archivedAt,
      startedAt: snapshot.startedAt,
      sizeBytes: snapshot.sizeBytes,
      agentId: snapshot.agentId
    });

    const profile = ensureProfile(snapshot);
    if (profile) {
      profile.snapshotCount += 1;
      profile.messageCount += Number(snapshot.messageCount || 0);
      profile.threadKeys.add(thread.key);
      profile.agents.add(snapshot.agentId);
      profile.chatTypes.add(snapshot.chatType || "unknown");
      if (snapshot.originLabel) {
        profile.labels.add(snapshot.originLabel);
      }
      profile.firstSeenAt = [profile.firstSeenAt, snapshot.startedAt, snapshot.updatedAt, snapshot.archivedAt].filter(Boolean).sort()[0] || profile.firstSeenAt;
      profile.lastSeenAt = [profile.lastSeenAt, snapshot.updatedAt, snapshot.archivedAt, snapshot.startedAt].filter(Boolean).sort().at(-1) || profile.lastSeenAt;
    }

    agentBreakdown.set(snapshot.agentId, (agentBreakdown.get(snapshot.agentId) || 0) + 1);
    variantBreakdown.set(snapshot.variant || "unknown", (variantBreakdown.get(snapshot.variant || "unknown") || 0) + 1);
    const archiveDay = String(snapshot.archivedAt || "").slice(0, 10);
    if (archiveDay) {
      archiveByDay.set(archiveDay, (archiveByDay.get(archiveDay) || 0) + 1);
    }
  }

  for (const liveSession of liveSessions) {
    const thread = ensureThread(liveSession);
    thread.liveSessionCount += 1;
    thread.latestLiveSessionId ||= liveSession.id;
    thread.messageCount += Number(liveSession.messageCount || 0);
    thread.eventCount += Number(liveSession.eventCount || 0);
    thread.agents.add(liveSession.agentId);
    thread.variants.add(liveSession.variant || "unknown");
    if (liveSession.originLabel) {
      thread.originLabels.add(liveSession.originLabel);
    }
    thread.liveSessions.push({
      id: liveSession.id,
      sessionId: liveSession.sessionId,
      filename: liveSession.filename,
      variant: liveSession.variant,
      updatedAt: liveSession.updatedAt,
      startedAt: liveSession.startedAt,
      active: liveSession.active
    });

    const profile = ensureProfile(liveSession);
    if (profile) {
      profile.liveSessionCount += 1;
      profile.threadKeys.add(thread.key);
      profile.agents.add(liveSession.agentId);
      profile.chatTypes.add(liveSession.chatType || "unknown");
      if (liveSession.originLabel) {
        profile.labels.add(liveSession.originLabel);
      }
      profile.firstSeenAt = [profile.firstSeenAt, liveSession.startedAt, liveSession.updatedAt].filter(Boolean).sort()[0] || profile.firstSeenAt;
      profile.lastSeenAt = [profile.lastSeenAt, liveSession.updatedAt, liveSession.startedAt].filter(Boolean).sort().at(-1) || profile.lastSeenAt;
    }
  }

  const threads = [...threadsMap.values()]
    .map((thread) => buildThreadSummary({
      ...thread,
      updatedAt: thread.lastSeenAt,
      agents: [...thread.agents].sort(),
      variants: [...thread.variants].sort(),
      originLabels: [...thread.originLabels].sort(),
      snapshots: thread.snapshots.sort(compareNewestFirst),
      liveSessions: thread.liveSessions.sort(compareNewestFirst)
    }, annotations))
    .sort(compareNewestFirst);

  const profiles = [...profilesMap.values()]
    .map((profile) => buildProfileSummary({
      ...profile,
      updatedAt: profile.lastSeenAt,
      labels: [...profile.labels].sort(),
      agents: [...profile.agents].sort(),
      chatTypes: [...profile.chatTypes].sort(),
      threadKeys: [...profile.threadKeys].sort()
    }, annotations))
    .sort(compareNewestFirst);

  const staleLiveSessions = liveSessions
    .filter((session) => Date.now() - toTimestampMs(session.updatedAt) > 12 * 60 * 60 * 1000)
    .sort(compareNewestFirst)
    .slice(0, 10)
    .map((session) => ({
      id: session.id,
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      updatedAt: session.updatedAt,
      variant: session.variant
    }));

  const dashboard = {
    liveCount: liveSessions.length,
    archiveSnapshotCount: snapshots.length,
    threadCount: threads.length,
    profileCount: profiles.length,
    bookmarkedCount: countBookmarkedAnnotations(annotations),
    agentBreakdown: [...agentBreakdown.entries()].map(([agentId, count]) => ({ agentId, count })).sort((a, b) => b.count - a.count),
    variantBreakdown: [...variantBreakdown.entries()].map(([variant, count]) => ({ variant, count })).sort((a, b) => b.count - a.count),
    topThreads: threads.slice(0, 8).map((thread) => ({
      key: thread.key,
      label: thread.label,
      agentId: thread.agentId,
      telegramId: thread.telegramId,
      snapshotCount: thread.snapshotCount,
      liveSessionCount: thread.liveSessionCount,
      lastSeenAt: thread.lastSeenAt
    })),
    archiveGrowth: [...archiveByDay.entries()].map(([day, count]) => ({ day, count })).sort((a, b) => a.day.localeCompare(b.day)),
    staleLiveSessions
  };

  return {
    snapshots,
    threads,
    profiles,
    dashboard
  };
}

export async function getOverview() {
  const [rawLiveSessions, index, annotations] = await Promise.all([
    getSessions(),
    loadArchiveIndex(),
    loadAnnotations()
  ]);
  const liveSessions = rawLiveSessions.map((session) => {
    const annotation = getAnnotationValue(annotations, "sessions", session.sourceKey);
    return {
      ...session,
      bookmarked: annotation?.bookmarked === true,
      note: annotation?.note || ""
    };
  });
  const catalog = buildArchiveCatalog(index, liveSessions, annotations);
  return {
    generatedAt: new Date().toISOString(),
    liveSessions,
    archiveStatus: summarizeArchiveStatus(index),
    threads: catalog.threads,
    profiles: catalog.profiles,
    dashboard: catalog.dashboard,
    annotations
  };
}

export async function getArchiveTranscript(snapshotId) {
  const index = await loadArchiveIndex();
  const snapshot = getArchiveSnapshots(index).find((item) => item.snapshotId === snapshotId);
  if (!snapshot) {
    throw new Error("Archive snapshot not found");
  }
  const raw = await readArchiveBlobText(index, snapshot);
  const entries = parseTranscriptEntries(raw);
  return {
    snapshot,
    transcript: entries.map(toMessageView)
  };
}

export async function searchArchive(query, filters = {}) {
  const index = await loadArchiveIndex();
  const annotations = await loadAnnotations();
  const terms = splitSearchTerms(query);
  const snapshots = getArchiveSnapshots(index).filter((snapshot) => matchesArchiveFilters(snapshot, filters));
  const results = [];

  for (const snapshot of snapshots) {
    const raw = await readArchiveBlobText(index, snapshot);
    const entries = parseTranscriptEntries(raw);
    const searchable = buildSearchableText(snapshot, entries);
    const lower = searchable.toLowerCase();
    if (terms.length && !terms.every((term) => lower.includes(term))) {
      continue;
    }
    const threadKey = buildThreadKey(snapshot);
    const threadAnnotation = getAnnotationValue(annotations, "threads", threadKey);
    results.push({
      snapshotId: snapshot.snapshotId,
      sourceKey: snapshot.sourceKey,
      threadKey,
      agentId: snapshot.agentId,
      telegramId: snapshot.telegramId || null,
      chatType: snapshot.chatType || null,
      variant: snapshot.variant || null,
      updatedAt: snapshot.updatedAt || snapshot.archivedAt || null,
      sessionKey: snapshot.sessionKey || null,
      originLabel: snapshot.originLabel || null,
      bookmarked: threadAnnotation?.bookmarked === true,
      note: threadAnnotation?.note || "",
      excerpt: buildSearchExcerpt(searchable, terms)
    });
  }

  results.sort(compareNewestFirst);
  return {
    query,
    terms,
    filters,
    count: results.length,
    results
  };
}

function diffLines(beforeLines, afterLines) {
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    commonPrefixCount: prefix,
    commonSuffixCount: suffix,
    removed: beforeLines.slice(prefix, beforeLines.length - suffix),
    added: afterLines.slice(prefix, afterLines.length - suffix),
    beforeCount: beforeLines.length,
    afterCount: afterLines.length
  };
}

export async function diffArchiveSnapshots(snapshotIdA, snapshotIdB) {
  const index = await loadArchiveIndex();
  const snapshots = getArchiveSnapshots(index);
  const before = snapshots.find((item) => item.snapshotId === snapshotIdA);
  const after = snapshots.find((item) => item.snapshotId === snapshotIdB);
  if (!before || !after) {
    throw new Error("Archive snapshot not found");
  }
  const [beforeRaw, afterRaw] = await Promise.all([
    readArchiveBlobText(index, before),
    readArchiveBlobText(index, after)
  ]);
  const beforeLines = buildMessageLines(parseTranscriptEntries(beforeRaw));
  const afterLines = buildMessageLines(parseTranscriptEntries(afterRaw));
  return {
    before,
    after,
    diff: diffLines(beforeLines, afterLines)
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderMessagesAsMarkdown(messages) {
  return messages
    .map((message) => `### ${message.role || message.entryType} · ${message.timestamp || "-"}\n\n${message.summary || ""}\n`)
    .join("\n");
}

function renderMessagesAsHtml(messages) {
  return messages
    .map((message) => `<section><h3>${escapeHtml(message.role || message.entryType)} · ${escapeHtml(message.timestamp || "-")}</h3><pre>${escapeHtml(message.summary || "")}</pre></section>`)
    .join("\n");
}

export async function buildExportPayload(kind, id, format) {
  if (!["json", "markdown", "html"].includes(format)) {
    throw new Error("Invalid export format");
  }
  const overview = await getOverview();
  if (kind === "thread") {
    const thread = overview.threads.find((item) => item.key === id);
    if (!thread) {
      throw new Error("Thread not found");
    }
    const snapshotTranscripts = [];
    for (const snapshot of thread.snapshots) {
      const transcript = await getArchiveTranscript(snapshot.snapshotId);
      snapshotTranscripts.push(transcript);
    }
    if (format === "json") {
      return {
        filename: `${sanitizeArchiveSegment(thread.label || thread.key, "thread")}.json`,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ thread, snapshots: snapshotTranscripts }, null, 2)
      };
    }
    if (format === "markdown") {
      const body = [
        `# ${thread.label || thread.key}`,
        `- Agent: ${thread.agentId}`,
        `- Telegram ID: ${thread.telegramId || "-"}`,
        `- Chat Type: ${thread.chatType || "-"}`,
        `- Snapshots: ${thread.snapshotCount}`,
        "",
        ...snapshotTranscripts.map((item) => `## ${item.snapshot.snapshotId}\n\n${renderMessagesAsMarkdown(item.transcript)}`)
      ].join("\n");
      return {
        filename: `${sanitizeArchiveSegment(thread.label || thread.key, "thread")}.md`,
        contentType: "text/markdown; charset=utf-8",
        body
      };
    }
    const body = [
      "<!doctype html><html><head><meta charset='utf-8'><title>Thread Export</title></head><body>",
      `<h1>${escapeHtml(thread.label || thread.key)}</h1>`,
      ...snapshotTranscripts.map((item) => `<h2>${escapeHtml(item.snapshot.snapshotId)}</h2>${renderMessagesAsHtml(item.transcript)}`),
      "</body></html>"
    ].join("");
    return {
      filename: `${sanitizeArchiveSegment(thread.label || thread.key, "thread")}.html`,
      contentType: "text/html; charset=utf-8",
      body
    };
  }

  if (kind === "profile") {
    const profile = overview.profiles.find((item) => item.key === id);
    if (!profile) {
      throw new Error("Profile not found");
    }
    const threads = overview.threads.filter((thread) => profile.threadKeys.includes(thread.key));
    if (format === "json") {
      return {
        filename: `${sanitizeArchiveSegment(profile.telegramId, "profile")}.json`,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ profile, threads }, null, 2)
      };
    }
    if (format === "markdown") {
      const body = [
        `# Telegram ${profile.telegramId}`,
        `- Labels: ${profile.labels.join(", ") || "-"}`,
        `- Agents: ${profile.agents.join(", ") || "-"}`,
        `- Threads: ${threads.length}`,
        "",
        "## Threads",
        ...threads.map((thread) => `- ${thread.label || thread.key} (${thread.snapshotCount} snapshots)`)
      ].join("\n");
      return {
        filename: `${sanitizeArchiveSegment(profile.telegramId, "profile")}.md`,
        contentType: "text/markdown; charset=utf-8",
        body
      };
    }
    const body = [
      "<!doctype html><html><head><meta charset='utf-8'><title>Profile Export</title></head><body>",
      `<h1>Telegram ${escapeHtml(profile.telegramId)}</h1>`,
      `<p>Labels: ${escapeHtml(profile.labels.join(", ") || "-")}</p>`,
      `<p>Agents: ${escapeHtml(profile.agents.join(", ") || "-")}</p>`,
      "<ul>",
      ...threads.map((thread) => `<li>${escapeHtml(thread.label || thread.key)} (${thread.snapshotCount} snapshots)</li>`),
      "</ul></body></html>"
    ].join("");
    return {
      filename: `${sanitizeArchiveSegment(profile.telegramId, "profile")}.html`,
      contentType: "text/html; charset=utf-8",
      body
    };
  }

  throw new Error("Unsupported export kind");
}

export async function pruneArchive(keepLatest = ARCHIVE_KEEP_LATEST || 3) {
  const parsedKeepLatest = Number(keepLatest);
  if (!Number.isInteger(parsedKeepLatest) || parsedKeepLatest < 1) {
    throw new Error("Invalid keepLatest");
  }
  const index = await loadArchiveIndex();
  const summary = {
    keepLatest: parsedKeepLatest,
    removedSnapshots: 0,
    removedBlobs: 0,
    affectedSources: 0
  };

  for (const source of Object.values(index.sources || {})) {
    if (!Array.isArray(source.snapshots) || source.snapshots.length <= parsedKeepLatest) {
      continue;
    }
    source.snapshots.sort(compareNewestFirst);
    const removed = source.snapshots.slice(parsedKeepLatest);
    source.snapshots = source.snapshots.slice(0, parsedKeepLatest);
    source.latestSnapshotId = source.snapshots[0]?.snapshotId || null;
    source.latestFingerprint = source.snapshots[0]?.fingerprint || null;
    summary.removedSnapshots += removed.length;
    summary.affectedSources += 1;
  }

  const referencedHashes = new Map();
  for (const source of Object.values(index.sources || {})) {
    for (const snapshot of Array.isArray(source.snapshots) ? source.snapshots : []) {
      referencedHashes.set(snapshot.hash, (referencedHashes.get(snapshot.hash) || 0) + 1);
    }
  }

  for (const [hash, blob] of Object.entries(index.blobs || {})) {
    if (referencedHashes.has(hash)) {
      blob.refCount = referencedHashes.get(hash);
      continue;
    }
    const target = path.resolve(path.join(ARCHIVE_DIR, blob.storedRelativePath));
    if (target.startsWith(`${ARCHIVE_DIR}${path.sep}`)) {
      await fs.unlink(target).catch(() => null);
    }
    delete index.blobs[hash];
    summary.removedBlobs += 1;
  }

  index.lastRun = {
    mode: "retention-prune",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    filesSeen: Object.keys(index.sources || {}).length,
    snapshotsCreated: 0,
    sourcesSkipped: 0,
    blobsWritten: 0,
    sourceErrors: []
  };
  await saveArchiveIndex(index);
  return {
    ...summary,
    status: summarizeArchiveStatus(index)
  };
}

async function serveMediaFile(res, candidatePath) {
  const target = resolveMediaPath(candidatePath);
  if (!target) {
    throw new Error("Invalid media path");
  }
  const ext = path.extname(target).toLowerCase();
  const contentType = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8"
  }[ext] || "application/octet-stream";
  const content = await fs.readFile(target);
  res.writeHead(200, buildHeaders(contentType));
  res.end(content);
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
  if (
    error.message === "Invalid path" ||
    error.message === "Invalid agentId" ||
    error.message === "Invalid annotation bucket" ||
    error.message === "Invalid annotation key" ||
    error.message === "Invalid JSON body" ||
    error.message === "Invalid export format" ||
    error.message === "Invalid keepLatest" ||
    error.message === "Invalid media path" ||
    error.message === "Missing archive action header" ||
    error.message === "Origin mismatch" ||
    error.message === "Archive writes require a loopback client" ||
    error.message === "Viewer token required for remote access" ||
    error.message === "Invalid viewer token" ||
    error.message === "Archive snapshot not found" ||
    error.message === "Thread not found" ||
    error.message === "Profile not found" ||
    error.message === "Unsupported export kind" ||
    error.message === "Request body too large"
  ) {
    return error.message;
  }
  if ("code" in error && error.code === "ENOENT") {
    return "Requested file was not found";
  }
  return "Internal server error";
}

function statusCodeForError(error) {
  if (!(error instanceof Error)) {
    return 500;
  }
  if (
    error.message === "Invalid path" ||
    error.message === "Invalid agentId" ||
    error.message === "Invalid annotation bucket" ||
    error.message === "Invalid annotation key" ||
    error.message === "Invalid JSON body" ||
    error.message === "Invalid export format" ||
    error.message === "Invalid keepLatest" ||
    error.message === "Invalid media path"
  ) {
    return 400;
  }
  if (
    error.message === "Missing archive action header" ||
    error.message === "Origin mismatch" ||
    error.message === "Archive writes require a loopback client"
  ) {
    return 403;
  }
  if (error.message === "Viewer token required for remote access" || error.message === "Invalid viewer token") {
    return 401;
  }
  if (error.message === "Archive snapshot not found" || error.message === "Thread not found" || error.message === "Profile not found") {
    return 404;
  }
  if (error.message === "Request body too large") {
    return 413;
  }
  if ("code" in error && error.code === "ENOENT") {
    return 404;
  }
  return 500;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    if (!req.url) {
      sendText(res, 400, "Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${BASE_PORT}`}`);

    try {
      if (url.pathname.startsWith("/api/")) {
        requireViewerAccess(req, url);
      }

      if (req.method === "POST" && url.pathname === "/api/archive/run") {
        ensureStateChangingRequest(req, url);
        const result = await runArchive("manual");
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/archive/prune") {
        ensureStateChangingRequest(req, url);
        const payload = await parseJsonRequestBody(req);
        const result = await pruneArchive(payload.keepLatest);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/annotations") {
        ensureStateChangingRequest(req, url);
        const payload = await parseJsonRequestBody(req);
        const annotations = await updateAnnotation(payload.bucket, payload.key, payload);
        sendJson(res, 200, {
          ok: true,
          annotations
        });
        return;
      }

      if (req.method !== "GET") {
        res.writeHead(405, {
          ...buildHeaders("text/plain; charset=utf-8"),
          Allow: "GET, POST"
        });
        res.end("Method not allowed");
        return;
      }

      if (url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/overview") {
        const overview = await getOverview();
        sendJson(res, 200, overview);
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

      if (url.pathname === "/api/archive/status") {
        const status = await getArchiveStatus();
        sendJson(res, 200, status);
        return;
      }

      if (url.pathname === "/api/archive/search") {
        const payload = await searchArchive(url.searchParams.get("q") || "", {
          agentId: url.searchParams.get("agentId") || "",
          telegramId: url.searchParams.get("telegramId") || "",
          chatType: url.searchParams.get("chatType") || "",
          variant: url.searchParams.get("variant") || "",
          dateFrom: url.searchParams.get("dateFrom") || "",
          dateTo: url.searchParams.get("dateTo") || ""
        });
        sendJson(res, 200, payload);
        return;
      }

      if (url.pathname === "/api/archive/transcript") {
        const snapshotId = url.searchParams.get("snapshotId");
        if (!snapshotId) {
          sendJson(res, 400, { error: "snapshotId is required" });
          return;
        }
        const payload = await getArchiveTranscript(snapshotId);
        sendJson(res, 200, payload);
        return;
      }

      if (url.pathname === "/api/archive/diff") {
        const snapshotA = url.searchParams.get("snapshotA");
        const snapshotB = url.searchParams.get("snapshotB");
        if (!snapshotA || !snapshotB) {
          sendJson(res, 400, { error: "snapshotA and snapshotB are required" });
          return;
        }
        const payload = await diffArchiveSnapshots(snapshotA, snapshotB);
        sendJson(res, 200, payload);
        return;
      }

      if (url.pathname === "/api/archive/export") {
        const kind = url.searchParams.get("kind") || "";
        const id = url.searchParams.get("id") || "";
        const format = url.searchParams.get("format") || "json";
        const payload = await buildExportPayload(kind, id, format);
        res.writeHead(200, {
          ...buildHeaders(payload.contentType),
          "Content-Disposition": `attachment; filename="${payload.filename}"`
        });
        res.end(payload.body);
        return;
      }

      if (url.pathname === "/api/annotations") {
        const annotations = await loadAnnotations();
        sendJson(res, 200, annotations);
        return;
      }

      if (url.pathname === "/api/dashboard") {
        const overview = await getOverview();
        sendJson(res, 200, overview.dashboard);
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

      if (url.pathname === "/api/media") {
        const mediaPath = url.searchParams.get("path");
        if (!mediaPath) {
          sendJson(res, 400, { error: "path is required" });
          return;
        }
        await serveMediaFile(res, mediaPath);
        return;
      }

      await serveStatic(req, res, url.pathname);
    } catch (error) {
      const statusCode = statusCodeForError(error);
      if (statusCode === 401) {
        res.writeHead(401, {
          ...buildHeaders("application/json; charset=utf-8"),
          "WWW-Authenticate": "Bearer"
        });
        res.end(JSON.stringify({ error: formatClientError(error) }));
        return;
      }
      sendJson(res, statusCode, { error: formatClientError(error) });
    }
  });
}

export const __test = {
  buildProfileKey,
  buildThreadKey,
  countBookmarkedAnnotations,
  deriveTranscriptOrigin,
  ensureStateChangingRequest,
  extractAttachmentsFromText,
  normalizeAnnotationInput,
  parseTranscriptEntries,
  requireViewerAccess,
  summarizeArchiveStatus,
  updateAnnotation
};

function startArchiveScheduler() {
  if (ARCHIVE_INTERVAL_MS <= 0 || archiveIntervalHandle) {
    return;
  }

  void maybeRunScheduledArchive("startup").catch((error) => {
    console.error(`Archive startup run failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  archiveIntervalHandle = setInterval(() => {
    void maybeRunScheduledArchive("interval").catch((error) => {
      console.error(`Archive scheduled run failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, ARCHIVE_INTERVAL_MS);

  if (typeof archiveIntervalHandle.unref === "function") {
    archiveIntervalHandle.unref();
  }
}

function canListen(host, port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        resolve({ ok: false, reason: "in_use" });
        return;
      }
      resolve({
        ok: false,
        reason: "error",
        error
      });
    });
    tester.once("listening", () => {
      tester.close(() => resolve({ ok: true }));
    });
    tester.listen(port, host);
  });
}

async function findAvailablePort(host, basePort) {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
    const port = basePort + offset;
    const result = await canListen(host, port);
    if (result.ok) {
      return port;
    }
    if (result.reason === "error") {
      const bindError = result.error;
      const code = bindError && typeof bindError === "object" && "code" in bindError ? bindError.code : "UNKNOWN";
      throw new Error(`Unable to probe ${host}:${port} (${code})`);
    }
  }
  throw new Error(`No free port found from ${basePort} to ${basePort + MAX_PORT_ATTEMPTS - 1}`);
}

if (process.env.OPENCLAW_MONITOR_NO_LISTEN !== "1" && process.argv[1] === __filename) {
  try {
    const bindHost = resolveBindHost(HOST);
    if (!LOOPBACK_HOSTS.has(bindHost) && !VIEWER_AUTH_TOKEN) {
      throw new Error("Remote bind requires OPENCLAW_VIEWER_TOKEN");
    }
    startArchiveScheduler();
    const port = await findAvailablePort(bindHost, BASE_PORT);
    const server = createServer();
    server.listen(port, bindHost, () => {
      console.log(`OpenClaw Chat Viewer listening on http://${bindHost}:${port}`);
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("(EPERM)")) {
      console.error("OpenClaw Chat Viewer could not open a local listening socket.");
      console.error("This environment denied bind/listen permissions for 127.0.0.1.");
      console.error("Run it in a normal local shell, or use an environment that allows local TCP listeners.");
      process.exit(1);
    }
    console.error(message);
    if (code) {
      process.exitCode = 1;
    } else {
      process.exit(1);
    }
  }
}
