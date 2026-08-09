const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');
const fs      = require('fs');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const ADMIN_CODE = process.env.ADMIN_CODE || 'deveriscool';

/* ── Allowed frontend origins (set your Vercel URL in Railway env vars) ── */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

function isAllowed(origin) {
    if (ALLOWED_ORIGINS.includes('*')) return true;
    return ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o));
}

/* ── Persistent data (clicks + blocked sessions) ── */
function loadData() {
    try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch (_) {}
    return { clicks: {}, blocked: [] };
}
function saveData() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(siteData, null, 2)); } catch (_) {}
}

let siteData = loadData();
if (!Array.isArray(siteData.blocked)) siteData.blocked = []; // migrate older data.json files

let saveTimer = null;
function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveData, 2000);
}

/* ── Online users ── */
const clients = new Map(); // ws -> { id, connectedAt }

function getTopGames(n) {
    return Object.entries(siteData.clicks)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([name, clicks]) => ({ name, clicks }));
}

function getActiveSessions() {
    const byId = new Map();
    clients.forEach((meta, ws) => {
        if (ws.readyState !== ws.OPEN) return;
        if (!meta || !meta.id) return;
        const existing = byId.get(meta.id);
        if (existing) {
            existing.connections += 1;
            if (meta.connectedAt < existing.connectedAt) existing.connectedAt = meta.connectedAt;
        } else {
            byId.set(meta.id, {
                id: meta.id,
                connections: 1,
                connectedAt: meta.connectedAt
            });
        }
    });
    return Array.from(byId.values()).sort((a, b) => a.connectedAt - b.connectedAt);
}

function broadcastStats() {
    const payload = JSON.stringify({
        type:    'stats',
        online:  clients.size,
        popular: getTopGames(15)
    });
    clients.forEach((_, ws) => { if (ws.readyState === ws.OPEN) ws.send(payload); });
}

function trackedCount() {
    return Object.keys(siteData.clicks || {}).length;
}

function isBlocked(id) {
    return siteData.blocked.some(s => s.id === id);
}

function broadcastBlockedList() {
    // let every connected client know the block list changed, so a user who
    // gets blocked mid-session is kicked out immediately, not just on refresh
    const payload = JSON.stringify({ type: 'blocklist', blocked: siteData.blocked.map(s => s.id) });
    clients.forEach((_, ws) => { if (ws.readyState === ws.OPEN) ws.send(payload); });
}

/* ── WebSocket ── */
wss.on('connection', (ws, req) => {
    const origin = req.headers.origin || '';
    if (!isAllowed(origin)) { ws.close(1008, 'Forbidden'); return; }

    clients.set(ws, { id: null, connectedAt: Date.now() });
    broadcastStats();

    ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return; }

        if ((msg.type === 'hello' || msg.type === 'identify') && typeof msg.id === 'string') {
            const id = msg.id.trim();
            if (/^\d{5}$/.test(id)) {
                const meta = clients.get(ws) || { connectedAt: Date.now() };
                meta.id = id;
                clients.set(ws, meta);
            }
            return;
        }

        if (msg.type === 'click' && typeof msg.name === 'string') {
            const name = msg.name.slice(0, 120).replace(/[^\w\s'\-.,!()]/g, '');
            siteData.clicks[name] = (siteData.clicks[name] || 0) + 1;
            scheduleSave();
            broadcastStats();
        }

        if (msg.type === 'check-session' && typeof msg.id === 'string') {
            ws.send(JSON.stringify({ type: 'session-status', id: msg.id, blocked: isBlocked(msg.id) }));
        }
    });

    ws.on('close',  () => { clients.delete(ws); broadcastStats(); });
    ws.on('error',  () => { clients.delete(ws); broadcastStats(); });
});

/* ── Middleware ── */
app.use(express.json());
app.use((req, res, next) => {
    const origin = req.headers.origin || '';
    if (isAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Code');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

function requireAdmin(req, res, next) {
    const code = req.get('X-Admin-Code') || (req.body && req.body.code) || '';
    if (code !== ADMIN_CODE) {
        return res.status(401).json({ error: 'unauthorized — bad admin code' });
    }
    next();
}

app.post('/api/admin/verify', (req, res) => {
    const code = (req.body && req.body.code) || '';
    if (code !== ADMIN_CODE) return res.status(401).json({ error: 'Wrong code', ok: false });
    res.json({ ok: true });
});

app.get('/api/stats', (req, res) => {
    res.json({ online: clients.size, popular: getTopGames(15), tracked: trackedCount() });
});

app.post('/api/click', (req, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'bad name' });
    const clean = name.slice(0, 120).replace(/[^\w\s'\-.,!()]/g, '');
    siteData.clicks[clean] = (siteData.clicks[clean] || 0) + 1;
    scheduleSave();
    broadcastStats();
    res.json({ ok: true, clicks: siteData.clicks[clean] });
});

app.get('/api/popular', (req, res) => {
    res.json(getTopGames(Math.min(parseInt(req.query.n) || 15, 200)));
});

app.delete('/api/popular', requireAdmin, (req, res) => {
    const cleared = Object.keys(siteData.clicks || {}).length;
    siteData.clicks = {};
    scheduleSave();
    broadcastStats();
    res.json({ ok: true, cleared });
});

app.get('/api/admin/sessions', requireAdmin, (req, res) => {
    res.json({
        online: clients.size,
        sessions: getActiveSessions()
    });
});

app.get('/api/admin/popular', requireAdmin, (req, res) => {
    res.json({
        tracked: trackedCount(),
        games: getTopGames(9999)
    });
});

/* ── Session block API ──
   GET stays public so the library can check if a visitor is blocked.
   POST / DELETE require the admin code (header X-Admin-Code). */
app.get('/api/blocked-sessions', (req, res) => {
    res.json({ blocked: siteData.blocked });
});

app.post('/api/blocked-sessions', requireAdmin, (req, res) => {
    const { id } = req.body;
    if (!id || !/^\d{5}$/.test(id)) return res.status(400).json({ error: 'id must be a 5-digit string' });
    if (isBlocked(id)) return res.status(409).json({ error: 'already blocked' });

    siteData.blocked.push({ id, blockedAt: new Date().toISOString() });
    scheduleSave();
    broadcastBlockedList();
    res.json({ ok: true, blocked: siteData.blocked });
});

app.delete('/api/blocked-sessions/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const before = siteData.blocked.length;
    siteData.blocked = siteData.blocked.filter(s => s.id !== id);

    if (siteData.blocked.length === before) return res.status(404).json({ error: 'not found' });

    scheduleSave();
    broadcastBlockedList();
    res.json({ ok: true, blocked: siteData.blocked });
});

app.get('/health', (req, res) => res.json({ ok: true, online: clients.size }));

/* ── Start ── */
server.listen(PORT, () => {
    console.log(`Library backend running on port ${PORT}`);
    console.log(`   Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});