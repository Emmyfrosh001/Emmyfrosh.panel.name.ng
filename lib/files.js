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

module.exports = { listDir, readFile, writeFile, deletePath, resolveSafePath };
