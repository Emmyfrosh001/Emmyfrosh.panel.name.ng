// lib/process.js
//
// Same interface as lib/docker.js, but every app is a plain child process
// instead of a container. This is what lets the panel run on hosts without
// Docker (Render, Railway, ...).
//
// SECURITY: apps share the machine, the network and the disk with the panel.
// The child environment is stripped so the panel password is not exposed,
// but this is NOT isolation. Only let people you trust deploy here.

const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { EventEmitter } = require("events");

const DATA_ROOT = path.resolve(process.env.DATA_ROOT || path.join(__dirname, "..", "data"));
const META_FILE = path.join(DATA_ROOT, "apps.json");
const MAX_LOG = 200 * 1024;

fs.mkdirSync(DATA_ROOT, { recursive: true });

const hostDirFor = (appId) => path.join(DATA_ROOT, appId);

// ---------------- metadata (which apps exist) ----------------
function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, "utf8")); } catch { return {}; }
}
function saveMeta(meta) { fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2)); }
function requireApp(appId) {
  const meta = loadMeta();
  if (!meta[appId]) throw new Error("App not found");
  return meta;
}

// ---------------- live state (in memory) ----------------
const live = new Map(); // appId -> { proc, startedAt, log, bus }
function state(appId) {
  if (!live.has(appId)) live.set(appId, { proc: null, startedAt: null, log: "", bus: new EventEmitter() });
  return live.get(appId);
}
function emitLog(appId, text) {
  const s = state(appId);
  s.log = (s.log + text).slice(-MAX_LOG);
  s.bus.emit("data", text);
}

// Environment given to user code: nothing from the panel's own env.
function cleanEnv(appId, memoryMb, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: hostDirFor(appId),
    TERM: "dumb",
    NODE_ENV: "production",
    NODE_OPTIONS: `--max-old-space-size=${memoryMb || 256}`,
    ...extra,
  };
}

function startCommand(dir) {
  if (fs.existsSync(path.join(dir, "package.json"))) {
    return "(test -d node_modules || npm install --no-audit --no-fund) && npm start";
  }
  for (const f of ["index.js", "main.js", "app.js", "server.js"]) {
    if (fs.existsSync(path.join(dir, f))) return `node ${f}`;
  }
  return null;
}

// ---------------- lifecycle ----------------
async function createApp({ appId, ownerId, memoryMb = 256 }) {
  fs.mkdirSync(hostDirFor(appId), { recursive: true });
  const meta = loadMeta();
  meta[appId] = { ownerId, memoryMb, createdAt: Math.floor(Date.now() / 1000), autostart: false };
  saveMeta(meta);
}

async function startApp(appId) {
  const meta = requireApp(appId);
  const s = state(appId);
  if (s.proc) return;

  const dir = hostDirFor(appId);
  const cmd = startCommand(dir);
  if (!cmd) {
    emitLog(appId, "Nothing to start. Add a package.json (with a start script) or an index.js in Files.\n");
    throw new Error("No package.json or index.js found");
  }

  emitLog(appId, `\n$ ${cmd}\n`);
  const proc = spawn("sh", ["-c", cmd], {
    cwd: dir,
    env: cleanEnv(appId, meta[appId].memoryMb, { PORT: "3000" }),
    detached: true, // own process group so Stop can kill npm and its children
  });
  s.proc = proc;
  s.startedAt = Date.now();

  proc.stdout.on("data", (d) => emitLog(appId, d.toString()));
  proc.stderr.on("data", (d) => emitLog(appId, d.toString()));
  proc.on("error", (e) => emitLog(appId, `Failed to start: ${e.message}\n`));
  proc.on("exit", (code, signal) => {
    emitLog(appId, `\n[process exited: ${signal || "code " + code}]\n`);
    if (s.proc === proc) { s.proc = null; s.startedAt = null; }
  });

  meta[appId].autostart = true;
  saveMeta(meta);
}

function killGroup(proc) {
  return new Promise((resolve) => {
    if (!proc) return resolve();
    proc.once("exit", () => resolve());
    try { process.kill(-proc.pid, "SIGTERM"); } catch { return resolve(); }
    setTimeout(() => { try { process.kill(-proc.pid, "SIGKILL"); } catch {} }, 5000);
  });
}

async function stopApp(appId) {
  const meta = requireApp(appId);
  meta[appId].autostart = false;
  saveMeta(meta);
  await killGroup(state(appId).proc);
}

async function restartApp(appId) {
  const meta = requireApp(appId);
  await killGroup(state(appId).proc);
  await startApp(appId);
  return meta;
}

async function removeApp(appId, { deleteData = false } = {}) {
  await killGroup(state(appId).proc);
  live.delete(appId);
  const meta = loadMeta();
  delete meta[appId];
  saveMeta(meta);
  if (deleteData) fs.rmSync(hostDirFor(appId), { recursive: true, force: true });
}

async function listApps(ownerId) {
  const meta = loadMeta();
  return Object.entries(meta)
    .filter(([, m]) => !ownerId || m.ownerId === ownerId)
    .map(([appId, m]) => ({
      appId,
      ownerId: m.ownerId,
      status: state(appId).proc ? "running" : "exited",
      createdAt: m.createdAt,
      ports: [],
    }));
}

// ---------------- stats ----------------
function psTable() {
  return new Promise((resolve) => {
    execFile("ps", ["-e", "-o", "pid=,ppid=,rss=,pcpu="], (err, out) => {
      if (err) return resolve([]);
      resolve(out.trim().split("\n").map((l) => {
        const [pid, ppid, rss, pcpu] = l.trim().split(/\s+/).map(Number);
        return { pid, ppid, rss, pcpu };
      }));
    });
  });
}

async function getStats(appId) {
  const meta = requireApp(appId);
  const s = state(appId);
  const limit = meta[appId].memoryMb || 256;
  if (!s.proc) return { running: false, startedAt: null, cpuPercent: 0, memUsageMb: 0, memLimitMb: limit };

  // Sum the app's whole process tree.
  const rows = await psTable();
  const ids = new Set([s.proc.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (ids.has(r.ppid) && !ids.has(r.pid)) { ids.add(r.pid); grew = true; }
  }
  const tree = rows.filter((r) => ids.has(r.pid));
  const rssKb = tree.reduce((a, r) => a + (r.rss || 0), 0);
  const cpu = tree.reduce((a, r) => a + (r.pcpu || 0), 0);

  return {
    running: true,
    startedAt: new Date(s.startedAt).toISOString(),
    cpuPercent: Number(cpu.toFixed(1)),
    memUsageMb: Number((rssKb / 1024).toFixed(2)),
    memLimitMb: limit,
  };
}

// ---------------- console ----------------
// Duck-types the stream server.js expects (on/write/end). Shows the app's
// output and gives a simple shell. There is no real terminal here, so this
// class does its own line editing and echo.
class ShellStream extends EventEmitter {
  constructor(appId) {
    super();
    this.appId = appId;
    this.line = "";
    this.closed = false;

    const s = state(appId);
    this.onLog = (t) => this.emit("data", Buffer.from(t));
    s.bus.on("data", this.onLog);

    setImmediate(() => {
      this.emit("data", Buffer.from(s.log || "Console ready. Press Start to run your app.\n"));
      this.spawnShell();
    });
  }

  spawnShell() {
    const meta = loadMeta()[this.appId];
    this.sh = spawn("sh", [], {
      cwd: hostDirFor(this.appId),
      env: cleanEnv(this.appId, meta && meta.memoryMb),
      detached: true,
    });
    const out = (d) => this.emit("data", d);
    this.sh.stdout.on("data", out);
    this.sh.stderr.on("data", out);
    this.sh.on("exit", () => { if (!this.closed) this.emit("data", Buffer.from("\n[shell restarted]\n$ ")); this.sh = null; if (!this.closed) this.spawnShell(); });
    this.emit("data", Buffer.from("\n$ "));
  }

  write(input) {
    for (const ch of input.toString()) {
      if (ch === "\r" || ch === "\n") {
        const cmd = this.line;
        this.line = "";
        this.emit("data", Buffer.from("\r\n"));
        // The printf redraws the prompt once the command has finished.
        if (this.sh) this.sh.stdin.write(`${cmd}\nprintf '\\n$ '\n`);
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line) { this.line = this.line.slice(0, -1); this.emit("data", Buffer.from("\b \b")); }
      } else if (ch === "\x03") {
        this.line = "";
        this.emit("data", Buffer.from("^C\r\n"));
        if (this.sh) try { process.kill(-this.sh.pid, "SIGKILL"); } catch {}
      } else if (ch >= " ") {
        this.line += ch;
        this.emit("data", Buffer.from(ch));
      }
    }
  }

  end() {
    this.closed = true;
    state(this.appId).bus.off("data", this.onLog);
    if (this.sh) try { process.kill(-this.sh.pid, "SIGKILL"); } catch {}
  }
}

async function attachShell(appId) {
  requireApp(appId);
  return { stream: new ShellStream(appId) };
}

// Bring back apps that were running before the panel restarted.
setImmediate(() => {
  const meta = loadMeta();
  for (const [appId, m] of Object.entries(meta)) {
    if (m.autostart) startApp(appId).catch((e) => console.error(`autostart ${appId}:`, e.message));
  }
});

module.exports = { DATA_ROOT, hostDirFor, createApp, startApp, stopApp, restartApp, removeApp, listApps, getStats, attachShell };
