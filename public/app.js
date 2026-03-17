const SIDEBAR_PAGE_SIZE = 100;

const state = {
  overview: null,
  mode: localStorage.getItem("openclawExplorerMode") || "dashboard",
  machines: [],
  selected: {
    dashboard: null,
    live: null,
    threads: null,
    profiles: null,
    search: null,
    machines: null,
    users: null
  },
  searchResults: [],
  searchTerms: [],
  detailCache: new Map(),
  diffCache: new Map(),
  threadSnapshotSelection: {},
  threadDiffSelection: {},
  sidebarVisibleCount: SIDEBAR_PAGE_SIZE,
  transcriptSortOrder: "asc",
  autoRefreshMs: Number(localStorage.getItem("openclawExplorerAutoRefreshMs") || "0"),
  autoRefreshHandle: null,
  authToken: localStorage.getItem("openclawViewerToken") || "",
  currentUser: null
};

const els = {
  modeButtons: {
    dashboard: document.querySelector("#modeDashboard"),
    live: document.querySelector("#modeLive"),
    threads: document.querySelector("#modeThreads"),
    profiles: document.querySelector("#modeProfiles"),
    search: document.querySelector("#modeSearch"),
    machines: document.querySelector("#modeMachines"),
    users: document.querySelector("#modeUsers")
  },
  machineFilter: document.querySelector("#machineFilter"),
  queryInput: document.querySelector("#queryInput"),
  agentFilter: document.querySelector("#agentFilter"),
  chatTypeFilter: document.querySelector("#chatTypeFilter"),
  variantFilter: document.querySelector("#variantFilter"),
  telegramIdFilter: document.querySelector("#telegramIdFilter"),
  dateFrom: document.querySelector("#dateFrom"),
  dateTo: document.querySelector("#dateTo"),
  autoRefreshSelect: document.querySelector("#autoRefreshSelect"),
  refreshButton: document.querySelector("#refreshButton"),
  searchButton: document.querySelector("#searchButton"),
  archiveButton: document.querySelector("#archiveButton"),
  pruneButton: document.querySelector("#pruneButton"),
  pruneKeepLatest: document.querySelector("#pruneKeepLatest"),
  archiveSummary: document.querySelector("#archiveSummary"),
  archiveStats: document.querySelector("#archiveStats"),
  archiveDetail: document.querySelector("#archiveDetail"),
  listStats: document.querySelector("#listStats"),
  sidebarList: document.querySelector("#sidebarList"),
  detailHeader: document.querySelector("#detailHeader"),
  detailBody: document.querySelector("#detailBody"),
  auxBody: document.querySelector("#auxBody"),
  bookmarkButton: document.querySelector("#bookmarkButton"),
  exportFormat: document.querySelector("#exportFormat"),
  exportButton: document.querySelector("#exportButton"),
  selectionHint: document.querySelector("#selectionHint"),
  noteInput: document.querySelector("#noteInput"),
  saveNoteButton: document.querySelector("#saveNoteButton"),
  listCardTemplate: document.querySelector("#listCardTemplate"),
  messageTemplate: document.querySelector("#messageTemplate"),
  logoutButton: document.querySelector("#logoutButton"),
  currentUserLabel: document.querySelector("#currentUserLabel")
};

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}

function clearNode(node) {
  node.replaceChildren();
}

function setHtml(node, html) {
  node.innerHTML = html;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightHtml(text, terms) {
  let html = escapeHtml(text);
  for (const term of terms) {
    if (!term) {
      continue;
    }
    const pattern = new RegExp(`(${escapeRegex(term)})`, "gi");
    html = html.replace(pattern, "<mark>$1</mark>");
  }
  return html;
}

function formatDate(value) {
  if (!value) {
    return "unknown";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "-";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDurationMs(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "off";
  }
  if (value % 60000 === 0) {
    return `${value / 60000}m`;
  }
  return `${Math.round(value / 1000)}s`;
}

function parseStructuredMessage(text) {
  const value = String(text || "");
  const sections = [];
  const blockPattern = /(Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)|Chat history since last reply \(untrusted, for context\)):\n```json\n([\s\S]*?)\n```/g;
  let lastIndex = 0;
  let match;

  while ((match = blockPattern.exec(value)) !== null) {
    const [fullMatch, label, json] = match;
    const leading = value.slice(lastIndex, match.index).trim();
    if (leading) {
      sections.push({ kind: "text", text: leading });
    }
    sections.push({ kind: "meta", label, json });
    lastIndex = match.index + fullMatch.length;
  }

  const trailing = value.slice(lastIndex).trim();
  if (trailing) {
    sections.push({
      kind: sections.length ? "text" : "plain",
      text: trailing
    });
  }

  return sections.length ? sections : [{ kind: "plain", text: value }];
}

async function fetchWithAuth(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options
  });

  if (response.status === 401) {
    location.href = "/login";
    throw new Error("Session expired");
  }

  return response;
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithAuth(url, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload || {};
}

async function fetchBlob(url, options = {}) {
  const response = await fetchWithAuth(url, options);
  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return {
    blob: await response.blob(),
    filename: parseDownloadFilename(response.headers.get("content-disposition"))
  };
}

function parseDownloadFilename(contentDisposition) {
  if (typeof contentDisposition !== "string" || !contentDisposition) {
    return "";
  }
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    return decodeURIComponent(utf8Match[1]);
  }
  const filenameMatch = contentDisposition.match(/filename="([^"]+)"/i) || contentDisposition.match(/filename=([^;]+)/i);
  return filenameMatch ? filenameMatch[1].trim() : "";
}

function matchesText(query, values) {
  if (!query) {
    return true;
  }
  const haystack = values.filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(query);
}

function itemTimestamp(item) {
  return item.updatedAt || item.lastSeenAt || item.archivedAt || item.startedAt || null;
}

function getFilterState() {
  return {
    agentId: els.agentFilter.value || "",
    chatType: els.chatTypeFilter.value || "",
    variant: els.variantFilter.value || "",
    telegramId: els.telegramIdFilter.value || "",
    dateFrom: els.dateFrom.value || "",
    dateTo: els.dateTo.value || "",
    machineId: getSelectedMachineId(),
  };
}

function applyCommonFilters(items, query) {
  const { agentId, chatType, variant, telegramId, dateFrom, dateTo, machineId } = getFilterState();
  const fromMs = dateFrom ? Date.parse(dateFrom) : 0;
  const toMs = dateTo ? Date.parse(dateTo) + 86399999 : 0;

  return items.filter((item) => {
    if (machineId && machineId !== "all") {
      const itemMachine = item.machineId || "local";
      const filterMachine = machineId || "local";
      if (itemMachine !== filterMachine) {
        return false;
      }
    }
    if (agentId && item.agentId !== agentId) {
      return false;
    }
    if (chatType && item.chatType !== chatType) {
      return false;
    }
    if (variant && item.variant !== variant) {
      return false;
    }
    if (telegramId && item.telegramId !== telegramId) {
      return false;
    }
    const timestamp = itemTimestamp(item);
    const timestampMs = timestamp ? Date.parse(timestamp) : 0;
    if (fromMs && timestampMs && timestampMs < fromMs) {
      return false;
    }
    if (toMs && timestampMs && timestampMs > toMs) {
      return false;
    }
    return matchesText(query, [
      item.agentId,
      item.telegramId,
      item.sessionKey,
      item.label,
      item.originLabel,
      item.note,
      item.lastSnippet,
      item.excerpt,
      item.filename
    ]);
  });
}

function getCurrentItems() {
  if (!state.overview) {
    return [];
  }
  const query = els.queryInput.value.trim().toLowerCase();

  if (state.mode === "live") {
    return applyCommonFilters(state.overview.liveSessions, query);
  }
  if (state.mode === "threads") {
    return applyCommonFilters(state.overview.threads, query);
  }
  if (state.mode === "profiles") {
    return applyCommonFilters(state.overview.profiles, query);
  }
  if (state.mode === "search") {
    return applyCommonFilters(state.searchResults, query);
  }
  if (state.mode === "machines") {
    return state.machines;
  }
  return state.overview.dashboard.topThreads || [];
}

function ensureSelections() {
  const items = getCurrentItems();
  if (!items.length) {
    state.selected[state.mode] = null;
    updateHash();
    return;
  }
  const selectedKey = state.selected[state.mode];
  const hasSelection = items.some((item) => getItemKey(item, state.mode) === selectedKey);
  if (!hasSelection) {
    state.selected[state.mode] = getItemKey(items[0], state.mode);
  }
  updateHash();
}

function getItemKey(item, mode = state.mode) {
  if (!item) {
    return null;
  }
  if (mode === "live") {
    return item.id;
  }
  if (mode === "threads") {
    return item.key;
  }
  if (mode === "profiles") {
    return item.key;
  }
  if (mode === "search") {
    return item.snapshotId;
  }
  if (mode === "machines") {
    return item.id;
  }
  return item.key || item.id || null;
}

function getSelectedItem(mode = state.mode) {
  const key = state.selected[mode];
  if (!key) {
    return null;
  }
  return getCurrentItems().find((item) => getItemKey(item, mode) === key) || null;
}

function populateFilters() {
  const overview = state.overview;
  if (!overview) {
    return;
  }

  const agents = [...new Set([
    ...overview.liveSessions.map((item) => item.agentId),
    ...overview.threads.map((item) => item.agentId),
    ...overview.profiles.flatMap((item) => item.agents || [])
  ])].filter(Boolean).sort();

  const telegramIds = [...new Set([
    ...overview.liveSessions.map((item) => item.telegramId),
    ...overview.threads.map((item) => item.telegramId),
    ...overview.profiles.map((item) => item.telegramId)
  ])].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const selectedAgent = els.agentFilter.value;
  const selectedTelegram = els.telegramIdFilter.value;

  setHtml(els.agentFilter, `<option value="">All</option>${agents.map((agentId) => `<option value="${escapeHtml(agentId)}">${escapeHtml(agentId)}</option>`).join("")}`);
  setHtml(els.telegramIdFilter, `<option value="">All</option>${telegramIds.map((telegramId) => `<option value="${escapeHtml(telegramId)}">${escapeHtml(telegramId)}</option>`).join("")}`);

  els.agentFilter.value = agents.includes(selectedAgent) ? selectedAgent : "";
  els.telegramIdFilter.value = telegramIds.includes(selectedTelegram) ? selectedTelegram : "";
}

function renderModeButtons() {
  for (const [mode, button] of Object.entries(els.modeButtons)) {
    const isActive = mode === state.mode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-current", isActive ? "page" : "false");
  }
}

function renderArchiveStatus() {
  const status = state.overview?.archiveStatus;
  if (!status) {
    els.archiveSummary.textContent = "Archive status unavailable.";
    els.archiveStats.innerHTML = "";
    els.archiveDetail.textContent = "";
    return;
  }
  const mode = status.enabled ? `Auto archive ${status.intervalMinutes}m` : "Auto archive off";
  const lastSuccessful = status.lastSuccessfulRunAt ? formatDate(status.lastSuccessfulRunAt) : "never";
  els.archiveSummary.textContent = `${mode} · last success ${lastSuccessful}`;
  els.archiveStats.innerHTML = [
    `<div class="archive-stat"><strong>${status.snapshotCount}</strong><span>snapshots</span></div>`,
    `<div class="archive-stat"><strong>${status.storedBlobCount}</strong><span>stored files</span></div>`,
    `<div class="archive-stat"><strong>${status.telegramIdCount}</strong><span>telegram ids</span></div>`
  ].join("");

  const lastRun = status.lastRun;
  if (!lastRun) {
    els.archiveDetail.textContent = status.archiveDir;
    return;
  }
  const errors = Array.isArray(lastRun.sourceErrors) && lastRun.sourceErrors.length ? ` · errors ${lastRun.sourceErrors.length}` : "";
  els.archiveDetail.textContent = `${lastRun.mode} · created ${lastRun.snapshotsCreated} · skipped ${lastRun.sourcesSkipped} · new blobs ${lastRun.blobsWritten}${errors} · ${status.archiveDir}`;
}

function renderListStats(items) {
  const overview = state.overview;
  if (!overview) {
    els.listStats.innerHTML = "";
    return;
  }
  const stats = {
    dashboard: [
      ["top threads", String(overview.dashboard.topThreads.length)],
      ["live", String(overview.dashboard.liveCount)],
      ["archived", String(overview.dashboard.archiveSnapshotCount)]
    ],
    live: [
      ["shown", String(items.length)],
      ["live", String(overview.liveSessions.length)],
      ["bookmarked", String(overview.liveSessions.filter((item) => item.bookmarked).length)]
    ],
    threads: [
      ["shown", String(items.length)],
      ["threads", String(overview.threads.length)],
      ["bookmarked", String(overview.threads.filter((item) => item.bookmarked).length)]
    ],
    profiles: [
      ["shown", String(items.length)],
      ["profiles", String(overview.profiles.length)],
      ["bookmarked", String(overview.profiles.filter((item) => item.bookmarked).length)]
    ],
    search: [
      ["results", String(items.length)],
      ["terms", String(state.searchTerms.length)],
      ["refresh", formatDurationMs(state.autoRefreshMs)]
    ],
    machines: [
      ["machines", String(items.length)],
      ["enabled", String(items.filter((m) => m.enabled !== false).length)],
      ["synced", String(items.filter((m) => m.lastSyncAt).length)]
    ]
  }[state.mode];

  els.listStats.innerHTML = stats.map(([label, value]) => `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
}

function getMachineBadge(item) {
  const machineId = getSelectedMachineId();
  if (machineId !== "all" || !item.machineId || item.machineId === "local") {
    return "";
  }
  const machine = state.machines.find((m) => m.id === item.machineId);
  return machine ? machine.name : item.machineId;
}

function buildCardPresentation(item, mode) {
  if (mode === "machines") {
    const statusLabel = item.id === "local" ? "local" : (item.lastSyncStatus || "unknown");
    return {
      primary: item.id,
      secondary: statusLabel,
      title: item.name || item.id,
      meta: item.host ? `${item.user || "user"}@${item.host}:${item.port || 22}` : "Local machine",
      snippet: item.lastSyncAt ? `Last sync: ${formatDate(item.lastSyncAt)}` : "Never synced",
      bookmarked: false
    };
  }
  if (mode === "live") {
    const machineBadge = getMachineBadge(item);
    return {
      primary: item.agentId,
      secondary: machineBadge || item.variant,
      title: item.sessionKey || item.sessionId || item.filename,
      meta: `${item.channel || "unknown"}${item.telegramId ? `:${item.telegramId}` : ""} · ${formatDate(item.updatedAt)}`,
      snippet: item.note || item.lastSnippet || "No preview",
      bookmarked: item.bookmarked === true
    };
  }
  if (mode === "threads") {
    return {
      primary: item.agentId,
      secondary: item.chatType || "thread",
      title: item.label || item.key,
      meta: `${item.telegramId || "no telegram"} · ${item.snapshotCount} snapshots · ${item.liveSessionCount} live · ${formatDate(item.lastSeenAt)}`,
      snippet: item.note || item.originLabels?.join(" · ") || "No note",
      bookmarked: item.bookmarked === true
    };
  }
  if (mode === "profiles") {
    return {
      primary: "profile",
      secondary: `${item.threadKeys.length} threads`,
      title: item.telegramId,
      meta: `${item.agents.join(", ") || "no agents"} · ${formatDate(item.lastSeenAt)}`,
      snippet: item.note || item.labels.join(" · ") || "No labels",
      bookmarked: item.bookmarked === true
    };
  }
  if (mode === "search") {
    return {
      primary: item.agentId,
      secondary: item.variant || "snapshot",
      title: item.sessionKey || item.originLabel || item.snapshotId,
      meta: `${item.telegramId || "no telegram"} · ${formatDate(item.updatedAt)}`,
      snippet: item.excerpt || "No excerpt",
      bookmarked: item.bookmarked === true
    };
  }
  return {
    primary: item.agentId || "dashboard",
    secondary: item.snapshotCount ? `${item.snapshotCount} snapshots` : "overview",
    title: item.label || item.key || item.sessionKey || "Dashboard",
    meta: item.lastSeenAt ? formatDate(item.lastSeenAt) : "",
    snippet: item.telegramId ? `telegram:${item.telegramId}` : "Open thread details",
    bookmarked: false
  };
}

function renderSidebarList() {
  clearNode(els.sidebarList);
  const items = getCurrentItems();
  ensureSelections();
  renderListStats(items);

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "placeholder";
    const emptyMessages = {
      dashboard: "No threads found. Run an archive first to populate the dashboard.",
      live: "No live sessions found. Check that agents are running.",
      threads: "No threads match the current filters. Try broadening your selection.",
      profiles: "No profiles match the current filters. Archive sessions with Telegram metadata first.",
      search: "No search results. Try different keywords or broaden the filters."
    };
    empty.textContent = emptyMessages[state.mode] || "No items match the current filters.";
    els.sidebarList.append(empty);
    return;
  }

  const selectedKey = state.selected[state.mode];
  const visible = items.slice(0, state.sidebarVisibleCount);

  for (const item of visible) {
    const card = els.listCardTemplate.content.firstElementChild.cloneNode(true);
    const view = buildCardPresentation(item, state.mode);
    const key = getItemKey(item, state.mode);
    card.classList.toggle("selected", key === selectedKey);
    card.querySelector(".list-card-badge.primary").textContent = view.primary || "";
    card.querySelector(".list-card-badge.secondary").textContent = view.secondary || "";
    card.querySelector(".list-card-title").textContent = view.title || "";
    card.querySelector(".list-card-meta").textContent = view.meta || "";
    card.querySelector(".list-card-snippet").textContent = view.snippet || "";
    card.querySelector(".list-card-bookmark").hidden = !view.bookmarked;
    card.addEventListener("click", () => {
      if (state.mode === "dashboard") {
        state.mode = "threads";
        state.selected.threads = item.key;
        persistMode();
        renderModeButtons();
        renderApp().catch(showFatalError);
        return;
      }
      state.selected[state.mode] = key;
      renderApp().catch(showFatalError);
    });
    els.sidebarList.append(card);
  }

  if (items.length > state.sidebarVisibleCount) {
    const remaining = items.length - state.sidebarVisibleCount;
    const showMore = document.createElement("button");
    showMore.type = "button";
    showMore.className = "mode-button";
    showMore.textContent = `Show more (${remaining} remaining)`;
    showMore.addEventListener("click", () => {
      state.sidebarVisibleCount += SIDEBAR_PAGE_SIZE;
      renderSidebarList();
    });
    els.sidebarList.append(showMore);
  }
}

function renderHeader(title, subtitle, details = []) {
  clearNode(els.detailHeader);
  const top = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = state.mode.toUpperCase();
  const heading = document.createElement("h2");
  heading.textContent = title;
  const sub = document.createElement("p");
  sub.className = "muted";
  sub.textContent = subtitle || "";
  top.append(eyebrow, heading, sub);

  const grid = document.createElement("div");
  grid.className = "session-detail-grid";
  for (const [label, value] of details) {
    const cell = document.createElement("div");
    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    const valueNode = document.createElement("strong");
    valueNode.textContent = value;
    cell.append(labelNode, valueNode);
    grid.append(cell);
  }
  els.detailHeader.append(top, grid);
}

function renderTextSection(container, title, text) {
  const section = document.createElement("section");
  section.className = "inline-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const body = document.createElement("pre");
  body.className = "inline-pre";
  body.textContent = text;
  section.append(heading, body);
  container.append(section);
}

function renderMetricCards(container, metrics) {
  const grid = document.createElement("div");
  grid.className = "metric-grid";
  for (const [label, value] of metrics) {
    const card = document.createElement("div");
    card.className = "metric-card";
    card.innerHTML = `<strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span>`;
    grid.append(card);
  }
  container.append(grid);
}

function getAnnotationContext() {
  const overview = state.overview;
  if (!overview) {
    return null;
  }
  if (state.mode === "live") {
    const item = getSelectedItem("live");
    if (!item) {
      return null;
    }
    return {
      bucket: "sessions",
      key: item.sourceKey,
      bookmarked: item.bookmarked === true,
      note: item.note || "",
      exportKind: item.threadKey ? "thread" : null,
      exportId: item.threadKey || null
    };
  }
  if (state.mode === "threads") {
    const item = getSelectedItem("threads");
    if (!item) {
      return null;
    }
    return {
      bucket: "threads",
      key: item.key,
      bookmarked: item.bookmarked === true,
      note: item.note || "",
      exportKind: "thread",
      exportId: item.key
    };
  }
  if (state.mode === "profiles") {
    const item = getSelectedItem("profiles");
    if (!item) {
      return null;
    }
    return {
      bucket: "profiles",
      key: item.key,
      bookmarked: item.bookmarked === true,
      note: item.note || "",
      exportKind: "profile",
      exportId: item.key
    };
  }
  if (state.mode === "search") {
    const item = getSelectedItem("search");
    if (!item) {
      return null;
    }
    return {
      bucket: "threads",
      key: item.threadKey,
      bookmarked: item.bookmarked === true,
      note: item.note || "",
      exportKind: item.threadKey ? "thread" : null,
      exportId: item.threadKey || null
    };
  }
  return null;
}

function updateActionState() {
  const context = getAnnotationContext();
  const exportable = context?.exportKind && context?.exportId;
  els.bookmarkButton.disabled = !context;
  els.saveNoteButton.disabled = !context;
  els.exportButton.disabled = !exportable;
  els.selectionHint.textContent = exportable
    ? `Export ${context.exportKind} as ${els.exportFormat.value}`
    : "Export is available for stitched threads and Telegram profiles.";
  els.noteInput.value = context?.note || "";
  els.bookmarkButton.textContent = context?.bookmarked ? "Unbookmark" : "Bookmark";
}

function renderAttachments(container, attachments) {
  clearNode(container);
  if (!Array.isArray(attachments) || !attachments.length) {
    return;
  }
  container.classList.add("has-attachments");
  for (const attachment of attachments) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "attachment-chip";
    chip.textContent = attachment.mimeType ? `${attachment.label} · ${attachment.mimeType}` : attachment.label;
    if (!attachment.safeMediaPath) {
      chip.disabled = true;
      chip.title = attachment.sourcePath || "Attachment path unavailable";
    } else {
      chip.title = attachment.sourcePath;
      chip.addEventListener("click", () => {
        openMediaAttachment(attachment.safeMediaPath).catch(showFatalError);
      });
    }
    container.append(chip);
  }
}

function renderMessageBody(container, text, terms) {
  clearNode(container);
  const sections = parseStructuredMessage(text);
  for (const section of sections) {
    if (section.kind === "meta") {
      const card = document.createElement("section");
      card.className = "message-metadata";
      const title = document.createElement("div");
      title.className = "message-metadata-title";
      title.textContent = section.label;
      const pre = document.createElement("pre");
      pre.className = "message-metadata-body";
      pre.innerHTML = highlightHtml(section.json, terms);
      card.append(title, pre);
      container.append(card);
      continue;
    }
    const pre = document.createElement("pre");
    pre.className = section.kind === "plain" ? "message-body-text" : "message-body-text message-body-text-emphasis";
    pre.innerHTML = highlightHtml(section.text, terms);
    container.append(pre);
  }
}

function renderTranscript(container, transcript, terms = []) {
  clearNode(container);
  if (!transcript || !transcript.length) {
    const empty = document.createElement("p");
    empty.className = "placeholder";
    empty.textContent = "No transcript available.";
    container.append(empty);
    return;
  }

  let sortOrder = state.transcriptSortOrder || "asc";
  const sorted = [...transcript];
  if (sortOrder === "desc") {
    sorted.reverse();
  }

  const toolbar = document.createElement("div");
  toolbar.className = "transcript-sort-bar";
  const sortBtn = document.createElement("button");
  sortBtn.type = "button";
  sortBtn.className = "transcript-sort-btn";
  sortBtn.textContent = sortOrder === "asc" ? "Oldest first" : "Newest first";
  sortBtn.addEventListener("click", () => {
    state.transcriptSortOrder = sortOrder === "asc" ? "desc" : "asc";
    renderTranscript(container, transcript, terms);
  });
  const countLabel = document.createElement("span");
  countLabel.className = "muted";
  countLabel.textContent = `${transcript.length} messages`;
  toolbar.append(sortBtn, countLabel);
  container.append(toolbar);

  for (const item of sorted) {
    const node = els.messageTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(`role-${String(item.role).replace(/[^a-z0-9_-]/gi, "").toLowerCase()}`);
    node.querySelector(".role-pill").textContent = item.role || item.entryType;
    node.querySelector(".timestamp").textContent = formatDate(item.timestamp);
    renderAttachments(node.querySelector(".message-attachments"), item.attachments || []);
    renderMessageBody(node.querySelector(".message-body"), item.summary || JSON.stringify(item.raw, null, 2), terms);
    container.append(node);
  }
}

async function openMediaAttachment(safePath) {
  const { blob } = await fetchBlob(`/api/media?path=${encodeURIComponent(safePath)}`);
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function getSelectedMachineId() {
  return els.machineFilter?.value || "";
}

async function loadOverview(options = {}) {
  const machineId = getSelectedMachineId();
  const machineParam = machineId ? `?machineId=${encodeURIComponent(machineId)}` : "";
  const payload = await fetchJson(`/api/overview${machineParam}`);
  state.overview = payload;
  populateFilters();
  renderArchiveStatus();
  if (options.refreshSearch && state.mode === "search" && (els.queryInput.value.trim() || state.searchResults.length)) {
    await runSearch(true);
  }
}

async function fetchLiveTranscript(session) {
  const cacheKey = `live:${session.id}`;
  if (state.detailCache.has(cacheKey)) {
    return state.detailCache.get(cacheKey);
  }
  const params = new URLSearchParams({
    agentId: session.agentId,
    filename: session.filename
  });
  if (session.machineId && session.machineId !== "local") {
    params.set("machineId", session.machineId);
  }
  const payload = await fetchJson(`/api/transcript?${params.toString()}`);
  const detail = {
    kind: "live",
    transcript: payload.transcript || [],
    meta: session
  };
  state.detailCache.set(cacheKey, detail);
  return detail;
}

async function fetchArchiveTranscript(snapshotId) {
  const cacheKey = `snapshot:${snapshotId}`;
  if (state.detailCache.has(cacheKey)) {
    return state.detailCache.get(cacheKey);
  }
  const payload = await fetchJson(`/api/archive/transcript?snapshotId=${encodeURIComponent(snapshotId)}`);
  const detail = {
    kind: "snapshot",
    transcript: payload.transcript || [],
    snapshot: payload.snapshot
  };
  state.detailCache.set(cacheKey, detail);
  return detail;
}

async function fetchSnapshotDiff(snapshotA, snapshotB) {
  const cacheKey = `${snapshotA}::${snapshotB}`;
  if (state.diffCache.has(cacheKey)) {
    return state.diffCache.get(cacheKey);
  }
  const payload = await fetchJson(`/api/archive/diff?snapshotA=${encodeURIComponent(snapshotA)}&snapshotB=${encodeURIComponent(snapshotB)}`);
  state.diffCache.set(cacheKey, payload);
  return payload;
}

function persistMode() {
  localStorage.setItem("openclawExplorerMode", state.mode);
  updateHash();
}

function updateHash() {
  const selected = state.selected[state.mode];
  const parts = [state.mode];
  if (selected) {
    parts.push(encodeURIComponent(selected));
  }
  const hash = `#${parts.join("/")}`;
  if (location.hash !== hash) {
    history.replaceState(null, "", hash);
  }
}

function restoreFromHash() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return false;
  const [mode, ...rest] = hash.split("/");
  const validModes = ["dashboard", "live", "threads", "profiles", "search", "machines"];
  if (!validModes.includes(mode)) return false;
  state.mode = mode;
  const selected = rest.length ? decodeURIComponent(rest.join("/")) : null;
  if (selected) {
    state.selected[mode] = selected;
  }
  return true;
}

function persistAutoRefresh() {
  localStorage.setItem("openclawExplorerAutoRefreshMs", String(state.autoRefreshMs));
}

function scheduleAutoRefresh() {
  if (state.autoRefreshHandle) {
    window.clearInterval(state.autoRefreshHandle);
    state.autoRefreshHandle = null;
  }
  if (!state.autoRefreshMs) {
    return;
  }
  state.autoRefreshHandle = window.setInterval(() => {
    refreshData({ refreshSearch: state.mode === "search" }).catch(showFatalError);
  }, state.autoRefreshMs);
}

async function refreshData(options = {}) {
  state.detailCache.clear();
  state.diffCache.clear();
  await loadOverview(options);
  renderApp();
}

async function runSearch(preserveSelection = false) {
  const filters = getFilterState();
  const params = new URLSearchParams({
    q: els.queryInput.value.trim(),
    ...filters
  });
  const payload = await fetchJson(`/api/archive/search?${params.toString()}`);
  state.searchResults = payload.results || [];
  state.searchTerms = payload.terms || [];
  if (!preserveSelection || !state.searchResults.some((item) => item.snapshotId === state.selected.search)) {
    state.selected.search = state.searchResults[0]?.snapshotId || null;
  }
}

function setDetailPlaceholder(message) {
  clearNode(els.detailBody);
  clearNode(els.auxBody);
  const placeholder = document.createElement("p");
  placeholder.className = "placeholder";
  placeholder.textContent = message;
  els.detailBody.append(placeholder);
}

function setDetailLoading(message = "Loading...") {
  clearNode(els.detailBody);
  clearNode(els.auxBody);
  const loader = document.createElement("p");
  loader.className = "placeholder loading-pulse";
  loader.textContent = message;
  els.detailBody.append(loader);
}

function renderDashboard() {
  const dashboard = state.overview.dashboard;
  renderHeader("Operational dashboard", "Live activity, archive growth, and stitched archive coverage.", [
    ["Live sessions", String(dashboard.liveCount)],
    ["Snapshots", String(dashboard.archiveSnapshotCount)],
    ["Threads", String(dashboard.threadCount)],
    ["Profiles", String(dashboard.profileCount)],
    ["Bookmarks", String(dashboard.bookmarkedCount)]
  ]);
  updateActionState();

  clearNode(els.detailBody);
  clearNode(els.auxBody);

  renderMetricCards(els.detailBody, [
    ["Live sessions", String(dashboard.liveCount)],
    ["Archived snapshots", String(dashboard.archiveSnapshotCount)],
    ["Stitched threads", String(dashboard.threadCount)],
    ["Telegram profiles", String(dashboard.profileCount)]
  ]);

  renderTextSection(els.detailBody, "Agent breakdown", dashboard.agentBreakdown.map((item) => `${item.agentId}: ${item.count}`).join("\n"));
  renderTextSection(els.detailBody, "Variant breakdown", dashboard.variantBreakdown.map((item) => `${item.variant}: ${item.count}`).join("\n"));

  renderTextSection(els.auxBody, "Archive growth", dashboard.archiveGrowth.map((item) => `${item.day}: ${item.count}`).join("\n") || "No archive growth data yet.");
  renderTextSection(els.auxBody, "Stale live sessions", dashboard.staleLiveSessions.map((item) => `${item.agentId} · ${item.sessionKey || item.id} · ${formatDate(item.updatedAt)}`).join("\n") || "No stale sessions.");
}

async function renderLiveDetail() {
  const session = getSelectedItem("live");
  if (!session) {
    renderHeader("No live session selected", "", []);
    updateActionState();
    setDetailPlaceholder("Choose a live session from the sidebar.");
    return;
  }
  renderHeader(session.sessionKey || session.sessionId, session.originLabel || session.deliveryTo || session.filename, [
    ["Agent", session.agentId],
    ["State", session.variant],
    ["Telegram", session.telegramId || "-"],
    ["Updated", formatDate(session.updatedAt)],
    ["Messages", String(session.messageCount)],
    ["File", session.filename]
  ]);
  updateActionState();
  setDetailLoading("Loading transcript...");
  const detail = await fetchLiveTranscript(session);
  renderTranscript(els.detailBody, detail.transcript, []);
  clearNode(els.auxBody);
  renderTextSection(els.auxBody, "Session note", session.note || "No note saved for this live source.");
}

function buildThreadSnapshotControls(thread) {
  const wrapper = document.createElement("div");
  wrapper.className = "thread-controls";

  const snapshotOptions = thread.snapshots.map((snapshot) => `<option value="${escapeHtml(snapshot.snapshotId)}">${escapeHtml(snapshot.variant)} · ${escapeHtml(formatDate(snapshot.updatedAt || snapshot.archivedAt))}</option>`).join("");

  const viewerCard = document.createElement("div");
  viewerCard.className = "inline-section";
  viewerCard.innerHTML = `
    <h3>Snapshot viewer</h3>
    <div class="inline-form">
      <select id="threadSnapshotSelect">${snapshotOptions}</select>
      <button id="threadSnapshotLoad" type="button">Open snapshot</button>
    </div>
  `;
  wrapper.append(viewerCard);

  if (thread.snapshots.length >= 2) {
    const defaults = state.threadDiffSelection[thread.key] || {
      before: thread.snapshots[1]?.snapshotId || thread.snapshots[0]?.snapshotId,
      after: thread.snapshots[0]?.snapshotId
    };
    const diffCard = document.createElement("div");
    diffCard.className = "inline-section";
    diffCard.innerHTML = `
      <h3>Snapshot diff</h3>
      <div class="inline-form">
        <select id="threadDiffBefore">${snapshotOptions}</select>
        <select id="threadDiffAfter">${snapshotOptions}</select>
        <button id="threadDiffRun" type="button">Compare</button>
      </div>
      <div id="threadDiffOutput" class="diff-output"></div>
    `;
    wrapper.append(diffCard);
    queueMicrotask(() => {
      const beforeSelect = diffCard.querySelector("#threadDiffBefore");
      const afterSelect = diffCard.querySelector("#threadDiffAfter");
      beforeSelect.value = defaults.before;
      afterSelect.value = defaults.after;
    });
  }

  queueMicrotask(() => {
    const snapshotSelect = wrapper.querySelector("#threadSnapshotSelect");
    if (snapshotSelect && state.threadSnapshotSelection[thread.key]) {
      snapshotSelect.value = state.threadSnapshotSelection[thread.key];
    }
    const loadButton = wrapper.querySelector("#threadSnapshotLoad");
    if (loadButton) {
      loadButton.addEventListener("click", () => {
        state.threadSnapshotSelection[thread.key] = snapshotSelect.value;
        renderApp().catch(showFatalError);
      });
    }
    const diffButton = wrapper.querySelector("#threadDiffRun");
    if (diffButton) {
      diffButton.addEventListener("click", async () => {
        const before = wrapper.querySelector("#threadDiffBefore").value;
        const after = wrapper.querySelector("#threadDiffAfter").value;
        state.threadDiffSelection[thread.key] = { before, after };
        const diff = await fetchSnapshotDiff(before, after);
        renderDiffOutput(wrapper.querySelector("#threadDiffOutput"), diff);
      });

      const current = state.threadDiffSelection[thread.key];
      if (current?.before && current?.after) {
        fetchSnapshotDiff(current.before, current.after)
          .then((diff) => renderDiffOutput(wrapper.querySelector("#threadDiffOutput"), diff))
          .catch(showFatalError);
      }
    }
  });

  return wrapper;
}

function renderDiffOutput(container, payload) {
  clearNode(container);
  if (!payload?.diff) {
    return;
  }
  renderMetricCards(container, [
    ["Before lines", String(payload.diff.beforeCount)],
    ["After lines", String(payload.diff.afterCount)],
    ["Removed", String(payload.diff.removed.length)],
    ["Added", String(payload.diff.added.length)]
  ]);
  renderTextSection(container, "Removed lines", payload.diff.removed.join("\n") || "No removed lines.");
  renderTextSection(container, "Added lines", payload.diff.added.join("\n") || "No added lines.");
}

async function renderThreadDetail() {
  const thread = getSelectedItem("threads");
  if (!thread) {
    renderHeader("No thread selected", "", []);
    updateActionState();
    setDetailPlaceholder("Choose a stitched thread from the sidebar.");
    return;
  }
  renderHeader(thread.label || thread.key, thread.originLabels.join(" · ") || thread.telegramId || "", [
    ["Agent", thread.agentId],
    ["Telegram", thread.telegramId || "-"],
    ["Chat type", thread.chatType || "-"],
    ["Snapshots", String(thread.snapshotCount)],
    ["Live sessions", String(thread.liveSessionCount)],
    ["Last seen", formatDate(thread.lastSeenAt)]
  ]);
  updateActionState();

  clearNode(els.detailBody);
  clearNode(els.auxBody);

  els.auxBody.append(buildThreadSnapshotControls(thread));
  renderTextSection(els.auxBody, "Variants", thread.variants.join("\n") || "No variants.");

  const snapshotId = state.threadSnapshotSelection[thread.key] || thread.snapshots[0]?.snapshotId || null;
  if (snapshotId) {
    state.threadSnapshotSelection[thread.key] = snapshotId;
    setDetailLoading("Loading snapshot...");
    const detail = await fetchArchiveTranscript(snapshotId);
    renderTranscript(els.detailBody, detail.transcript, []);
  } else if (thread.liveSessions.length) {
    const liveSession = state.overview.liveSessions.find((item) => item.id === thread.liveSessions[0].id);
    if (liveSession) {
      const detail = await fetchLiveTranscript(liveSession);
      renderTranscript(els.detailBody, detail.transcript, []);
    } else {
      setDetailPlaceholder("No archived snapshot or live transcript available for this thread.");
    }
  } else {
    setDetailPlaceholder("No archived snapshot or live transcript available for this thread.");
  }
}

function renderThreadButtons(container, threadKeys) {
  const threadLookup = new Map(state.overview.threads.map((thread) => [thread.key, thread]));
  const list = document.createElement("div");
  list.className = "thread-link-list";
  for (const threadKey of threadKeys) {
    const thread = threadLookup.get(threadKey);
    if (!thread) {
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thread-link";
    button.textContent = `${thread.label || thread.key} · ${thread.snapshotCount} snapshots`;
    button.addEventListener("click", () => {
      state.mode = "threads";
      state.selected.threads = thread.key;
      persistMode();
      renderModeButtons();
      renderApp().catch(showFatalError);
    });
    list.append(button);
  }
  container.append(list);
}

function renderProfileDetail() {
  const profile = getSelectedItem("profiles");
  if (!profile) {
    renderHeader("No profile selected", "", []);
    updateActionState();
    setDetailPlaceholder("Choose a Telegram profile from the sidebar.");
    return;
  }
  renderHeader(`Telegram ${profile.telegramId}`, profile.labels.join(" · ") || "No labels", [
    ["Threads", String(profile.threadKeys.length)],
    ["Snapshots", String(profile.snapshotCount)],
    ["Live sessions", String(profile.liveSessionCount)],
    ["Agents", profile.agents.join(", ") || "-"],
    ["Chat types", profile.chatTypes.join(", ") || "-"],
    ["Last seen", formatDate(profile.lastSeenAt)]
  ]);
  updateActionState();

  clearNode(els.detailBody);
  clearNode(els.auxBody);
  renderMetricCards(els.detailBody, [
    ["Threads", String(profile.threadKeys.length)],
    ["Snapshots", String(profile.snapshotCount)],
    ["Live sessions", String(profile.liveSessionCount)],
    ["Agents", String(profile.agents.length)]
  ]);
  renderTextSection(els.detailBody, "Labels", profile.labels.join("\n") || "No labels.");
  renderThreadButtons(els.auxBody, profile.threadKeys);
}

async function renderSearchDetail() {
  const result = getSelectedItem("search");
  if (!result) {
    renderHeader("No search result selected", "Run an archive search to inspect results.", []);
    updateActionState();
    setDetailPlaceholder("Search archived snapshots with the current filters.");
    return;
  }
  renderHeader(result.sessionKey || result.originLabel || result.snapshotId, result.excerpt || "", [
    ["Agent", result.agentId],
    ["Telegram", result.telegramId || "-"],
    ["Variant", result.variant || "-"],
    ["Updated", formatDate(result.updatedAt)]
  ]);
  updateActionState();
  setDetailLoading("Loading transcript...");
  const detail = await fetchArchiveTranscript(result.snapshotId);
  renderTranscript(els.detailBody, detail.transcript, state.searchTerms);
  clearNode(els.auxBody);
  renderTextSection(els.auxBody, "Search excerpt", result.excerpt || "No excerpt.");
  if (result.threadKey) {
    renderThreadButtons(els.auxBody, [result.threadKey]);
  }
}

function renderMachinesDetail() {
  const machine = getSelectedItem("machines");
  if (!machine) {
    renderHeader("Machine Management", "Add, test, and sync remote OpenClaw instances.", []);
    updateActionState();
    clearNode(els.detailBody);
    clearNode(els.auxBody);
  } else {
    const details = machine.id === "local"
      ? [["ID", "local"], ["Status", "Running"]]
      : [
          ["ID", machine.id],
          ["Host", machine.host || "-"],
          ["User", machine.user || "user"],
          ["Port", String(machine.port || 22)],
          ["Home", machine.openclawHome || "~/.openclaw"],
          ["Last sync", machine.lastSyncAt ? formatDate(machine.lastSyncAt) : "Never"],
          ["Sync status", machine.lastSyncStatus || "unknown"]
        ];
    renderHeader(machine.name || machine.id, machine.host ? `${machine.user || "user"}@${machine.host}` : "Local machine", details);
    updateActionState();
    clearNode(els.detailBody);
    clearNode(els.auxBody);

    if (machine.id !== "local") {
      const actionsCard = document.createElement("div");
      actionsCard.className = "inline-section";
      actionsCard.innerHTML = `
        <h3>Actions</h3>
        <div class="inline-form">
          <button type="button" id="machineTestBtn">Test connection</button>
          <button type="button" id="machineSyncBtn">Sync now</button>
          <button type="button" id="machineDeleteBtn">Delete</button>
        </div>
        <p id="machineActionResult" class="muted" style="margin-top:0.6rem"></p>
      `;
      els.detailBody.append(actionsCard);

      queueMicrotask(() => {
        const resultEl = actionsCard.querySelector("#machineActionResult");
        actionsCard.querySelector("#machineTestBtn").addEventListener("click", async () => {
          resultEl.textContent = "Testing connection...";
          try {
            const result = await fetchJson("/api/machines/test", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-OpenClaw-Action": "machine-test" },
              body: JSON.stringify(machine)
            });
            resultEl.textContent = result.ok
              ? `Connection OK (${result.latencyMs}ms)`
              : `Connection failed: ${result.error}`;
          } catch (err) {
            resultEl.textContent = `Error: ${err.message}`;
          }
        });
        actionsCard.querySelector("#machineSyncBtn").addEventListener("click", async () => {
          resultEl.textContent = "Syncing...";
          try {
            const result = await fetchJson("/api/machines/sync", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-OpenClaw-Action": "machine-sync" },
              body: JSON.stringify(machine)
            });
            resultEl.textContent = result.ok
              ? `Sync complete (${result.filesTransferred} files)`
              : `Sync failed: ${result.error}`;
            await loadMachinesList();
            renderSidebarList();
          } catch (err) {
            resultEl.textContent = `Error: ${err.message}`;
          }
        });
        actionsCard.querySelector("#machineDeleteBtn").addEventListener("click", async () => {
          if (!confirm(`Delete machine "${machine.name}"?`)) return;
          try {
            await fetchJson("/api/machines/delete", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-OpenClaw-Action": "machine-delete" },
              body: JSON.stringify({ id: machine.id })
            });
            state.selected.machines = null;
            await loadMachinesList();
            await populateMachineFilter();
            renderApp().catch(showFatalError);
          } catch (err) {
            showToast(`Delete failed: ${err.message}`, "error");
          }
        });
      });
    }
  }

  const addCard = document.createElement("div");
  addCard.className = "inline-section";
  addCard.innerHTML = `
    <h3>Add / Edit Machine</h3>
    <div class="inline-form">
      <label><span>Name</span><input type="text" id="machineAddName" placeholder="e.g. Trucking"></label>
      <label><span>Host</span><input type="text" id="machineAddHost" placeholder="192.168.1.10"></label>
      <label><span>User</span><input type="text" id="machineAddUser" placeholder="ssh username"></label>
      <label><span>Port</span><input type="number" id="machineAddPort" value="22" min="1" max="65535"></label>
      <label><span>OpenClaw home</span><input type="text" id="machineAddHome" value="~/.openclaw"></label>
    </div>
    <div style="margin-top:0.6rem"><button type="button" id="machineAddBtn">Add machine</button></div>
    <p id="machineAddResult" class="muted" style="margin-top:0.4rem"></p>
  `;
  els.auxBody.append(addCard);

  queueMicrotask(() => {
    addCard.querySelector("#machineAddBtn").addEventListener("click", async () => {
      const resultEl = addCard.querySelector("#machineAddResult");
      const name = addCard.querySelector("#machineAddName").value.trim();
      const host = addCard.querySelector("#machineAddHost").value.trim();
      const user = addCard.querySelector("#machineAddUser").value.trim();
      const port = Number(addCard.querySelector("#machineAddPort").value) || 22;
      const openclawHome = addCard.querySelector("#machineAddHome").value.trim() || "~/.openclaw";
      if (!name || !host) {
        resultEl.textContent = "Name and host are required.";
        return;
      }
      try {
        await fetchJson("/api/machines", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenClaw-Action": "machine-add" },
          body: JSON.stringify({ name, host, user, port, openclawHome })
        });
        resultEl.textContent = `Machine "${name}" added.`;
        await loadMachinesList();
        await populateMachineFilter();
        renderSidebarList();
      } catch (err) {
        resultEl.textContent = `Error: ${err.message}`;
      }
    });
  });

  const uploadCard = document.createElement("div");
  uploadCard.className = "inline-section";
  uploadCard.innerHTML = `
    <h3>Upload Session Data</h3>
    <div class="inline-form">
      <label><span>Machine</span><select id="uploadMachineSelect"></select></label>
      <label><span>Agent ID</span><input type="text" id="uploadAgentId" placeholder="main"></label>
      <label><span>File (.jsonl)</span><input type="file" id="uploadFile" accept=".jsonl"></label>
    </div>
    <div style="margin-top:0.6rem"><button type="button" id="uploadBtn">Upload</button></div>
    <p id="uploadResult" class="muted" style="margin-top:0.4rem"></p>
  `;
  els.auxBody.append(uploadCard);

  queueMicrotask(() => {
    const machineSelect = uploadCard.querySelector("#uploadMachineSelect");
    for (const m of state.machines.filter((m) => m.id !== "local")) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      machineSelect.append(opt);
    }

    uploadCard.querySelector("#uploadBtn").addEventListener("click", async () => {
      const resultEl = uploadCard.querySelector("#uploadResult");
      const machineId = machineSelect.value;
      const agentId = uploadCard.querySelector("#uploadAgentId").value.trim();
      const fileInput = uploadCard.querySelector("#uploadFile");
      if (!machineId || !agentId || !fileInput.files.length) {
        resultEl.textContent = "Machine, agent ID, and file are required.";
        return;
      }
      const file = fileInput.files[0];
      const content = await file.text();
      try {
        await fetchJson("/api/machines/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenClaw-Action": "machine-upload" },
          body: JSON.stringify({ machineId, agentId, filename: file.name, content })
        });
        resultEl.textContent = `Uploaded ${file.name} to ${machineId}/${agentId}.`;
      } catch (err) {
        resultEl.textContent = `Error: ${err.message}`;
      }
    });
  });
}

async function renderUsersDetail() {
  renderHeader("User Management", "Add, edit, and remove users.", []);
  updateActionState();
  clearNode(els.detailBody);
  clearNode(els.auxBody);

  let users = [];
  try {
    users = await fetchJson("/api/users");
  } catch (err) {
    setDetailPlaceholder("Failed to load users: " + err.message);
    return;
  }

  const listCard = document.createElement("div");
  listCard.className = "inline-section";
  let tableHtml = "<h3>Users</h3><table style='width:100%;border-collapse:collapse;font-size:0.9rem'>";
  tableHtml += "<tr><th style='text-align:left;padding:0.4rem'>Username</th><th style='text-align:left;padding:0.4rem'>Role</th><th style='text-align:left;padding:0.4rem'>Enabled</th><th style='text-align:left;padding:0.4rem'>Created</th><th style='padding:0.4rem'></th></tr>";
  for (const u of users) {
    tableHtml += `<tr>
      <td style="padding:0.4rem">${escapeHtml(u.username)}</td>
      <td style="padding:0.4rem">${escapeHtml(u.role)}</td>
      <td style="padding:0.4rem">${u.enabled !== false ? "Yes" : "No"}</td>
      <td style="padding:0.4rem">${u.createdAt ? formatDate(u.createdAt) : "-"}</td>
      <td style="padding:0.4rem">
        <button type="button" class="user-delete-btn" data-username="${escapeHtml(u.username)}" style="font-size:0.75rem;padding:0.3rem 0.6rem">Delete</button>
        <button type="button" class="user-toggle-btn" data-username="${escapeHtml(u.username)}" data-enabled="${u.enabled !== false}" style="font-size:0.75rem;padding:0.3rem 0.6rem">${u.enabled !== false ? "Disable" : "Enable"}</button>
      </td>
    </tr>`;
  }
  tableHtml += "</table>";
  listCard.innerHTML = tableHtml;
  els.detailBody.append(listCard);

  queueMicrotask(() => {
    for (const btn of listCard.querySelectorAll(".user-delete-btn")) {
      btn.addEventListener("click", async () => {
        const username = btn.dataset.username;
        if (!confirm("Delete user \"" + username + "\"?")) return;
        try {
          await fetchJson("/api/users/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-OpenClaw-Action": "user-delete" },
            body: JSON.stringify({ username })
          });
          showToast("User deleted");
          await renderUsersDetail();
        } catch (err) {
          showToast("Delete failed: " + err.message, "error");
        }
      });
    }
    for (const btn of listCard.querySelectorAll(".user-toggle-btn")) {
      btn.addEventListener("click", async () => {
        const username = btn.dataset.username;
        const isEnabled = btn.dataset.enabled === "true";
        try {
          await fetchJson("/api/users/update", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-OpenClaw-Action": "user-update" },
            body: JSON.stringify({ username, enabled: !isEnabled })
          });
          showToast(isEnabled ? "User disabled" : "User enabled");
          await renderUsersDetail();
        } catch (err) {
          showToast("Update failed: " + err.message, "error");
        }
      });
    }
  });

  const addCard = document.createElement("div");
  addCard.className = "inline-section";
  addCard.innerHTML = `
    <h3>Add User</h3>
    <div class="inline-form">
      <label><span>Username</span><input type="text" id="userAddUsername" placeholder="username"></label>
      <label><span>Password</span><input type="password" id="userAddPassword" placeholder="password"></label>
      <label><span>Role</span><select id="userAddRole"><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label>
    </div>
    <div style="margin-top:0.6rem"><button type="button" id="userAddBtn">Add user</button></div>
    <p id="userAddResult" class="muted" style="margin-top:0.4rem"></p>
  `;
  els.auxBody.append(addCard);

  queueMicrotask(() => {
    addCard.querySelector("#userAddBtn").addEventListener("click", async () => {
      const resultEl = addCard.querySelector("#userAddResult");
      const username = addCard.querySelector("#userAddUsername").value.trim();
      const password = addCard.querySelector("#userAddPassword").value;
      const role = addCard.querySelector("#userAddRole").value;
      if (!username || !password) {
        resultEl.textContent = "Username and password are required.";
        return;
      }
      try {
        await fetchJson("/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenClaw-Action": "user-add" },
          body: JSON.stringify({ username, password, role })
        });
        resultEl.textContent = "User \"" + username + "\" added.";
        addCard.querySelector("#userAddUsername").value = "";
        addCard.querySelector("#userAddPassword").value = "";
        await renderUsersDetail();
      } catch (err) {
        resultEl.textContent = "Error: " + err.message;
      }
    });
  });
}

async function renderCurrentDetail() {
  if (!state.overview) {
    renderHeader("Loading explorer data", "", []);
    updateActionState();
    setDetailLoading("Loading explorer data...");
    return;
  }

  if (state.mode === "dashboard") {
    renderDashboard();
    return;
  }
  if (state.mode === "live") {
    await renderLiveDetail();
    return;
  }
  if (state.mode === "threads") {
    await renderThreadDetail();
    return;
  }
  if (state.mode === "profiles") {
    renderProfileDetail();
    return;
  }
  if (state.mode === "machines") {
    renderMachinesDetail();
    return;
  }
  if (state.mode === "users") {
    await renderUsersDetail();
    return;
  }
  await renderSearchDetail();
}

async function renderApp() {
  renderModeButtons();
  renderArchiveStatus();
  renderSidebarList();
  await renderCurrentDetail();
}

async function saveAnnotation(bookmarkedOverride = null) {
  const context = getAnnotationContext();
  if (!context) {
    return;
  }
  const bookmarked = bookmarkedOverride === null ? context.bookmarked : bookmarkedOverride;
  await fetchJson("/api/annotations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OpenClaw-Action": "annotation-save"
    },
    body: JSON.stringify({
      bucket: context.bucket,
      key: context.key,
      bookmarked,
      note: els.noteInput.value
    })
  });
  await refreshData({ refreshSearch: state.mode === "search" });
}

async function downloadExport() {
  const context = getAnnotationContext();
  if (!context?.exportKind || !context?.exportId) {
    return;
  }
  const { blob, filename } = await fetchBlob(`/api/archive/export?kind=${encodeURIComponent(context.exportKind)}&id=${encodeURIComponent(context.exportId)}&format=${encodeURIComponent(els.exportFormat.value)}`);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || `openclaw-export.${els.exportFormat.value === "markdown" ? "md" : els.exportFormat.value}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function runArchiveNow() {
  els.archiveButton.disabled = true;
  try {
    await fetchJson("/api/archive/run", {
      method: "POST",
      headers: {
        "X-OpenClaw-Action": "archive-run"
      }
    });
    await refreshData({ refreshSearch: state.mode === "search" });
  } finally {
    els.archiveButton.disabled = false;
  }
}

async function pruneArchiveNow() {
  els.pruneButton.disabled = true;
  try {
    await fetchJson("/api/archive/prune", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenClaw-Action": "retention-prune"
      },
      body: JSON.stringify({
        keepLatest: Number(els.pruneKeepLatest.value || "3")
      })
    });
    await refreshData({ refreshSearch: state.mode === "search" });
  } finally {
    els.pruneButton.disabled = false;
  }
}

function showToast(message, type = "info", duration = 5000) {
  const container = document.querySelector("#toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast${type === "error" ? " toast-error" : ""}`;
  const text = document.createElement("span");
  text.textContent = message;
  toast.append(text);
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "toast-dismiss";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => toast.remove());
  toast.append(dismiss);
  container.append(toast);
  if (duration > 0) {
    setTimeout(() => toast.remove(), duration);
  }
}

function showFatalError(error) {
  const message = error instanceof Error ? error.message : String(error);
  showToast(message, "error", 8000);
}

for (const [mode, button] of Object.entries(els.modeButtons)) {
  button.addEventListener("click", () => {
    state.mode = mode;
    state.sidebarVisibleCount = SIDEBAR_PAGE_SIZE;
    persistMode();
    if (mode === "search") {
      runSearch().then(renderApp).catch(showFatalError);
      return;
    }
    renderApp().catch(showFatalError);
  });
}

els.refreshButton.addEventListener("click", () => {
  refreshData({ refreshSearch: state.mode === "search" }).catch(showFatalError);
});

els.searchButton.addEventListener("click", () => {
  state.mode = "search";
  persistMode();
  renderModeButtons();
  runSearch().then(renderApp).catch(showFatalError);
});

els.queryInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    if (state.mode === "search") {
      runSearch().then(renderApp).catch(showFatalError);
    } else {
      renderApp().catch(showFatalError);
    }
  }
});

const debouncedRenderApp = debounce(() => {
  if (state.mode !== "search") {
    renderApp().catch(showFatalError);
  }
}, 200);

for (const element of [els.agentFilter, els.chatTypeFilter, els.variantFilter, els.telegramIdFilter, els.dateFrom, els.dateTo, els.queryInput]) {
  element.addEventListener("input", debouncedRenderApp);
  element.addEventListener("change", () => {
    if (state.mode === "search") {
      return;
    }
    renderApp().catch(showFatalError);
  });
}

if (els.machineFilter) {
  els.machineFilter.addEventListener("change", () => {
    state.sidebarVisibleCount = SIDEBAR_PAGE_SIZE;
    state.detailCache.clear();
    refreshData({ refreshSearch: state.mode === "search" }).catch(showFatalError);
  });
}

els.autoRefreshSelect.value = String(state.autoRefreshMs);
els.autoRefreshSelect.addEventListener("change", () => {
  state.autoRefreshMs = Number(els.autoRefreshSelect.value || "0");
  persistAutoRefresh();
  scheduleAutoRefresh();
  renderListStats(getCurrentItems());
});

els.bookmarkButton.addEventListener("click", () => {
  const context = getAnnotationContext();
  if (!context) {
    return;
  }
  saveAnnotation(!context.bookmarked).catch(showFatalError);
});

els.saveNoteButton.addEventListener("click", () => {
  const context = getAnnotationContext();
  if (!context) {
    return;
  }
  saveAnnotation(context.bookmarked).catch(showFatalError);
});

els.exportButton.addEventListener("click", () => {
  downloadExport().catch(showFatalError);
});

els.archiveButton.addEventListener("click", () => {
  runArchiveNow().catch(showFatalError);
});

if (els.logoutButton) {
  els.logoutButton.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    location.href = "/login";
  });
}

els.pruneButton.addEventListener("click", () => {
  pruneArchiveNow().catch(showFatalError);
});

async function loadMachinesList() {
  try {
    state.machines = await fetchJson("/api/machines");
  } catch {
    state.machines = [{ id: "local", name: "Local", host: null, enabled: true }];
  }
}

async function populateMachineFilter() {
  if (!els.machineFilter) return;
  const prev = els.machineFilter.value;
  const options = [`<option value="">Local</option>`, `<option value="all">All machines</option>`];
  for (const m of state.machines) {
    if (m.id === "local") continue;
    options.push(`<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.id)}</option>`);
  }
  setHtml(els.machineFilter, options.join(""));
  if (prev && [...els.machineFilter.options].some((o) => o.value === prev)) {
    els.machineFilter.value = prev;
  }
}

async function boot() {
  try {
    const me = await fetchJson("/api/auth/me");
    state.currentUser = me.user;
  } catch {
    location.href = "/login";
    return;
  }

  if (els.currentUserLabel) {
    els.currentUserLabel.textContent = state.currentUser.username;
  }
  if (els.modeButtons.users && state.currentUser.role === "admin") {
    els.modeButtons.users.hidden = false;
  }

  restoreFromHash();
  await loadMachinesList();
  await populateMachineFilter();
  await loadOverview();
  if (state.mode === "search") {
    await runSearch();
  }
  scheduleAutoRefresh();
  await renderApp();
}

window.addEventListener("hashchange", () => {
  if (restoreFromHash()) {
    renderModeButtons();
    renderApp().catch(showFatalError);
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "k") {
    event.preventDefault();
    els.queryInput.focus();
    els.queryInput.select();
  }
});

boot().catch(showFatalError);
