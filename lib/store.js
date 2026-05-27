const fs = require('fs').promises;
const path = require('path');

const SEED_FILE = path.join(__dirname, '..', 'data', 'redirects.json');

let pool;
let usePostgres = false;
let cache = {};
let pathIndex = {};

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS redirects (
        id TEXT PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        target_url TEXT NOT NULL,
        description TEXT DEFAULT '',
        group_name TEXT DEFAULT '',
        updated_by TEXT DEFAULT 'system',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        history JSONB DEFAULT '[]'
      )
    `);

    const { rows } = await pool.query('SELECT count(*) AS c FROM redirects');
    if (parseInt(rows[0].c) === 0) {
      await seedFromFile();
    }

    usePostgres = true;
    await refreshCache();
    console.log('Store: Postgres');
  } else {
    try {
      const raw = await fs.readFile(SEED_FILE, 'utf8');
      cache = JSON.parse(raw);
    } catch {
      cache = {};
    }
    rebuildPathIndex();
    console.log('Store: file-based JSON');
  }
}

async function seedFromFile() {
  try {
    const raw = await fs.readFile(SEED_FILE, 'utf8');
    const seed = JSON.parse(raw);
    for (const [id, r] of Object.entries(seed)) {
      await pool.query(
        `INSERT INTO redirects (id, path, target_url, description, group_name, updated_by, updated_at, history)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [id, r.path, r.targetUrl, r.description || '', r.group || '', r.updatedBy || 'system', r.updatedAt || new Date().toISOString(), JSON.stringify(r.history || [])]
      );
    }
  } catch {
    // seed file missing is fine
  }
}

async function refreshCache() {
  if (!usePostgres) return;
  const { rows } = await pool.query('SELECT * FROM redirects ORDER BY group_name, path');
  cache = {};
  for (const row of rows) {
    cache[row.id] = rowToObj(row);
  }
  rebuildPathIndex();
}

function rowToObj(row) {
  return {
    path: row.path,
    targetUrl: row.target_url,
    description: row.description,
    group: row.group_name,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    history: row.history || [],
  };
}

async function saveFile() {
  if (usePostgres) return;
  try {
    await fs.writeFile(SEED_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    if (err.code !== 'EROFS') throw err;
    // read-only filesystem (Vercel) — in-memory cache remains valid for this invocation
  }
}

async function getAll() {
  return { ...cache };
}

async function get(id) {
  return cache[id] || null;
}

function rebuildPathIndex() {
  pathIndex = {};
  for (const r of Object.values(cache)) {
    pathIndex[r.path] = r;
  }
}

async function getByPath(requestPath) {
  return pathIndex[requestPath] || null;
}

async function create({ id, path: rPath, targetUrl, description, group, updatedBy }) {
  const now = new Date().toISOString();
  const entry = {
    path: rPath,
    targetUrl,
    description: description || '',
    group: group || '',
    updatedBy: updatedBy || 'admin',
    updatedAt: now,
    history: [],
  };

  if (usePostgres) {
    await pool.query(
      `INSERT INTO redirects (id, path, target_url, description, group_name, updated_by, updated_at, history)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '[]')`,
      [id, rPath, targetUrl, entry.description, entry.group, entry.updatedBy, now]
    );
  }

  cache[id] = entry;
  pathIndex[entry.path] = entry;
  await saveFile();
  return entry;
}

async function update(id, { targetUrl, description, note, updatedBy }) {
  const existing = cache[id];
  if (!existing) return null;

  const historyEntry = {
    targetUrl: existing.targetUrl,
    description: existing.description,
    updatedBy: existing.updatedBy,
    updatedAt: existing.updatedAt,
    note: note || '',
  };

  const now = new Date().toISOString();
  const updated = {
    ...existing,
    targetUrl: targetUrl !== undefined ? targetUrl : existing.targetUrl,
    description: description !== undefined ? description : existing.description,
    updatedBy: updatedBy || 'admin',
    updatedAt: now,
    history: [historyEntry, ...existing.history],
  };

  if (usePostgres) {
    await pool.query(
      `UPDATE redirects SET target_url=$1, description=$2, updated_by=$3, updated_at=$4, history=$5 WHERE id=$6`,
      [updated.targetUrl, updated.description, updated.updatedBy, now, JSON.stringify(updated.history), id]
    );
  }

  cache[id] = updated;
  pathIndex[updated.path] = updated;
  await saveFile();
  return updated;
}

async function rollback(id, historyIndex, updatedBy) {
  const existing = cache[id];
  if (!existing || !existing.history[historyIndex]) return null;

  const target = existing.history[historyIndex];
  return update(id, {
    targetUrl: target.targetUrl,
    description: target.description,
    note: `Rolled back to version from ${target.updatedAt}`,
    updatedBy: updatedBy || 'admin',
  });
}

async function remove(id) {
  const existing = cache[id];
  if (usePostgres) {
    await pool.query('DELETE FROM redirects WHERE id=$1', [id]);
  }
  delete cache[id];
  if (existing) delete pathIndex[existing.path];
  await saveFile();
}

module.exports = { init, getAll, get, getByPath, create, update, rollback, remove };
