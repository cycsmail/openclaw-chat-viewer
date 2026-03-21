import path from "node:path";
import { promises as fs } from "node:fs";
import {
  getAgentsDir, getArchiveDir, getArchiveKeepLatest, getArchiveIntervalMs,
  readJson, hashContent, toTimestampMs, minTimestamp, maxTimestamp, compareNewestFirst
} from "./config.mjs";
import {
  sanitizeArchiveSegment, extractSessionId, extractTelegramId, isTranscriptFile,
  parseVariant, deriveTranscriptOrigin, summarizeMessage, toMessageView,
  readTranscriptEntries, resolveSessionsDir, parseTranscriptEntries,
  buildThreadKey, buildProfileKey, getAnnotationValue, normalizeAnnotationInput,
  buildMessageLines, buildSearchableText, splitSearchTerms, buildSearchExcerpt,
  matchesArchiveFilters, diffLines, escapeHtml, renderMessagesAsMarkdown,
  renderMessagesAsHtml
} from "./helpers.mjs";
import { loadMachines, getMachineCachedAgentsDir } from "./machines.mjs";
import {
  loadArchiveIndex, saveArchiveIndex, loadAnnotations, updateAnnotation,
  buildArchiveSourceKey, buildArchivedRelativePath, findExistingSnapshot,
  ensureArchiveBlob, readArchiveBlobText, summarizeArchiveStatus,
  countBookmarkedAnnotations, getArchiveSnapshots, SEARCH_RESULT_LIMIT,
  createArchiveIndex,
  loadSearchIndex, saveSearchIndex, extractSearchTokens
} from "./archive.mjs";

let archiveRunPromise = null;

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

export function finalizeThreads(threadsMap, annotations) {
  return [...threadsMap.values()]
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
}

export function finalizeProfiles(profilesMap, annotations) {
  return [...profilesMap.values()]
    .map((profile) => buildProfileSummary({
      ...profile,
      updatedAt: profile.lastSeenAt,
      labels: [...profile.labels].sort(),
      agents: [...profile.agents].sort(),
      chatTypes: [...profile.chatTypes].sort(),
      threadKeys: [...profile.threadKeys].sort()
    }, annotations))
    .sort(compareNewestFirst);
}

export function buildDashboard(snapshots, threads, profiles, liveSessions, annotations, agentBreakdown, variantBreakdown, archiveByDay) {
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

  return {
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
}

export function buildArchiveCatalog(index, liveSessions, annotations, machineId = "") {
  let snapshots = getArchiveSnapshots(index);
  if (machineId && machineId !== "all") {
    const filterMachine = machineId || "local";
    snapshots = snapshots.filter((s) => (s.machineId || "local") === filterMachine);
  }
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
    const key = buildProfileKey(record.telegramId, record.machineId);
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
    thread.firstSeenAt = minTimestamp(thread.firstSeenAt, snapshot.startedAt, snapshot.updatedAt, snapshot.archivedAt) || thread.firstSeenAt;
    thread.lastSeenAt = maxTimestamp(thread.lastSeenAt, snapshot.updatedAt, snapshot.archivedAt, snapshot.startedAt) || thread.lastSeenAt;
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
      profile.firstSeenAt = minTimestamp(profile.firstSeenAt, snapshot.startedAt, snapshot.updatedAt, snapshot.archivedAt) || profile.firstSeenAt;
      profile.lastSeenAt = maxTimestamp(profile.lastSeenAt, snapshot.updatedAt, snapshot.archivedAt, snapshot.startedAt) || profile.lastSeenAt;
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
      profile.firstSeenAt = minTimestamp(profile.firstSeenAt, liveSession.startedAt, liveSession.updatedAt) || profile.firstSeenAt;
      profile.lastSeenAt = maxTimestamp(profile.lastSeenAt, liveSession.updatedAt, liveSession.startedAt) || profile.lastSeenAt;
    }
  }

  const threads = finalizeThreads(threadsMap, annotations);
  const profiles = finalizeProfiles(profilesMap, annotations);
  const dashboard = buildDashboard(snapshots, threads, profiles, liveSessions, annotations, agentBreakdown, variantBreakdown, archiveByDay);

  return { snapshots, threads, profiles, dashboard };
}

export async function getSessions(agentsDir = getAgentsDir(), machineId = "local") {
  const agentNames = await fs.readdir(agentsDir).catch(() => []);
  const sessions = [];

  for (const agentId of agentNames) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
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
        id: machineId !== "local" ? `${machineId}/${agentId}:${filename}` : `${agentId}:${filename}`,
        machineId,
        agentId,
        filename,
        sourceKey: buildArchiveSourceKey(agentId, filename, machineId),
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

export async function getTranscript(agentId, filename, agentsDir = null) {
  const sessionsDir = agentsDir
    ? path.join(agentsDir, agentId, "sessions")
    : resolveSessionsDir(agentId);
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
    const sessions = await getAllSessions();
    const index = await loadArchiveIndex();
    const searchIndex = await loadSearchIndex();
    // Convert token arrays to Sets for efficient dedup during the archive run
    for (const token of Object.keys(searchIndex.tokens)) {
      searchIndex.tokens[token] = new Set(searchIndex.tokens[token]);
    }
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
          updatedAt: session.updatedAt,
          machineId: session.machineId || "local"
        };

        sourceEntry.latestFingerprint = fingerprint;
        sourceEntry.latestSnapshotId = snapshotId;
        sourceEntry.lastSeenAt = archivedAt;
        sourceEntry.snapshots.push(snapshot);
        index.sources[sourceKey] = sourceEntry;
        summary.snapshotsCreated += 1;

        // Update search index for this snapshot
        try {
          const entries = parseTranscriptEntries(raw);
          const searchable = buildSearchableText(snapshot, entries);
          const tokens = extractSearchTokens(searchable);
          for (const token of tokens) {
            if (!searchIndex.tokens[token]) {
              searchIndex.tokens[token] = new Set();
            }
            searchIndex.tokens[token].add(snapshotId);
          }
          searchIndex.snapshotMeta[snapshotId] = {
            agentId: snapshot.agentId,
            telegramId: snapshot.telegramId || null,
            chatType: snapshot.chatType || null,
            variant: snapshot.variant || null,
            originLabel: snapshot.originLabel || null,
            sessionKey: snapshot.sessionKey || null,
            updatedAt: snapshot.updatedAt || null,
            machineId: snapshot.machineId || "local"
          };
        } catch {
          // search index update is best-effort
        }
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
    if (summary.snapshotsCreated > 0) {
      // Convert Sets back to arrays for JSON serialization
      for (const token of Object.keys(searchIndex.tokens)) {
        if (searchIndex.tokens[token] instanceof Set) {
          searchIndex.tokens[token] = [...searchIndex.tokens[token]];
        }
      }
      await saveSearchIndex(searchIndex);
    }
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
  if (getArchiveIntervalMs() <= 0) {
    return null;
  }

  const index = await loadArchiveIndex();
  const lastSuccessfulMs = index.lastSuccessfulRunAt ? Date.parse(index.lastSuccessfulRunAt) : 0;
  if (lastSuccessfulMs && Date.now() - lastSuccessfulMs < getArchiveIntervalMs()) {
    return {
      skipped: true,
      reason: "not_due",
      status: summarizeArchiveStatus(index)
    };
  }

  return runArchive(`scheduled:${trigger}`);
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
    telegramNames: buildTelegramNames(liveSessions, catalog.threads, catalog.profiles),
    annotations
  };
}

function buildTelegramNames(liveSessions, threads, profiles) {
  const names = {};
  for (const s of liveSessions) {
    if (s.telegramId && s.originLabel) {
      const clean = s.originLabel.replace(/\s*\(id:\d+\)\s*$/, "").replace(/\s*id:\d+\s*$/, "").trim();
      if (clean && !names[s.telegramId]) names[s.telegramId] = clean;
    }
  }
  for (const t of threads) {
    if (t.telegramId && t.label && !names[t.telegramId]) {
      const clean = t.label.replace(/\s*\(id:\d+\)\s*$/, "").replace(/\s*id:\d+\s*$/, "").trim();
      if (clean) names[t.telegramId] = clean;
    }
  }
  for (const p of profiles) {
    if (p.telegramId && p.labels?.length && !names[p.telegramId]) {
      const clean = p.labels[0].replace(/\s*\(id:\d+\)\s*$/, "").replace(/\s*\(\d+\)\s*$/, "").trim();
      if (clean) names[p.telegramId] = clean;
    }
  }
  return names;
}

export async function getRemoteSessions(machineId) {
  const agentsDir = getMachineCachedAgentsDir(machineId);
  return getSessions(agentsDir, machineId);
}

export async function getAllSessions() {
  const machines = await loadMachines();
  const tasks = machines.map((m) =>
    m.id === "local"
      ? getSessions()
      : getRemoteSessions(m.id)
  );
  const results = await Promise.allSettled(tasks);
  const allSessions = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      allSessions.push(...result.value);
    }
  }
  allSessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return allSessions;
}

export async function getOverviewForMachine(machineId) {
  const rawLiveSessions = machineId === "local"
    ? await getSessions()
    : await getRemoteSessions(machineId);
  const [index, annotations] = await Promise.all([
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
  const catalog = buildArchiveCatalog(index, liveSessions, annotations, machineId);
  return {
    generatedAt: new Date().toISOString(),
    machineId,
    liveSessions,
    archiveStatus: summarizeArchiveStatus(index),
    threads: catalog.threads,
    profiles: catalog.profiles,
    dashboard: catalog.dashboard,
    telegramNames: buildTelegramNames(liveSessions, catalog.threads, catalog.profiles),
    annotations
  };
}

export async function getOverviewAll() {
  const allLiveSessions = await getAllSessions();
  const [index, annotations] = await Promise.all([
    loadArchiveIndex(),
    loadAnnotations()
  ]);
  const liveSessions = allLiveSessions.map((session) => {
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
    machineId: "all",
    liveSessions,
    archiveStatus: summarizeArchiveStatus(index),
    threads: catalog.threads,
    profiles: catalog.profiles,
    dashboard: catalog.dashboard,
    telegramNames: buildTelegramNames(liveSessions, catalog.threads, catalog.profiles),
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
  const limit = Number(filters.limit) || SEARCH_RESULT_LIMIT;
  const offset = Number(filters.offset) || 0;
  const snapshots = getArchiveSnapshots(index).filter((snapshot) => matchesArchiveFilters(snapshot, filters));
  const results = [];

  // Try to use the search index for fast candidate filtering
  let candidateSnapshotIds = null;
  if (terms.length > 0) {
    const searchIdx = await loadSearchIndex();
    const hasIndex = Object.keys(searchIdx.tokens).length > 0;
    if (hasIndex) {
      const sets = terms.map((term) => {
        const matched = new Set();
        for (const [token, ids] of Object.entries(searchIdx.tokens)) {
          if (token.includes(term)) {
            for (const id of ids) matched.add(id);
          }
        }
        return matched;
      });
      // Intersect all sets
      candidateSnapshotIds = sets.reduce((acc, set) => {
        const result = new Set();
        for (const id of acc) {
          if (set.has(id)) result.add(id);
        }
        return result;
      });
    }
  }

  for (const snapshot of snapshots) {
    // If we have index candidates, skip snapshots not in the candidate set
    if (candidateSnapshotIds && !candidateSnapshotIds.has(snapshot.snapshotId)) {
      continue;
    }

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
  const total = results.length;
  const paged = results.slice(offset, offset + limit);
  return {
    query,
    terms,
    filters,
    total,
    count: paged.length,
    offset,
    limit,
    results: paged
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

export async function buildBatchExportPayload(machineId, format) {
  if (!["json", "markdown"].includes(format)) {
    throw new Error("Invalid export format");
  }
  const overview = machineId && machineId !== "local"
    ? await getOverviewForMachine(machineId)
    : await getOverview();
  const threads = overview.threads;

  if (format === "json") {
    const allExports = [];
    for (const thread of threads) {
      const snapshotTranscripts = [];
      for (const snapshot of thread.snapshots) {
        try {
          const transcript = await getArchiveTranscript(snapshot.snapshotId);
          snapshotTranscripts.push(transcript);
        } catch {
          // skip missing snapshots
        }
      }
      allExports.push({ thread, snapshots: snapshotTranscripts });
    }
    return {
      filename: `openclaw-export-all.json`,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(allExports, null, 2)
    };
  }

  // markdown
  const parts = [];
  for (const thread of threads) {
    parts.push(`# ${thread.label || thread.key}`);
    parts.push(`- Agent: ${thread.agentId}`);
    parts.push(`- Telegram ID: ${thread.telegramId || "-"}`);
    parts.push(`- Chat Type: ${thread.chatType || "-"}`);
    parts.push(`- Snapshots: ${thread.snapshotCount}`);
    parts.push("");
    for (const snapshot of thread.snapshots) {
      try {
        const transcript = await getArchiveTranscript(snapshot.snapshotId);
        parts.push(`## ${snapshot.snapshotId}`);
        parts.push("");
        parts.push(renderMessagesAsMarkdown(transcript.transcript));
      } catch {
        parts.push(`## ${snapshot.snapshotId} (unavailable)`);
      }
      parts.push("");
    }
    parts.push("---");
    parts.push("");
  }
  return {
    filename: `openclaw-export-all.md`,
    contentType: "text/markdown; charset=utf-8",
    body: parts.join("\n")
  };
}

export async function pruneArchive(keepLatest = getArchiveKeepLatest() || 3) {
  const parsedKeepLatest = Number(keepLatest);
  if (!Number.isInteger(parsedKeepLatest) || parsedKeepLatest < 1) {
    throw new Error("Invalid keepLatest");
  }
  const archiveDir = getArchiveDir();
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
    const target = path.resolve(path.join(archiveDir, blob.storedRelativePath));
    if (target.startsWith(`${archiveDir}${path.sep}`)) {
      await fs.unlink(target).catch(() => null);
    }
    delete index.blobs[hash];
    summary.removedBlobs += 1;
  }

  const knownPaths = new Set(Object.values(index.blobs || {}).map((b) => path.resolve(path.join(archiveDir, b.storedRelativePath))));
  summary.orphanedFiles = 0;
  const transcriptsDir = path.join(archiveDir, "transcripts");
  await (async function scanOrphans(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanOrphans(fullPath);
      } else if (entry.isFile() && !knownPaths.has(path.resolve(fullPath))) {
        await fs.unlink(fullPath).catch(() => null);
        summary.orphanedFiles += 1;
      }
    }
  })(transcriptsDir);

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
