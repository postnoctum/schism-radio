import Database from "better-sqlite3";
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

const scryptAsync = promisify(scrypt);

// ---------------------------------------------------------------------------
// Roles and permissions
// ---------------------------------------------------------------------------
export const ROLES = ["guest", "member", "trusted", "officer", "admin"];
export const PERMS = ["listen", "add", "queue", "playnext", "skip", "remove", "delete", "manage"];

const DEFAULTS = {
  perms: {
    guest: ["listen"],
    member: ["listen", "add", "queue"],
    trusted: ["listen", "add", "queue", "playnext"],
    officer: ["listen", "add", "queue", "playnext", "skip", "remove"],
    admin: [...PERMS],
  },
  // Max songs one person can have waiting in the queue. 0 = no limit.
  queueCap: { guest: 1, member: 3, trusted: 5, officer: 0, admin: 0 },
};

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
// YouTube player errors that mean the video itself can't play (not the listener's browser).
const VIDEO_ERRORS = new Set([2, 100, 101, 150]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,
  video_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  channel TEXT,
  duration REAL,
  added_by INTEGER,
  added_at INTEGER NOT NULL,
  play_count INTEGER NOT NULL DEFAULT 0,
  last_played INTEGER
);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL,
  user_id INTEGER,
  priority INTEGER NOT NULL,   -- 0 = play next, 1 = queue
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY,
  track_id INTEGER NOT NULL,
  played_at INTEGER NOT NULL,
  source TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

export function getCookie(header, name) {
  for (const part of String(header || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

// scrypt: memory-hard, built into Node, no native add-ons needed.
async function hashPassword(password, saltB64) {
  const salt = saltB64 ? Buffer.from(saltB64, "base64") : randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return { hash: key.toString("base64"), salt: salt.toString("base64") };
}
async function verifyPassword(password, salt, hash) {
  const { hash: attempt } = await hashPassword(password, salt);
  const a = Buffer.from(attempt, "base64");
  const b = Buffer.from(hash, "base64");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Accepts watch URLs, youtu.be, shorts, embed, live, music.youtube.com, or a bare 11-char id.
export function parseVideoId(input) {
  const s = String(input || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try {
    u = new URL(s.startsWith("http") ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  const ok = (id) => (id && /^[\w-]{11}$/.test(id.slice(0, 11)) ? id.slice(0, 11) : null);
  if (host === "youtu.be") return ok(u.pathname.slice(1));
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.searchParams.get("v")) return ok(u.searchParams.get("v"));
    const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/);
    if (m) return m[2];
  }
  return null;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Looks up a video's title and whether it allows embedding. Swappable for tests.
export async function youtubeLookup(videoId) {
  const res = await fetch(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`
  );
  if (!res.ok) return null;
  const meta = await res.json();
  return { title: meta.title, channel: meta.author_name };
}

// ---------------------------------------------------------------------------
// The station
// ---------------------------------------------------------------------------
export class Station {
  constructor({ dataDir, lookup = youtubeLookup }) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "radio.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.lookup = lookup;
    this.sockets = new Set();
    this.timer = null;
    this.scheduleEnd(this.kvGet("now")); // pick up where we left off after a restart
  }

  close() {
    clearTimeout(this.timer);
    this.db.close();
  }

  // --- small storage helpers -------------------------------------------------
  all(sql, ...args) {
    return this.db.prepare(sql).all(...args);
  }
  get(sql, ...args) {
    return this.db.prepare(sql).get(...args);
  }
  run(sql, ...args) {
    return this.db.prepare(sql).run(...args);
  }
  count(sql, ...args) {
    return this.get(sql, ...args).n;
  }
  kvGet(k, fallback = null) {
    const row = this.get("SELECT v FROM kv WHERE k = ?", k);
    return row ? JSON.parse(row.v) : fallback;
  }
  kvSet(k, v) {
    this.run("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
  }
  kvDel(k) {
    this.run("DELETE FROM kv WHERE k = ?", k);
  }
  bump(k) {
    this.kvSet(k, this.kvGet(k, 0) + 1);
  }
  track(id) {
    return this.get(
      `SELECT t.id, t.video_id, t.title, t.channel, t.duration, t.added_at, t.play_count, u.username AS added_by
       FROM tracks t LEFT JOIN users u ON u.id = t.added_by WHERE t.id = ?`,
      id
    );
  }

  // --- permissions ----------------------------------------------------------
  settings() {
    const saved = this.kvGet("settings", {});
    const perms = {};
    const queueCap = {};
    for (const r of ROLES) {
      perms[r] = r === "admin" ? [...PERMS] : saved.perms?.[r] ?? DEFAULTS.perms[r];
      queueCap[r] = saved.queueCap?.[r] ?? DEFAULTS.queueCap[r];
    }
    return { perms, queueCap };
  }
  can(user, perm) {
    return this.settings().perms[user?.role ?? "guest"].includes(perm);
  }
  need(user, perm) {
    if (!this.can(user, perm)) fail(user ? 403 : 401, user ? "Your role doesn't allow that." : "Sign in first.");
  }

  // --- HTTP API -------------------------------------------------------------
  // Takes a plain object: { method, path, cookie, body } and returns { status, body, cookie? }.
  async handle({ method, path, cookie, body = {} }) {
    try {
      const user = this.userFrom(cookie);
      let m;

      if (path === "/api/me" && method === "GET") return ok(this.me(user));
      if (path === "/api/register" && method === "POST") return await this.register(body);
      if (path === "/api/login" && method === "POST") return await this.login(body);
      if (path === "/api/logout" && method === "POST") return this.logout(cookie);

      if (path === "/api/library" && method === "GET") {
        this.need(user, "listen");
        return ok({ tracks: this.library() });
      }
      if (path === "/api/tracks" && method === "POST") return ok(await this.addTrack(user, body));
      if ((m = path.match(/^\/api\/tracks\/(\d+)$/)) && method === "DELETE") return ok(this.deleteTrack(user, +m[1]));
      if (path === "/api/queue" && method === "POST") {
        this.enqueue(user, Number(body.trackId), !!body.next);
        this.changed();
        return ok({ ok: true });
      }
      if ((m = path.match(/^\/api\/queue\/(\d+)$/)) && method === "DELETE") return ok(this.dequeue(user, +m[1]));
      if (path === "/api/skip" && method === "POST") return ok(this.skip(user));

      if (path === "/api/admin/users" && method === "GET") {
        this.need(user, "manage");
        return ok({ users: this.all("SELECT id, username, role, created_at FROM users ORDER BY username") });
      }
      if ((m = path.match(/^\/api\/admin\/users\/(\d+)$/))) {
        this.need(user, "manage");
        if (method === "POST") return ok(this.setRole(+m[1], body.role));
        if (method === "DELETE") return ok(this.deleteUser(+m[1]));
      }
      if (path === "/api/admin/settings") {
        this.need(user, "manage");
        if (method === "GET") return ok({ ...this.settings(), roles: ROLES, permissions: PERMS });
        if (method === "PUT") return ok(this.saveSettings(body));
      }
      fail(404, "Not found.");
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
      console.error(e);
      return { status: 500, body: { error: "Something went wrong on the server." } };
    }
  }

  // --- accounts -------------------------------------------------------------
  userFrom(cookieHeader) {
    const token = getCookie(cookieHeader, "sid");
    if (!token) return null;
    return (
      this.get(
        `SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires > ?`,
        token,
        Date.now()
      ) || null
    );
  }

  me(user) {
    const role = user?.role ?? "guest";
    const s = this.settings();
    return {
      user: user ? { id: user.id, username: user.username, role } : null,
      role,
      perms: s.perms[role],
      queueCap: s.queueCap[role],
      firstAccount: this.count("SELECT COUNT(*) AS n FROM users") === 0,
    };
  }

  startSession(userId, payload) {
    const token = randomBytes(32).toString("hex");
    this.run("INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)", token, userId, Date.now() + SESSION_MS);
    return { status: 200, body: payload, cookie: { value: token, maxAge: SESSION_MS / 1000 } };
  }

  async register(b) {
    const name = String(b.username || "").trim();
    const password = b.password;
    if (!/^[A-Za-z0-9_-]{2,24}$/.test(name))
      fail(400, "Usernames are 2–24 characters: letters, numbers, dashes, or underscores.");
    if (typeof password !== "string" || password.length < 8 || password.length > 200)
      fail(400, "Passwords need at least 8 characters.");
    if (this.count("SELECT COUNT(*) AS n FROM users WHERE username = ?", name)) fail(409, "That username is taken.");

    const { hash, salt } = await hashPassword(password);
    // The very first account runs the place.
    const role = this.count("SELECT COUNT(*) AS n FROM users") === 0 ? "admin" : "guest";
    let id;
    try {
      id = this.get(
        "INSERT INTO users (username, hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
        name,
        hash,
        salt,
        role,
        Date.now()
      ).id;
    } catch {
      fail(409, "That username is taken.");
    }
    return this.startSession(id, { user: { id, username: name, role } });
  }

  async login(b) {
    const name = String(b.username || "").trim();
    const key = `fail:${name.toLowerCase()}`;
    const attempts = this.kvGet(key, { n: 0, until: 0 });
    if (attempts.until > Date.now()) fail(429, "Too many wrong passwords. Try again in 5 minutes.");

    const u = this.get("SELECT id, username, role, hash, salt FROM users WHERE username = ?", name);
    const good = u && typeof b.password === "string" && (await verifyPassword(b.password, u.salt, u.hash));
    if (!good) {
      attempts.n += 1;
      if (attempts.n >= 5) Object.assign(attempts, { n: 0, until: Date.now() + 5 * 60 * 1000 });
      this.kvSet(key, attempts);
      fail(401, "Wrong username or password.");
    }
    this.kvDel(key);
    this.run("DELETE FROM sessions WHERE expires < ?", Date.now());
    return this.startSession(u.id, { user: { id: u.id, username: u.username, role: u.role } });
  }

  logout(cookieHeader) {
    const token = getCookie(cookieHeader, "sid");
    if (token) this.run("DELETE FROM sessions WHERE token = ?", token);
    return { status: 200, body: { ok: true }, cookie: { value: "", maxAge: 0 } };
  }

  setRole(id, role) {
    if (!ROLES.includes(role)) fail(400, "Unknown role.");
    const target = this.get("SELECT role FROM users WHERE id = ?", id);
    if (!target) fail(404, "That account no longer exists.");
    if (target.role === "admin" && role !== "admin" && this.count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'") === 1)
      fail(400, "Promote someone else to admin first. The station needs at least one.");
    this.run("UPDATE users SET role = ? WHERE id = ?", role, id);
    this.bump("setv");
    this.broadcast();
    return { ok: true };
  }

  deleteUser(id) {
    const target = this.get("SELECT role FROM users WHERE id = ?", id);
    if (!target) fail(404, "That account no longer exists.");
    if (target.role === "admin" && this.count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'") === 1)
      fail(400, "You can't delete the last admin.");
    this.run("DELETE FROM sessions WHERE user_id = ?", id);
    this.run("DELETE FROM queue WHERE user_id = ?", id);
    this.run("DELETE FROM users WHERE id = ?", id);
    this.changed();
    return { ok: true };
  }

  saveSettings(input) {
    const perms = {};
    const queueCap = {};
    for (const r of ROLES) {
      if (r !== "admin")
        perms[r] = Array.isArray(input.perms?.[r])
          ? PERMS.filter((p) => p !== "manage" && input.perms[r].includes(p))
          : DEFAULTS.perms[r];
      const cap = Math.floor(Number(input.queueCap?.[r]));
      queueCap[r] = cap >= 0 && cap <= 100 ? cap : DEFAULTS.queueCap[r];
    }
    this.kvSet("settings", { perms, queueCap });
    this.bump("setv");
    this.broadcast();
    return this.settings();
  }

  // --- library and queue ----------------------------------------------------
  library() {
    return this.all(
      `SELECT t.id, t.video_id, t.title, t.channel, t.duration, t.added_at, t.play_count, u.username AS added_by
       FROM tracks t LEFT JOIN users u ON u.id = t.added_by ORDER BY t.added_at DESC`
    );
  }

  async addTrack(user, b) {
    this.need(user, "add");
    const then = b.then === "queue" || b.then === "next" ? b.then : null;
    if (then) this.need(user, then === "next" ? "playnext" : "queue");

    const vid = parseVideoId(b.url);
    if (!vid) fail(400, "Paste a YouTube link, like youtube.com/watch?v=… or youtu.be/…");

    let row = this.get("SELECT id FROM tracks WHERE video_id = ?", vid);
    const existed = !!row;
    if (!row) {
      let meta;
      try {
        meta = await this.lookup(vid);
      } catch {
        fail(502, "Couldn't reach YouTube to check that link. Try again in a minute.");
      }
      if (!meta) fail(422, "That video is private, removed, or blocks playback on other sites. Try a different upload.");
      row = this.get("SELECT id FROM tracks WHERE video_id = ?", vid); // someone may have beaten us
      if (!row) {
        row = this.get(
          "INSERT INTO tracks (video_id, title, channel, added_by, added_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
          vid,
          String(meta.title || "Untitled").slice(0, 300),
          String(meta.channel || "").slice(0, 200),
          user?.id ?? null,
          Date.now()
        );
        this.bump("libv");
      }
    }
    if (then) this.enqueue(user, row.id, then === "next");
    this.changed();
    return { track: this.track(row.id), existed };
  }

  deleteTrack(user, id) {
    this.need(user, "delete");
    if (!this.track(id)) fail(404, "That song is already gone.");
    this.run("DELETE FROM queue WHERE track_id = ?", id);
    this.run("DELETE FROM history WHERE track_id = ?", id);
    this.run("DELETE FROM tracks WHERE id = ?", id);
    this.bump("libv");
    if (this.kvGet("now")?.trackId === id) this.advance();
    this.changed();
    return { ok: true };
  }

  enqueue(user, trackId, next) {
    this.need(user, next ? "playnext" : "queue");
    if (!this.track(trackId)) fail(404, "That song isn't in the library.");
    if (this.count("SELECT COUNT(*) AS n FROM queue WHERE track_id = ?", trackId)) fail(409, "That song is already in the queue.");
    const cap = this.settings().queueCap[user?.role ?? "guest"];
    if (user && cap > 0 && this.count("SELECT COUNT(*) AS n FROM queue WHERE user_id = ?", user.id) >= cap)
      fail(429, `You can have ${cap} ${cap === 1 ? "song" : "songs"} waiting at a time. Try again after one plays.`);
    this.run(
      "INSERT INTO queue (track_id, user_id, priority, created_at) VALUES (?, ?, ?, ?)",
      trackId,
      user?.id ?? null,
      next ? 0 : 1,
      Date.now()
    );
  }

  dequeue(user, id) {
    const row = this.get("SELECT user_id FROM queue WHERE id = ?", id);
    if (!row) fail(404, "That song already left the queue.");
    if (!(this.can(user, "remove") || (user && row.user_id === user.id))) fail(403, "You can only remove songs you queued.");
    this.run("DELETE FROM queue WHERE id = ?", id);
    this.changed();
    return { ok: true };
  }

  skip(user) {
    this.need(user, "skip");
    this.advance();
    this.changed();
    return { ok: true };
  }

  // --- choosing what plays --------------------------------------------------
  // 1. Play Next  2. Queue  3. Songs never played yet (oldest first)  4. Shuffle bag
  pickNext(currentId) {
    const q = this.get(
      `SELECT q.id, q.track_id, u.username FROM queue q LEFT JOIN users u ON u.id = q.user_id
       ORDER BY q.priority, q.id LIMIT 1`
    );
    if (q) {
      this.run("DELETE FROM queue WHERE id = ?", q.id);
      return { trackId: q.track_id, source: "queue", by: q.username || null };
    }

    const fresh = this.get(
      "SELECT id FROM tracks WHERE play_count = 0 AND id != ? ORDER BY added_at, id LIMIT 1",
      currentId ?? -1
    );
    if (fresh) return { trackId: fresh.id, source: "new" };

    // Shuffle bag: every song plays once before anything repeats.
    let bag = this.kvGet("bag", []);
    for (;;) {
      while (bag.length) {
        const id = bag.shift();
        if (id !== currentId && this.track(id)) {
          this.kvSet("bag", bag);
          return { trackId: id, source: "shuffle" };
        }
      }
      const all = this.all("SELECT id FROM tracks").map((r) => r.id);
      if (!all.length) {
        this.kvSet("bag", []);
        return null;
      }
      if (all.length === 1) {
        this.kvSet("bag", []);
        return { trackId: all[0], source: "shuffle" };
      }
      bag = shuffle(all.filter((id) => id !== currentId));
    }
  }

  advance() {
    const prev = this.kvGet("now");
    const next = this.pickNext(prev?.trackId);
    clearTimeout(this.timer);
    if (!next) {
      this.kvSet("now", null);
      return;
    }
    const t = this.track(next.trackId);
    const now = {
      playId: randomUUID(),
      trackId: t.id,
      startedAt: Date.now(),
      duration: t.duration || null,
      source: next.source,
      by: next.by || null,
    };
    this.run("UPDATE tracks SET play_count = play_count + 1, last_played = ? WHERE id = ?", now.startedAt, t.id);
    this.run("INSERT INTO history (track_id, played_at, source) VALUES (?, ?, ?)", t.id, now.startedAt, next.source);
    this.run("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 100)");
    // Whatever just played counts as this round's play, so drop it from the bag.
    this.kvSet("bag", this.kvGet("bag", []).filter((id) => id !== t.id));
    this.kvSet("now", now);
    this.scheduleEnd(now);
  }

  scheduleEnd(now) {
    clearTimeout(this.timer);
    if (!now?.duration) return;
    const wait = Math.max(0, now.startedAt + now.duration * 1000 + 1000 - Date.now());
    this.timer = setTimeout(() => this.onSongEnd(), wait);
  }

  isOver(now) {
    return !!now?.duration && Date.now() > now.startedAt + now.duration * 1000 + 1000;
  }

  // Start something if the station is silent or the current song ran out while nobody was listening.
  ensurePlaying() {
    const now = this.kvGet("now");
    if (!now || this.isOver(now)) this.advance();
  }

  changed() {
    this.ensurePlaying();
    this.broadcast();
  }

  onSongEnd() {
    const now = this.kvGet("now");
    if (!now?.duration) return;
    if (!this.isOver(now)) return this.scheduleEnd(now);
    // Nobody tuned in: hold here so new songs aren't "played" to an empty room.
    if (this.listeners().length === 0) return;
    this.advance();
    this.broadcast();
  }

  // --- live connections -----------------------------------------------------
  open() {
    return [...this.sockets].filter((ws) => ws.readyState === 1);
  }
  // Only people who pressed "Tune in" count as listening.
  listeners() {
    return this.open().filter((ws) => ws.tuned);
  }

  addSocket(ws) {
    ws.tuned = false;
    this.sockets.add(ws);
    ws.on("message", (data) => this.onMessage(ws, data.toString()));
    ws.on("close", () => {
      this.sockets.delete(ws);
      this.broadcast();
    });
    ws.on("error", () => {});
    this.ensurePlaying();
    this.broadcast();
  }

  state() {
    const now = this.kvGet("now");
    return {
      type: "state",
      serverTime: Date.now(),
      now: now ? { ...now, track: this.track(now.trackId) } : null,
      queue: this.all(
        `SELECT q.id, q.priority, q.user_id, u.username AS by, t.id AS track_id, t.title, t.channel, t.video_id, t.duration
         FROM queue q JOIN tracks t ON t.id = q.track_id LEFT JOIN users u ON u.id = q.user_id
         ORDER BY q.priority, q.id`
      ),
      freshCount: this.count("SELECT COUNT(*) AS n FROM tracks WHERE play_count = 0"),
      libSize: this.count("SELECT COUNT(*) AS n FROM tracks"),
      recent: this.all(
        `SELECT h.played_at, h.source, t.id AS track_id, t.title, t.channel
         FROM history h JOIN tracks t ON t.id = h.track_id ORDER BY h.id DESC LIMIT 10 OFFSET ?`,
        now ? 1 : 0
      ),
      listeners: this.listeners().length,
      libv: this.kvGet("libv", 0),
      setv: this.kvGet("setv", 0),
    };
  }

  broadcast() {
    if (!this.sockets.size) return;
    const msg = JSON.stringify(this.state());
    for (const ws of this.open()) ws.send(msg);
  }

  onMessage(ws, raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "ping") return ws.send(JSON.stringify({ type: "pong", t: m.t, serverTime: Date.now() }));
    if (m.type === "tune") {
      ws.tuned = !!m.on;
      if (m.on) this.ensurePlaying();
      this.broadcast();
      return;
    }

    const now = this.kvGet("now");
    if (!now || m.playId !== now.playId) return;

    if (m.type === "duration") {
      // The first listener to load a song tells us how long it is; we remember it for next time.
      const d = Number(m.seconds);
      if (now.duration || !(d > 0 && d < 6 * 3600)) return;
      this.run("UPDATE tracks SET duration = ? WHERE id = ?", d, now.trackId);
      now.duration = d;
      this.kvSet("now", now);
      if (this.isOver(now)) this.advance();
      else this.scheduleEnd(now);
      this.broadcast();
    } else if (m.type === "ended") {
      const earliest = now.duration ? now.startedAt + (now.duration - 5) * 1000 : now.startedAt + 10000;
      if (Date.now() >= earliest) {
        this.advance();
        this.broadcast();
      }
    } else if (m.type === "error" && VIDEO_ERRORS.has(Number(m.code))) {
      this.advance();
      this.broadcast();
    }
  }
}

const ok = (body) => ({ status: 200, body });
