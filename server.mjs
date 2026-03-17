import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  initConfig, getHost, getBasePort, MAX_PORT_ATTEMPTS, LOOPBACK_HOSTS, getPublicDir,
  getArchiveIntervalMs, getViewerAuthToken,
  buildHeaders, sendJson, sendText, isLoopbackAddress,
  formatClientError, statusCodeForError, resolveBindHost
} from "./lib/config.mjs";

// Re-initialize config from current process.env on each fresh import.
// This is needed because tests cache-bust server.mjs but lib/ modules are cached.
initConfig();

import {
  resolveMediaPath, parseTranscriptEntries, toMessageView,
  sanitizeArchiveSegment, parseVariant, isTranscriptFile,
  extractSessionId, extractTelegramId, extractTelegramIdFromLabel,
  summarizeContentNode, flattenMessageText, summarizeMessage,
  extractJsonBlock, deriveTranscriptOrigin, extractAttachmentsFromText,
  extractAttachments, readTranscriptEntries, resolveSessionsDir,
  splitSearchTerms, buildSearchExcerpt, matchesArchiveFilters,
  buildThreadKey, buildProfileKey, getAnnotationValue, normalizeAnnotationInput,
  buildMessageLines, buildSearchableText, diffLines, escapeHtml,
  renderMessagesAsMarkdown, renderMessagesAsHtml, normalizePathSlashes,
  ATTACHED_MEDIA_PATTERN, INLINE_MEDIA_PATTERN
} from "./lib/helpers.mjs";

import {
  loadAnnotations, updateAnnotation, summarizeArchiveStatus,
  countBookmarkedAnnotations
} from "./lib/archive.mjs";

import {
  getSessions, getTranscript, getArchiveStatus,
  runArchive, maybeRunScheduledArchive, getOverview,
  getArchiveTranscript, searchArchive, diffArchiveSnapshots,
  buildExportPayload, pruneArchive,
  getRemoteSessions, getAllSessions, getOverviewForMachine, getOverviewAll
} from "./lib/catalog.mjs";

import {
  loadMachines, saveMachines, addOrUpdateMachine, removeMachine,
  testMachineConnection, syncMachine, getMachineCachedAgentsDir,
  uploadSessionData, slugifyMachineName
} from "./lib/machines.mjs";

const __filename = fileURLToPath(import.meta.url);

let archiveIntervalHandle = null;

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
  const viewerToken = getViewerAuthToken();
  if (!viewerToken) {
    throw new Error("Viewer token required for remote access");
  }
  const supplied = getRequestToken(req, url);
  const expected = Buffer.from(viewerToken, "utf8");
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
  const publicDir = getPublicDir();
  const resolved = path.resolve(path.join(publicDir, `.${localPath}`));
  if (!resolved.startsWith(`${publicDir}${path.sep}`) && resolved !== publicDir) {
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

export { getSessions, getTranscript, getArchiveStatus, runArchive, maybeRunScheduledArchive, getOverview, getArchiveTranscript, searchArchive, diffArchiveSnapshots, buildExportPayload, pruneArchive, getRemoteSessions, getAllSessions, getOverviewForMachine, getOverviewAll };

export function createServer() {
  return http.createServer(async (req, res) => {
    if (!req.url) {
      sendText(res, 400, "Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${getHost()}:${getBasePort()}`}`);

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
        const keepLatest = Number(payload.keepLatest);
        if (!Number.isFinite(keepLatest) || keepLatest < 1 || !Number.isInteger(keepLatest)) {
          throw new Error("Invalid keepLatest");
        }
        const result = await pruneArchive(keepLatest);
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

      if (req.method === "GET" && url.pathname === "/api/machines") {
        const machines = await loadMachines();
        sendJson(res, 200, machines);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/machines") {
        ensureStateChangingRequest(req, url);
        const body = await parseJsonRequestBody(req);
        const machine = await addOrUpdateMachine(body);
        sendJson(res, 200, { ok: true, machine });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/machines/delete") {
        ensureStateChangingRequest(req, url);
        const body = await parseJsonRequestBody(req);
        const result = await removeMachine(body.id);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/machines/test") {
        ensureStateChangingRequest(req, url);
        const body = await parseJsonRequestBody(req);
        const result = await testMachineConnection(body);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/machines/sync") {
        ensureStateChangingRequest(req, url);
        const body = await parseJsonRequestBody(req);
        const result = await syncMachine(body);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/machines/upload") {
        ensureStateChangingRequest(req, url);
        const body = await parseJsonRequestBody(req, 4 * 1024 * 1024);
        const result = await uploadSessionData(body.machineId, body.agentId, body.filename, body.content);
        sendJson(res, 200, result);
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
        const machineId = url.searchParams.get("machineId") || "";
        let overview;
        if (machineId === "all") {
          overview = await getOverviewAll();
        } else if (machineId && machineId !== "local") {
          overview = await getOverviewForMachine(machineId);
        } else {
          overview = await getOverview();
        }
        sendJson(res, 200, overview);
        return;
      }

      if (url.pathname === "/api/sessions") {
        const machineId = url.searchParams.get("machineId") || "";
        let sessions;
        if (machineId === "all") {
          sessions = await getAllSessions();
        } else if (machineId && machineId !== "local") {
          sessions = await getRemoteSessions(machineId);
        } else {
          sessions = await getSessions();
        }
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
          dateTo: url.searchParams.get("dateTo") || "",
          limit: url.searchParams.get("limit") || "",
          offset: url.searchParams.get("offset") || ""
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
        if (!kind || !id) {
          sendJson(res, 400, { error: "kind and id are required" });
          return;
        }
        const payload = await buildExportPayload(kind, id, format);
        res.writeHead(200, {
          ...buildHeaders(payload.contentType),
          "Content-Disposition": `attachment; filename="${String(payload.filename).replace(/["\\]/g, "_")}"`
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
        const machineId = url.searchParams.get("machineId") || "";
        if (!agentId || !filename) {
          sendJson(res, 400, { error: "agentId and filename are required" });
          return;
        }
        const remoteAgentsDir = machineId && machineId !== "local"
          ? getMachineCachedAgentsDir(machineId)
          : null;
        const transcript = await getTranscript(agentId, filename, remoteAgentsDir);
        sendJson(res, 200, {
          generatedAt: new Date().toISOString(),
          agentId,
          filename,
          machineId: machineId || "local",
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
  diffLines,
  ensureStateChangingRequest,
  extractAttachmentsFromText,
  extractSessionId,
  extractTelegramId,
  formatClientError,
  isTranscriptFile,
  normalizeAnnotationInput,
  parseTranscriptEntries,
  parseVariant,
  requireViewerAccess,
  resolveMediaPath,
  resolveSessionsDir,
  sanitizeArchiveSegment,
  splitSearchTerms,
  statusCodeForError,
  summarizeArchiveStatus,
  toMessageView,
  updateAnnotation,
  loadMachines,
  addOrUpdateMachine,
  removeMachine,
  testMachineConnection,
  syncMachine,
  uploadSessionData,
  slugifyMachineName,
  getMachineCachedAgentsDir
};

function startArchiveScheduler() {
  if (getArchiveIntervalMs() <= 0 || archiveIntervalHandle) {
    return;
  }

  void maybeRunScheduledArchive("startup").catch((error) => {
    console.error(`Archive startup run failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  archiveIntervalHandle = setInterval(() => {
    void maybeRunScheduledArchive("interval").catch((error) => {
      console.error(`Archive scheduled run failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, getArchiveIntervalMs());

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
    const bindHost = resolveBindHost(getHost());
    if (!LOOPBACK_HOSTS.has(bindHost) && !getViewerAuthToken()) {
      throw new Error("Remote bind requires OPENCLAW_VIEWER_TOKEN");
    }
    startArchiveScheduler();
    const port = await findAvailablePort(bindHost, getBasePort());
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
