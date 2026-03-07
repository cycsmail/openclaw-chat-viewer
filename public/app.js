const state = {
  sessions: [],
  filteredSessions: [],
  selectedId: null
};

const els = {
  searchInput: document.querySelector("#searchInput"),
  agentFilter: document.querySelector("#agentFilter"),
  variantFilter: document.querySelector("#variantFilter"),
  chatTypeFilter: document.querySelector("#chatTypeFilter"),
  telegramIdFilter: document.querySelector("#telegramIdFilter"),
  refreshButton: document.querySelector("#refreshButton"),
  sessionStats: document.querySelector("#sessionStats"),
  sessionList: document.querySelector("#sessionList"),
  sessionHeader: document.querySelector("#sessionHeader"),
  transcript: document.querySelector("#transcript"),
  sessionCardTemplate: document.querySelector("#sessionCardTemplate"),
  messageTemplate: document.querySelector("#messageTemplate")
};

function clearNode(node) {
  node.replaceChildren();
}

function showError(message) {
  setPlaceholder(els.sessionHeader, message);
  setPlaceholder(els.transcript, message);
}

function setPlaceholder(node, message) {
  clearNode(node);
  const element = document.createElement("p");
  element.className = "placeholder";
  element.textContent = message;
  node.append(element);
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
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

function formatDate(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      sections.push({
        kind: "text",
        text: leading
      });
    }
    sections.push({
      kind: "meta",
      label,
      json
    });
    lastIndex = match.index + fullMatch.length;
  }

  const trailing = value.slice(lastIndex).trim();
  if (trailing) {
    sections.push({
      kind: sections.length ? "text" : "plain",
      text: trailing
    });
  }

  if (!sections.length) {
    return [{ kind: "plain", text: value }];
  }

  return sections;
}

function renderMessageBody(container, text) {
  clearNode(container);
  const sections = parseStructuredMessage(text);

  for (const section of sections) {
    if (section.kind === "meta") {
      const card = document.createElement("section");
      card.className = "message-metadata";

      const title = document.createElement("div");
      title.className = "message-metadata-title";
      title.textContent = section.label;

      const code = document.createElement("pre");
      code.className = "message-metadata-body";
      code.textContent = section.json;

      card.append(title, code);
      container.append(card);
      continue;
    }

    const block = document.createElement("pre");
    block.className = section.kind === "plain" ? "message-body-text" : "message-body-text message-body-text-emphasis";
    block.textContent = section.text;
    container.append(block);
  }
}

function buildAgentFilter() {
  const agents = [...new Set(state.sessions.map((session) => session.agentId))];
  els.agentFilter.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All agents";
  els.agentFilter.append(all);
  for (const agentId of agents) {
    const option = document.createElement("option");
    option.value = agentId;
    option.textContent = agentId;
    els.agentFilter.append(option);
  }
}

function buildTelegramIdFilter() {
  const telegramIds = [...new Set(state.sessions.map((session) => session.telegramId).filter(Boolean))];
  const currentValue = els.telegramIdFilter.value;
  els.telegramIdFilter.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All Telegram ids";
  els.telegramIdFilter.append(all);
  for (const telegramId of telegramIds) {
    const option = document.createElement("option");
    option.value = telegramId;
    option.textContent = telegramId;
    els.telegramIdFilter.append(option);
  }
  els.telegramIdFilter.value = telegramIds.includes(currentValue) ? currentValue : "all";
}

function applyFilters() {
  const query = els.searchInput.value.trim().toLowerCase();
  const agent = els.agentFilter.value || "all";
  const variant = els.variantFilter.value || "all";
  const chatType = els.chatTypeFilter.value || "all";
  const telegramId = els.telegramIdFilter.value || "all";

  state.filteredSessions = state.sessions.filter((session) => {
    if (agent !== "all" && session.agentId !== agent) return false;
    if (variant !== "all" && session.variant !== variant) return false;
    if (chatType !== "all" && session.chatType !== chatType) return false;
    if (telegramId !== "all" && session.telegramId !== telegramId) return false;
    if (!query) return true;
    const haystack = [
      session.agentId,
      session.sessionId,
      session.sessionKey,
      session.originLabel,
      session.channel,
      session.telegramId,
      session.chatType,
      session.lastSnippet,
      session.filename
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  if (!state.filteredSessions.some((session) => session.id === state.selectedId)) {
    state.selectedId = state.filteredSessions[0]?.id || null;
  }
}

function renderStats() {
  const activeCount = state.sessions.filter((session) => session.active).length;
  const html = [
    `<div class="stat"><strong>${state.filteredSessions.length}</strong><span>shown</span></div>`,
    `<div class="stat"><strong>${state.sessions.length}</strong><span>files</span></div>`,
    `<div class="stat"><strong>${activeCount}</strong><span>active</span></div>`
  ].join("");
  els.sessionStats.innerHTML = html;
}

function renderSessionList() {
  clearNode(els.sessionList);
  for (const session of state.filteredSessions) {
    const node = els.sessionCardTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = session.id;
    if (session.id === state.selectedId) {
      node.classList.add("selected");
    }
    node.querySelector(".agent-pill").textContent = session.agentId;
    node.querySelector(".variant-pill").textContent = session.variant;
    node.querySelector(".session-key").textContent = session.sessionKey || `${session.sessionId} · ${session.filename}`;
    node.querySelector(".session-meta").textContent =
      `${session.channel || "unknown channel"}${session.telegramId ? `:${session.telegramId}` : ""} · ${session.chatType || "unknown chat"} · ${formatDate(session.updatedAt)}`;
    node.querySelector(".session-snippet").textContent = session.lastSnippet || "No preview";
    node.addEventListener("click", () => {
      state.selectedId = session.id;
      renderSessionList();
      loadTranscript();
    });
    els.sessionList.append(node);
  }
  if (!state.filteredSessions.length) {
    setPlaceholder(els.sessionList, "No sessions match the current filters.");
  }
}

function renderHeader(session) {
  if (!session) {
    setPlaceholder(els.sessionHeader, "Select a session file to inspect its transcript.");
    return;
  }

  clearNode(els.sessionHeader);

  const top = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = `${session.agentId} · ${session.variant}`;
  const title = document.createElement("h2");
  title.textContent = session.sessionKey || session.sessionId;
  const subtitle = document.createElement("p");
  subtitle.className = "muted";
  subtitle.textContent = session.originLabel || session.deliveryTo || session.filename;
  top.append(eyebrow, title, subtitle);

  const detailGrid = document.createElement("div");
  detailGrid.className = "session-detail-grid";
  const details = [
    ["Updated", formatDate(session.updatedAt)],
    ["Started", formatDate(session.startedAt)],
    ["Messages", String(session.messageCount)],
    ["Events", String(session.eventCount)],
    ["Size", formatBytes(session.sizeBytes)],
    ["Telegram id", session.telegramId || "-"],
    ["File", session.filename]
  ];

  for (const [label, value] of details) {
    const cell = document.createElement("div");
    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    const valueNode = document.createElement("strong");
    valueNode.textContent = value;
    cell.append(labelNode, valueNode);
    detailGrid.append(cell);
  }

  els.sessionHeader.append(top, detailGrid);
}

function renderTranscript(transcript) {
  clearNode(els.transcript);
  if (!transcript.length) {
    setPlaceholder(els.transcript, "Transcript file is empty.");
    return;
  }

  for (const item of transcript) {
    const node = els.messageTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(`role-${String(item.role).replace(/[^a-z0-9_-]/gi, "").toLowerCase()}`);
    node.querySelector(".role-pill").textContent = item.role || item.entryType;
    node.querySelector(".timestamp").textContent = formatDate(item.timestamp);
    renderMessageBody(node.querySelector(".message-body"), item.summary || JSON.stringify(item.raw, null, 2));
    els.transcript.append(node);
  }
}

async function loadSessions() {
  els.refreshButton.disabled = true;
  try {
    const payload = await fetchJson("/api/sessions");
    state.sessions = payload.sessions || [];
    buildAgentFilter();
    buildTelegramIdFilter();
    applyFilters();
    renderStats();
    renderSessionList();
    renderHeader(state.filteredSessions.find((session) => session.id === state.selectedId) || null);
    if (state.selectedId) {
      await loadTranscript();
    } else {
      renderTranscript([]);
    }
  } finally {
    els.refreshButton.disabled = false;
  }
}

async function loadTranscript() {
  const session = state.filteredSessions.find((item) => item.id === state.selectedId);
  renderHeader(session || null);
  if (!session) {
    renderTranscript([]);
    return;
  }
  setPlaceholder(els.transcript, "Loading transcript...");
  const params = new URLSearchParams({
    agentId: session.agentId,
    filename: session.filename
  });
  const payload = await fetchJson(`/api/transcript?${params.toString()}`);
  renderTranscript(payload.transcript || []);
}

for (const element of [els.searchInput, els.agentFilter, els.variantFilter, els.chatTypeFilter, els.telegramIdFilter]) {
  element.addEventListener("input", () => {
    applyFilters();
    renderStats();
    renderSessionList();
    renderHeader(state.filteredSessions.find((session) => session.id === state.selectedId) || null);
  });
  element.addEventListener("change", () => {
    applyFilters();
    renderStats();
    renderSessionList();
    renderHeader(state.filteredSessions.find((session) => session.id === state.selectedId) || null);
  });
}

els.refreshButton.addEventListener("click", () => {
  loadSessions().catch((error) => {
    showError(error.message);
  });
});

loadSessions().catch((error) => {
  showError(error.message);
});
