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

/* ── Allowed frontend origins (set your Vercel URL in Railway env vars) ── */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

function isAllowed(origin) {
    if (ALLOWED_ORIGINS.includes('*')) return true;
    return ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o));
}

/* ── Persistent click data ── */
function loadData() {
    try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
    catch (_) {}
    return { clicks: {} };
}
function saveData() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(siteData, null, 2)); } catch (_) {}
}

let siteData  = loadData();
let saveTimer = null;
function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveData, 2000);
}

/* ── Online users ── */
const clients = new Set();

function getTopGames(n) {
    return Object.entries(siteData.clicks)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([name, clicks]) => ({ name, clicks }));
}

function broadcastStats() {
    const payload = JSON.stringify({
        type:    'stats',
        online:  clients.size,
        popular: getTopGames(15)
    });
    clients.forEach(ws => { if (ws.readyState === ws.OPEN) ws.send(payload); });
}

/* ── WebSocket ── */
wss.on('connection', (ws, req) => {
    const origin = req.headers.origin || '';
    if (!isAllowed(origin)) { ws.close(1008, 'Forbidden'); return; }

    clients.add(ws);
    broadcastStats();

    ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return; }
        if (msg.type === 'click' && typeof msg.name === 'string') {
            const name = msg.name.slice(0, 120).replace(/[^\w\s'\-.,!()]/g, '');
            siteData.clicks[name] = (siteData.clicks[name] || 0) + 1;
            scheduleSave();
            broadcastStats();
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
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

/* ── API ── */
app.get('/api/stats', (req, res) => {
    res.json({ online: clients.size, popular: getTopGames(15) });
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
    res.json(getTopGames(Math.min(parseInt(req.query.n) || 15, 50)));
});

app.get('/health', (req, res) => res.json({ ok: true, online: clients.size }));

/* ── Start ── */
server.listen(PORT, () => {
    console.log(`🌴 Library backend running on port ${PORT}`);
    console.log(`   Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});