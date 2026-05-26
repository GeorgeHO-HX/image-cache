const express = require('express');
const path = require('path');
const store = require('./lib/store');
const agent = require('./lib/agent');

const app = express();
const router = express.Router();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-token';
const BASE_PATH = process.env.BASE_PATH || '';

app.set('trust proxy', 1);
app.use(express.json());

function requireAuth(req, res, next) {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

router.get('/admin', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Campaign Image Agent (URL-only, not linked from admin) ──

router.get('/campaign-agent', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'campaign-agent.html'));
});

router.get('/api/agent/status', requireAuth, async (_req, res) => {
  res.json(await agent.getState());
});

router.post('/api/agent/sync', requireAuth, async (_req, res) => {
  await agent.sync();
  res.json(await agent.getState());
});

// Called by Vercel Cron every minute — uses CRON_SECRET, no admin token needed
router.post('/api/agent/cron-sync', async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  await agent.sync();
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── Admin API ──────────────────────────────────────────────

router.get('/api/redirects', requireAuth, async (_req, res) => {
  res.json(await store.getAll());
});

router.get('/api/redirects/:id', requireAuth, async (req, res) => {
  const r = await store.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

router.post('/api/redirects', requireAuth, async (req, res) => {
  const { id, path: rPath, targetUrl, description, group } = req.body;
  if (!id || !rPath || !targetUrl) {
    return res.status(400).json({ error: 'id, path, and targetUrl are required' });
  }
  if (await store.get(id)) {
    return res.status(409).json({ error: 'Redirect with this id already exists' });
  }
  const user = req.body.user || req.query.user || 'admin';
  const r = await store.create({ id, path: rPath, targetUrl, description, group, updatedBy: user });
  res.status(201).json(r);
});

router.put('/api/redirects/:id', requireAuth, async (req, res) => {
  const { targetUrl, description, note } = req.body;
  const user = req.body.user || req.query.user || 'admin';
  const r = await store.update(req.params.id, { targetUrl, description, note, updatedBy: user });
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

router.post('/api/redirects/:id/rollback/:index', requireAuth, async (req, res) => {
  const user = req.body.user || req.query.user || 'admin';
  const r = await store.rollback(req.params.id, parseInt(req.params.index, 10), user);
  if (!r) return res.status(404).json({ error: 'Not found or invalid history index' });
  res.json(r);
});

router.delete('/api/redirects/:id', requireAuth, async (req, res) => {
  await store.remove(req.params.id);
  res.status(204).end();
});

// ── Public: manifest ───────────────────────────────────────

router.get('/manifest.json', async (_req, res) => {
  const all = await store.getAll();
  const manifest = {};
  for (const [id, r] of Object.entries(all)) {
    manifest[id] = {
      path: r.path,
      targetUrl: r.targetUrl,
      description: r.description,
      group: r.group,
      updatedAt: r.updatedAt,
    };
  }
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.json(manifest);
});

// ── Public: redirects (catch-all) ──────────────────────────

router.get('*', async (req, res) => {
  const r = await store.getByPath(req.path);
  if (!r) return res.status(404).json({ error: 'Not found' });

  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.redirect(302, r.targetUrl);
});

app.use(BASE_PATH, router);

// ── Start ──────────────────────────────────────────────────

store.init().then(() => {
  agent.start();
  app.listen(PORT, () => {
    console.log(`Image cache running on :${PORT} (base: ${BASE_PATH || '/'})`);
  });
});
