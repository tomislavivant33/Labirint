'use strict';
// LABIRINT STRAHA – server (Node.js + WebSocket)
// Isti proces poslužuje index.html i WebSocket, pa nije potrebno podešavati SERVER_URL.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const CFG = {
  T: 32,               // veličina pločice (px)
  N: 24,               // labirint N x N ćelija -> (2N+1) x (2N+1) pločica
  R: 9,                // polumjer igrača
  TICK: 30,            // simulacija po sekundi
  ROUND: +process.env.ROUND_SECONDS || 120,   // trajanje runde: 2 minute
  INTRO: 3,            // odbrojavanje prije runde
  FREEZE: +process.env.FREEZE_SECONDS || 6,   // ubojica miruje prvih nekoliko sekundi
  VK: 150,             // brzina ubojice
  VS: 120,             // brzina preživjelog
  VSPRINT: 190,        // brzina trčanja
  STAM_MAX: 3,         // sekundi trčanja
  STAM_REGEN: 0.6,
  STAM_BACK: 1,        // nakon iscrpljenja treba se oporaviti do ovoga
  KILL_RANGE: 30,
  KILL_CD: 1.2,
  MISS_CD: 0.35,
  SEE_S: 175,          // vidno polje preživjelih
  SEE_K: 210,          // vidno polje ubojice
  PULSE_FIRST: 30,     // ubojica "njuši" sve preživjele
  PULSE_EVERY: 25,
  PULSE_LEN: 3,
  MAX_PLAYERS: 10,
  MAX_ROOMS: 80,
  AUTO_START: +process.env.AUTO_START_SECONDS || 20,   // javne sobe: odbrojavanje do starta
};

const rand = n => Math.floor(Math.random() * n);
const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- labirint ----------
function genMaze(n) {
  const W = 2 * n + 1;
  const g = Array.from({ length: W }, () => new Array(W).fill(1));
  const vis = Array.from({ length: n }, () => new Array(n).fill(false));
  const stack = [[0, 0]];
  vis[0][0] = true; g[1][1] = 0;
  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const opts = D4.filter(([dx, dy]) => {
      const nx = cx + dx, ny = cy + dy;
      return nx >= 0 && ny >= 0 && nx < n && ny < n && !vis[ny][nx];
    });
    if (!opts.length) { stack.pop(); continue; }
    const [dx, dy] = opts[rand(opts.length)];
    const nx = cx + dx, ny = cy + dy;
    vis[ny][nx] = true;
    g[2 * cy + 1 + dy][2 * cx + 1 + dx] = 0;
    g[2 * ny + 1][2 * nx + 1] = 0;
    stack.push([nx, ny]);
  }
  // petlje: ubojica ne može samo zatvoriti slijepe ulice
  for (let y = 1; y < W - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (g[y][x] === 1 && ((x % 2 === 0 && y % 2 === 1) || (x % 2 === 1 && y % 2 === 0)) && Math.random() < 0.09) g[y][x] = 0;
    }
  }
  // nekoliko otvorenih prostorija
  for (let i = 0; i < 8; i++) {
    const s = rand(2) ? 3 : 5;
    const cx = rand(Math.floor((2 * n - 1 - s) / 2)), cy = rand(Math.floor((2 * n - 1 - s) / 2));
    for (let y = 2 * cy + 1; y <= 2 * cy + s; y++) for (let x = 2 * cx + 1; x <= 2 * cx + s; x++) g[y][x] = 0;
  }
  return g;
}

function bfs(g, sx, sy) {
  const H = g.length, W = g[0].length;
  const d = new Int32Array(W * H).fill(-1);
  const q = [sy * W + sx];
  d[q[0]] = 0;
  for (let i = 0; i < q.length; i++) {
    const c = q[i], x = c % W, y = (c / W) | 0;
    for (const [dx, dy] of D4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || g[ny][nx] === 1) continue;
      const k = ny * W + nx;
      if (d[k] !== -1) continue;
      d[k] = d[c] + 1;
      q.push(k);
    }
  }
  return d;
}

// ---------- fizika ----------
function solid(g, tx, ty) {
  return ty < 0 || tx < 0 || ty >= g.length || tx >= g[0].length || g[ty][tx] === 1;
}
function hits(g, x, y) {
  const T = CFG.T, R = CFG.R;
  const x0 = Math.floor((x - R) / T), x1 = Math.floor((x + R) / T);
  const y0 = Math.floor((y - R) / T), y1 = Math.floor((y + R) / T);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (!solid(g, tx, ty)) continue;
      const cx = Math.max(tx * T, Math.min(x, tx * T + T));
      const cy = Math.max(ty * T, Math.min(y, ty * T + T));
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < R * R) return true;
    }
  }
  return false;
}
function moveBy(g, p, dx, dy) {
  if (!hits(g, p.x + dx, p.y)) p.x += dx;
  if (!hits(g, p.x, p.y + dy)) p.y += dy;
}
function los(g, ax, ay, bx, by) {
  const d = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(d / 8));
  for (let i = 1; i < steps; i++) {
    const x = ax + (bx - ax) * i / steps, y = ay + (by - ay) * i / steps;
    if (solid(g, Math.floor(x / CFG.T), Math.floor(y / CFG.T))) return false;
  }
  return true;
}

// ---------- sobe ----------
const rooms = new Map();
let nextId = 1;

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function newCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += L[rand(L.length)];
    if (!rooms.has(c)) return c;
  }
}
const num = v => (typeof v === 'number' && isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();   // aktivni igrači (spojeni)
    this.rec = new Map();       // svi sudionici trenutne runde (za rezultate)
    this.hostId = null;
    this.phase = 'lobby';       // lobby | intro | play
    this.lastKiller = null;
    this.killerId = null;
    this.grid = null;
    this.public = false;        // javna soba: vidljiva na popisu, automatski start, ulazak i usred runde
    this.autoLeft = null;       // odbrojavanje do automatskog starta (samo javne sobe)
    this.lastCd = null;
    this.mazeRows = null;
    this.startList = [];
  }

  // Igrač koji uđe usred runde (javna soba) gleda kao gledatelj do sljedeće runde.
  addSpectator(ws, name) {
    const p = this.addPlayer(ws, name);
    p.alive = false; p.role = 's'; p.c = this.startList.length;
    p.x = (CFG.N + 0.5) * CFG.T; p.y = (CFG.N + 0.5) * CFG.T;
    this.startList.push({ id: p.id, name: p.name, c: p.c });
    this.broadcastLobby();
    send(ws, this.startMsg(p, true));
    return p;
  }

  startMsg(p, spec) {
    return {
      t: 'start', you: p.id, role: p.role, players: this.startList, maze: this.mazeRows, spec: spec ? 1 : 0,
      cfg: {
        T: CFG.T, R: CFG.R, VK: CFG.VK, VS: CFG.VS, VSPRINT: CFG.VSPRINT, ROUND: CFG.ROUND,
        SEE_S: CFG.SEE_S, SEE_K: CFG.SEE_K, KILL_RANGE: CFG.KILL_RANGE, KILL_CD: CFG.KILL_CD,
        STAM_MAX: CFG.STAM_MAX, PULSE_LEN: CFG.PULSE_LEN,
      },
    };
  }

  addPlayer(ws, name) {
    const p = {
      id: String(nextId++), ws, name, x: 0, y: 0, ix: 0, iy: 0, sprint: false, killReq: false,
      role: 's', alive: true, stam: CFG.STAM_MAX, exh: false, killCd: 0, deathT: 0, left: false, c: 0,
    };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    ws.player = p; ws.room = this;
    return p;
  }

  lobbyMsg(p) {
    return {
      t: 'lobby', room: this.code, you: p.id, host: this.hostId, pub: this.public ? 1 : 0,
      cd: this.autoLeft === null ? 0 : Math.max(1, Math.ceil(this.autoLeft)),
      players: [...this.players.values()].map(q => ({ id: q.id, name: q.name })),
    };
  }
  broadcastLobby() {
    for (const p of this.players.values()) send(p.ws, this.lobbyMsg(p));
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    p.left = true;
    if (this.players.size === 0) { rooms.delete(this.code); return; }
    if (this.hostId === id) this.hostId = this.players.keys().next().value;
    if (this.phase === 'intro' || this.phase === 'play') {
      p.alive = false;
      p.deathT = CFG.ROUND - (this.timeLeft ?? CFG.ROUND);
      if (id === this.killerId) return this.endRound('s', 'Ubojica je napustio igru');
      if (this.players.size < 2 || this.aliveSurvivors() === 0) return this.endRound('k', 'Nema više preživjelih');
    } else {
      this.broadcastLobby();
    }
  }

  aliveSurvivors() {
    let n = 0;
    for (const p of this.players.values()) if (p.role === 's' && p.alive) n++;
    return n;
  }

  startRound() {
    const ids = [...this.players.keys()];
    let pool = ids.filter(i => i !== this.lastKiller);
    if (!pool.length) pool = ids;
    this.killerId = pool[rand(pool.length)];

    const n = CFG.N, T = CFG.T;
    this.grid = genMaze(n);
    const g = this.grid;
    const kc = n >> 1;
    const ktx = 2 * kc + 1, kty = 2 * kc + 1;
    const dist = bfs(g, ktx, kty);
    const W = g[0].length;

    const cells = [];
    let maxD = 0;
    for (let cy = 0; cy < n; cy++) for (let cx = 0; cx < n; cx++) {
      const tx = 2 * cx + 1, ty = 2 * cy + 1, d = dist[ty * W + tx];
      if (d > maxD) maxD = d;
      cells.push([tx, ty, d]);
    }
    let far = shuffle(cells.filter(c => c[2] >= maxD * 0.5));
    const picked = [];
    const need = ids.length - 1;
    for (let sep = 10; sep >= 0 && picked.length < need; sep -= 2) {
      for (const c of far) {
        if (picked.length >= need) break;
        if (picked.includes(c)) continue;
        if (picked.every(q => Math.abs(q[0] - c[0]) + Math.abs(q[1] - c[1]) >= sep)) picked.push(c);
      }
    }

    this.rec = new Map();
    let ci = 0, colorIdx = 0;
    for (const p of this.players.values()) {
      p.alive = true; p.left = false; p.stam = CFG.STAM_MAX; p.exh = false; p.killCd = 0.5;
      p.ix = p.iy = 0; p.sprint = false; p.killReq = false; p.deathT = 0;
      p.c = colorIdx++;
      if (p.id === this.killerId) {
        p.role = 'k'; p.x = (ktx + 0.5) * T; p.y = (kty + 0.5) * T;
      } else {
        p.role = 's';
        const c = picked[ci++] || cells[rand(cells.length)];
        p.x = (c[0] + 0.5) * T; p.y = (c[1] + 0.5) * T;
      }
      this.rec.set(p.id, p);
    }

    this.phase = 'intro';
    this.introLeft = CFG.INTRO;
    this.timeLeft = CFG.ROUND;
    this.freezeLeft = CFG.FREEZE;
    this.seq = 0;

    this.mazeRows = g.map(r => r.join(''));
    this.startList = [...this.players.values()].map(q => ({ id: q.id, name: q.name, c: q.c }));
    this.autoLeft = null; this.lastCd = null;
    for (const p of this.players.values()) send(p.ws, this.startMsg(p, false));
  }

  tick() {
    const dt = 1 / CFG.TICK;
    if (this.phase === 'intro') {
      this.introLeft -= dt;
      if (this.introLeft <= 0) { this.phase = 'play'; this.timeLeft = CFG.ROUND; this.freezeLeft = CFG.FREEZE; }
    } else if (this.phase === 'play') {
      this.step(dt);
    } else if (this.public) {
      this.autoStart(dt);
    }
    if (this.phase === 'intro' || this.phase === 'play') this.broadcastState();
  }

  // Javne sobe se same pokreću kad ima barem 2 igrača, a runde idu jedna za drugom.
  autoStart(dt) {
    if (this.players.size >= 2) {
      if (this.autoLeft === null) this.autoLeft = CFG.AUTO_START;
      this.autoLeft -= dt;
      const s = Math.max(0, Math.ceil(this.autoLeft));
      if (s !== this.lastCd) {
        this.lastCd = s;
        for (const p of this.players.values()) send(p.ws, { t: 'cd', s });
      }
      if (this.autoLeft <= 0) this.startRound();
    } else if (this.autoLeft !== null) {
      this.autoLeft = null; this.lastCd = null;
      for (const p of this.players.values()) send(p.ws, { t: 'cd', s: 0 });
    }
  }

  pulseActive() {
    if (this.phase !== 'play') return false;
    const e = CFG.ROUND - this.timeLeft - CFG.PULSE_FIRST;
    return e >= 0 && (e % CFG.PULSE_EVERY) < CFG.PULSE_LEN;
  }

  step(dt) {
    const g = this.grid;
    this.timeLeft -= dt;
    this.freezeLeft = Math.max(0, this.freezeLeft - dt);

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      let ix = p.ix, iy = p.iy;
      const len = Math.hypot(ix, iy);
      if (len > 1) { ix /= len; iy /= len; }
      const moving = len > 0.05;
      let speed;
      if (p.role === 'k') {
        speed = this.freezeLeft > 0 ? 0 : CFG.VK;
        p.killCd = Math.max(0, p.killCd - dt);
      } else {
        if (p.exh && p.stam >= CFG.STAM_BACK) p.exh = false;
        if (p.sprint && moving && !p.exh && p.stam > 0) {
          speed = CFG.VSPRINT;
          p.stam = Math.max(0, p.stam - dt);
          if (p.stam === 0) p.exh = true;
        } else {
          speed = CFG.VS;
          p.stam = Math.min(CFG.STAM_MAX, p.stam + CFG.STAM_REGEN * dt);
        }
      }
      if (moving && speed > 0) moveBy(g, p, ix * speed * dt, iy * speed * dt);
    }

    // ubijanje
    const killer = this.players.get(this.killerId);
    if (killer && killer.killReq) {
      killer.killReq = false;
      if (killer.alive && this.freezeLeft <= 0 && killer.killCd <= 0) {
        let best = null, bd = CFG.KILL_RANGE;
        for (const p of this.players.values()) {
          if (p.role !== 's' || !p.alive) continue;
          const d = Math.hypot(p.x - killer.x, p.y - killer.y);
          if (d <= bd) { bd = d; best = p; }
        }
        if (best) {
          best.alive = false;
          best.deathT = CFG.ROUND - this.timeLeft;
          killer.killCd = CFG.KILL_CD;
          const ev = { t: 'ev', k: 'kill', id: best.id, name: best.name, x: Math.round(best.x), y: Math.round(best.y) };
          for (const p of this.players.values()) send(p.ws, ev);
        } else {
          killer.killCd = CFG.MISS_CD;
        }
      }
    }

    if (this.aliveSurvivors() === 0) return this.endRound('k', 'Svi preživjeli su eliminirani');
    if (this.timeLeft <= 0) { this.timeLeft = 0; return this.endRound('s', 'Vrijeme je isteklo'); }
  }

  broadcastState() {
    const g = this.grid;
    const pulse = this.pulseActive();
    const killer = this.players.get(this.killerId);
    const alive = this.aliveSurvivors();
    const round1 = v => Math.round(v * 10) / 10;
    const base = {
      t: 's', ph: this.phase === 'play' ? 1 : 0, il: round1(Math.max(0, this.introLeft || 0)),
      tl: round1(this.timeLeft), fz: round1(this.freezeLeft), pl: pulse ? 1 : 0, al: alive,
    };
    for (const me of this.players.values()) {
      const e = [];
      for (const o of this.players.values()) {
        if (o === me) continue;
        let see = false;
        if (!me.alive) see = true;                                   // gledatelji vide sve
        else {
          const d = Math.hypot(o.x - me.x, o.y - me.y);
          if (me.role === 'k') {
            see = (pulse && o.alive) || (d <= CFG.SEE_K && los(g, me.x, me.y, o.x, o.y));
          } else {
            see = d <= CFG.SEE_S && los(g, me.x, me.y, o.x, o.y);
          }
        }
        if (see) e.push([o.id, Math.round(o.x), Math.round(o.y), o.alive ? 1 : 0, o.role === 'k' ? 1 : 0]);
      }
      const msg = Object.assign({}, base, {
        you: {
          x: round1(me.x), y: round1(me.y), a: me.alive ? 1 : 0,
          st: round1(me.stam), ex: me.exh ? 1 : 0, kc: round1(me.killCd || 0),
        },
        e,
      });
      if (me.role === 's' && me.alive && killer) msg.kd = Math.round(Math.hypot(killer.x - me.x, killer.y - me.y));
      send(me.ws, msg);
    }
  }

  endRound(winner, reason) {
    if (this.phase === 'lobby') return;
    const killerRec = this.rec.get(this.killerId);
    const res = [...this.rec.values()].map(p => ({
      name: p.name, role: p.role, alive: !!p.alive && !p.left,
      t: p.role === 's' ? Math.round(p.alive && !p.left ? CFG.ROUND : p.deathT) : null,
    }));
    const msg = { t: 'end', winner, reason, killer: killerRec ? killerRec.name : '?', res };
    for (const p of this.players.values()) send(p.ws, msg);
    this.lastKiller = this.killerId;
    this.phase = 'lobby';
    this.autoLeft = null; this.lastCd = null;
    for (const p of this.players.values()) { p.ix = p.iy = 0; p.alive = true; p.role = 's'; }
    this.broadcastLobby();
  }
}

// ---------- poruke ----------
function cleanName(s, fallback) {
  const n = String(s || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  return n || fallback;
}

function createRoom(ws, isPublic) {
  if (rooms.size >= CFG.MAX_ROOMS) {
    send(ws, { t: 'err', msg: 'Server je trenutno pun. Pokušaj za koju minutu.' });
    return null;
  }
  const room = new Room(newCode());
  room.public = isPublic;
  rooms.set(room.code, room);
  return room;
}

function joinRoom(ws, room, name) {
  if (room.players.size >= CFG.MAX_PLAYERS) return send(ws, { t: 'err', msg: 'Soba je puna (max ' + CFG.MAX_PLAYERS + ').' });
  const nm = cleanName(name, 'Igrač' + (room.players.size + 1));
  if (room.phase === 'lobby') {
    room.addPlayer(ws, nm);
    room.broadcastLobby();
  } else if (room.public) {
    room.addSpectator(ws, nm);          // javna soba: gledaš do sljedeće runde
  } else {
    send(ws, { t: 'err', msg: 'Runda je u tijeku – pričekaj kraj.' });
  }
}

function onMessage(ws, raw) {
  if (raw.length > 1000) return;
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  const p = ws.player;

  switch (m.t) {
    case 'create': {
      if (p) return;
      const room = createRoom(ws, !!m.public);
      if (!room) return;
      const pl = room.addPlayer(ws, cleanName(m.name, 'Igrač'));
      send(ws, room.lobbyMsg(pl));
      break;
    }
    case 'join': {
      if (p) return;
      const code = String(m.room || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'err', msg: 'Soba ' + (code || '????') + ' ne postoji.' });
      joinRoom(ws, room, m.name);
      break;
    }
    case 'quick': {
      // "Brzo igraj": uđi u javnu sobu koja čeka igrače (najpuniju), inače u onu u tijeku (gledaš), inače napravi novu
      if (p) return;
      const open = [...rooms.values()].filter(r => r.public && r.players.size < CFG.MAX_PLAYERS);
      open.sort((a, b) => (b.phase === 'lobby') - (a.phase === 'lobby') || b.players.size - a.players.size);
      const room = open[0] || createRoom(ws, true);
      if (!room) return;
      if (open[0]) joinRoom(ws, room, m.name);
      else { const pl = room.addPlayer(ws, cleanName(m.name, 'Igrač')); send(ws, room.lobbyMsg(pl)); }
      break;
    }
    case 'start': {
      if (!p) return;
      const room = ws.room;
      if (room.phase !== 'lobby' || room.hostId !== p.id) return;
      if (room.players.size < 2) return send(ws, { t: 'err', msg: 'Trebaju najmanje 2 igrača.', soft: 1 });
      room.startRound();
      break;
    }
    case 'in': {
      if (!p) return;
      p.ix = num(m.x); p.iy = num(m.y); p.sprint = !!m.s;
      break;
    }
    case 'kill': {
      if (p && p.role === 'k') p.killReq = true;
      break;
    }
    default:
  }
}

// ---------- HTTP + WS ----------
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (req.url.split('?')[0] === '/api/rooms') {
    const list = [...rooms.values()].filter(r => r.public).map(r => ({
      code: r.code,
      host: (r.players.get(r.hostId) || {}).name || '',
      n: r.players.size, max: CFG.MAX_PLAYERS,
      phase: r.phase === 'lobby' ? 'lobby' : 'play',
    })).sort((a, b) => b.n - a.n);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ rooms: list, online: wss.clients.size }));
  }
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) { res.writeHead(500); return res.end('index.html nije pronađen'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', d => onMessage(ws, d.toString()));
  ws.on('close', () => { if (ws.player && ws.room) ws.room.removePlayer(ws.player.id); });
  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

setInterval(() => {
  for (const r of rooms.values()) r.tick();
}, 1000 / CFG.TICK);

if (require.main === module) {
  server.listen(PORT, () => console.log('Labirint straha sluša na portu ' + PORT));
}

module.exports = { Room, CFG, genMaze, bfs, rooms, server, wss };
