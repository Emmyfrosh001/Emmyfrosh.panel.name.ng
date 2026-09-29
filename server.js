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

const docker = require("./lib/docker");
const files = require("./lib/files");

const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(express.static("public"));

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
