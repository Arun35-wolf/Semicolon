/**
 * BACKEND — Collaborative Notes + Habit Tracker
 * Stack: Express + ws (WebSocket) + in-memory store
 * Run: node backend.js   (port 3001)
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// ─── In-Memory Store ─────────────────────────────────────────────────────────

const store = {
  docs: {},          // docId → { id, title, content, updatedAt, createdAt }
  users: {},         // userId → { id, name, avatar, joinedAt }
  habits: {},        // userId → [{ id, name, emoji, color, completions: Set<dateStr>, streak, reminder }]
  leaderboard: [],   // [{ userId, name, avatar, totalStreak, weekScore }]
};

// Seed a demo doc
const demoDocId = 'demo-doc-1';
store.docs[demoDocId] = {
  id: demoDocId,
  title: 'Welcome Note ✨',
  content: '# Welcome to NoteFlow\n\nStart typing to collaborate in real-time.\n\n- Share this doc URL with others\n- Track your habits on the right panel\n- Check the leaderboard to compete with friends\n\nHappy writing! 🚀',
  updatedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  activeUsers: new Set(),
};

// ─── REST API ─────────────────────────────────────────────────────────────────

// Users
app.post('/api/users', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  const avatarColors = ['#3b82f6','#06b6d4','#8b5cf6','#ec4899','#10b981'];
  const user = {
    id,
    name,
    avatar: name.slice(0, 2).toUpperCase(),
    color: avatarColors[Math.floor(Math.random() * avatarColors.length)],
    joinedAt: new Date().toISOString(),
  };
  store.users[id] = user;
  store.habits[id] = [];
  res.json(user);
});

app.get('/api/users/:id', (req, res) => {
  const user = store.users[req.params.id];
  if (!user) return res.status(404).json({ error: 'not found' });
  res.json(user);
});

// Docs
app.get('/api/docs', (req, res) => {
  res.json(Object.values(store.docs).map(d => ({ id: d.id, title: d.title, updatedAt: d.updatedAt })));
});

app.post('/api/docs', (req, res) => {
  const { title } = req.body;
  const id = uuidv4();
  const doc = { id, title: title || 'Untitled', content: '', updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), activeUsers: new Set() };
  store.docs[id] = doc;
  broadcast({ type: 'DOC_LIST_UPDATED', docs: getDocList() });
  res.json({ id: doc.id, title: doc.title, content: doc.content, updatedAt: doc.updatedAt });
});

app.get('/api/docs/:id', (req, res) => {
  const doc = store.docs[req.params.id];
  if (!doc) return res.status(404).json({ error: 'not found' });
  res.json({ id: doc.id, title: doc.title, content: doc.content, updatedAt: doc.updatedAt });
});

app.delete('/api/docs/:id', (req, res) => {
  if (req.params.id === demoDocId) return res.status(403).json({ error: 'cannot delete demo doc' });
  delete store.docs[req.params.id];
  broadcast({ type: 'DOC_LIST_UPDATED', docs: getDocList() });
  res.json({ ok: true });
});

// Habits
app.get('/api/habits/:userId', (req, res) => {
  const habits = store.habits[req.params.userId];
  if (!habits) return res.status(404).json({ error: 'user not found' });
  res.json(habits.map(h => serializeHabit(h)));
});

app.post('/api/habits/:userId', (req, res) => {
  const { name, emoji, color, reminder } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const habits = store.habits[req.params.userId];
  if (!habits) return res.status(404).json({ error: 'user not found' });
  const habit = {
    id: uuidv4(),
    name,
    emoji: emoji || '✅',
    color: color || '#3b82f6',
    completions: new Set(),
    streak: 0,
    reminder: reminder || null,
    createdAt: new Date().toISOString(),
  };
  habits.push(habit);
  res.json(serializeHabit(habit));
});

app.post('/api/habits/:userId/:habitId/toggle', (req, res) => {
  const { date } = req.body; // YYYY-MM-DD
  const today = date || todayStr();
  const habits = store.habits[req.params.userId];
  if (!habits) return res.status(404).json({ error: 'user not found' });
  const habit = habits.find(h => h.id === req.params.habitId);
  if (!habit) return res.status(404).json({ error: 'habit not found' });

  if (habit.completions.has(today)) {
    habit.completions.delete(today);
  } else {
    habit.completions.add(today);
  }
  habit.streak = calcStreak(habit.completions);
  updateLeaderboard();
  broadcast({ type: 'LEADERBOARD_UPDATED', leaderboard: store.leaderboard });
  res.json(serializeHabit(habit));
});

app.delete('/api/habits/:userId/:habitId', (req, res) => {
  const habits = store.habits[req.params.userId];
  if (!habits) return res.status(404).json({ error: 'user not found' });
  const idx = habits.findIndex(h => h.id === req.params.habitId);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  habits.splice(idx, 1);
  res.json({ ok: true });
});

// Leaderboard
app.get('/api/leaderboard', (req, res) => {
  updateLeaderboard();
  res.json(store.leaderboard);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function serializeHabit(h) {
  return { ...h, completions: [...h.completions] };
}

function calcStreak(completions) {
  if (completions.size === 0) return 0;
  const sorted = [...completions].sort().reverse();
  const today = todayStr();
  let streak = 0;
  let cursor = new Date(today);
  for (let i = 0; i < 365; i++) {
    const ds = cursor.toISOString().slice(0, 10);
    if (completions.has(ds)) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    } else break;
  }
  return streak;
}

function updateLeaderboard() {
  const entries = Object.entries(store.users).map(([uid, user]) => {
    const habits = store.habits[uid] || [];
    const totalStreak = habits.reduce((s, h) => s + calcStreak(h.completions), 0);
    // Week score = completions in last 7 days
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const weekScore = habits.reduce((s, h) => {
      return s + [...h.completions].filter(d => new Date(d) >= weekAgo).length;
    }, 0);
    return { userId: uid, name: user.name, avatar: user.avatar, color: user.color, totalStreak, weekScore, habitCount: habits.length };
  });
  store.leaderboard = entries.sort((a, b) => b.totalStreak - a.totalStreak || b.weekScore - a.weekScore);
}

function getDocList() {
  return Object.values(store.docs).map(d => ({ id: d.id, title: d.title, updatedAt: d.updatedAt }));
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map(); // ws → { userId, docId }

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(ws, { clientId, userId: null, docId: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const meta = clients.get(ws);

    switch (msg.type) {
      case 'JOIN': {
        meta.userId = msg.userId;
        meta.docId = msg.docId;
        if (store.docs[msg.docId]) {
          store.docs[msg.docId].activeUsers.add(msg.userId);
          broadcastToDoc(msg.docId, { type: 'PRESENCE', users: getDocPresence(msg.docId) });
        }
        // Send current doc state
        const doc = store.docs[msg.docId];
        if (doc) ws.send(JSON.stringify({ type: 'DOC_STATE', doc: { id: doc.id, title: doc.title, content: doc.content } }));
        break;
      }
      case 'DOC_UPDATE': {
        const doc = store.docs[msg.docId];
        if (!doc) break;
        if (msg.content !== undefined) doc.content = msg.content;
        if (msg.title !== undefined) doc.title = msg.title;
        doc.updatedAt = new Date().toISOString();
        // Broadcast to others in same doc
        broadcastToDoc(msg.docId, { type: 'DOC_UPDATE', content: doc.content, title: doc.title, from: meta.userId }, ws);
        broadcast({ type: 'DOC_LIST_UPDATED', docs: getDocList() });
        break;
      }
      case 'CURSOR': {
        broadcastToDoc(meta.docId, { type: 'CURSOR', userId: meta.userId, position: msg.position, name: msg.name }, ws);
        break;
      }
      case 'LEAVE': {
        cleanupClient(ws, meta);
        break;
      }
    }
  });

  ws.on('close', () => {
    const meta = clients.get(ws);
    if (meta) cleanupClient(ws, meta);
    clients.delete(ws);
  });
});

function cleanupClient(ws, meta) {
  if (meta.docId && store.docs[meta.docId] && meta.userId) {
    store.docs[meta.docId].activeUsers.delete(meta.userId);
    broadcastToDoc(meta.docId, { type: 'PRESENCE', users: getDocPresence(meta.docId) });
  }
}

function getDocPresence(docId) {
  const doc = store.docs[docId];
  if (!doc) return [];
  return [...doc.activeUsers].map(uid => store.users[uid]).filter(Boolean);
}

function broadcastToDoc(docId, msg, exclude = null) {
  const data = JSON.stringify(msg);
  clients.forEach((meta, ws) => {
    if (meta.docId === docId && ws !== exclude && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach((_, ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 NoteFlow backend running on http://localhost:${PORT}`));