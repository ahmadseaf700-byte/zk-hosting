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
    servers: [...servers.values()]
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
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
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
    return sendJson(res, 200, { ok: true, service: "dragonhost", version: "0.4.0", message: "DragonHost API تعمل" });
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

    if (req.method === "POST" && url.pathname === "/api/servers") {
      try {
        const body = await readBody(req);
        const name = String(body.name || "").trim();
        const subdomain = String(body.subdomain || "").trim().toLowerCase();
        const edition = String(body.edition || "").trim().toLowerCase();
        const version = String(body.version || "1.21.11").trim();
        const software = String(body.software || "paper").trim().toLowerCase();
        const subdomain = String(body.subdomain || "").trim().toLowerCase();
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
        await saveData();
        return sendJson(res, 201, { server: { ...server, userId: undefined } });
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
  app.listen(PORT, "0.0.0.0", () => console.log(`DragonHost v0.3.0 listening on port ${PORT}`));
}).catch(error => {
  console.error("Failed to load DragonHost data:", error);
  process.exit(1);
});
