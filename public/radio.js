"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (sec) => {
  if (!(sec >= 0) || !isFinite(sec)) return "–:––";
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(s).padStart(2, "0")}`;
};
const ROLE_NAMES = { guest: "Guest", member: "Member", trusted: "Trusted", officer: "Officer", admin: "Admin" };
const PERM_NAMES = {
  listen: "Listen",
  add: "Add songs",
  queue: "Queue songs",
  playnext: "Play next",
  skip: "Skip",
  remove: "Remove anyone's queued songs",
  delete: "Delete from library",
};

let me = { user: null, role: "guest", perms: [] };
let state = null;
let library = [];
let libv = -1, setv = -1;
let clockOffset = 0, bestRtt = Infinity;
let socket = null, retry = 0;
let player = null, playerReady = false, tunedIn = false, loadedPlayId = null, reportedFor = null;

const can = (p) => me.perms.includes(p);
const serverNow = () => Date.now() + clockOffset;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

let toastTimer;
function toast(msg, error = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (error ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), error ? 6000 : 3000);
}
const attempt = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (e) {
    toast(e.message, true);
  }
};

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
async function loadMe() {
  me = await api("/api/me");
  renderAccount();
  renderPermissionBits();
}

function renderAccount() {
  const el = $("account");
  if (me.user) {
    el.innerHTML = `<span>${esc(me.user.username)} <span class="role">${ROLE_NAMES[me.role]}</span></span>
      ${me.perms.includes("manage") ? '<button class="quiet small" id="open-admin">Settings</button>' : ""}
      <button class="quiet small" id="sign-out">Sign out</button>`;
    $("sign-out").onclick = attempt(async () => {
      await api("/api/logout", { method: "POST" });
      location.reload();
    });
    if ($("open-admin")) $("open-admin").onclick = attempt(openAdmin);
  } else {
    el.innerHTML = `<button class="quiet small" id="sign-in">Sign in</button><button class="small" id="sign-up">Create account</button>`;
    $("sign-in").onclick = () => openAuth("login");
    $("sign-up").onclick = () => openAuth("register");
  }
}

function renderPermissionBits() {
  $("add-form").hidden = !can("add");
  $("add-hint").hidden = !can("add");
  $("skip").hidden = !can("skip");
  if (state) renderState();
  renderLibrary();
}

let authMode = "login";
function openAuth(mode) {
  authMode = mode;
  const reg = mode === "register";
  $("auth-title").textContent = reg ? "Create an account" : "Sign in";
  $("auth-submit").textContent = reg ? "Create account" : "Sign in";
  $("auth-switch").textContent = reg ? "I already have an account" : "Create an account instead";
  $("auth-form").password.autocomplete = reg ? "new-password" : "current-password";
  const note = $("auth-note");
  note.hidden = !reg;
  note.textContent = me.firstAccount
    ? "You're the first one here, so this account will be the station admin."
    : "New accounts can listen right away. An officer can give you access to add songs.";
  $("auth-error").textContent = "";
  if (!$("auth").open) $("auth").showModal();
  $("auth-form").username.focus();
}
$("auth-switch").onclick = () => openAuth(authMode === "login" ? "register" : "login");
$("auth-cancel").onclick = () => $("auth").close();
$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  $("auth-submit").disabled = true;
  try {
    await api(authMode === "register" ? "/api/register" : "/api/login", {
      method: "POST",
      body: { username: f.username.value, password: f.password.value },
    });
    $("auth").close();
    f.reset();
    await loadMe();
    await loadLibrary();
    reconnect();
    toast(authMode === "register" ? "Account created." : "Signed in.");
  } catch (err) {
    $("auth-error").textContent = err.message;
  } finally {
    $("auth-submit").disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
async function openAdmin() {
  const [{ users }, settings] = await Promise.all([api("/api/admin/users"), api("/api/admin/settings")]);
  renderUsers(users, settings.roles);
  renderGrid(settings);
  $("admin-error").textContent = "";
  if (!$("admin").open) $("admin").showModal();
}
$("admin-close").onclick = () => $("admin").close();

function renderUsers(users, roles) {
  $("users").innerHTML =
    `<thead><tr><th>Name</th><th>Role</th><th>Joined</th><th></th></tr></thead><tbody>` +
    users
      .map(
        (u) => `<tr>
      <td>${esc(u.username)}</td>
      <td><select data-user="${u.id}" aria-label="Role for ${esc(u.username)}">${roles
          .map((r) => `<option value="${r}"${r === u.role ? " selected" : ""}>${ROLE_NAMES[r]}</option>`)
          .join("")}</select></td>
      <td class="muted">${new Date(u.created_at).toLocaleDateString()}</td>
      <td>${u.id === me.user.id ? "" : `<button class="quiet small" data-delete-user="${u.id}" data-name="${esc(u.username)}">Remove</button>`}</td>
    </tr>`
      )
      .join("") +
    `</tbody>`;
  for (const sel of $("users").querySelectorAll("select[data-user]")) {
    sel.onchange = attempt(async () => {
      await api(`/api/admin/users/${sel.dataset.user}`, { method: "POST", body: { role: sel.value } });
      toast("Role updated.");
      await openAdmin();
    });
  }
  for (const b of $("users").querySelectorAll("button[data-delete-user]")) {
    b.onclick = attempt(async () => {
      if (!confirm(`Remove ${b.dataset.name}'s account? Songs they added stay in the library.`)) return;
      await api(`/api/admin/users/${b.dataset.deleteUser}`, { method: "DELETE" });
      toast("Account removed.");
      await openAdmin();
    });
  }
}

let gridRoles = [];
function renderGrid(settings) {
  gridRoles = settings.roles.filter((r) => r !== "admin");
  const perms = Object.keys(PERM_NAMES);
  $("perm-grid").innerHTML =
    `<thead><tr><th></th>${gridRoles.map((r) => `<th class="c">${ROLE_NAMES[r]}</th>`).join("")}</tr></thead><tbody>` +
    perms
      .map(
        (p) =>
          `<tr><td>${PERM_NAMES[p]}</td>${gridRoles
            .map(
              (r) =>
                `<td class="c"><input type="checkbox" data-role="${r}" data-perm="${p}" aria-label="${ROLE_NAMES[r]}: ${PERM_NAMES[p]}"${
                  settings.perms[r].includes(p) ? " checked" : ""
                }></td>`
            )
            .join("")}</tr>`
      )
      .join("") +
    `<tr><td>Songs waiting in queue at once<br><span class="muted">0 means no limit</span></td>${gridRoles
      .map(
        (r) =>
          `<td class="c"><input type="number" min="0" max="100" data-cap="${r}" value="${settings.queueCap[r]}" aria-label="${ROLE_NAMES[r]} queue limit"></td>`
      )
      .join("")}</tr></tbody>`;
}
$("admin-save").onclick = async () => {
  const perms = {}, queueCap = {};
  for (const r of gridRoles) {
    perms[r] = [...$("perm-grid").querySelectorAll(`input[data-role="${r}"]:checked`)].map((i) => i.dataset.perm);
    queueCap[r] = Number($("perm-grid").querySelector(`input[data-cap="${r}"]`).value);
  }
  try {
    await api("/api/admin/settings", { method: "PUT", body: { perms, queueCap } });
    $("admin-error").textContent = "";
    toast("Permissions saved.");
  } catch (e) {
    $("admin-error").textContent = e.message;
  }
};

// ---------------------------------------------------------------------------
// Live connection
// ---------------------------------------------------------------------------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
  socket = ws;
  let opened = false;
  ws.onopen = () => {
    opened = true;
    retry = 0;
    ping();
    if (tunedIn) send({ type: "tune", on: true });
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "pong") {
      const rtt = Date.now() - m.t;
      if (rtt < bestRtt) {
        bestRtt = rtt;
        clockOffset = m.serverTime + rtt / 2 - Date.now();
      }
    } else if (m.type === "state") {
      if (bestRtt === Infinity) clockOffset = m.serverTime - Date.now();
      onState(m);
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    if (!opened && !can("listen")) {
      showLocked();
      return;
    }
    const wait = Math.min(30000, 1000 * 2 ** retry++);
    $("np-title").textContent = "Reconnecting…";
    setTimeout(connect, wait);
  };
}
function reconnect() {
  const old = socket;
  socket = null;
  if (old) old.close();
  if (can("listen")) connect();
  else showLocked();
}
function send(msg) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
}
function ping() {
  send({ type: "ping", t: Date.now() });
}
setInterval(ping, 30000);

function showLocked() {
  $("np-title").textContent = "Sign in to listen";
  $("np-meta").textContent = "The radio is open to guild members only right now.";
  $("tune").hidden = false;
  $("tune-btn").disabled = true;
}

function onState(s) {
  state = s;
  if (s.libv !== libv) {
    libv = s.libv;
    loadLibrary().catch(() => {});
  }
  if (s.setv !== setv) {
    const first = setv === -1;
    setv = s.setv;
    if (!first) loadMe().catch(() => {});
  }
  renderState();
  syncPlayer();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function sourceLine(now) {
  if (now.source === "queue") return `<span class="source">Queued${now.by ? ` by ${esc(now.by)}` : ""}</span>`;
  if (now.source === "new") return `<span class="source new">New to the library${now.track.added_by ? `, added by ${esc(now.track.added_by)}` : ""}</span>`;
  return `Shuffle${now.track.added_by ? `, added by ${esc(now.track.added_by)}` : ""}`;
}

function renderState() {
  const s = state;
  const now = s.now;
  if (now) {
    $("np-title").textContent = now.track.title;
    $("np-meta").innerHTML = `${esc(now.track.channel)} · ${sourceLine(now)}`;
    document.title = `${now.track.title} · Schism radio`;
  } else {
    $("np-title").textContent = "Nothing playing";
    $("np-meta").textContent = can("add") ? "Paste a YouTube link in the library to start the station." : "The library is empty. Members can add songs.";
    document.title = "Schism radio";
  }
  $("listeners").textContent = `${s.listeners} listening`;
  $("tune-btn").disabled = !now || !playerReady;

  const q = $("queue");
  q.innerHTML = s.queue.length
    ? s.queue
        .map((it) => {
          const mine = me.user && it.user_id === me.user.id;
          const removable = can("remove") || mine;
          return `<li><span class="t">${esc(it.title)}</span>
            <span class="s">${it.priority === 0 ? '<span class="next-flag">Playing next</span> · ' : ""}${it.by ? `Queued by ${esc(it.by)}` : "Queued"}</span>
            <span class="acts">${removable ? `<button class="quiet small" data-dequeue="${it.id}" aria-label="Remove ${esc(it.title)} from the queue">Remove</button>` : ""}</span></li>`;
        })
        .join("")
    : `<li class="empty">The queue is empty.</li>`;
  for (const b of q.querySelectorAll("[data-dequeue]"))
    b.onclick = attempt(() => api(`/api/queue/${b.dataset.dequeue}`, { method: "DELETE" }));

  const fresh = s.freshCount;
  $("then").textContent = s.libSize
    ? fresh
      ? `Then ${fresh} new ${fresh === 1 ? "song" : "songs"}, then shuffle across all ${s.libSize}.`
      : `Then shuffle across all ${s.libSize} songs.`
    : "";

  $("recent").innerHTML = s.recent.length
    ? s.recent
        .map(
          (r) => `<li><span class="t">${esc(r.title)}</span><span class="s">${new Date(r.played_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${
            r.source === "new" ? " · first play" : ""
          }</span></li>`
        )
        .join("")
    : `<li class="empty">Nothing yet.</li>`;
}

async function loadLibrary() {
  if (!can("listen")) {
    library = [];
    renderLibrary();
    return;
  }
  library = (await api("/api/library")).tracks;
  renderLibrary();
}

function renderLibrary() {
  const list = $("library");
  if (!can("listen")) {
    list.innerHTML = `<li class="locked">Sign in to see the library.</li>`;
    $("lib-count").textContent = "";
    return;
  }
  const term = $("search").value.trim().toLowerCase();
  const rows = term
    ? library.filter((t) => `${t.title} ${t.channel} ${t.added_by || ""}`.toLowerCase().includes(term))
    : library;
  $("lib-count").textContent = term
    ? `${rows.length} of ${library.length} songs`
    : `${library.length} ${library.length === 1 ? "song" : "songs"}, newest first`;
  const queued = new Set((state?.queue || []).map((q) => q.track_id));
  list.innerHTML = rows.length
    ? rows
        .map((t) => {
          const inQueue = queued.has(t.id);
          const acts = [
            can("queue") ? `<button class="quiet small" data-q="${t.id}"${inQueue ? " disabled" : ""}>${inQueue ? "Queued" : "Queue"}</button>` : "",
            can("playnext") && !inQueue ? `<button class="quiet small" data-n="${t.id}">Play next</button>` : "",
            can("delete") ? `<button class="quiet small" data-del="${t.id}" aria-label="Delete ${esc(t.title)}">Delete</button>` : "",
          ].join("");
          return `<li><span class="t" title="${esc(t.title)}">${esc(t.title)}</span>
            <span class="s">${t.play_count === 0 ? '<span class="source new">New</span> · ' : ""}${esc(t.channel)}${t.added_by ? ` · added by ${esc(t.added_by)}` : ""}${
            t.duration ? ` · ${fmt(t.duration)}` : ""
          }</span>
            <span class="acts">${acts}</span></li>`;
        })
        .join("")
    : `<li class="empty">${library.length ? "No songs match that search." : "The library is empty. Paste a YouTube link above to add the first song."}</li>`;
  for (const b of list.querySelectorAll("[data-q]"))
    b.onclick = attempt(async () => {
      await api("/api/queue", { method: "POST", body: { trackId: +b.dataset.q } });
      toast("Added to the queue.");
    });
  for (const b of list.querySelectorAll("[data-n]"))
    b.onclick = attempt(async () => {
      await api("/api/queue", { method: "POST", body: { trackId: +b.dataset.n, next: true } });
      toast("Playing next.");
    });
  for (const b of list.querySelectorAll("[data-del]"))
    b.onclick = attempt(async () => {
      const t = library.find((x) => x.id === +b.dataset.del);
      if (!confirm(`Delete "${t?.title}" from the library for everyone?`)) return;
      await api(`/api/tracks/${b.dataset.del}`, { method: "DELETE" });
      toast("Deleted.");
    });
}
$("search").addEventListener("input", renderLibrary);

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("add-url");
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const r = await api("/api/tracks", { method: "POST", body: { url: input.value } });
    input.value = "";
    toast(r.existed ? `"${r.track.title}" is already in the library.` : `Added "${r.track.title}".`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$("skip").onclick = attempt(() => api("/api/skip", { method: "POST" }));

// Progress bar runs off the server clock, not the player, so it's right even before you tune in.
function tickProgress() {
  const now = state?.now;
  if (now) {
    const elapsed = Math.max(0, (serverNow() - now.startedAt) / 1000);
    const dur = now.duration || (loadedPlayId === now.playId && playerReady ? player.getDuration() : 0);
    $("elapsed").textContent = fmt(dur ? Math.min(elapsed, dur) : elapsed);
    $("total").textContent = fmt(dur || NaN);
    $("bar").style.width = dur ? `${Math.min(100, (elapsed / dur) * 100)}%` : "0";
  } else {
    $("elapsed").textContent = "0:00";
    $("total").textContent = "–:––";
    $("bar").style.width = "0";
  }
}
setInterval(tickProgress, 500);

// ---------------------------------------------------------------------------
// YouTube player
// ---------------------------------------------------------------------------
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("yt", {
    width: "100%",
    height: "100%",
    playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0 },
    events: {
      onReady: () => {
        playerReady = true;
        player.setVolume(+$("volume").value);
        if (state) {
          renderState();
          syncPlayer();
        }
      },
      onStateChange: (e) => {
        const now = state?.now;
        if (!now || loadedPlayId !== now.playId) return;
        if (e.data === YT.PlayerState.PLAYING && reportedFor !== now.playId) {
          const d = player.getDuration();
          if (d > 0) {
            reportedFor = now.playId;
            if (!now.duration) send({ type: "duration", playId: now.playId, seconds: d });
          }
        }
        if (e.data === YT.PlayerState.ENDED) send({ type: "ended", playId: now.playId });
      },
      onError: (e) => {
        const now = state?.now;
        if (now) send({ type: "error", playId: now.playId, code: e.data });
      },
    },
  });
};
(() => {
  const s = document.createElement("script");
  s.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(s);
})();

function expectedPosition() {
  return Math.max(0, (serverNow() - state.now.startedAt) / 1000);
}

function syncPlayer() {
  if (!playerReady || !state) return;
  const now = state.now;
  if (!now) {
    if (loadedPlayId) player.stopVideo();
    loadedPlayId = null;
    return;
  }
  if (loadedPlayId !== now.playId) {
    loadedPlayId = now.playId;
    const opts = { videoId: now.track.video_id, startSeconds: expectedPosition() };
    if (tunedIn) player.loadVideoById(opts);
    else player.cueVideoById(opts);
    return;
  }
  if (!tunedIn) return;
  const st = player.getPlayerState();
  if (st === YT.PlayerState.PAUSED || st === YT.PlayerState.CUED) player.playVideo();
  if (st === YT.PlayerState.PLAYING) {
    const want = expectedPosition();
    const dur = player.getDuration();
    if (Math.abs(player.getCurrentTime() - want) > 2.5 && (!dur || want < dur - 1)) player.seekTo(want, true);
  }
}
setInterval(syncPlayer, 4000);

$("tune-btn").onclick = () => {
  if (!playerReady || !state?.now) return;
  tunedIn = true;
  player.unMute();
  player.setVolume(+$("volume").value);
  loadedPlayId = null; // force a fresh load at the live position
  syncPlayer();
  send({ type: "tune", on: true });
  $("tune").hidden = true;
  $("stop").hidden = false;
};
$("stop").onclick = () => {
  tunedIn = false;
  if (playerReady) player.pauseVideo();
  send({ type: "tune", on: false });
  $("tune").hidden = false;
  $("tune-msg").textContent = "You're tuned out. The station keeps playing for everyone else.";
  $("tune-btn").textContent = "Tune back in";
  $("stop").hidden = true;
};
$("volume").oninput = () => playerReady && player.setVolume(+$("volume").value);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
(async () => {
  try {
    await loadMe();
  } catch (e) {
    toast(e.message, true);
  }
  if (can("listen")) {
    connect();
    loadLibrary().catch((e) => toast(e.message, true));
  } else showLocked();
})();
