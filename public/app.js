// public/app.js
//
// Talks to the REST API in server.js and drives an xterm.js terminal over
// the /ws/console WebSocket. No build step — plain browser JS.

const API = ""; // same origin
const OWNER_ID = "demo-user"; // stand-in until real auth exists

let currentAppId = null;
let currentDir = ".";
let currentFilePath = null;
let allApps = [];
let term = null;
let fitAddon = null;
let socket = null;
let statsTimer = null;
let uptimeTimer = null;
let startedAt = null;

const $ = (id) => document.getElementById(id);
const appsEl = $("apps");
const detailTitle = $("detailTitle");
const fileListEl = $("fileList");
const fileEditor = $("fileEditor");

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

let toastTimer = null;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

// Run a click handler and show any failure instead of swallowing it.
const safe = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { toast(err.message); }
};

function formatUptime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m ${s % 60}s`;
}

// ---------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------

function setView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === `view-${name}`));
  document.querySelectorAll(".rail-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.view === name));
  if (name === "console" && fitAddon) requestAnimationFrame(() => fitAddon.fit());
}

document.querySelectorAll(".rail-btn").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

function showAppPanels(hasApp) {
  $("consoleEmpty").hidden = hasApp;
  $("consoleBox").hidden = !hasApp;
  $("cmdForm").hidden = !hasApp;
  $("filesEmpty").hidden = hasApp;
  $("filesBox").hidden = !hasApp;
  $("settingsEmpty").hidden = hasApp;
  $("settingsBox").hidden = !hasApp;
}

// ---------------------------------------------------------------------
// App list
// ---------------------------------------------------------------------

function renderApps() {
  const q = $("search").value.trim().toLowerCase();
  const apps = allApps.filter((a) => !q || a.appId.toLowerCase().includes(q) || a.status.includes(q));
  appsEl.innerHTML = "";

  if (!apps.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = allApps.length ? "No apps match your search." : "No apps yet. Tap + to create your first one.";
    appsEl.appendChild(empty);
    return;
  }

  apps.forEach((a) => {
    const row = document.createElement("div");
    row.className = "app-row" + (a.appId === currentAppId ? " is-current" : "");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.innerHTML = `<span class="dot ${a.status === "running" ? "on" : ""}"></span>
      <span class="name">${a.appId.slice(0, 8)}</span>
      <span class="state">${a.status}</span>`;
    const open = safe(() => openApp(a.appId));
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    appsEl.appendChild(row);
  });
}

async function refreshApps() {
  allApps = await api(`/api/apps?ownerId=${OWNER_ID}`);
  renderApps();
}

$("search").addEventListener("input", renderApps);

$("createBtn").addEventListener("click", safe(async () => {
  await api("/api/apps", { method: "POST", body: JSON.stringify({ ownerId: OWNER_ID }) });
  await refreshApps();
  setView("apps");
}));

// ---------------------------------------------------------------------
// Start / Restart / Stop / Delete
// ---------------------------------------------------------------------

document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.addEventListener("click", safe(() => appAction(btn.dataset.action)));
});

async function appAction(action) {
  if (!currentAppId) return;

  if (action === "delete") {
    if (!confirm("Delete this app and its container? Files are kept on disk.")) return;
    await api(`/api/apps/${currentAppId}`, { method: "DELETE" });
    closeApp();
    await refreshApps();
    return setView("apps");
  }

  await api(`/api/apps/${currentAppId}/${action}`, { method: "POST" });
  await refreshApps();
  await pollStats();
  // A restarted or newly started container needs a fresh shell.
  if (action === "start" || action === "restart") connectTerminal(currentAppId);
}

function closeApp() {
  currentAppId = null;
  if (socket) socket.close();
  socket = null;
  clearInterval(statsTimer);
  clearInterval(uptimeTimer);
  startedAt = null;
  detailTitle.textContent = "Console";
  showAppPanels(false);
  renderStats(null);
}

async function openApp(appId) {
  currentAppId = appId;
  currentDir = ".";
  currentFilePath = null;
  fileEditor.value = "";
  detailTitle.textContent = `app-${appId.slice(0, 8)}`;
  showAppPanels(true);
  renderApps();
  setView("console");

  loadFileList(".").catch((err) => toast(err.message));

  clearInterval(statsTimer);
  statsTimer = setInterval(pollStats, 3000);
  clearInterval(uptimeTimer);
  uptimeTimer = setInterval(tickUptime, 1000);
  pollStats();

  connectTerminal(appId);
}

// ---------------------------------------------------------------------
// Footer stats: uptime / RAM / CPU
// ---------------------------------------------------------------------

function renderStats(s) {
  if (!s || !s.running) {
    startedAt = null;
    $("statUptime").textContent = s ? "Stopped" : "–";
    $("statMem").textContent = "–";
    $("statCpu").textContent = "–";
    return;
  }
  startedAt = s.startedAt ? new Date(s.startedAt).getTime() : null;
  $("statMem").textContent = `${s.memUsageMb.toFixed(1)}mb`;
  $("statCpu").textContent = `${s.cpuPercent}%`;
  tickUptime();
}

function tickUptime() {
  if (startedAt) $("statUptime").textContent = formatUptime((Date.now() - startedAt) / 1000);
}

async function pollStats() {
  if (!currentAppId) return;
  try {
    renderStats(await api(`/api/apps/${currentAppId}/stats`));
  } catch {
    renderStats(null);
  }
}

// ---------------------------------------------------------------------
// File manager
// ---------------------------------------------------------------------

const join = (dir, name) => (dir === "." ? name : `${dir}/${name}`);

async function loadFileList(relPath) {
  const entries = await api(`/api/apps/${currentAppId}/files?path=${encodeURIComponent(relPath)}`);
  currentDir = relPath;
  $("crumb").textContent = relPath === "." ? "/app" : `/app/${relPath}`;
  fileListEl.innerHTML = "";

  if (relPath !== ".") {
    const up = document.createElement("div");
    up.className = "dir";
    up.textContent = "../";
    up.tabIndex = 0;
    up.addEventListener("click", safe(() => {
      const parent = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : ".";
      return loadFileList(parent);
    }));
    fileListEl.appendChild(up);
  }

  if (!entries.length && relPath === ".") {
    const empty = document.createElement("div");
    empty.textContent = "No files yet. Create some from the console.";
    fileListEl.appendChild(empty);
  }

  entries.forEach((e) => {
    const div = document.createElement("div");
    div.tabIndex = 0;
    div.className = e.isDirectory ? "dir" : "";
    div.textContent = e.isDirectory ? `${e.name}/` : e.name;
    const go = safe(() => (e.isDirectory ? loadFileList(join(relPath, e.name)) : openFile(join(relPath, e.name))));
    div.addEventListener("click", go);
    div.addEventListener("keydown", (ev) => { if (ev.key === "Enter") go(); });
    fileListEl.appendChild(div);
  });
}

async function openFile(relPath) {
  const { content } = await api(`/api/apps/${currentAppId}/file?path=${encodeURIComponent(relPath)}`);
  currentFilePath = relPath;
  fileEditor.value = content;
}

$("saveFileBtn").addEventListener("click", safe(async () => {
  if (!currentFilePath) return toast("Open a file first.");
  await api(`/api/apps/${currentAppId}/file`, {
    method: "PUT",
    body: JSON.stringify({ path: currentFilePath, content: fileEditor.value }),
  });
  toast(`Saved ${currentFilePath}`);
}));

// Upload files (or a .zip that is unpacked into the current folder)
$("uploadBtn").addEventListener("click", () => $("uploadInput").click());

$("uploadInput").addEventListener("change", safe(async (e) => {
  const picked = [...e.target.files];
  e.target.value = "";
  let saved = 0, extracted = 0;
  for (const file of picked) {
    const isZip = file.name.toLowerCase().endsWith(".zip");
    const q = isZip
      ? `extract=1&dir=${encodeURIComponent(currentDir)}`
      : `path=${encodeURIComponent(join(currentDir, file.name))}`;
    toast(`Uploading ${file.name}...`);
    const res = await fetch(`/api/apps/${currentAppId}/upload?${q}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${file.name}: ${body.error || res.statusText}`);
    if (isZip) extracted += body.extracted || 0; else saved++;
  }
  await loadFileList(currentDir);
  toast([saved && `${saved} file(s) uploaded`, extracted && `${extracted} file(s) unpacked from zip`].filter(Boolean).join(", "));
}));

$("newFileBtn").addEventListener("click", safe(async () => {
  const name = prompt("New file name (for example index.js):");
  if (!name) return;
  const rel = join(currentDir, name.trim());
  await api(`/api/apps/${currentAppId}/file`, { method: "PUT", body: JSON.stringify({ path: rel, content: "" }) });
  await loadFileList(currentDir);
  await openFile(rel);
}));

$("newFolderBtn").addEventListener("click", safe(async () => {
  const name = prompt("New folder name:");
  if (!name) return;
  await api(`/api/apps/${currentAppId}/mkdir`, { method: "POST", body: JSON.stringify({ path: join(currentDir, name.trim()) }) });
  await loadFileList(currentDir);
}));

$("deleteFileBtn").addEventListener("click", safe(async () => {
  if (!currentFilePath) return toast("Open a file first, then tap Delete.");
  if (!confirm(`Delete ${currentFilePath}?`)) return;
  await api(`/api/apps/${currentAppId}/file?path=${encodeURIComponent(currentFilePath)}`, { method: "DELETE" });
  currentFilePath = null;
  fileEditor.value = "";
  await loadFileList(currentDir);
}));

// ---------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------

function connectTerminal(appId) {
  if (typeof Terminal === "undefined") {
    return toast("Terminal library failed to load. Check your internet connection and reload.");
  }
  if (socket) socket.close();
  const termEl = $("term");
  termEl.innerHTML = "";

  term = new Terminal({
    convertEol: true,
    fontSize: 13,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    allowTransparency: true,
    theme: { background: "rgba(0,0,0,0)", foreground: "#2cf07f", cursor: "#2cf07f", selectionBackground: "rgba(44,240,127,0.3)" },
  });
  fitAddon = window.FitAddon ? new FitAddon.FitAddon() : null;
  if (fitAddon) term.loadAddon(fitAddon);
  term.open(termEl);
  if (fitAddon) requestAnimationFrame(() => fitAddon.fit());

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/console?appId=${appId}`);
  socket = ws;

  ws.addEventListener("message", async (ev) => {
    const text = typeof ev.data === "string" ? ev.data : await ev.data.text();
    term.write(text);
  });
  ws.addEventListener("close", () => {
    if (socket === ws) term.write("\r\n[connection closed. Press Start or Restart to reconnect]\r\n");
  });

  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

window.addEventListener("resize", () => { if (fitAddon) fitAddon.fit(); });

// Command bar: easier than the raw terminal on a phone keyboard.
$("cmdForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("cmd");
  if (!socket || socket.readyState !== WebSocket.OPEN) return toast("Console is not connected. Start the app first.");
  socket.send(input.value + "\r");
  input.value = "";
});

showAppPanels(false);
refreshApps().catch((err) => toast(err.message));
