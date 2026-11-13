const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const servers = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
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

function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname); }
  catch { res.writeHead(400); return res.end("Bad Request"); }
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, requested);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, "index.html")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream"
    });
    res.end(data);
  });
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "dragonhost",
      version: "0.2.0",
      message: "DragonHost API تعمل"
    });
  }

  if (req.method === "GET" && url.pathname === "/api/servers") {
    return sendJson(res, 200, {
      servers: [...servers.values()],
      note: "إعدادات تجريبية مؤقتة؛ التشغيل الفعلي يتطلب ربط جهاز الاستضافة."
    });
  }

  if (req.method === "POST" && url.pathname === "/api/servers") {
    try {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const edition = String(body.edition || "").trim().toLowerCase();
      const version = String(body.version || "1.21.11").trim();
      const software = String(body.software || "paper").trim().toLowerCase();

      if (name.length < 2 || name.length > 32) {
        return sendJson(res, 400, { error: "اسم السيرفر يجب أن يكون بين حرفين و32 حرفاً." });
      }
      if (!["java", "bedrock"].includes(edition)) {
        return sendJson(res, 400, { error: "اختر Java أو Bedrock." });
      }
      if (!["vanilla", "paper", "purpur"].includes(software)) {
        return sendJson(res, 400, { error: "نوع السيرفر غير مدعوم حالياً." });
      }
      if (!/^\d{1,2}\.\d{1,2}(\.\d{1,2})?$/.test(version)) {
        return sendJson(res, 400, { error: "صيغة الإصدار غير صحيحة." });
      }

      const server = {
        id: crypto.randomUUID(),
        name,
        edition,
        version,
        software: edition === "bedrock" ? "bedrock" : software,
        status: "offline",
        hostStatus: "not_paired",
        createdAt: new Date().toISOString()
      };
      servers.set(server.id, server);
      return sendJson(res, 201, { server });
    } catch (error) {
      return sendJson(res, 400, { error: error.message || "تعذر قراءة الطلب." });
    }
  }

  if (req.method === "GET") return serveStatic(req, res);
  return sendJson(res, 405, { error: "Method not allowed" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DragonHost listening on port ${PORT}`);
});
