// lib/runtime.js
// RUNTIME=docker  -> each app is a Docker container (needs your own server)
// RUNTIME=process -> each app is a child process (works on Render and similar)
module.exports = process.env.RUNTIME === "process" ? require("./process") : require("./docker");
