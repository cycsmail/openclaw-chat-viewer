import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { getMachinesPath, getMachineCacheDir, readJson } from "./config.mjs";

export function slugifyMachineName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function loadMachines() {
  const machines = await readJson(getMachinesPath(), []);
  const list = Array.isArray(machines) ? machines : [];
  const hasLocal = list.some((m) => m.id === "local");
  if (!hasLocal) {
    list.unshift({ id: "local", name: "Local", host: null, enabled: true });
  }
  return list;
}

export async function saveMachines(machines) {
  const filtered = machines.filter((m) => m.id !== "local");
  const machinesPath = getMachinesPath();
  await fs.mkdir(path.dirname(machinesPath), { recursive: true });
  const tempPath = `${machinesPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(filtered, null, 2));
  await fs.rename(tempPath, machinesPath);
}

export async function addOrUpdateMachine(profile) {
  if (!profile || typeof profile !== "object") {
    throw new Error("Invalid machine profile");
  }
  if (!profile.name || typeof profile.name !== "string" || !profile.name.trim()) {
    throw new Error("Invalid machine profile");
  }
  if (!profile.host || typeof profile.host !== "string" || !profile.host.trim()) {
    throw new Error("Invalid machine profile");
  }

  const id = profile.id || slugifyMachineName(profile.name);
  if (!id || id === "local") {
    throw new Error("Invalid machine profile");
  }

  const machines = await loadMachines();
  const existing = machines.findIndex((m) => m.id === id);

  const entry = {
    id,
    name: profile.name.trim(),
    host: profile.host.trim(),
    user: profile.user || "",
    port: Number(profile.port) || 22,
    openclawHome: profile.openclawHome || "~/.openclaw",
    enabled: profile.enabled !== false,
    lastSyncAt: null,
    lastSyncStatus: null
  };

  if (existing >= 0) {
    entry.lastSyncAt = machines[existing].lastSyncAt || null;
    entry.lastSyncStatus = machines[existing].lastSyncStatus || null;
    machines[existing] = entry;
  } else {
    machines.push(entry);
  }

  await saveMachines(machines);
  return entry;
}

export async function removeMachine(machineId) {
  if (!machineId || machineId === "local") {
    throw new Error("Invalid machineId");
  }
  const machines = await loadMachines();
  const idx = machines.findIndex((m) => m.id === machineId);
  if (idx < 0) {
    throw new Error("Machine not found");
  }
  machines.splice(idx, 1);
  await saveMachines(machines);

  const cacheDir = path.join(getMachineCacheDir(), machineId);
  await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  return { ok: true };
}

function execFileAsync(cmd, args, options) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export async function testMachineConnection(machine) {
  if (!machine || !machine.host) {
    throw new Error("Invalid machine profile");
  }
  const port = String(machine.port || 22);
  const user = machine.user || "";
  const target = user ? `${user}@${machine.host}` : machine.host;
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "StrictHostKeyChecking=accept-new",
    "-p", port,
    target,
    "echo ok"
  ];

  const startMs = Date.now();
  try {
    await execFileAsync("ssh", args, { timeout: 60000 });
    const latencyMs = Date.now() - startMs;
    return { ok: true, latencyMs, error: null };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    return { ok: false, latencyMs, error: err.message || String(err) };
  }
}

export async function syncMachine(machine) {
  if (!machine || !machine.host) {
    throw new Error("Invalid machine profile");
  }
  const port = String(machine.port || 22);
  const user = machine.user || "";
  const openclawHome = machine.openclawHome || "~/.openclaw";
  const cacheDir = path.join(getMachineCacheDir(), machine.id);
  await fs.mkdir(path.join(cacheDir, "agents"), { recursive: true });

  const sshCmd = `ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -p ${port}`;
  const source = user ? `${user}@${machine.host}:${openclawHome}/agents/` : `${machine.host}:${openclawHome}/agents/`;
  const dest = path.join(cacheDir, "agents") + "/";

  const args = [
    "-az",
    "--timeout=30",
    "-e", sshCmd,
    source,
    dest
  ];

  const startMs = Date.now();
  try {
    const { stdout } = await execFileAsync("rsync", args, { timeout: 60000 });
    const latencyMs = Date.now() - startMs;
    const filesTransferred = stdout.split("\n").filter(Boolean).length;

    const machines = await loadMachines();
    const entry = machines.find((m) => m.id === machine.id);
    if (entry) {
      entry.lastSyncAt = new Date().toISOString();
      entry.lastSyncStatus = "ok";
      await saveMachines(machines);
    }

    return { ok: true, filesTransferred, error: null };
  } catch (err) {
    const machines = await loadMachines();
    const entry = machines.find((m) => m.id === machine.id);
    if (entry) {
      entry.lastSyncAt = new Date().toISOString();
      entry.lastSyncStatus = `error: ${err.message || String(err)}`;
      await saveMachines(machines);
    }

    return { ok: false, filesTransferred: 0, error: err.message || String(err) };
  }
}

export function getMachineCachedAgentsDir(machineId) {
  return path.join(getMachineCacheDir(), machineId, "agents");
}

export async function syncAllMachines() {
  const machines = await loadMachines();
  const remote = machines.filter((m) => m.id !== "local" && m.enabled !== false && m.host);
  const results = await Promise.allSettled(remote.map((m) => syncMachine(m)));
  return remote.map((m, i) => ({
    id: m.id,
    name: m.name,
    ...(results[i].status === "fulfilled" ? results[i].value : { ok: false, filesTransferred: 0, error: results[i].reason?.message || "Unknown error" })
  }));
}

let syncSchedulerHandle = null;

export function startSyncScheduler(intervalMs) {
  stopSyncScheduler();
  if (!intervalMs || intervalMs < 60000) return;
  syncSchedulerHandle = setInterval(() => {
    syncAllMachines().catch((err) => {
      console.error(`Scheduled machine sync failed: ${err.message || String(err)}`);
    });
  }, intervalMs);
  if (typeof syncSchedulerHandle.unref === "function") {
    syncSchedulerHandle.unref();
  }
  // Run once immediately on start
  syncAllMachines().catch((err) => {
    console.error(`Initial machine sync failed: ${err.message || String(err)}`);
  });
}

export function stopSyncScheduler() {
  if (syncSchedulerHandle) {
    clearInterval(syncSchedulerHandle);
    syncSchedulerHandle = null;
  }
}

export async function uploadSessionData(machineId, agentId, filename, content) {
  if (!machineId || machineId === "local") {
    throw new Error("Invalid machineId");
  }
  if (!agentId || !/^[a-zA-Z0-9_-]{1,100}$/.test(agentId)) {
    throw new Error("Invalid agentId");
  }
  if (!filename || !filename.endsWith(".jsonl")) {
    throw new Error("Invalid path");
  }

  const sessionsDir = path.join(getMachineCachedAgentsDir(machineId), agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const target = path.join(sessionsDir, path.basename(filename));
  await fs.writeFile(target, content);
  return { ok: true, path: target };
}
