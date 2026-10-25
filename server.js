// server.js - landing page, accounts, per-user bots, file manager, console
require("dotenv").config();
const express = require("express"), morgan = require("morgan"), http = require("http");
const crypto = require("crypto"), path = require("path");
const { WebSocketServer } = require("ws");
const docker = require("./lib/runtime"), files = require("./lib/files");
const auth = require("./lib/auth")(docker.DATA_ROOT || path.join(__dirname, "data"));

const PORT = process.env.PORT || 4000;
const MAX_BOTS = +process.env.MAX_BOTS_PER_USER || 1; // free hosts: keep this low
const pub = (f = "") => path.join(__dirname, "public", f);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const app = express();
app.set("trust proxy", 1);
app.use(morgan("dev"));
const json = express.json();
app.use((req, res, next) => (req.path.endsWith("/upload") ? next() : json(req, res, next)));

app.get("/healthz", (req, res) => res.type("text").send("ok"));
app.use("/auth", auth.router);
app.get("/", (req, res) => res.sendFile(pub(auth.user(req) ? "index.html" : "landing.html")));
app.get("/login", (req, res) => (auth.user(req) ? res.redirect("/") : res.sendFile(pub("login.html"))));
app.use("/vendor/xterm", express.static(path.join(__dirname, "node_modules", "xterm")));
app.use("/vendor/xterm-addon-fit", express.static(path.join(__dirname, "node_modules", "xterm-addon-fit")));
app.use(express.static(pub(), { index: false }));
app.use("/api", auth.require); // everything under /api needs a logged-in user

// A user can only touch their own apps.
app.param("id", async (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid app id" });
  try {
    if (!(await docker.listApps(req.user)).some((a) => a.appId === id)) return res.status(404).json({ error: "App not found" });
    next();
  } catch (e) { next(e); }
});

const ok = (fn, code = 500) => async (req, res) => {
  try { res.json((await fn(req)) || { ok: true }); } catch (e) { res.status(code).json({ error: e.message }); }
};
const need = (v) => { if (!v) throw new Error("path is required"); return v; };

app.get("/api/ws-token", ok((req) => ({ token: auth.wsToken(req.user) })));
app.get("/api/apps", ok((req) => docker.listApps(req.user)));
app.post("/api/apps", ok(async (req) => {
  if ((await docker.listApps(req.user)).length >= MAX_BOTS) throw new Error(`Limit reached: ${MAX_BOTS} bot(s) per account`);
  const appId = crypto.randomUUID();
  await docker.createApp({ appId, ownerId: req.user, memoryMb: 256 });
  return { appId };
}));
app.get("/api/apps/:id/stats", ok((req) => docker.getStats(req.params.id)));
for (const a of ["start", "stop", "restart"]) app.post(`/api/apps/:id/${a}`, ok((req) => docker[`${a}App`](req.params.id)));
app.delete("/api/apps/:id", ok((req) => docker.removeApp(req.params.id, { deleteData: req.query.deleteData === "true" })));

app.get("/api/apps/:id/files", ok((req) => files.listDir(req.params.id, req.query.path || "."), 400));
app.get("/api/apps/:id/file", ok((req) => ({ content: files.readFile(req.params.id, need(req.query.path)) }), 400));
app.put("/api/apps/:id/file", ok((req) => { const b = req.body || {}; files.writeFile(req.params.id, need(b.path), b.content ?? ""); }, 400));
app.put("/api/apps/:id/upload", express.raw({ type: "*/*", limit: "100mb" }), ok((req) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error("The file is empty");
  if (req.query.extract === "1") return { ok: true, extracted: files.extractZip(req.params.id, req.query.dir || ".", req.body) };
  files.writeBuffer(req.params.id, need(req.query.path), req.body);
}, 400));
app.post("/api/apps/:id/mkdir", ok((req) => files.makeDir(req.params.id, need((req.body || {}).path)), 400));
app.delete("/api/apps/:id/file", ok((req) => files.deletePath(req.params.id, need(req.query.path)), 400));

// ---- console WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/console" });
setInterval(() => wss.clients.forEach((c) => c.readyState === 1 && c.ping()), 25000);

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://x");
  const user = auth.wsUser(url.searchParams.get("token")) || auth.user(req);
  const appId = url.searchParams.get("appId");
  if (!user) { ws.send("Unauthorized\r\n"); return ws.close(); }
  let stream;
  try {
    if (!(await docker.listApps(user)).some((a) => a.appId === appId)) throw new Error("App not found");
    stream = (await docker.attachShell(appId)).stream;
  } catch (e) { ws.send(`Failed to attach: ${e.message}\r\n`); return ws.close(); }
  stream.on("data", (c) => ws.readyState === ws.OPEN && ws.send(c));
  stream.on("end", () => ws.close());
  ws.on("message", (m) => stream.write(m));
  ws.on("close", () => stream.end());
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
server.listen(PORT, "0.0.0.0", () => console.log(`Listening on port ${PORT}`));
