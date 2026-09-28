'use strict';

/* =========================================================================
   Cloud sync (Supabase).

   The phone's copy is always what the app reads and writes, so everything keeps
   working offline. When there is a connection, each business is merged with the
   cloud copy and pushed back:
   - businesses table: one row per business with products and the current day.
     Optimistic locking on `rev` detects two phones pushing at the same time.
   - closes table: one row per closing. Closings never change, so they are
     uploaded once and downloaded once (feed ordered by `seq`).

   Loaded before app.js; it only defines things. app.js calls Cloud.init().
   ========================================================================= */

const CLOUD_URL = 'https://myrwgbzdnqllhyfwpzul.supabase.co';
const CLOUD_KEY = 'sb_publishable_vMZY_eQBu14SbrwpOKhLvw_7laUK5Vz'; // public by design; RLS protects the data
const SESSION_KEY = 'peter-mipyme-session';
const SYNC_KEY = 'peter-mipyme-sync';
const REQUEST_TIMEOUT_MS = 20000;
const POLL_MS = 45000;

/* ---------- Merge (pure functions) ---------- */

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

// The part of a business that lives in the businesses table.
function cloudDoc(s) {
  return { version: s.version, settings: s.settings, categories: s.categories, products: s.products, day: s.day };
}

function unionById(a, b) {
  const m = new Map();
  for (const x of a) m.set(x.id, x);
  for (const x of b) if (!m.has(x.id)) m.set(x.id, x);
  return [...m.values()];
}

function byTime(a, b) {
  return String(a.time).localeCompare(String(b.time));
}

// Ties keep the local version.
function newerOf(local, remote) {
  return (remote.updatedAt || 0) > (local.updatedAt || 0) ? remote : local;
}

function mergeProducts(local, remote) {
  const m = new Map(local.map((p) => [p.id, p]));
  for (const p of remote) m.set(p.id, m.has(p.id) ? newerOf(m.get(p.id), p) : p);
  return [...m.values()];
}

function mergeSameDay(a, b) {
  const removed = new Set([...a.removedSales, ...b.removedSales]);
  const inicio = {};
  const inicioAt = {};
  for (const pid of new Set([...Object.keys(a.inicio), ...Object.keys(b.inicio)])) {
    const useB = !(pid in a.inicio) || ((pid in b.inicio) && (b.inicioAt[pid] || 0) > (a.inicioAt[pid] || 0));
    const src = useB ? b : a;
    inicio[pid] = src.inicio[pid];
    if (src.inicioAt[pid]) inicioAt[pid] = src.inicioAt[pid];
  }
  return {
    id: a.id,
    openedAt: a.openedAt < b.openedAt ? a.openedAt : b.openedAt,
    inicio,
    inicioAt,
    entries: unionById(a.entries, b.entries).sort(byTime),
    sales: unionById(a.sales, b.sales).filter((s) => !removed.has(s.id)).sort(byTime),
    removedSales: [...removed],
  };
}

// Sales/entries a phone recorded on a day that another phone already closed are
// moved into the new day, so nothing sold is lost.
function carryOver(current, closedDay, close) {
  const covered = new Set([...(close.saleIds || []), ...(close.entryIds || [])]);
  const removed = new Set(closedDay.removedSales);
  return mergeSameDay(current, {
    id: current.id,
    openedAt: current.openedAt,
    inicio: {},
    inicioAt: {},
    entries: closedDay.entries.filter((e) => !covered.has(e.id)),
    sales: closedDay.sales.filter((s) => !covered.has(s.id) && !removed.has(s.id)),
    removedSales: [],
  });
}

function mergeDays(a, b, closes) {
  if (a.id === b.id) return mergeSameDay(a, b);
  const closeOf = (dayId) => closes.find((c) => c.dayId === dayId);
  const aClose = closeOf(a.id);
  const bClose = closeOf(b.id);
  if (aClose && !bClose) return carryOver(b, a, aClose);
  if (bClose && !aClose) return carryOver(a, b, bClose);
  // Two days opened separately before the phones ever synced: fold into the later one.
  const [base, other] = a.openedAt >= b.openedAt ? [a, b] : [b, a];
  return mergeSameDay(base, { ...other, id: base.id });
}

// Merges a cloud copy into the local state. Closings and the closing draft stay local
// (closings are synced through their own table).
function mergeStates(local, remote) {
  const settings = newerOf(local.settings, remote.settings);
  const categories = [...local.categories];
  for (const c of remote.categories) if (!categories.includes(c)) categories.push(c);
  const day = mergeDays(local.day, remote.day, local.closes);
  return {
    ...local,
    settings,
    categories,
    products: mergeProducts(local.products, remote.products),
    day,
    draft: day.id === local.day.id ? local.draft : null,
  };
}

function isPristine(s) {
  return !s.closes.length && !s.day.sales.length && !s.day.entries.length
    && s.products.every((p) => !p.price)
    && Object.values(s.day.inicio).every((n) => !n);
}

/* ---------- Cloud client ---------- */

const Cloud = {
  session: null,
  meta: null,
  status: 'off', // off | syncing | ok | pending | offline | error | auth
  listening: false,
  running: false,
  again: false,
  timer: null,
  renderPending: false,

  freshMeta() {
    return { rev: {}, dirty: {}, deletedBiz: [], replace: {}, closes: {}, closesSeq: 0, lastSync: null, lastError: null };
  },

  init() {
    this.session = readJson(SESSION_KEY);
    this.meta = { ...this.freshMeta(), ...(readJson(SYNC_KEY) || {}) };
    if (!this.session) return;
    if (!navigator.onLine) this.status = 'offline';
    else this.status = this.meta.lastSync && !this.hasPending() ? 'ok' : 'syncing';
    this.schedule(600);
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('online', () => this.schedule(500));
    window.addEventListener('offline', () => this.setStatus('offline'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.schedule(300);
    });
    setInterval(() => {
      if (document.visibilityState === 'visible') this.syncNow();
    }, POLL_MS);
    document.addEventListener('focusout', () => setTimeout(() => this.flushRender(), 0));
  },

  get loggedIn() {
    return !!this.session;
  },

  saveMeta() {
    writeJson(SYNC_KEY, this.meta);
  },

  hasPending() {
    return Object.values(this.meta.dirty).some((n) => n > 0) || this.meta.deletedBiz.length > 0;
  },

  markDirty(bizId) {
    if (!this.session) return;
    this.meta.dirty[bizId] = (this.meta.dirty[bizId] || 0) + 1;
    this.saveMeta();
    if (this.status !== 'syncing') this.setStatus(navigator.onLine ? 'pending' : 'offline');
    this.schedule(2500);
  },

  businessDeleted(bizId) {
    if (!this.session) return;
    delete this.meta.dirty[bizId];
    if (this.meta.rev[bizId]) this.meta.deletedBiz.push(bizId);
    this.saveMeta();
    this.schedule(1000);
  },

  // After restoring a backup the phone's copy replaces the cloud copy instead of merging.
  restored(bizIds) {
    if (!this.session) return;
    for (const id of bizIds) {
      this.meta.replace[id] = true;
      this.meta.closes[id] = {};
      this.meta.dirty[id] = (this.meta.dirty[id] || 0) + 1;
    }
    this.saveMeta();
    this.schedule(500);
  },

  schedule(ms) {
    if (!this.session) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.syncNow(), ms);
  },

  setStatus(status) {
    this.status = status;
    this.renderBadge();
    if (ui.tab === 'ajustes') {
      const box = $('#cloudBox');
      if (box) box.innerHTML = this.settingsInnerHtml();
    }
  },

  /* ----- HTTP ----- */

  async request(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    const h = { apikey: CLOUD_KEY, 'Content-Type': 'application/json', ...headers };
    if (auth) h.Authorization = 'Bearer ' + this.session.access_token;
    try {
      const res = await fetch(CLOUD_URL + path, {
        method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const err = new Error((data && (data.msg || data.message || data.error_description || data.error)) || res.statusText);
        err.status = res.status;
        err.code = data && (data.error_code || data.code);
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  },

  async api(path, opts = {}) {
    await this.ensureToken();
    try {
      return await this.request(path, opts);
    } catch (err) {
      if (err.status !== 401) throw err;
      await this.refresh();
      return this.request(path, opts);
    }
  },

  async ensureToken() {
    if (!this.session) throw Object.assign(new Error('no session'), { auth: true });
    if ((this.session.expires_at || 0) - 60 < Date.now() / 1000) await this.refresh();
  },

  async refresh() {
    try {
      const s = await this.request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', auth: false, body: { refresh_token: this.session.refresh_token },
      });
      this.storeSession(s);
    } catch (err) {
      if (err.status === 400 || err.status === 401) err.auth = true;
      throw err;
    }
  },

  storeSession(s) {
    this.session = {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
      user: { id: s.user.id, email: s.user.email },
    };
    writeJson(SESSION_KEY, this.session);
  },

  /* ----- Local business access ----- */

  getBiz(id) {
    return id === index.activeId ? state : loadBusiness(id);
  },

  // Writes a cloud-merged copy, merging once more with whatever the phone has now,
  // in case something was sold while the request was in flight.
  putBiz(id, merged) {
    if (id === index.activeId) {
      const before = stableStringify(cloudDoc(state));
      state = mergeStates(state, merged);
      writeJson(bizKey(id), state);
      if (stableStringify(cloudDoc(state)) !== before) this.requestRender();
    } else {
      writeJson(bizKey(id), mergeStates(loadBusiness(id), merged));
    }
    const entry = index.list.find((b) => b.id === id);
    const name = (id === index.activeId ? state : merged).settings.businessName;
    if (entry && name && entry.name !== name) {
      entry.name = name;
      saveIndex();
      this.requestRender();
    }
  },

  requestRender() {
    this.renderPending = true;
    this.flushRender();
  },

  // Never re-render under the user's fingers: wait until no field has focus.
  flushRender() {
    if (!this.renderPending) return;
    const el = document.activeElement;
    if (el && el.matches('input, textarea, select')) return;
    this.renderPending = false;
    render();
  },

  addLocalBusiness(id, data) {
    const s = migrate(data);
    s.closes = [];
    s.removedCloses = [];
    s.draft = null;
    writeJson(bizKey(id), s);
    index.list.push({ id, name: s.settings.businessName });
    saveIndex();
    this.requestRender();
  },

  removeLocalBusiness(id) {
    localStorage.removeItem(bizKey(id));
    index.list = index.list.filter((b) => b.id !== id);
    delete this.meta.rev[id];
    delete this.meta.dirty[id];
    delete this.meta.closes[id];
    if (!index.list.length) {
      const fresh = defaultState(false, 'Mi negocio');
      const nid = uid();
      writeJson(bizKey(nid), fresh);
      index.list.push({ id: nid, name: fresh.settings.businessName });
    }
    if (index.activeId === id) {
      index.activeId = index.list[0].id;
      state = loadBusiness(index.activeId);
      ui.cart = {};
      ui.cat = 'Todos';
    }
    saveIndex();
    this.requestRender();
  },

  /* ----- Sync ----- */

  async syncNow() {
    if (!this.session) return;
    if (this.running) {
      this.again = true;
      return;
    }
    if (!navigator.onLine) return this.setStatus('offline');
    this.running = true;
    this.setStatus('syncing');
    try {
      await this.pushBusinessDeletes();
      const heads = await this.api('/rest/v1/businesses?select=id,rev,deleted');
      await this.pullNewBusinesses(heads);
      await this.pullCloses();
      await this.pushCloses();
      await this.syncBusinesses(heads);
      this.meta.lastSync = new Date().toISOString();
      this.meta.lastError = null;
      this.saveMeta();
      this.setStatus(this.hasPending() ? 'pending' : 'ok');
    } catch (err) {
      console.error(err);
      this.meta.lastError = err.message;
      this.saveMeta();
      if (err.auth) this.setStatus('auth');
      else if (!navigator.onLine || err.name === 'AbortError' || err instanceof TypeError) this.setStatus('offline');
      else this.setStatus('error');
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.schedule(1000);
      }
    }
  },

  async pushBusinessDeletes() {
    for (const id of [...this.meta.deletedBiz]) {
      await this.api(`/rest/v1/businesses?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', body: { deleted: true, updated_at: new Date().toISOString() },
      });
      this.meta.deletedBiz = this.meta.deletedBiz.filter((x) => x !== id);
      this.saveMeta();
    }
  },

  async fetchBusiness(id) {
    const rows = await this.api(`/rest/v1/businesses?select=id,rev,data,deleted&id=eq.${encodeURIComponent(id)}`);
    return rows[0] || null;
  },

  async pullNewBusinesses(heads) {
    for (const h of heads) {
      const local = index.list.some((b) => b.id === h.id);
      if (h.deleted) {
        if (local && !this.meta.replace[h.id]) this.removeLocalBusiness(h.id);
        continue;
      }
      if (local || this.meta.deletedBiz.includes(h.id)) continue;
      const row = await this.fetchBusiness(h.id);
      if (!row || row.deleted) continue;
      this.addLocalBusiness(h.id, row.data);
      this.meta.rev[h.id] = row.rev;
      this.meta.closes[h.id] = {};
      this.saveMeta();
    }
  },

  async pullCloses() {
    for (;;) {
      const rows = await this.api(
        `/rest/v1/closes?select=business_id,id,data,deleted,seq&seq=gt.${this.meta.closesSeq}&order=seq.asc&limit=500`
      );
      const byBiz = new Map();
      for (const r of rows) {
        if (!byBiz.has(r.business_id)) byBiz.set(r.business_id, []);
        byBiz.get(r.business_id).push(r);
      }
      for (const [bizId, list] of byBiz) {
        if (!index.list.some((b) => b.id === bizId) || this.meta.replace[bizId]) continue;
        const s = this.getBiz(bizId);
        const track = (this.meta.closes[bizId] = this.meta.closes[bizId] || {});
        let changed = false;
        for (const r of list) {
          const has = s.closes.some((c) => c.id === r.id);
          if (r.deleted) {
            track[r.id] = 'del';
            if (has) {
              s.closes = s.closes.filter((c) => c.id !== r.id);
              changed = true;
            }
            if (!s.removedCloses.includes(r.id)) s.removedCloses.push(r.id);
          } else {
            track[r.id] = 'up';
            if (!has && !s.removedCloses.includes(r.id)) {
              s.closes.push(r.data);
              changed = true;
            }
          }
        }
        writeJson(bizKey(bizId), s);
        if (changed && bizId === index.activeId) this.requestRender();
      }
      if (rows.length) this.meta.closesSeq = rows[rows.length - 1].seq;
      this.saveMeta();
      if (rows.length < 500) break;
    }
  },

  async pushCloses() {
    const owner = this.session.user.id;
    for (const b of index.list) {
      const s = this.getBiz(b.id);
      const track = (this.meta.closes[b.id] = this.meta.closes[b.id] || {});
      const toUpload = s.closes.filter((c) => track[c.id] !== 'up');
      if (toUpload.length) {
        await this.api('/rest/v1/closes', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: toUpload.map((c) => ({ owner, business_id: b.id, id: c.id, data: c, deleted: false })),
        });
        for (const c of toUpload) track[c.id] = 'up';
        this.saveMeta();
      }
      for (const id of s.removedCloses) {
        if (track[id] !== 'up') continue;
        await this.api(`/rest/v1/closes?business_id=eq.${encodeURIComponent(b.id)}&id=eq.${encodeURIComponent(id)}`, {
          method: 'PATCH', body: { deleted: true },
        });
        track[id] = 'del';
        this.saveMeta();
      }
    }
  },

  async syncBusinesses(heads) {
    const headMap = new Map(heads.map((h) => [h.id, h]));
    for (const b of [...index.list]) {
      let head = headMap.get(b.id);
      if (head && head.deleted && !this.meta.replace[b.id]) continue;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (await this.syncOne(b.id, head)) break;
        const row = await this.fetchBusiness(b.id);
        head = row ? { id: row.id, rev: row.rev, deleted: row.deleted } : undefined;
      }
    }
  },

  // Returns false when another phone pushed first; the caller retries with fresh data.
  async syncOne(id, head) {
    const gen = this.meta.dirty[id] || 0;
    const local = this.getBiz(id);
    const owner = this.session.user.id;

    if (!head) {
      try {
        await this.api('/rest/v1/businesses', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: { owner, id, name: local.settings.businessName, data: cloudDoc(local), rev: 1 },
        });
      } catch (err) {
        if (err.status === 409) return false;
        throw err;
      }
      this.finish(id, 1, gen);
      return true;
    }

    const replace = !!this.meta.replace[id];
    let merged = local;
    let remoteDoc = null;
    if (!replace && head.rev !== this.meta.rev[id]) {
      const row = await this.fetchBusiness(id);
      if (!row) return false;
      head = row;
      remoteDoc = migrate({ ...row.data, closes: local.closes });
      merged = mergeStates(this.getBiz(id), remoteDoc);
    }

    const differs = remoteDoc && stableStringify(cloudDoc(merged)) !== stableStringify(cloudDoc(remoteDoc));
    let rev = head.rev;
    if (gen > 0 || differs || replace || head.deleted) {
      const rows = await this.api(`/rest/v1/businesses?id=eq.${encodeURIComponent(id)}&rev=eq.${head.rev}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: {
          name: merged.settings.businessName,
          data: cloudDoc(merged),
          rev: head.rev + 1,
          deleted: false,
          updated_at: new Date().toISOString(),
        },
      });
      if (!rows || !rows.length) return false;
      rev = head.rev + 1;
    }
    if (remoteDoc) this.putBiz(id, merged);
    delete this.meta.replace[id];
    this.finish(id, rev, gen);
    return true;
  },

  finish(id, rev, gen) {
    this.meta.rev[id] = rev;
    if ((this.meta.dirty[id] || 0) === gen) delete this.meta.dirty[id];
    this.saveMeta();
  },

  /* ----- Account ----- */

  async login(email, password, create) {
    const path = create ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
    const s = await this.request(path, { method: 'POST', auth: false, body: { email, password } });
    if (!s.access_token) throw new Error('No se pudo iniciar sesión');
    this.storeSession(s);
    this.meta = this.freshMeta();
    this.saveMeta();

    const heads = await this.api('/rest/v1/businesses?select=id,name&deleted=eq.false');
    const localPristine = index.list.every((b) => isPristine(this.getBiz(b.id)));
    if (heads.length && localPristine) return this.useCloudOnly();
    if (heads.length) return { ask: heads };
    this.markAllDirty();
    this.start();
    return { done: 'uploaded' };
  },

  // Drops this phone's businesses and downloads the account's ones.
  async useCloudOnly() {
    for (const b of index.list) localStorage.removeItem(bizKey(b.id));
    index.list = [];
    this.meta = this.freshMeta();
    const heads = await this.api('/rest/v1/businesses?select=id,rev,deleted&deleted=eq.false');
    await this.pullNewBusinesses(heads);
    if (!index.list.length) {
      const fresh = defaultState(false, 'Mi negocio');
      const id = uid();
      writeJson(bizKey(id), fresh);
      index.list.push({ id, name: fresh.settings.businessName });
    }
    index.activeId = index.list[0].id;
    saveIndex();
    state = loadBusiness(index.activeId);
    ui.cart = {};
    ui.cat = 'Todos';
    this.start();
    return { done: 'downloaded' };
  },

  mergeWithCloud() {
    this.markAllDirty();
    this.start();
    return { done: 'merged' };
  },

  markAllDirty() {
    for (const b of index.list) this.meta.dirty[b.id] = 1;
    this.saveMeta();
  },

  start() {
    this.init();
    render();
  },

  logout() {
    this.session = null;
    this.meta = this.freshMeta();
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SYNC_KEY);
    clearTimeout(this.timer);
    this.status = 'off';
  },

  /* ----- UI ----- */

  badgeInfo() {
    switch (this.status) {
      case 'syncing': return { cls: 'sync', text: 'Sincronizando…' };
      case 'ok': return { cls: 'ok', text: 'En la nube' };
      case 'pending': return { cls: 'wait', text: 'Pendiente' };
      case 'offline': return { cls: 'off', text: 'Sin conexión' };
      case 'auth': return { cls: 'bad', text: 'Inicia sesión' };
      case 'error': return { cls: 'bad', text: 'Error al sincronizar' };
      default: return null;
    }
  },

  renderBadge() {
    const el = $('#syncBadge');
    if (!el) return;
    const info = this.badgeInfo();
    el.hidden = !info;
    if (info) {
      el.className = 'sync-badge ' + info.cls;
      el.innerHTML = `<i></i>${info.text}`;
    }
  },

  settingsInnerHtml() {
    if (!this.session) {
      return `
        <div class="small">Con una cuenta, los datos se guardan también en internet. Así no se pierden si se rompe el teléfono, y otras personas pueden usar la app en su teléfono con la misma cuenta y ver lo mismo.</div>
        <button class="btn primary block" data-action="cloudLogin">Iniciar sesión o crear cuenta</button>`;
    }
    const last = this.meta.lastSync;
    const mins = last ? Math.round((Date.now() - new Date(last).getTime()) / 60000) : null;
    const when = last ? (mins < 1 ? 'hace un momento' : mins < 60 ? `hace ${mins} min` : new Date(last).toLocaleString('es')) : 'todavía no';
    const info = this.badgeInfo() || { cls: 'ok', text: '' };
    return `
      <div class="row between"><span class="small muted">Cuenta</span><b class="small">${esc(this.session.user.email)}</b></div>
      <div class="row between"><span class="small muted">Estado</span><span class="sync-badge ${info.cls}"><i></i>${info.text}</span></div>
      <div class="row between"><span class="small muted">Última sincronización</span><span class="small">${when}</span></div>
      ${this.status === 'error' && this.meta.lastError ? `<div class="small" style="color:var(--bad)">${esc(this.meta.lastError)}</div>` : ''}
      <div class="small muted">Para usar la app en otro teléfono, entra con este mismo correo y contraseña.</div>
      <div class="btn-row">
        ${this.status === 'auth'
          ? `<button class="btn primary" data-action="cloudLogin">Iniciar sesión otra vez</button>`
          : `<button class="btn" data-action="cloudSyncNow">Sincronizar ahora</button>`}
        <button class="btn danger" data-action="cloudLogout">Cerrar sesión</button>
      </div>`;
  },

  settingsHtml() {
    return `
      <h3 class="section-title">Nube</h3>
      <div class="card stack" id="cloudBox">${this.settingsInnerHtml()}</div>`;
  },

  loginSheetHtml(error = '') {
    const email = this.session ? this.session.user.email : '';
    return `
      <h2>Cuenta en la nube</h2>
      <form id="loginForm" class="stack">
        <label class="field"><span>Correo</span><input name="email" type="email" inputmode="email" autocomplete="username" value="${esc(email)}" required></label>
        <label class="field"><span>Contraseña (mínimo 6 caracteres)</span><input name="password" type="password" autocomplete="current-password" minlength="6" required></label>
        ${error ? `<div class="small" style="color:var(--bad);font-weight:600">${esc(error)}</div>` : ''}
        <button class="btn primary block" type="submit" name="mode" value="login">Entrar</button>
        <button class="btn block" type="submit" name="mode" value="signup">Crear cuenta nueva</button>
        <div class="small muted">Si es la primera vez, toca “Crear cuenta nueva”. En los otros teléfonos usa “Entrar” con el mismo correo y contraseña.</div>
      </form>`;
  },

  askSheetHtml(heads) {
    return `
      <h2>Esta cuenta ya tiene datos</h2>
      <div class="small">En la nube hay ${heads.length === 1 ? 'un negocio' : heads.length + ' negocios'}:
        <b>${heads.map((h) => esc(h.name)).join(', ')}</b>. ¿Qué hacemos con lo que hay en este teléfono?</div>
      <div class="stack" style="margin-top:14px">
        <button class="btn primary block" data-action="cloudChoice" data-choice="cloud">Usar solo lo de la nube</button>
        <div class="small muted" style="margin-top:4px">Lo de este teléfono se reemplaza por lo de la nube. Es lo normal en un teléfono nuevo o de un empleado.</div>
        <button class="btn block" data-action="cloudChoice" data-choice="merge">Juntar las dos cosas</button>
        <div class="small muted" style="margin-top:4px">Se suben también los negocios de este teléfono a la cuenta.</div>
      </div>`;
  },
};

function loginErrorText(err) {
  const m = String(err.message || '').toLowerCase();
  if (err.name === 'AbortError' || err instanceof TypeError) return 'No hay conexión. Prueba otra vez cuando tengas internet.';
  if (m.includes('invalid login')) return 'Correo o contraseña incorrectos.';
  if (m.includes('already registered') || m.includes('already exists')) return 'Ya existe una cuenta con ese correo. Toca “Entrar”.';
  if (m.includes('password')) return 'La contraseña debe tener al menos 6 caracteres.';
  if (m.includes('email')) return 'Revisa el correo, no parece válido.';
  return 'No se pudo entrar: ' + err.message;
}

async function submitLoginForm(form, submitter) {
  const data = new FormData(form);
  const email = String(data.get('email') || '').trim().toLowerCase();
  const password = String(data.get('password') || '');
  const create = submitter && submitter.value === 'signup';
  for (const b of $$('button', form)) b.disabled = true;
  submitter.textContent = 'Un momento…';
  try {
    const result = await Cloud.login(email, password, create);
    if (result.ask) {
      $('#sheet').innerHTML = `<div class="sheet-handle"></div>${Cloud.askSheetHtml(result.ask)}`;
      return;
    }
    closeSheet();
    toast(result.done === 'downloaded' ? 'Listo. Datos descargados de la nube.' : 'Listo. Los datos se guardan en la nube.');
  } catch (err) {
    console.error(err);
    $('#sheet').innerHTML = `<div class="sheet-handle"></div>${Cloud.loginSheetHtml(loginErrorText(err))}`;
  }
}

async function cloudChoice(choice) {
  for (const b of $$('#sheet button')) b.disabled = true;
  try {
    if (choice === 'cloud') {
      if (!confirm('Se reemplazan los datos de este teléfono por los de la nube. ¿Seguir?')) {
        for (const b of $$('#sheet button')) b.disabled = false;
        return;
      }
      await Cloud.useCloudOnly();
      toast('Listo. Datos descargados de la nube.');
    } else {
      Cloud.mergeWithCloud();
      toast('Listo. Se están juntando los datos.');
    }
    closeSheet();
    render();
  } catch (err) {
    console.error(err);
    alert(loginErrorText(err));
    for (const b of $$('#sheet button')) b.disabled = false;
  }
}

function cloudLogout() {
  if (Cloud.hasPending() && !confirm('Hay cambios que todavía no se han subido a la nube. Si cierras sesión ahora no se subirán. ¿Cerrar sesión igual?')) return;
  if (!confirm('¿Cerrar sesión?\n\nLos datos se quedan en este teléfono, pero dejan de guardarse en la nube.')) return;
  Cloud.logout();
  render();
  toast('Sesión cerrada');
}
