// Serveur de chat vocal de proximité pour Roblox (style pma-voice / FiveM)
// Lancer :  npm install  puis  API_KEY=xxx ADMIN_KEY=yyy node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-moi-api";
const ADMIN_KEY = process.env.ADMIN_KEY || "change-moi-admin";
const MAX_DIST = Number(process.env.MAX_DIST || 40);  // portée max de la voix (studs)
const FULL_DIST = Number(process.env.FULL_DIST || 8); // distance à laquelle le volume est encore à 100 %

const world = new Map();   // userId -> { name, x, y, z, t }
const codes = new Map();   // code -> { userId, name }
const clients = new Map(); // userId -> { ws, id, userId, name }
const muted = new Set();   // userIds rendus muets
const pttDown = new Set(); // userIds qui maintiennent la touche pour parler (en jeu)
let nextId = 1;

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
const send = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};
const page = (res, file) => {
  fs.readFile(path.join(__dirname, "public", file), (err, data) => {
    if (err) { res.writeHead(404); return res.end("introuvable"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (req.method === "GET" && url.pathname === "/") return page(res, "index.html");

  // --- Appels depuis Roblox (protégés par API_KEY) ---
  if (url.pathname.startsWith("/roblox/")) {
    if (req.headers["x-api-key"] !== API_KEY) return send(res, 401, { error: "clé invalide" });
    const body = await readBody(req);

    if (url.pathname === "/roblox/link") {
      for (const [c, v] of codes) if (v.userId === body.userId) codes.delete(c);
      codes.set(String(body.code), { userId: body.userId, name: body.name });
      return send(res, 200, { ok: true });
    }

    if (url.pathname === "/roblox/update") {
      const list = Array.isArray(body.players) ? body.players : [];
      const present = new Set();
      const now = Date.now();
      for (const p of list) {
        present.add(p.userId);
        if (p.ptt) pttDown.add(p.userId); else pttDown.delete(p.userId);
        world.set(p.userId, { name: p.name, x: p.x ?? null, y: p.y ?? null, z: p.z ?? null, t: now });
      }
      for (const id of [...world.keys()]) if (!present.has(id)) world.delete(id);
      for (const [c, v] of codes) if (!present.has(v.userId)) codes.delete(c);
      for (const [id, c] of clients) if (!present.has(id)) { c.ws.close(4000, "Tu as quitté le jeu"); clients.delete(id); }
      for (const id of [...pttDown]) if (!present.has(id)) pttDown.delete(id);
      // On renvoie à Roblox qui est connecté au vocal et qui est en train de parler
      const t = Date.now();
      const speaking = [...clients.values()]
        .filter((c) => t - c.lastVoice < 400 && !muted.has(c.userId))
        .map((c) => c.userId);
      return send(res, 200, { ok: true, connected: [...clients.keys()], speaking });
    }

    if (url.pathname === "/roblox/ptt") { // changement immédiat de la touche pour parler
      body.talking ? pttDown.add(body.userId) : pttDown.delete(body.userId);
      return send(res, 200, { ok: true });
    }

    if (url.pathname === "/roblox/mute") { // appelable depuis ton système d'admin Roblox
      body.muted ? muted.add(body.userId) : muted.delete(body.userId);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "route inconnue" });
  }

  // --- Modération (protégée par ADMIN_KEY) ---
  if (url.pathname.startsWith("/admin")) {
    if (url.searchParams.get("key") !== ADMIN_KEY) { res.writeHead(401); return res.end("clé admin invalide"); }
    if (url.pathname === "/admin") return page(res, "admin.html");
    if (url.pathname === "/admin/list") {
      return send(res, 200, [...clients.values()].map((c) => ({
        userId: c.userId, name: c.name, muted: muted.has(c.userId),
      })));
    }
    if (url.pathname === "/admin/act" && req.method === "POST") {
      const { action, userId } = await readBody(req);
      if (action === "mute") muted.add(userId);
      if (action === "unmute") muted.delete(userId);
      if (action === "kick") { const c = clients.get(userId); if (c) c.ws.close(4001, "Expulsé du vocal"); }
      return send(res, 200, { ok: true });
    }
  }

  res.writeHead(404); res.end("introuvable");
});

// --- Voix : WebSocket ---
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16384 });

function relay(sender, pcm) {
  const me = world.get(sender.userId);
  if (!me || me.x === null || Date.now() - me.t > 5000) return;
  for (const c of clients.values()) {
    if (c === sender || c.ws.readyState !== 1) continue;
    const o = world.get(c.userId);
    if (!o || o.x === null) continue;
    const d = Math.hypot(me.x - o.x, me.y - o.y, me.z - o.z);
    if (d >= MAX_DIST) continue;
    const g = d <= FULL_DIST ? 1 : 1 - (d - FULL_DIST) / (MAX_DIST - FULL_DIST);
    const head = Buffer.alloc(3);
    head.writeUInt16LE(sender.id, 0);
    head.writeUInt8(Math.round(g * g * 255), 2);
    c.ws.send(Buffer.concat([head, pcm]));
  }
}

wss.on("connection", (ws) => {
  let me = null;
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === "join") {
        const link = codes.get(String(m.code || "").trim());
        if (!link) { ws.send(JSON.stringify({ type: "error", message: "Code invalide. Regarde le code affiché en jeu." })); return; }
        const old = clients.get(link.userId);
        if (old) old.ws.close(4002, "Connecté ailleurs");
        me = { ws, id: nextId++ % 65535, userId: link.userId, name: link.name, pttMode: false, lastVoice: 0 };
        clients.set(link.userId, me);
        ws.send(JSON.stringify({ type: "joined", name: link.name }));
      }
      if (m.type === "mode" && me) me.pttMode = m.ptt === true;
      return;
    }
    if (!me || muted.has(me.userId) || data.length === 0 || data.length > 8192) return;
    if (me.pttMode && !pttDown.has(me.userId)) return; // mode "appuyer pour parler" : touche N non enfoncée
    me.lastVoice = Date.now();
    relay(me, data);
  });
  ws.on("close", () => { if (me && clients.get(me.userId) === me) clients.delete(me.userId); });
});

server.listen(PORT, () => console.log(`Serveur vocal prêt sur le port ${PORT}`));
