const store = require('./store');

const PICK_API_URL = process.env.PICK_API_URL || 'https://hx-p-i-c-k.vercel.app';
const PICK_AGENT_SECRET = process.env.PICK_AGENT_SECRET || '';
const SYNC_INTERVAL = parseInt(process.env.AGENT_SYNC_INTERVAL || '60000', 10);

// Maps Pick product keys → image-cache entry IDs (desktop + mobile)
const PRODUCT_MAP = {
  parking:           { desktop: 'parking-desktop',           mobile: 'parking-mobile' },
  hotels:            { desktop: 'hotels-desktop',            mobile: 'hotels-mobile' },
  hotel_and_parking: { desktop: 'hotel-and-parking-desktop', mobile: 'hotel-and-parking-mobile' },
  insurance:         { desktop: 'insurance-desktop',         mobile: 'insurance-mobile' },
  car_hire:          { desktop: 'car-hire-desktop',          mobile: 'car-hire-mobile' },
  transfers:         { desktop: 'transfers-desktop',         mobile: 'transfers-mobile' },
  lounge:            { desktop: 'lounge-desktop',            mobile: 'lounge-mobile' },
  port_parking:      { desktop: 'port-parking-desktop',      mobile: 'port-parking-mobile' },
};

const state = {
  running: false,
  lastSync: null,
  lastSyncStatus: null,
  nextSync: null,
  syncCount: 0,
  updateCount: 0,
  log: [],
  upcomingCampaigns: [],
};

let syncTimer = null;

function addLog(level, message, detail) {
  const entry = { time: new Date().toISOString(), level, message };
  if (detail) entry.detail = detail;
  state.log.unshift(entry);
  if (state.log.length > 100) state.log.pop();
  console.log(`[CIA] ${level.toUpperCase()}: ${message}`);
}

async function pickFetch(path) {
  const url = `${PICK_API_URL}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${PICK_AGENT_SECRET}` },
    signal: AbortSignal.timeout(10000),
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
    const [bannerState, upcoming] = await Promise.allSettled([
      pickFetch('/api/agent/banner-state'),
      pickFetch('/api/agent/upcoming'),
    ]);

    if (upcoming.status === 'fulfilled') {
      const u = upcoming.value;
      state.upcomingCampaigns = Object.entries(u).flatMap(([product, devices]) =>
        Object.entries(devices || {})
          .filter(([, d]) => d)
          .map(([device, d]) => ({ product, device, ...d }))
      );
    }

    if (bannerState.status === 'rejected') {
      throw bannerState.reason;
    }

    const data = bannerState.value;
    let updatedCount = 0;

    for (const [product, deviceMap] of Object.entries(PRODUCT_MAP)) {
      const productData = data[product];
      if (!productData) continue;

      for (const [device, cacheId] of Object.entries(deviceMap)) {
        const banner = productData[device];
        if (!banner || !banner.imageUrl) continue;

        const existing = await store.get(cacheId);
        if (!existing) {
          addLog('warn', `Cache entry '${cacheId}' not found in store`);
          continue;
        }

        if (existing.targetUrl === banner.imageUrl) continue;

        await store.update(cacheId, {
          targetUrl: banner.imageUrl,
          description: `[CIA] ${banner.campaignName} — ${banner.outcome}`,
          note: `Auto-updated by Campaign Image Agent. Campaign: "${banner.campaignName}", Outcome: ${banner.outcome}${banner.startsAt ? `, active from ${banner.startsAt}` : ''}`,
          updatedBy: 'campaign-image-agent',
        });

        addLog('success', `Updated ${cacheId}`, {
          product, device,
          campaign: banner.campaignName,
          outcome: banner.outcome,
          url: banner.imageUrl,
        });
        updatedCount++;
        state.updateCount++;
      }
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
    // On Vercel, syncs are driven by the cron job hitting /api/agent/cron-sync
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
    productMap: PRODUCT_MAP,
    managed,
  };
}

module.exports = { start, stop, sync, getState };
