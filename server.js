import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Station } from "./station.js";

const PORT = Number(process.env.PORT) || 3000;
// Railway sets RAILWAY_VOLUME_MOUNT_PATH when a volume is attached. Without a volume, data is lost on redeploy.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || "./data";
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const MAX_BODY = 64 * 1024;

const station = new Station({ dataDir: DATA_DIR });

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const isHttps = (req) => (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";

// Browsers always send Origin on cross-site POSTs and WebSocket handshakes; reject ones from other sites.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleApi(req, res, url) {
  if (req.method !== "GET" && !sameOrigin(req)) return sendJson(res, 403, { error: "Cross-site request blocked." });
  let body = {};
  if (req.method !== "GET" && req.method !== "HEAD") {
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return sendJson(res, 413, { error: "That request is too large." });
    }
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: "The request body wasn't valid JSON." });
      }
      if (!body || typeof body !== "object") body = {};
    }
  }
  const result = await station.handle({ method: req.method, path: url.pathname, cookie: req.headers.cookie, body });
  const headers = {};
  if (result.cookie) {
    headers["Set-Cookie"] =
      `sid=${result.cookie.value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${result.cookie.maxAge}` +
      (isHttps(req) ? "; Secure" : "");
  }
  sendJson(res, result.status, result.body, headers);
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, BASE_HEADERS);
    return res.end();
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, BASE_HEADERS);
    return res.end();
  }
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file);
    res.writeHead(200, {
      ...BASE_HEADERS,
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404, { ...BASE_HEADERS, "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong on the server." });
  }
});

// --- live connections ---------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

server.on("upgrade", (req, socket, head) => {
  const reject = (code, text) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  const { pathname } = new URL(req.url, "http://x");
  if (pathname !== "/api/ws") return reject(404, "Not Found");
  if (!sameOrigin(req)) return reject(403, "Forbidden");
  const user = station.userFrom(req.headers.cookie);
  if (!station.can(user, "listen")) return reject(403, "Forbidden");
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    station.addSocket(ws);
  });
});

// Drop connections that silently died (closed laptops, dropped Wi-Fi) so the listener count stays honest.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`Schism radio listening on :${PORT} (data in ${path.resolve(DATA_DIR)})`));

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1012, "Restarting");
  server.close(() => {
    station.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
