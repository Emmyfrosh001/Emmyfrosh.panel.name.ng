// lib/files.js
//
// Minimal file manager, operating directly on the host bind-mount for each
// app (see hostDirFor in lib/docker.js). Since each app's folder is mounted
// straight into its container at /app, editing a file here is instantly
// visible inside the container — no docker cp needed.
//
// SECURITY NOTE: every path from a client is resolved with resolveSafePath()
// below, which refuses to leave the app's own folder (blocks "../../etc"
// style traversal). Do not bypass this in routes that accept a user path.

const fs = require("fs");
const path = require("path");
const { hostDirFor } = require("./runtime");

function resolveSafePath(appId, relativePath = ".") {
  const root = hostDirFor(appId);
  const resolved = path.resolve(root, "." + path.sep + relativePath);
  if (!resolved.startsWith(path.resolve(root))) {
    throw new Error("Path escapes app directory");
  }
  return resolved;
}

function listDir(appId, relativePath = ".") {
  const dir = resolveSafePath(appId, relativePath);
  return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
  }));
}

function readFile(appId, relativePath) {
  const file = resolveSafePath(appId, relativePath);
  return fs.readFileSync(file, "utf8");
}

function writeFile(appId, relativePath, content) {
  const file = resolveSafePath(appId, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function deletePath(appId, relativePath) {
  const target = resolveSafePath(appId, relativePath);
  fs.rmSync(target, { recursive: true, force: true });
}

function writeBuffer(appId, relativePath, buffer) {
  const file = resolveSafePath(appId, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
}

function makeDir(appId, relativePath) {
  fs.mkdirSync(resolveSafePath(appId, relativePath), { recursive: true });
}

// Unpack a .zip into a folder of the app. If everything sits inside one
// top-level folder (common when zipping a project), that folder is dropped.
function extractZip(appId, relativeDir, buffer) {
  const AdmZip = require("adm-zip");
  const root = resolveSafePath(appId, relativeDir);
  const entries = new AdmZip(buffer).getEntries().filter(
    (e) => !e.entryName.startsWith("__MACOSX/") && !e.entryName.endsWith(".DS_Store")
  );
  if (entries.length > 5000) throw new Error("Zip has too many files (max 5000)");

  const tops = new Set(entries.map((e) => e.entryName.split("/")[0]));
  const strip = tops.size === 1 && entries.some((e) => e.entryName.includes("/")) ? [...tops][0] + "/" : "";

  let count = 0;
  for (const e of entries) {
    const name = strip && e.entryName.startsWith(strip) ? e.entryName.slice(strip.length) : e.entryName;
    if (!name) continue;
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Zip contains an unsafe path");
    if (e.isDirectory) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.getData());
    count++;
  }
  return count;
}

module.exports = { listDir, readFile, writeFile, writeBuffer, makeDir, extractZip, deletePath, resolveSafePath };
