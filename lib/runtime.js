// lib/runtime.js
//
// Picks how apps are run:
//   docker  -> each app is a Docker container (needs your own server + Docker)
//   process -> each app is a child process (works on Render, Railway, etc.)
//
// FIX: the panel used to always default to Docker, so on hosts without Docker
// every action failed with "connect ENOENT /var/run/docker.sock" (no apps,
// no uploads, no files). Now:
//   RUNTIME=process            -> process mode
//   RUNTIME=docker (or unset)  -> Docker if the socket exists, otherwise it
//                                 automatically falls back to process mode
const fs = require("fs");

const SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const wanted = (process.env.RUNTIME || "auto").toLowerCase();

let mode;
if (wanted === "process") {
  mode = "process";
} else if (fs.existsSync(SOCKET)) {
  mode = "docker";
} else {
  mode = "process";
  console.warn(
    `[runtime] Docker socket not found at ${SOCKET}. ` +
      "Falling back to RUNTIME=process (apps run as child processes)."
  );
}

const impl = mode === "process" ? require("./process") : require("./docker");

console.log(`[runtime] Using "${mode}" runtime`);

module.exports = { ...impl, MODE: mode };
