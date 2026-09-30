// server.js
//
// Entry point. Wires up:
//   - REST API for creating/listing/starting/stopping/deleting apps
//   - REST API for a basic file manager scoped to each app
//   - A WebSocket endpoint that bridges a browser terminal (xterm.js) to
//     a live `docker exec` shell inside the app's container
//
// This is a starter, not a production panel: there is NO AUTH here yet
// (see the "Adding auth" section in README.md). Do not expose this
// publicly as-is — anyone who can reach it can create/delete containers
// and read/write any app's files.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const docker = require("./lib/runtime");
const files = require("./lib/files");

const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
// ---------------------------------------------------------------------
// Password protection. Anyone who gets in can run code on this machine,
// so the panel refuses to start in "process" mode without a password.
// ---------------------------------------------------------------------
const PANEL_PASSWORD = process.env.PANEL_PASSWORD;
// Use the runtime that was actually selected (it may have fallen back to
// "process" automatically when Docker isn't available on this host).
if (docker.MODE === "process" && !PANEL_PASSWORD) {
  console.error(
    "Docker is not available, so the panel is running in process mode.\n" +
      "Set PANEL_PASSWORD in your environment variables, then redeploy. Refusing to start."
  );
  process.exit(1);
}

function passwordOk(header) {
  if (!PANEL_PASSWORD) return true;
  if (!header || !header.startsWith("Basic ")) return false;
  const given = Buffer.from(header.slice(6), "base64").toString().split(":").slice(1).join(":");
  const a = Buffer.from(given), b = Buffer.from(PANEL_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Short-lived token for the console WebSocket. Mobile browsers (iOS Safari,
// Chrome) often do NOT send the saved password on WebSocket connections,
// which caused "Unauthorized" in the console. The page fetches a token over
// normal (authenticated) HTTP and passes it in the WebSocket URL instead.
const TOKEN_SECRET = crypto.randomBytes(32);
function makeWsToken() {
  const exp = String(Date.now() + 60 * 1000);
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(exp).digest("hex");
  return `${exp}.${sig}`;
}
function wsTokenOk(token) {
  if (!token) return false;
  const [exp, sig] = String(token).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = crypto.createHmac("sha256", TOKEN_SECRET).update(exp).digest("hex");
  const a = Buffer.from(sig), b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use((req, res, next) => {
  if (passwordOk(req.headers.authorization)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Node Panel"').status(401).send("Password required");
});

app.use(express.static("public"));
// Terminal library served from our own server (no dependency on a CDN).
const path = require("path");
app.use("/vendor/xterm", express.static(path.join(__dirname, "node_modules", "xterm")));
app.use("/vendor/xterm-addon-fit", express.static(path.join(__dirname, "node_modules", "xterm-addon-fit")));

// Only accept real app ids (UUIDs) in /api/apps/:id/... routes. Without this,
// an id like "..%2F.." could point the file manager outside the data folder.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.param("id", (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid app id" });
  next();
});

app.get("/api/ws-token", (req, res) => res.json({ token: makeWsToken() }));

const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------

// Create a new app (container). Body: { ownerId, memoryMb?, cpus? }
app.post("/api/apps", async (req, res) => {
  try {
    const { ownerId = "demo-user", memoryMb, cpus } = req.body || {};
    const appId = crypto.randomUUID();
    await docker.createApp({ appId, ownerId, memoryMb, cpus });
    res.json({ appId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// List apps, optionally filtered by ?ownerId=
app.get("/api/apps", async (req, res) => {
  try {
    const apps = await docker.listApps(req.query.ownerId);
    res.json(apps);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Live stats for one app (CPU %, memory) — only meaningful if running.
app.get("/api/apps/:id/stats", async (req, res) => {
  try {
    const stats = await docker.getStats(req.params.id);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/apps/:id/start", async (req, res) => {
  try {
    await docker.startApp(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/apps/:id/stop", async (req, res) => {
  try {
    await docker.stopApp(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/apps/:id/restart", async (req, res) => {
  try {
    await docker.restartApp(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete an app. ?deleteData=true also wipes its files on disk.
app.delete("/api/apps/:id", async (req, res) => {
  try {
    const deleteData = req.query.deleteData === "true";
    await docker.removeApp(req.params.id, { deleteData });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// File manager
// ---------------------------------------------------------------------

app.get("/api/apps/:id/files", (req, res) => {
  try {
    const relPath = req.query.path || ".";
    res.json(files.listDir(req.params.id, relPath));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/apps/:id/file", (req, res) => {
  try {
    const relPath = req.query.path;
    if (!relPath) return res.status(400).json({ error: "path is required" });
    res.json({ content: files.readFile(req.params.id, relPath) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/apps/:id/file", (req, res) => {
  try {
    const { path: relPath, content } = req.body || {};
    if (!relPath) return res.status(400).json({ error: "path is required" });
    files.writeFile(req.params.id, relPath, content ?? "");
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Upload one file as the raw request body. A .zip with ?extract=1 is unpacked
// into ?dir= (the current folder) instead of being saved.
app.put("/api/apps/:id/upload", express.raw({ type: "*/*", limit: "100mb" }), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "The file is empty" });
    if (req.query.extract === "1") {
      const extracted = files.extractZip(req.params.id, req.query.dir || ".", req.body);
      return res.json({ ok: true, extracted });
    }
    if (!req.query.path) return res.status(400).json({ error: "path is required" });
    files.writeBuffer(req.params.id, req.query.path, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/apps/:id/mkdir", (req, res) => {
  try {
    const relPath = (req.body || {}).path;
    if (!relPath) return res.status(400).json({ error: "path is required" });
    files.makeDir(req.params.id, relPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/apps/:id/file", (req, res) => {
  try {
    const relPath = req.query.path;
    if (!relPath) return res.status(400).json({ error: "path is required" });
    files.deletePath(req.params.id, relPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// WebSocket terminal bridge:  browser <-> ws <-> docker exec shell
// ---------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/console" });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  if (!passwordOk(req.headers.authorization) && !wsTokenOk(url.searchParams.get("token"))) {
    ws.send("Unauthorized\r\n");
    return ws.close();
  }
  const appId = url.searchParams.get("appId");

  if (!appId) {
    ws.send("No appId provided\r\n");
    return ws.close();
  }

  let dockerStream;
  try {
    const { stream } = await docker.attachShell(appId);
    dockerStream = stream;
  } catch (err) {
    ws.send(`Failed to attach: ${err.message}\r\n`);
    return ws.close();
  }

  // Container -> browser
  dockerStream.on("data", (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  dockerStream.on("end", () => ws.close());

  // Browser -> container
  ws.on("message", (msg) => {
    dockerStream.write(msg);
  });

  ws.on("close", () => {
    dockerStream.end();
  });
});

server.listen(PORT, () => {
  console.log(`Panel API + terminal listening on http://localhost:${PORT}`);
});
