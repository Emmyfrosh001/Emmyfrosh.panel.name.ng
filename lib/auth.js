// lib/auth.js - accounts: signup/login, signed cookie sessions, per-user ownership
const crypto = require("crypto"), fs = require("fs"), path = require("path");
const express = require("express");

module.exports = (DATA_ROOT) => {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const USERS = path.join(DATA_ROOT, "users.json");
  const load = () => { try { return JSON.parse(fs.readFileSync(USERS, "utf8")); } catch { return {}; } };
  const SECRET = process.env.SESSION_SECRET || (() => {
    const f = path.join(DATA_ROOT, ".secret");
    try { return fs.readFileSync(f, "utf8"); } catch {}
    const s = crypto.randomBytes(32).toString("hex");
    try { fs.writeFileSync(f, s, { mode: 0o600 }); } catch {}
    return s;
  })();
  const sign = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("hex");
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const token = (user, ttl) => { const p = `${user}.${Date.now() + ttl}`; return `${p}.${sign(p)}`; };
  const read = (t) => {
    const m = /^([a-z0-9_]{3,20})\.(\d+)\.([0-9a-f]{64})$/.exec(t || "");
    return m && same(m[3], sign(`${m[1]}.${m[2]}`)) && +m[2] > Date.now() ? m[1] : null;
  };
  const cookie = (req) => ((req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith("sid=")) || "").slice(4);
  const user = (req) => { const u = read(cookie(req)); return u && load()[u] ? u : null; };
  const hash = (pw, salt = crypto.randomBytes(16).toString("hex")) => `${salt}:${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
  const check = (pw, stored) => { const [s] = stored.split(":"); return same(hash(pw, s), stored); };
  const setCookie = (req, res, u, age) => res.setHeader("Set-Cookie",
    `sid=${u ? token(u, age * 1000) : ""}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${req.secure ? "; Secure" : ""}`);

  const tries = new Map(); // simple brute-force guard: 15 attempts / 10 min / IP
  const limited = (req) => {
    const now = Date.now(), t = (tries.get(req.ip) || []).filter((x) => now - x < 6e5);
    t.push(now); tries.set(req.ip, t); return t.length > 15;
  };

  const router = express.Router();
  const go = (mode) => (req, res) => {
    if (limited(req)) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    const name = String((req.body || {}).username || "").toLowerCase(), pw = String((req.body || {}).password || "");
    const users = load();
    if (mode === "signup") {
      if (!/^[a-z0-9_]{3,20}$/.test(name)) return res.status(400).json({ error: "Username: 3-20 letters, numbers or _" });
      if (pw.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
      if (users[name]) return res.status(400).json({ error: "Username already taken" });
      if (Object.keys(users).length >= (+process.env.MAX_USERS || 50)) return res.status(400).json({ error: "Signups are full" });
      users[name] = { pw: hash(pw), createdAt: Date.now() };
      fs.writeFileSync(USERS, JSON.stringify(users));
    } else if (!users[name] || !check(pw, users[name].pw)) {
      return res.status(400).json({ error: "Wrong username or password" });
    }
    setCookie(req, res, name, 7 * 86400);
    res.json({ ok: true });
  };
  router.post("/signup", go("signup"));
  router.post("/login", go("login"));
  router.post("/logout", (req, res) => { setCookie(req, res, null, 0); res.json({ ok: true }); });
  router.get("/me", (req, res) => res.json({ user: user(req) }));

  return {
    router, user,
    require: (req, res, next) => { req.user = user(req); req.user ? next() : res.status(401).json({ error: "Please log in" }); },
    wsToken: (u) => token(u, 60000),
    wsUser: (t) => read(t),
  };
};
