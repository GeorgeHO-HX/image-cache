const store = require('./store');

const PICK_API_URL = process.env.PICK_API_URL || 'https://hx-p-i-c-k.vercel.app';
const PICK_AGENT_SECRET = process.env.PICK_AGENT_SECRET || '';
const SYNC_INTERVAL = parseInt(process.env.AGENT_SYNC_INTERVAL || '60000', 10);

const state = {
  running: false,
  lastSync: null,
  lastSyncStatus: null,
  nextSync: null,
  syncCount: 0,
  updateCount: 0,
  log: [],
  upcomingCampaigns: [],
  outcomePreviewsData: {},
};

let syncTimer = null;

function addLog(level, message, detail) {
  const entry = { time: new Date().toISOString(), level, message };
  if (detail) entry.detail = detail;
  state.log.unshift(entry);
  if (state.log.length > 100) state.log.pop();
  console.log(`[CIA] ${level.toUpperCase()}: ${message}`);
}

async function getManagedIds() {
  const all = await store.getAll();
  return Object.keys(all).filter(id => all[id].group === 'campaign-image-agent');
}

async function pickFetch(path) {
  const url = `${PICK_API_URL}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${PICK_AGENT_SECRET}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`Pick API ${path} returned ${res.status}`);
  }
  return res.json();
}

async function sync() {
  if (!PICK_AGENT_SECRET) {
    addLog('warn', 'PICK_AGENT_SECRET not set — skipping sync');
    return;
  }

  addLog('info', 'Sync started');
  state.syncCount++;

  try {
    const managedIds = await getManagedIds();
    if (!managedIds.length) {
      addLog('warn', 'No campaign-image-agent entries in store — nothing to sync');
      state.lastSync = new Date().toISOString();
      state.lastSyncStatus = 'ok';
      return;
    }

    const idsParam = encodeURIComponent(managedIds.join(','));

    const [bannerState, upcoming, outcomePreviews] = await Promise.allSettled([
      pickFetch(`/api/agent/banner-state?ids=${idsParam}`),
      pickFetch('/api/agent/upcoming'),
      pickFetch('/api/agent/outcome-previews'),
    ]);

    if (upcoming.status === 'fulfilled') {
      const u = upcoming.value;
      if (Array.isArray(u.outcomes)) {
        state.upcomingCampaigns = u.outcomes;
      } else {
        state.upcomingCampaigns = Object.entries(u)
          .filter(([k]) => k !== '_meta')
          .flatMap(([product, devices]) =>
            Object.entries(devices || {})
              .filter(([, d]) => d)
              .map(([device, d]) => ({ product, device, ...d }))
          );
      }
    }

    if (outcomePreviews.status === 'fulfilled') {
      state.outcomePreviewsData = Object.fromEntries(
        Object.entries(outcomePreviews.value).filter(([k]) => k !== '_meta')
      );
    }

    if (bannerState.status === 'rejected') {
      throw bannerState.reason;
    }

    const data = bannerState.value;
    let updatedCount = 0;

    // Detect flat format { "parking-desktop": {...} } vs legacy nested { "parking": { "desktop": {...} } }
    const isFlat = managedIds.some(id => id in data);

    for (const cacheId of managedIds) {
      let banner;

      if (isFlat) {
        banner = data[cacheId];
      } else {
        // Legacy: derive product + device from ID convention ({product-with-hyphens}-{desktop|mobile})
        const parts = cacheId.split('-');
        const device = parts[parts.length - 1];
        if (!['desktop', 'mobile'].includes(device)) continue;
        const product = parts.slice(0, -1).join('_');
        banner = data[product]?.[device];
      }

      if (!banner || !banner.imageUrl) continue;

      const existing = await store.get(cacheId);
      if (!existing) {
        addLog('warn', `Cache entry '${cacheId}' not found in store`);
        continue;
      }

      if (banner.status === 'armed') {
        addLog('info', `Skipping ${cacheId} — armed but not yet triggered`);
        continue;
      }

      if (existing.targetUrl === banner.imageUrl) continue;

      const triggerNote = banner.scheduledAt
        ? `, outcome triggers at ${banner.scheduledAt}`
        : banner.startsAt ? `, active from ${banner.startsAt}` : '';

      await store.update(cacheId, {
        targetUrl: banner.imageUrl,
        description: `[CIA] ${banner.campaignName} — ${banner.outcome}`,
        note: `Auto-updated by Campaign Image Agent. Campaign: "${banner.campaignName}", Outcome: ${banner.outcome}${triggerNote}`,
        updatedBy: 'campaign-image-agent',
      });

      addLog('success', `Updated ${cacheId}`, {
        campaign: banner.campaignName,
        outcome: banner.outcome,
        url: banner.imageUrl,
      });
      updatedCount++;
      state.updateCount++;
    }

    state.lastSync = new Date().toISOString();
    state.lastSyncStatus = 'ok';
    addLog('info', updatedCount > 0
      ? `Sync complete — ${updatedCount} entr${updatedCount === 1 ? 'y' : 'ies'} updated`
      : 'Sync complete — no changes'
    );
  } catch (err) {
    state.lastSync = new Date().toISOString();
    state.lastSyncStatus = 'error';
    addLog('error', `Sync failed: ${err.message}`);
  }
}

function scheduleNext() {
  syncTimer = setTimeout(async () => {
    state.nextSync = null;
    await sync();
    state.nextSync = new Date(Date.now() + SYNC_INTERVAL).toISOString();
    scheduleNext();
  }, SYNC_INTERVAL);
  state.nextSync = new Date(Date.now() + SYNC_INTERVAL).toISOString();
}

function start() {
  if (state.running) return;
  state.running = true;
  if (process.env.VERCEL) {
    addLog('info', 'Campaign Image Agent started — cron-driven mode (Vercel)');
    sync();
  } else {
    addLog('info', `Campaign Image Agent started — syncing every ${SYNC_INTERVAL / 1000}s`);
    sync().then(() => scheduleNext());
  }
}

function stop() {
  if (syncTimer) clearTimeout(syncTimer);
  state.running = false;
  state.nextSync = null;
}

async function getState() {
  const allRedirects = await store.getAll();
  const managed = {};
  for (const [id, r] of Object.entries(allRedirects)) {
    if (r.group === 'campaign-image-agent') managed[id] = r;
  }

  return {
    running: state.running,
    configured: !!PICK_AGENT_SECRET,
    pickApiUrl: PICK_API_URL,
    syncIntervalMs: SYNC_INTERVAL,
    lastSync: state.lastSync,
    lastSyncStatus: state.lastSyncStatus,
    nextSync: state.nextSync,
    syncCount: state.syncCount,
    updateCount: state.updateCount,
    log: state.log.slice(0, 50),
    upcomingCampaigns: state.upcomingCampaigns,
    outcomePreviewsData: state.outcomePreviewsData,
    managed,
  };
}

module.exports = { start, stop, sync, getState };
