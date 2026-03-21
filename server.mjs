import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

import {
  initConfig, getHost, getBasePort, MAX_PORT_ATTEMPTS, LOOPBACK_HOSTS, getPublicDir,
  getArchiveIntervalMs, getSyncIntervalMs,
  buildHeaders, sendJson, sendText,
  formatClientError, statusCodeForError, resolveBindHost
} from "./lib/config.mjs";

import {
  ensureAdminUser, authenticateUser, createSession, getSession, destroySession,
  getSessionCookie, setSessionCookie, clearSessionCookie,
  loadUsers, addUser, updateUser, removeUser
} from "./lib/auth.mjs";

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
  buildExportPayload, buildBatchExportPayload, pruneArchive,
  getRemoteSessions, getAllSessions, getOverviewForMachine, getOverviewAll
} from "./lib/catalog.mjs";

import {
  loadMachines, saveMachines, addOrUpdateMachine, removeMachine,
  testMachineConnection, syncMachine, syncAllMachines, getMachineCachedAgentsDir,
  uploadSessionData, slugifyMachineName, startSyncScheduler
} from "./lib/machines.mjs";

const __filename = fileURLToPath(import.meta.url);

let archiveIntervalHandle = null;

async function resolveMachineById(machineId) {
  if (!machineId) throw new Error("Invalid machineId");
  const machines = await loadMachines();
  const machine = machines.find((m) => m.id === machineId);
  if (!machine || machine.id === "local") throw new Error("Machine not found");
  return machine;
}

async function validateMachineId(machineId) {
  if (!machineId || machineId === "local" || machineId === "all") return;
  const machines = await loadMachines();
  if (!machines.some((m) => m.id === machineId)) {
    throw new Error("Machine not found");
  }
}

function ensureStateChangingRequest(req, url) {
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

function requireAdmin(session) {
  if (!session || session.role !== "admin") {
    throw new Error("Forbidden");
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
  const localPath = pathname === "/" ? "/index.html" : (pathname === "/login" ? "/login.html" : pathname);
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

export { getSessions, getTranscript, getArchiveStatus, runArchive, maybeRunScheduledArchive, getOverview, getArchiveTranscript, searchArchive, diffArchiveSnapshots, buildExportPayload, buildBatchExportPayload, pruneArchive, getRemoteSessions, getAllSessions, getOverviewForMachine, getOverviewAll };

export function createServer() {
  return http.createServer(async (req, res) => {
    if (!req.url) {
      sendText(res, 400, "Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${getHost()}:${getBasePort()}`}`);

    try {
      // --- Auth routes (no session required) ---
      const isLoginAsset = url.pathname === "/login" || url.pathname === "/login.html" || url.pathname === "/login.css" || url.pathname === "/login.js";
      const isAuthApi = url.pathname === "/api/auth/login" || url.pathname === "/api/auth/logout";
      const isHealthApi = url.pathname === "/api/health";

      if (!isLoginAsset && !isAuthApi && !isHealthApi) {
        const token = getSessionCookie(req);
        const session = getSession(token);
        if (!session) {
          if (url.pathname.startsWith("/api/")) {
            throw new Error("Unauthorized");
          }
          res.writeHead(302, { Location: "/login" });
          res.end();
          return;
        }
        req._session = session;
      }

      // --- Auth API routes ---
      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await parseJsonRequestBody(req);
        const user = await authenticateUser(body.username, body.password);
        if (!user) {
          sendJson(res, 401, { ok: false, error: "Invalid credentials" });
          return;
        }
        const token = createSession(user.username, user.role);
        setSessionCookie(res, token);
        sendJson(res, 200, { ok: true, user: { username: user.username, role: user.role } });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        const token = getSessionCookie(req);
        if (token) {
          destroySession(token);
        }
        clearSessionCookie(res);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/auth/me") {
        const session = req._session;
        if (!session) {
          throw new Error("Unauthorized");
        }
        sendJson(res, 200, { ok: true, user: { username: session.username, role: session.role } });
        return;
      }

      // --- User management routes (admin only) ---
      if (req.method === "GET" && url.pathname === "/api/users") {
        requireAdmin(req._session);
        const users = await loadUsers();
        sendJson(res, 200, users.map((u) => ({
          username: u.username, role: u.role, enabled: u.enabled, createdAt: u.createdAt
        })));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/users") {
        requireAdmin(req._session);
        ensureStateChangingRequest(req, url);
        const body = await parseJsonRequestBody(req);
        const user = await addUser(body.username, body.password, body.role);
        sendJson(res, 200, { ok: true, user: { username: user.username, role: user.role, enabled: user.enabled } });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/users/update") {
        requireAdmin(req._session);
        ensureStateChangingRequest(req, url);
        const body = await parseJsonRequestBody(req);
        const user = await updateUser(body.username, body);
        sendJson(res, 200, { ok: true, user: { username: user.username, role: user.role, enabled: user.enabled } });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/users/delete") {
        requireAdmin(req._session);
        ensureStateChangingRequest(req, url);
        const body = await parseJsonRequestBody(req);
        await removeUser(body.username);
        sendJson(res, 200, { ok: true });
        return;
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
        const machine = body.host ? body : await resolveMachineById(body.id);
        const result = await testMachineConnection(machine);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/machines/sync") {
        ensureStateChangingRequest(req, url);
        const body = await parseJsonRequestBody(req);
        const machine = body.host ? body : await resolveMachineById(body.id);
        const result = await syncMachine(machine);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/machines/sync-all") {
        ensureStateChangingRequest(req, url);
        const results = await syncAllMachines();
        sendJson(res, 200, { ok: true, results });
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
        await validateMachineId(machineId);
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
        await validateMachineId(machineId);
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
          machineId: url.searchParams.get("machineId") || "",
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

      if (url.pathname === "/api/archive/export-all") {
        const machineId = url.searchParams.get("machineId") || "";
        const format = url.searchParams.get("format") || "json";
        const payload = await buildBatchExportPayload(machineId, format);
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
        await validateMachineId(machineId);
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
  requireAdmin,
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
  removeMachine: removeMachine,
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
    await ensureAdminUser();
    const bindHost = resolveBindHost(getHost());
    startArchiveScheduler();
    const syncMs = getSyncIntervalMs();
    if (syncMs > 0) startSyncScheduler(syncMs);
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
