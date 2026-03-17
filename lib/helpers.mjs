import path from "node:path";
import { promises as fs } from "node:fs";
import { getRootDir, getAgentsDir, toTimestampMs } from "./config.mjs";

export function sanitizeArchiveSegment(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, 120) || fallback;
}

export function normalizePathSlashes(value) {
  return String(value || "").split(path.sep).join("/");
}

export function parseVariant(filename) {
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

export function isTranscriptFile(filename) {
  return filename.endsWith(".jsonl") || filename.includes(".jsonl.reset.") || filename.includes(".jsonl.deleted.");
}

export function extractSessionId(filename) {
  const match = filename.match(/^([0-9a-f-]+)\.jsonl/);
  return match ? match[1] : filename;
}

export function extractTelegramId(...values) {
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

export function extractTelegramIdFromLabel(label) {
  if (typeof label !== "string" || !label) {
    return null;
  }
  const match = label.match(/id:([-\d]+)/);
  return match ? match[1] : null;
}

export function summarizeContentNode(node) {
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

export function flattenMessageText(content) {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((node) => node && typeof node === "object" && node.type === "text" && typeof node.text === "string")
    .map((node) => node.text)
    .join("\n");
}

export function summarizeMessage(entry) {
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

export function extractJsonBlock(text, heading) {
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

export function deriveTranscriptOrigin(entries) {
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

export function resolveMediaPath(candidatePath) {
  if (typeof candidatePath !== "string" || !candidatePath) {
    return null;
  }
  const resolved = path.resolve(candidatePath);
  const mediaRoot = path.join(getRootDir(), "media");
  if (resolved === mediaRoot || resolved.startsWith(`${mediaRoot}${path.sep}`)) {
    return resolved;
  }
  return null;
}

export const ATTACHED_MEDIA_PATTERN = /\[media attached:\s*([^\]|]+?)(?:\s+\(([^)]+)\))?\s*\|\s*([^\]]+)\]/g;
export const INLINE_MEDIA_PATTERN = /MEDIA:([^\s]+)/g;

export function extractAttachmentsFromText(text) {
  if (typeof text !== "string" || !text) {
    return [];
  }

  const attachments = [];
  ATTACHED_MEDIA_PATTERN.lastIndex = 0;
  let match;
  while ((match = ATTACHED_MEDIA_PATTERN.exec(text)) !== null) {
    const sourcePath = match[3]?.trim() || match[1]?.trim();
    attachments.push({
      kind: "media-attached",
      label: path.basename(sourcePath || match[1] || "attachment"),
      mimeType: match[2] || null,
      sourcePath,
      safeMediaPath: resolveMediaPath(sourcePath)
    });
  }

  INLINE_MEDIA_PATTERN.lastIndex = 0;
  while ((match = INLINE_MEDIA_PATTERN.exec(text)) !== null) {
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

export function extractAttachments(content) {
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

export function toMessageView(entry) {
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

export function parseTranscriptEntries(raw) {
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

export async function readTranscriptEntries(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return parseTranscriptEntries(raw);
}

export function resolveSessionsDir(agentId) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(agentId)) {
    throw new Error("Invalid agentId");
  }
  const agentsDir = getAgentsDir();
  const resolved = path.resolve(path.join(agentsDir, agentId, "sessions"));
  if (!resolved.startsWith(`${agentsDir}${path.sep}`)) {
    throw new Error("Invalid agentId");
  }
  return resolved;
}

export function splitSearchTerms(query) {
  return String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function buildSearchExcerpt(text, terms) {
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

export function matchesArchiveFilters(snapshot, filters) {
  if (filters.machineId && filters.machineId !== "all") {
    const snapshotMachine = snapshot.machineId || "local";
    const filterMachine = filters.machineId || "local";
    if (snapshotMachine !== filterMachine) {
      return false;
    }
  }
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

export function buildThreadKey(record) {
  const machinePrefix = record.machineId && record.machineId !== "local" ? `${record.machineId}:` : "";
  if (record.telegramId) {
    return `thread:telegram:${machinePrefix}${record.agentId}:${record.chatType || "unknown"}:${record.telegramId}`;
  }
  if (record.sessionKey) {
    return `thread:session-key:${machinePrefix}${record.agentId}:${record.sessionKey}`;
  }
  return `thread:session:${machinePrefix}${record.agentId}:${record.sessionId || record.filename || "unknown"}`;
}

export function buildProfileKey(telegramId, machineId) {
  const machinePrefix = machineId && machineId !== "local" ? `${machineId}:` : "";
  return `profile:telegram:${machinePrefix}${telegramId}`;
}

export function getAnnotationValue(annotations, bucket, key) {
  return annotations?.[bucket]?.[key] || null;
}

export function normalizeAnnotationInput(payload) {
  const bookmarked = payload?.bookmarked === true;
  const note = typeof payload?.note === "string" ? payload.note.trim().slice(0, 4000) : "";
  return {
    bookmarked,
    note
  };
}

export function buildMessageLines(entries) {
  return entries.map((entry) => {
    const view = toMessageView(entry);
    const timestamp = view.timestamp || "-";
    return `${timestamp} | ${view.role || view.entryType}: ${view.summary || ""}`.trim();
  });
}

export function buildSearchableText(snapshot, entries) {
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

export function diffLines(beforeLines, afterLines) {
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

export function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderMessagesAsMarkdown(messages) {
  return messages
    .map((message) => `### ${message.role || message.entryType} · ${message.timestamp || "-"}\n\n${message.summary || ""}\n`)
    .join("\n");
}

export function renderMessagesAsHtml(messages) {
  return messages
    .map((message) => `<section><h3>${escapeHtml(message.role || message.entryType)} · ${escapeHtml(message.timestamp || "-")}</h3><pre>${escapeHtml(message.summary || "")}</pre></section>`)
    .join("\n");
}
