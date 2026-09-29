// lib/docker.js
//
// Thin wrapper around dockerode. Every "app" a user creates in the panel is
// really just one Docker container, tagged with a label so we can find it
// again. This file is the only place that talks to the Docker Engine API.

const Docker = require("dockerode");
const path = require("path");

// Connects to the local Docker daemon over the unix socket.
// On the host running this panel, the user running node must have
// permission to access /var/run/docker.sock (usually: be in the "docker"
// group, or run as root — root is NOT recommended for production).
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const LABEL_KEY = "node-panel.managed";
const IMAGE = process.env.APP_IMAGE || "node:20-alpine";

// Where per-app persistent data lives on the HOST. Each app gets its own
// subfolder, bind-mounted into the container at /app. This is what makes
// a user's files survive container restarts/redeploys.
const DATA_ROOT = process.env.DATA_ROOT || path.join(__dirname, "..", "data");

function containerNameFor(appId) {
  return `node-panel-${appId}`;
}

function hostDirFor(appId) {
  return path.join(DATA_ROOT, appId);
}

/**
 * Create (but do not start) a new container for an app.
 * ownerId is stored as a label so listApps() can filter per-user.
 */
async function createApp({ appId, ownerId, memoryMb = 256, cpus = 0.5 }) {
  const fs = require("fs");
  const hostDir = hostDirFor(appId);
  fs.mkdirSync(hostDir, { recursive: true });

  const container = await docker.createContainer({
    name: containerNameFor(appId),
    Image: IMAGE,
    // Keep the container alive even with no app started yet — the user's
    // own "npm start" (run via the web terminal or an entrypoint file)
    // is what actually runs their code. This just gives them a shell.
    Tty: true,
    OpenStdin: true,
    WorkingDir: "/app",
    Cmd: ["sh"],
    Labels: {
      [LABEL_KEY]: "true",
      "node-panel.owner": ownerId,
      "node-panel.appId": appId,
    },
    HostConfig: {
      Binds: [`${hostDir}:/app`],
      Memory: memoryMb * 1024 * 1024,
      NanoCpus: Math.floor(cpus * 1e9),
      RestartPolicy: { Name: "unless-stopped" },
      // Expose the app's port to a random free host port. Look it up later
      // with container.inspect() -> NetworkSettings.Ports.
      PortBindings: { "3000/tcp": [{ HostPort: "0" }] },
    },
    ExposedPorts: { "3000/tcp": {} },
  });

  return container;
}

function getContainer(appId) {
  return docker.getContainer(containerNameFor(appId));
}

async function startApp(appId) {
  await getContainer(appId).start();
}

async function stopApp(appId) {
  await getContainer(appId).stop().catch((e) => {
    // 304 = already stopped, not a real error
    if (e.statusCode !== 304) throw e;
  });
}

async function restartApp(appId) {
  await getContainer(appId).restart();
}

async function removeApp(appId, { deleteData = false } = {}) {
  const container = getContainer(appId);
  await container.remove({ force: true });
  if (deleteData) {
    const fs = require("fs");
    fs.rmSync(hostDirFor(appId), { recursive: true, force: true });
  }
}

/**
 * List every app this panel manages, optionally filtered to one owner.
 * Includes live status and, when running, basic stats.
 */
async function listApps(ownerId) {
  const filters = { label: [LABEL_KEY] };
  if (ownerId) filters.label.push(`node-panel.owner=${ownerId}`);

  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify(filters),
  });

  return containers.map((c) => ({
    appId: c.Labels["node-panel.appId"],
    ownerId: c.Labels["node-panel.owner"],
    status: c.State, // "running" | "exited" | "created" | ...
    createdAt: c.Created,
    ports: c.Ports,
  }));
}

/**
 * Point-in-time CPU % and memory usage for a running container.
 * Mirrors the kind of numbers shown in typical hosting-panel dashboards.
 */
async function getStats(appId) {
  const container = getContainer(appId);
  const info = await container.inspect();

  // Not running: no live numbers, but still report the memory limit.
  if (!info.State.Running) {
    return {
      running: false,
      startedAt: null,
      cpuPercent: 0,
      memUsageMb: 0,
      memLimitMb: Number(((info.HostConfig.Memory || 0) / (1024 * 1024)).toFixed(2)),
    };
  }

  const stats = await container.stats({ stream: false });

  const cpuDelta =
    stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const cpuCount = stats.cpu_stats.online_cpus || 1;
  const cpuPercent =
    systemDelta > 0 && cpuDelta > 0
      ? (cpuDelta / systemDelta) * cpuCount * 100
      : 0;

  const memUsage = stats.memory_stats.usage || 0;
  const memLimit = stats.memory_stats.limit || 1;

  return {
    running: true,
    startedAt: info.State.StartedAt,
    cpuPercent: Number(cpuPercent.toFixed(2)),
    memUsageMb: Number((memUsage / (1024 * 1024)).toFixed(2)),
    memLimitMb: Number((memLimit / (1024 * 1024)).toFixed(2)),
  };
}

/**
 * Attach an interactive shell (docker exec) to a running container and
 * return the duplex stream. Used by the WebSocket terminal bridge.
 */
async function attachShell(appId) {
  const container = getContainer(appId);
  const exec = await container.exec({
    Cmd: ["sh"],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });
  const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
  return { exec, stream };
}

module.exports = {
  DATA_ROOT,
  hostDirFor,
  createApp,
  getContainer,
  startApp,
  stopApp,
  restartApp,
  removeApp,
  listApps,
  getStats,
  attachShell,
};
