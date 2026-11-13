#!/usr/bin/env node
"use strict";

// DragonHost Hosting Agent — Node.js 20+ (Termux/Linux).
// Keep this process running; it owns the Minecraft child processes.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");

const execFileAsync = promisify(execFile);
const CONFIG_PATH = path.resolve(process.env.DRAGONHOST_CONFIG || ".dragonhost-agent.json");
const ROOT = path.resolve(process.env.DRAGONHOST_SERVERS_DIR || "dragonhost-servers");
const children = new Map();
let stopping = false;

function log(...args) { console.log(new Date().toISOString(), ...args); }
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return null; }
}
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
}
async function request(config, route, options = {}) {
  const response = await fetch(new URL(route, config.url), {
    ...options,
    headers: { Authorization: `Bearer ${config.token}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(25_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function pair(code, url) {
  const response = await fetch(new URL("/api/agent/pair", url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceName: `${os.hostname()} — ${os.platform()}` })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Pairing failed: HTTP ${response.status}`);
  const config = { url: url.replace(/\/$/, ""), token: data.token, agentId: data.agent.id, createdAt: new Date().toISOString() };
  saveConfig(config);
  log("Paired successfully as", data.agent.name);
}
async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temp = destination + ".download";
  const file = fs.createWriteStream(temp);
  await new Promise((resolve, reject) => {
    response.body.pipeTo(new WritableStream({
      write(chunk) { return new Promise((res, rej) => file.write(Buffer.from(chunk), err => err ? rej(err) : res())); },
      close() { file.end(resolve); },
      abort(reason) { file.destroy(reason); reject(reason); }
    })).catch(reject);
  });
  await fs.promises.rename(temp, destination);
}
async function resolveJar(server, dir) {
  if (server.edition !== "java") throw new Error("استضافة Bedrock على Android غير مدعومة حالياً؛ اختر Java Edition.");
  if (server.software === "paper") {
    const base = `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(server.version)}`;
    const buildsResponse = await fetch(`${base}/builds`);
    if (!buildsResponse.ok) throw new Error("إصدار Paper غير متاح للتنزيل.");
    const builds = await buildsResponse.json();
    const build = builds.builds.filter(item => item.channel === "default").at(-1);
    if (!build) throw new Error("لا يوجد إصدار Paper مستقر لهذا الإصدار.");
    const name = build.downloads.application.name;
    await download(`${base}/builds/${build.build}/downloads/${name}`, path.join(dir, "server.jar"));
  } else if (server.software === "purpur") {
    const url = `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(server.version)}/latest/download`;
    await download(url, path.join(dir, "server.jar"));
  } else if (server.software === "vanilla") {
    const manifestResponse = await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
    if (!manifestResponse.ok) throw new Error("تعذر جلب قائمة إصدارات Minecraft الرسمية.");
    const manifest = await manifestResponse.json();
    const version = manifest.versions.find(item => item.id === server.version);
    if (!version) throw new Error("إصدار Vanilla غير موجود في القائمة الرسمية.");
    const metaResponse = await fetch(version.url);
    if (!metaResponse.ok) throw new Error("تعذر جلب بيانات إصدار Minecraft.");
    const meta = await metaResponse.json();
    await download(meta.downloads.server.url, path.join(dir, "server.jar"));
  } else {
    throw new Error("نوع السيرفر غير مدعوم من Hosting Agent.");
  }
  return path.join(dir, "server.jar");
}
function properties(server, port) {
  const clean = value => String(value ?? "").replace(/[\r\n]/g, " ").replace(/=/g, "\\=");
  return [
    `server-port=${port}`, "server-ip=0.0.0.0",
    `motd=${clean(server.motd || server.name)}`,
    `max-players=${server.maxPlayers || 20}`,
    `gamemode=${server.gamemode || "survival"}`,
    `difficulty=${server.difficulty || "normal"}`,
    `online-mode=${server.cracked ? "false" : "true"}`,
    `allow-flight=${server.allowFlight ? "true" : "false"}`,
    `pvp=${server.pvp === false ? "false" : "true"}`,
    "enable-rcon=false", "view-distance=6", "simulation-distance=4"
  ].join("\n") + "\n";
}
async function findFreePort() {
  for (let port = 25565; port <= 25650; port++) {
    const available = await new Promise(resolve => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "0.0.0.0", () => probe.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error("لا توجد منافذ متاحة ضمن المجال 25565-25650.");
}
function existingPort(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, "server.properties"), "utf8");
    const match = text.match(/^server-port=(\\d+)$/m);
    return match ? Number(match[1]) : 25565;
  } catch { return 25565; }
}
async function javaCheck() {
  try { await execFileAsync("java", ["-version"]); }
  catch { throw new Error("Java غير مثبت. في Termux نفّذ: pkg install openjdk-21"); }
}
async function launch(server, dir, port) {
  await javaCheck();
  const jar = path.join(dir, "server.jar");
  if (!fs.existsSync(jar)) throw new Error("ملف server.jar غير موجود؛ أنشئ السيرفر أولاً.");
  if (children.has(server.id) && children.get(server.id).exitCode === null) return { running: true, port };
  const heap = String(process.env.DRAGONHOST_HEAP || "1536M");
  const child = spawn("java", [`-Xms512M`, `-Xmx${heap}`, "-jar", "server.jar", "nogui"], {
    cwd: dir, stdio: ["pipe", "pipe", "pipe"]
  });
  children.set(server.id, child);
  child.stdout.on("data", chunk => log(`[${server.id}] ${chunk.toString().trimEnd()}`));
  child.stderr.on("data", chunk => log(`[${server.id} ERROR] ${chunk.toString().trimEnd()}`));
  child.on("exit", (code, signal) => log(`Server ${server.id} exited: code=${code} signal=${signal}`));
  const ready = await new Promise(resolve => {
    let done = false;
    const finish = value => { if (!done) { done = true; resolve(value); } };
    const timer = setTimeout(() => finish(child.exitCode === null), 30_000);
    child.stdout.on("data", chunk => {
      if (chunk.toString().includes("Done (")) { clearTimeout(timer); finish(true); }
    });
    child.once("exit", () => { clearTimeout(timer); finish(false); });
  });
  if (!ready) throw new Error("Minecraft لم يبدأ خلال 30 ثانية. افحص سجل الجهاز والذاكرة المتاحة.");
  return { running: true, port };
}
async function stop(serverId) {
  const child = children.get(serverId);
  if (!child || child.exitCode !== null) return;
  child.stdin.write("stop\n");
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(20_000)]);
  if (child.exitCode === null) child.kill("SIGTERM");
}
async function execute(task) {
  const server = task.payload?.server || {};
  if (!server.id || server.id !== task.serverId) throw new Error("بيانات السيرفر داخل المهمة غير صالحة.");
  const dir = path.join(ROOT, server.id);
  await fs.promises.mkdir(dir, { recursive: true });
  if (task.type === "provision") {
    if (server.eulaAccepted !== true) throw new Error("لم يتم تأكيد موافقة Minecraft EULA.");
    await resolveJar(server, dir);
    await fs.promises.writeFile(path.join(dir, "eula.txt"), "eula=true\n", { mode: 0o600 });
    const port = await findFreePort();
    await fs.promises.writeFile(path.join(dir, "server.properties"), properties(server, port));
    return await launch(server, dir, port);
  }
  if (task.type === "start") {
    const result = await launch(server, dir, existingPort(dir));
    return result;
  }
  if (task.type === "stop") {
    await stop(server.id);
    return { running: false };
  }
  if (task.type === "restart") {
    await stop(server.id);
    const result = await launch(server, dir, 25565);
    return result;
  }
  throw new Error(`Unknown task type: ${task.type}`);
}
async function report(config, task, result) {
  await request(config, `/api/agent/tasks/${task.id}/result`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result)
  });
}
async function main() {
  const [command, value, urlArg] = process.argv.slice(2);
  if (command === "pair") {
    if (!value || !urlArg) {
      console.error("Usage: node agent.js pair <6-digit-code> <https://your-dragonhost-domain>");
      process.exitCode = 2; return;
    }
    await pair(value, urlArg);
  }
  const config = readConfig();
  if (!config) {
    log("Not paired. Run: node agent.js pair <code> <DragonHost URL>");
    process.exitCode = 1; return;
  }
  await javaCheck();
  log("Agent started. Server directory:", ROOT);
  while (!stopping) {
    try {
      await request(config, "/api/agent/heartbeat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceName: os.hostname(), platform: os.platform(), agentVersion: "0.1.0", runningServers: [...children.entries()].filter(([, child]) => child.exitCode === null).map(([id]) => id) })
      });
      const data = await request(config, "/api/agent/tasks");
      for (const task of data.tasks || []) {
        log("Running task", task.type, task.id);
        try {
          const result = await execute(task);
          await report(config, task, { success: true, ...result, message: "تم تنفيذ المهمة بنجاح." });
        } catch (error) {
          log("Task failed:", error.message);
          try { await report(config, task, { success: false, message: error.message }); }
          catch (reportError) { log("Could not report task result:", reportError.message); }
        }
      }
    } catch (error) { log("Connection error:", error.message); }
    await delay(5_000);
  }
}
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
main().catch(error => { log("Fatal:", error.message); process.exitCode = 1; });
