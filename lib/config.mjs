import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Mutable config store ---
// server.mjs calls initConfig() on each fresh import (cache-busted by tests)
// so that env-dependent values are captured at the right time.
const _cfg = {
  initialized: false,
  OPENCLAW_HOME: "",
  ROOT_DIR: "",
  AGENTS_DIR: "",
  PUBLIC_DIR: path.join(__dirname, "..", "public"),
  ARCHIVE_DIR: "",
  ARCHIVE_INDEX_PATH: "",
  ANNOTATIONS_PATH: "",
  HOST: "127.0.0.1",
  BASE_PORT: 48312,
  ARCHIVE_INTERVAL_MINUTES: 0,
  ARCHIVE_INTERVAL_MS: 0,
  ARCHIVE_KEEP_LATEST: 0,
  ARCHIVE_MODE: "standard",
  ARCHIVE_SECRET: "",
  VIEWER_AUTH_TOKEN: ""
};

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

export function initConfig() {
  _cfg.OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(process.env.HOME || "", ".openclaw");
  _cfg.ROOT_DIR = path.resolve(_cfg.OPENCLAW_HOME);
  _cfg.AGENTS_DIR = path.join(_cfg.ROOT_DIR, "agents");
  _cfg.ARCHIVE_DIR = path.join(_cfg.ROOT_DIR, "viewer-archive");
  _cfg.ARCHIVE_INDEX_PATH = path.join(_cfg.ARCHIVE_DIR, "index.json");
  _cfg.ANNOTATIONS_PATH = path.join(_cfg.ARCHIVE_DIR, "annotations.json");
  _cfg.HOST = process.env.HOST || "127.0.0.1";
  _cfg.BASE_PORT = resolveBasePort(process.env.PORT);
  _cfg.ARCHIVE_INTERVAL_MINUTES = resolveArchiveInterval(process.env.OPENCLAW_ARCHIVE_INTERVAL_MINUTES);
  _cfg.ARCHIVE_INTERVAL_MS = _cfg.ARCHIVE_INTERVAL_MINUTES > 0 ? _cfg.ARCHIVE_INTERVAL_MINUTES * 60_000 : 0;
  _cfg.ARCHIVE_KEEP_LATEST = resolveKeepLatest(process.env.OPENCLAW_ARCHIVE_KEEP_LATEST);
  _cfg.ARCHIVE_MODE = resolveArchiveMode(process.env.OPENCLAW_ARCHIVE_MODE);
  _cfg.ARCHIVE_SECRET = process.env.OPENCLAW_ARCHIVE_SECRET || "";
  _cfg.VIEWER_AUTH_TOKEN = process.env.OPENCLAW_VIEWER_TOKEN || process.env.VIEWER_AUTH_TOKEN || "";
  _cfg.initialized = true;
}

// Initialize on first load with current env
initConfig();

// Accessor functions that read from the mutable config store
export function getOpenclawHome() { return _cfg.OPENCLAW_HOME; }
export function getRootDir() { return _cfg.ROOT_DIR; }
export function getAgentsDir() { return _cfg.AGENTS_DIR; }
export function getPublicDir() { return _cfg.PUBLIC_DIR; }
export function getArchiveDir() { return _cfg.ARCHIVE_DIR; }
export function getArchiveIndexPath() { return _cfg.ARCHIVE_INDEX_PATH; }
export function getAnnotationsPath() { return _cfg.ANNOTATIONS_PATH; }
export function getHost() { return _cfg.HOST; }
export function getBasePort() { return _cfg.BASE_PORT; }
export function getArchiveIntervalMinutes() { return _cfg.ARCHIVE_INTERVAL_MINUTES; }
export function getArchiveIntervalMs() { return _cfg.ARCHIVE_INTERVAL_MS; }
export function getArchiveKeepLatest() { return _cfg.ARCHIVE_KEEP_LATEST; }
export function getArchiveMode() { return _cfg.ARCHIVE_MODE; }
export function getArchiveSecret() { return _cfg.ARCHIVE_SECRET; }
export function getViewerAuthToken() { return _cfg.VIEWER_AUTH_TOKEN; }

export const MAX_PORT_ATTEMPTS = 25;
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function resolveBindHost(configuredHost) {
  if (LOOPBACK_HOSTS.has(configuredHost)) {
    return configuredHost;
  }
  if (process.env.ALLOW_REMOTE_BIND === "1") {
    return configuredHost;
  }
  throw new Error(`Refusing to bind to non-loopback host "${configuredHost}" without ALLOW_REMOTE_BIND=1`);
}

export function buildHeaders(contentType) {
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

export function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, buildHeaders("application/json; charset=utf-8"));
  res.end(JSON.stringify(payload));
}

export function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, buildHeaders(contentType));
  res.end(text);
}

export function hashContent(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export async function readJson(filePath, fallback) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Warning: corrupt JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

export const KNOWN_ERRORS = new Map([
  ["Invalid path", 400],
  ["Invalid agentId", 400],
  ["Invalid annotation bucket", 400],
  ["Invalid annotation key", 400],
  ["Invalid JSON body", 400],
  ["Invalid export format", 400],
  ["Invalid keepLatest", 400],
  ["Invalid media path", 400],
  ["Missing archive action header", 403],
  ["Origin mismatch", 403],
  ["Archive writes require a loopback client", 403],
  ["Viewer token required for remote access", 401],
  ["Invalid viewer token", 401],
  ["Archive snapshot not found", 404],
  ["Thread not found", 404],
  ["Profile not found", 404],
  ["Unsupported export kind", 400],
  ["Request body too large", 413],
]);

export function formatClientError(error) {
  if (!(error instanceof Error)) {
    return "Unknown error";
  }
  if (KNOWN_ERRORS.has(error.message)) {
    return error.message;
  }
  if ("code" in error && error.code === "ENOENT") {
    return "Requested file was not found";
  }
  return "Internal server error";
}

export function statusCodeForError(error) {
  if (!(error instanceof Error)) {
    return 500;
  }
  const knownCode = KNOWN_ERRORS.get(error.message);
  if (knownCode !== undefined) {
    return knownCode;
  }
  if ("code" in error && error.code === "ENOENT") {
    return 404;
  }
  return 500;
}

export function minTimestamp(...values) {
  let result = null;
  for (const v of values) {
    if (!v) continue;
    if (!result || v < result) result = v;
  }
  return result;
}

export function maxTimestamp(...values) {
  let result = null;
  for (const v of values) {
    if (!v) continue;
    if (!result || v > result) result = v;
  }
  return result;
}

export function toTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function compareNewestFirst(a, b) {
  return (toTimestampMs(b.updatedAt) || toTimestampMs(b.archivedAt) || b.sourceMtimeMs || 0) -
    (toTimestampMs(a.updatedAt) || toTimestampMs(a.archivedAt) || a.sourceMtimeMs || 0);
}
