import path from "node:path";
import { promises as fs } from "node:fs";
import {
  getArchiveDir, getArchiveIndexPath, getAnnotationsPath,
  getArchiveIntervalMinutes, getArchiveMode,
  readJson, hashContent, compareNewestFirst, toTimestampMs
} from "./config.mjs";
import { encryptArchiveBlob, decryptArchiveBlob } from "./crypto.mjs";
import {
  sanitizeArchiveSegment, normalizePathSlashes, extractSessionId,
  normalizeAnnotationInput
} from "./helpers.mjs";

export function createArchiveIndex() {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    lastRun: null,
    lastSuccessfulRunAt: null,
    settings: {
      archiveDir: getArchiveDir(),
      intervalMinutes: getArchiveIntervalMinutes()
    },
    blobs: {},
    sources: {}
  };
}

export async function loadArchiveIndex() {
  const index = await readJson(getArchiveIndexPath(), null);
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

export async function saveArchiveIndex(index) {
  const archiveDir = getArchiveDir();
  const indexPath = getArchiveIndexPath();
  const payload = {
    ...index,
    updatedAt: new Date().toISOString(),
    settings: {
      archiveDir,
      intervalMinutes: getArchiveIntervalMinutes()
    }
  };
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.copyFile(indexPath, `${indexPath}.bak`).catch(() => {});
  const tempPath = `${indexPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2));
  await fs.rename(tempPath, indexPath);
}

export function createAnnotationsStore() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    sessions: {},
    threads: {},
    profiles: {}
  };
}

export async function loadAnnotations() {
  const annotations = await readJson(getAnnotationsPath(), null);
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

export async function saveAnnotations(annotations) {
  const archiveDir = getArchiveDir();
  const annotationsPath = getAnnotationsPath();
  const payload = {
    ...annotations,
    updatedAt: new Date().toISOString()
  };
  await fs.mkdir(archiveDir, { recursive: true });
  const tempPath = `${annotationsPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2));
  await fs.rename(tempPath, annotationsPath);
}

export async function updateAnnotation(bucket, key, payload) {
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

export function buildArchiveSourceKey(agentId, filename, machineId) {
  const base = normalizePathSlashes(path.join("agents", agentId, "sessions", filename));
  if (machineId && machineId !== "local") {
    return `${machineId}/${base}`;
  }
  return base;
}

export function buildArchivedRelativePath(session, hash) {
  const channel = sanitizeArchiveSegment(session.channel || "unknown-channel", "unknown-channel");
  const chatType = sanitizeArchiveSegment(session.chatType || "unknown-chat", "unknown-chat");
  const telegramId = sanitizeArchiveSegment(session.telegramId || "unknown-telegram", "unknown-telegram");
  const agentId = sanitizeArchiveSegment(session.agentId, "unknown-agent");
  const sessionId = sanitizeArchiveSegment(session.sessionId || extractSessionId(session.filename), "unknown-session");
  const variant = sanitizeArchiveSegment(session.variant || "unknown", "unknown");
  const extension = getArchiveMode() === "sensitive" ? ".jsonl.enc" : ".jsonl";
  return path.join("transcripts", channel, chatType, telegramId, agentId, `${sessionId}--${variant}--${hash.slice(0, 12)}${extension}`);
}

export function findExistingSnapshot(sourceEntry, fingerprint) {
  if (!sourceEntry || !Array.isArray(sourceEntry.snapshots)) {
    return null;
  }
  return sourceEntry.snapshots.find((snapshot) => snapshot.fingerprint === fingerprint) || null;
}

export async function ensureArchiveBlob(index, hash, raw, preferredRelativePath) {
  const archiveDir = getArchiveDir();
  const archiveMode = getArchiveMode();
  const existing = index.blobs[hash];
  const relativePath = existing?.storedRelativePath || preferredRelativePath;
  const target = path.join(archiveDir, relativePath);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isFile()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const payload = archiveMode === "sensitive" ? encryptArchiveBlob(raw) : raw;
    await fs.writeFile(target, payload);
  }
  if (!existing) {
    index.blobs[hash] = {
      hash,
      storedRelativePath: relativePath,
      sizeBytes: Buffer.byteLength(raw),
      firstSeenAt: new Date().toISOString(),
      encrypted: archiveMode === "sensitive",
      refCount: 0
    };
  }
  return relativePath;
}

export async function readArchiveBlobText(index, snapshot) {
  const archiveDir = getArchiveDir();
  const blob = index.blobs?.[snapshot.hash];
  const relativePath = blob?.storedRelativePath || snapshot.storedRelativePath;
  if (!relativePath) {
    throw new Error("Archive blob path missing");
  }
  const target = path.resolve(path.join(archiveDir, relativePath));
  if (!target.startsWith(`${archiveDir}${path.sep}`)) {
    throw new Error("Invalid archive blob path");
  }
  const stored = await fs.readFile(target, "utf8");
  if (blob?.encrypted) {
    return decryptArchiveBlob(stored);
  }
  return stored;
}

export function summarizeArchiveStatus(index) {
  const sources = Object.values(index.sources || {});
  const snapshots = sources.flatMap((source) => Array.isArray(source.snapshots) ? source.snapshots : []);
  const telegramIds = new Set(snapshots.map((snapshot) => snapshot.telegramId).filter(Boolean));
  return {
    archiveDir: getArchiveDir(),
    enabled: getArchiveIntervalMinutes() > 0,
    intervalMinutes: getArchiveIntervalMinutes(),
    lastRun: index.lastRun || null,
    lastSuccessfulRunAt: index.lastSuccessfulRunAt || null,
    sourceCount: sources.length,
    snapshotCount: snapshots.length,
    storedBlobCount: Object.keys(index.blobs || {}).length,
    telegramIdCount: telegramIds.size
  };
}

export function countBookmarkedAnnotations(annotations) {
  return ["sessions", "threads", "profiles"]
    .flatMap((bucket) => Object.values(annotations?.[bucket] || {}))
    .filter((value) => value?.bookmarked === true)
    .length;
}

export function getArchiveSnapshots(index) {
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

export const SEARCH_RESULT_LIMIT = 200;
