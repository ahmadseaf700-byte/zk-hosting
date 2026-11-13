const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "dragonhost.json");
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const users = new Map();
const servers = new Map();
const sessions = new Map();
const agents = new Map();
const tasks = new Map();
const pairingCodes = new Map();
const loginAttempts = new Map();
let saveQueue = Promise.resolve();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 20_000) {
        reject(new Error("حجم الطلب كبير جداً"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("صيغة JSON غير صحيحة")); }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function getUser(req) {
  const token = parseCookies(req).dh_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return users.get(session.userId) || null;
}

function sessionCookie(token, maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `dh_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function createSession(user, res) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL });
  res.setHeader("Set-Cookie", sessionCookie(token, SESSION_TTL / 1000));
}

function clearSession(req, res) {
  const token = parseCookies(req).dh_session;
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", sessionCookie("", 0));
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: derived.toString("hex") };
}

async function verifyPassword(password, user) {
  const derived = await scrypt(password, user.salt, 64);
  const stored = Buffer.from(user.passwordHash, "hex");
  return stored.length === derived.length && crypto.timingSafeEqual(stored, derived);
}

async function saveData() {
  const data = JSON.stringify({
    users: [...users.values()],
    servers: [...servers.values()],
    agents: [...agents.values()],
    tasks: [...tasks.values()]
  }, null, 2);
  saveQueue = saveQueue.then(async () => {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tempFile = DATA_FILE + ".tmp";
    await fs.promises.writeFile(tempFile, data, { mode: 0o600 });
    await fs.promises.rename(tempFile, DATA_FILE);
  });
  return saveQueue;
}

async function loadData() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try {
    const data = JSON.parse(await fs.promises.readFile(DATA_FILE, "utf8"));
    for (const user of data.users || []) users.set(user.id, user);
    for (const server of data.servers || []) servers.set(server.id, server);
    for (const agent of data.agents || []) agents.set(agent.id, agent);
    for (const task of data.tasks || []) tasks.set(task.id, task);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}


function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function getAgent(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer ([a-f0-9]{64})$/i);
  if (!match) return null;
  const tokenHash = hashToken(match[1]);
  return [...agents.values()].find(agent => agent.tokenHash === tokenHash) || null;
}
function agentIsOnline(agent) {
  return !!agent && Date.now() - Date.parse(agent.lastSeenAt || 0) < 90_000;
}
function enqueueTask(agent, server, type, payload = {}) {
  const task = {
    id: crypto.randomUUID(), agentId: agent.id, userId: server.userId,
    serverId: server.id, type, payload, status: "queued",
    createdAt: new Date().toISOString(), attempts: 0
  };
  tasks.set(task.id, task);
  return task;
}

function isRateLimited(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (entry.resetAt <= now) {
    entry.count = 0;
    entry.resetAt = now + 15 * 60 * 1000;
  }
  entry.count += 1;
  loginAttempts.set(ip, entry);
  return entry.count > 20;
}

function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { res.writeHead(400); return res.end("Bad Request"); }
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, service: "dragonhost", version: "0.5.0", message: "DragonHost API تعمل" });
  }

  if (req.method === "POST" && ["/api/auth/register", "/api/auth/login"].includes(url.pathname)) {
    if (isRateLimited(req)) return sendJson(res, 429, { error: "محاولات كثيرة. انتظر 15 دقيقة ثم حاول مجدداً." });
    try {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        return sendJson(res, 400, { error: "أدخل بريداً إلكترونياً صحيحاً." });
      }
      if (password.length < 8 || password.length > 128) {
        return sendJson(res, 400, { error: "كلمة المرور يجب أن تكون بين 8 و128 حرفاً." });
      }

      if (url.pathname.endsWith("/register")) {
        if ([...users.values()].some(user => user.email === email)) {
          return sendJson(res, 409, { error: "هذا البريد مسجل مسبقاً. سجّل الدخول." });
        }
        const credentials = await hashPassword(password);
        const user = {
          id: crypto.randomUUID(),
          email,
          salt: credentials.salt,
          passwordHash: credentials.hash,
          createdAt: new Date().toISOString()
        };
        users.set(user.id, user);
        await saveData();
        createSession(user, res);
        return sendJson(res, 201, { user: { id: user.id, email: user.email } });
      }

      const user = [...users.values()].find(item => item.email === email);
      if (!user || !(await verifyPassword(password, user))) {
        return sendJson(res, 401, { error: "البريد الإلكتروني أو كلمة المرور غير صحيحة." });
      }
      createSession(user, res);
      return sendJson(res, 200, { user: { id: user.id, email: user.email } });
    } catch (error) {
      console.error("Auth error:", error);
      return sendJson(res, 500, { error: "حدث خطأ أثناء تسجيل الحساب. حاول مجدداً." });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const user = getUser(req);
    return user
      ? sendJson(res, 200, { user: { id: user.id, email: user.email } })
      : sendJson(res, 401, { error: "يلزم تسجيل الدخول." });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    clearSession(req, res);
    return sendJson(res, 200, { ok: true });
  }


  // Device pairing: short-lived one-time code created by the signed-in user.
  if (req.method === "POST" && url.pathname === "/api/agent/pair-code") {
    const user = getUser(req);
    if (!user) return sendJson(res, 401, { error: "سجّل الدخول أولاً." });
    for (const [code, item] of pairingCodes) if (item.expiresAt <= Date.now()) pairingCodes.delete(code);
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    pairingCodes.set(code, { userId: user.id, expiresAt: Date.now() + 5 * 60 * 1000 });
    return sendJson(res, 201, { code, expiresInSeconds: 300, message: "استخدم الرمز مرة واحدة خلال 5 دقائق من تطبيق Hosting Agent." });
  }

  if (req.method === "POST" && url.pathname === "/api/agent/pair") {
    try {
      const body = await readBody(req);
      const code = String(body.code || "");
      const pairing = pairingCodes.get(code);
      if (!/^\d{6}$/.test(code) || !pairing || pairing.expiresAt <= Date.now()) {
        pairingCodes.delete(code);
        return sendJson(res, 400, { error: "رمز الربط غير صحيح أو منتهي الصلاحية." });
      }
      pairingCodes.delete(code);
      const token = crypto.randomBytes(32).toString("hex");
      const agent = {
        id: crypto.randomUUID(), userId: pairing.userId,
        name: String(body.deviceName || "DragonHost Android").trim().slice(0, 48) || "DragonHost Android",
        tokenHash: hashToken(token), createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(), status: "online"
      };
      agents.set(agent.id, agent);
      await saveData();
      return sendJson(res, 201, { agent: { id: agent.id, name: agent.name }, token, pollIntervalSeconds: 5 });
    } catch (error) {
      console.error("Agent pairing error:", error);
      return sendJson(res, 500, { error: "تعذر ربط جهاز الاستضافة." });
    }
  }

  if (url.pathname.startsWith("/api/agent/") && url.pathname !== "/api/agent/pair-code" && url.pathname !== "/api/agent/pair") {
    const agent = getAgent(req);
    if (!agent) return sendJson(res, 401, { error: "رمز جهاز الاستضافة غير صالح." });

    if (req.method === "POST" && url.pathname === "/api/agent/heartbeat") {
      try {
        const body = await readBody(req);
        agent.lastSeenAt = new Date().toISOString();
        agent.status = "online";
        if (body.deviceName) agent.name = String(body.deviceName).trim().slice(0, 48);
        if (body.platform) agent.platform = String(body.platform).slice(0, 40);
        if (body.agentVersion) agent.agentVersion = String(body.agentVersion).slice(0, 32);
        await saveData();
        return sendJson(res, 200, { ok: true, serverCount: [...servers.values()].filter(s => s.userId === agent.userId).length });
      } catch { return sendJson(res, 400, { error: "بيانات النبض غير صالحة." }); }
    }

    if (req.method === "GET" && url.pathname === "/api/agent/tasks") {
      agent.lastSeenAt = new Date().toISOString();
      agent.status = "online";
      const pending = [...tasks.values()].filter(task => task.agentId === agent.id && task.status === "queued").slice(0, 5);
      for (const task of pending) {
        task.status = "claimed";
        task.claimedAt = new Date().toISOString();
        task.attempts = (task.attempts || 0) + 1;
      }
      if (pending.length) await saveData();
      return sendJson(res, 200, { tasks: pending });
    }

    const resultMatch = url.pathname.match(/^\/api\/agent\/tasks\/([0-9a-f-]+)\/result$/i);
    if (req.method === "POST" && resultMatch) {
      try {
        const body = await readBody(req);
        const task = tasks.get(resultMatch[1]);
        if (!task || task.agentId !== agent.id || !["claimed", "running"].includes(task.status)) {
          return sendJson(res, 404, { error: "المهمة غير موجودة أو لم تعد متاحة." });
        }
        const success = body.success === true;
        task.status = success ? "completed" : "failed";
        task.finishedAt = new Date().toISOString();
        task.message = String(body.message || "").slice(0, 500);
        const server = servers.get(task.serverId);
        if (server) {
          if (task.type === "provision") {
            server.status = success ? "offline" : "error";
            server.hostStatus = success ? "ready" : "provision_failed";
            if (body.port) server.port = Number(body.port);
            if (body.address) server.hostAddress = String(body.address).slice(0, 120);
          } else if (task.type === "start") {
            server.status = success ? "online" : "error";
          } else if (task.type === "stop") {
            server.status = success ? "offline" : "error";
          }
          server.updatedAt = new Date().toISOString();
        }
        await saveData();
        return sendJson(res, 200, { ok: true, task: { id: task.id, status: task.status } });
      } catch { return sendJson(res, 400, { error: "نتيجة المهمة غير صالحة." }); }
    }
  }

  if (req.method === "GET" && url.pathname === "/api/agent/status") {
    const user = getUser(req);
    if (!user) return sendJson(res, 401, { error: "سجّل الدخول أولاً." });
    const owned = [...agents.values()].filter(agent => agent.userId === user.id);
    return sendJson(res, 200, { agents: owned.map(agent => ({
      id: agent.id, name: agent.name, status: agentIsOnline(agent) ? "online" : "offline",
      lastSeenAt: agent.lastSeenAt, platform: agent.platform || null, agentVersion: agent.agentVersion || null
    })) });
  }

  if (req.method === "GET" && url.pathname === "/api/subdomains/check") {
    const user = getUser(req);
    if (!user) return sendJson(res, 401, { error: "سجّل الدخول أولاً." });
    const name = String(url.searchParams.get("name") || "").trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(name)) return sendJson(res, 400, { error: "صيغة العنوان غير صحيحة." });
    const available = ![...servers.values()].some(server => server.subdomain === name);
    return sendJson(res, 200, { available, name });
  }

  if (url.pathname.startsWith("/api/servers")) {
    const user = getUser(req);
    if (!user) return sendJson(res, 401, { error: "سجّل الدخول أولاً للمتابعة." });

    if (req.method === "GET" && url.pathname === "/api/servers") {
      const ownedServers = [...servers.values()].filter(server => server.userId === user.id);
      return sendJson(res, 200, { servers: ownedServers, note: "حالة السيرفرات تجريبية حتى ربط جهاز الاستضافة." });
    }

    const actionMatch = url.pathname.match(/^\/api\/servers\/([0-9a-f-]+)\/(start|stop|restart)$/i);
    if (actionMatch && req.method === "POST") {
      const target = servers.get(actionMatch[1]);
      if (!target || target.userId !== user.id) return sendJson(res, 404, { error: "السيرفر غير موجود." });
      const agent = [...agents.values()].find(item => item.userId === user.id && agentIsOnline(item));
      if (!agent) return sendJson(res, 503, { error: "جهاز الاستضافة غير متصل. اربط Hosting Agent أولاً.", code: "AGENT_NOT_CONNECTED" });
      const action = actionMatch[2];
      const task = enqueueTask(agent, target, action);
      target.status = action === "stop" ? "stopping" : action === "start" ? "starting" : "restarting";
      target.updatedAt = new Date().toISOString();
      saveData().catch(error => console.error("Task save error:", error));
      return sendJson(res, 202, { ok: true, taskId: task.id, status: target.status });
    }
    const serverMatch = url.pathname.match(/^\/api\/servers\/([0-9a-f-]+)$/i);
    if (serverMatch) {
      const server = servers.get(serverMatch[1]);
      if (!server || server.userId !== user.id) return sendJson(res, 404, { error: "السيرفر غير موجود." });
      if (req.method === "PATCH") {
        try {
          const body = await readBody(req);
          const allowed = ["name", "motd", "gamemode", "difficulty", "maxPlayers", "cracked", "allowFlight", "pvp"];
          const next = { ...server };
          if (body.name !== undefined) { const value = String(body.name).trim(); if (value.length < 2 || value.length > 32) return sendJson(res, 400, { error: "اسم السيرفر يجب أن يكون بين حرفين و32 حرفاً." }); next.name = value; }
          if (body.motd !== undefined) next.motd = String(body.motd).trim().slice(0, 120);
          if (body.gamemode !== undefined) { if (!["survival", "creative", "adventure"].includes(body.gamemode)) return sendJson(res, 400, { error: "وضع اللعب غير صالح." }); next.gamemode = body.gamemode; }
          if (body.difficulty !== undefined) { if (!["peaceful", "easy", "normal", "hard"].includes(body.difficulty)) return sendJson(res, 400, { error: "الصعوبة غير صالحة." }); next.difficulty = body.difficulty; }
          if (body.maxPlayers !== undefined) { const value = Number(body.maxPlayers); if (!Number.isInteger(value) || value < 1 || value > 100) return sendJson(res, 400, { error: "عدد اللاعبين يجب أن يكون بين 1 و100." }); next.maxPlayers = value; }
          for (const key of ["cracked", "allowFlight", "pvp"]) if (body[key] !== undefined) next[key] = body[key] === true;
          next.updatedAt = new Date().toISOString();
          servers.set(server.id, next); await saveData();
          return sendJson(res, 200, { server: { ...next, userId: undefined } });
        } catch (error) { console.error("Server update error:", error); return sendJson(res, 500, { error: "تعذر حفظ الإعدادات." }); }
      }
      if (req.method === "DELETE") { servers.delete(server.id); await saveData(); return sendJson(res, 200, { ok: true }); }
      return sendJson(res, 405, { error: "Method not allowed" });
    }

    if (req.method === "POST" && url.pathname === "/api/servers") {
      try {
        const body = await readBody(req);
        const name = String(body.name || "").trim();
        const subdomain = String(body.subdomain || "").trim().toLowerCase();
        const edition = String(body.edition || "").trim().toLowerCase();
        const version = String(body.version || "1.21.11").trim();
        const software = String(body.software || "paper").trim().toLowerCase();
        const motd = String(body.motd || "").trim().slice(0, 120);
        const gamemode = String(body.gamemode || "survival").toLowerCase();
        const difficulty = String(body.difficulty || "normal").toLowerCase();
        const maxPlayers = Number(body.maxPlayers ?? 20);
        const cracked = body.cracked === true;
        const allowFlight = body.allowFlight === true;
        const pvp = body.pvp !== false;

        if (name.length < 2 || name.length > 32) return sendJson(res, 400, { error: "اسم السيرفر يجب أن يكون بين حرفين و32 حرفاً." });
        if (!/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(subdomain)) return sendJson(res, 400, { error: "عنوان السيرفر غير صحيح." });
        if ([...servers.values()].some(server => server.subdomain === subdomain)) return sendJson(res, 409, { error: "هذا العنوان مستخدم، اختر عنواناً آخر." });
        if (!["java", "bedrock"].includes(edition)) return sendJson(res, 400, { error: "اختر Java أو Bedrock." });
        if (!["vanilla", "paper", "purpur"].includes(software)) return sendJson(res, 400, { error: "نوع السيرفر غير مدعوم حالياً." });
        if (!/^\d{1,2}\.\d{1,2}(\.\d{1,2})?$/.test(version)) return sendJson(res, 400, { error: "صيغة الإصدار غير صحيحة." });
        if (!["survival", "creative", "adventure"].includes(gamemode)) return sendJson(res, 400, { error: "وضع اللعب غير صالح." });
        if (!["peaceful", "easy", "normal", "hard"].includes(difficulty)) return sendJson(res, 400, { error: "مستوى الصعوبة غير صالح." });
        if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 100) return sendJson(res, 400, { error: "عدد اللاعبين يجب أن يكون بين 1 و100." });

        const server = {
          id: crypto.randomUUID(), userId: user.id, name, subdomain, motd, edition, version,
          software: edition === "bedrock" ? "bedrock" : software,
          gamemode, difficulty, maxPlayers, cracked, allowFlight, pvp,
          status: "offline", hostStatus: "not_paired", createdAt: new Date().toISOString()
        };
        servers.set(server.id, server);
        const agent = [...agents.values()].find(item => item.userId === user.id && agentIsOnline(item));
        if (agent) {
          server.hostStatus = "provisioning";
          const task = enqueueTask(agent, server, "provision", { edition: server.edition, software: server.software, version: server.version });
          server.provisionTaskId = task.id;
        }
        await saveData();
        return sendJson(res, 201, { server: { ...server, userId: undefined }, queued: !!agent });
      } catch (error) {
        console.error("Server create error:", error);
        return sendJson(res, 500, { error: "تعذر إنشاء السيرفر حالياً." });
      }
    }
  }

  if (req.method === "GET") return serveStatic(req, res);
  return sendJson(res, 405, { error: "Method not allowed" });
});

loadData().then(() => {
  app.listen(PORT, "0.0.0.0", () => console.log(`DragonHost v0.5.0 listening on port ${PORT}`));
}).catch(error => {
  console.error("Failed to load DragonHost data:", error);
  process.exit(1);
});
