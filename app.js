'use strict';

/* =========================================================================
   Peter Mipyme — sales, inventory and end-of-day closing.
   All data lives on the device (localStorage). Backups are JSON files.
   ========================================================================= */

const STORAGE_KEY = 'peter-mipyme-v1';
const STATE_VERSION = 1;

/* ---------- Helpers ---------- */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function parseNum(value) {
  const n = parseFloat(String(value ?? '').trim().replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money(n) {
  return '$' + round2(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function qty(n) {
  return round2(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function normalize(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Closings done after midnight (before 5am) belong to the previous day.
function defaultCloseDate() {
  const d = new Date();
  if (d.getHours() < 5) d.setDate(d.getDate() - 1);
  return localDate(d);
}

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function parseLocalDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function fmtDate(ymd) {
  const d = parseLocalDate(ymd);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtDateNumeric(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtDayOpened(iso) {
  const d = new Date(iso);
  if (localDate(d) === localDate()) return `hoy ${fmtTime(iso)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${fmtTime(iso)}`;
}

function daysSince(iso) {
  if (!iso) return Infinity;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

/* ---------- State ---------- */

function newDay(inicio = {}) {
  return { openedAt: new Date().toISOString(), inicio, entradas: {}, sales: [] };
}

function defaultState() {
  return {
    version: STATE_VERSION,
    settings: { businessName: 'Peter Mipyme', lastBackup: null, hideInstallTip: false },
    categories: [...SEED_CATEGORIES],
    products: SEED_PRODUCTS.map(([name, category], i) => ({
      id: 'p' + (i + 1),
      name,
      category,
      unit: 'u',
      price: 0,
      trackStock: true,
      archived: false,
    })),
    day: newDay(),
    closes: [],
    draft: null,
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return migrate(JSON.parse(raw));
  } catch (err) {
    console.error(err);
    return defaultState();
  }
}

function migrate(s) {
  const base = defaultState();
  return {
    version: STATE_VERSION,
    settings: { ...base.settings, ...(s.settings || {}) },
    categories: Array.isArray(s.categories) ? s.categories : base.categories,
    products: Array.isArray(s.products) ? s.products : base.products,
    day: s.day && s.day.inicio ? { ...newDay(), ...s.day } : newDay(),
    closes: Array.isArray(s.closes) ? s.closes : [],
    draft: s.draft || null,
  };
}

let state = loadState();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error(err);
    toast('No se pudo guardar. Haz una copia de seguridad.');
  }
}

/* ---------- Derived data ---------- */

function productById(id) {
  return state.products.find((p) => p.id === id);
}

function activeProducts() {
  return state.products.filter((p) => !p.archived);
}

function soldMap() {
  const m = {};
  for (const sale of state.day.sales) {
    for (const it of sale.items) m[it.pid] = (m[it.pid] || 0) + it.qty;
  }
  return m;
}

function stockOf(p, sold = soldMap()) {
  const d = state.day;
  return (d.inicio[p.id] || 0) + (d.entradas[p.id] || 0) - (sold[p.id] || 0);
}

// Sets the on-hand quantity. Before any movement today it rewrites the opening
// count; afterwards the difference is recorded as an adjustment entry.
function setStock(p, value) {
  const d = state.day;
  const sold = soldMap();
  if (!sold[p.id] && !d.entradas[p.id]) {
    d.inicio[p.id] = value;
  } else {
    const diff = value - stockOf(p, sold);
    if (diff) d.entradas[p.id] = (d.entradas[p.id] || 0) + diff;
  }
}

function saleTotal(sale) {
  return sale.items.reduce((sum, it) => sum + it.qty * it.price, 0);
}

function dayRegisteredTotal() {
  return state.day.sales.reduce((sum, s) => sum + saleTotal(s), 0);
}

function categoryList() {
  const used = new Set(state.products.filter((p) => !p.archived).map((p) => p.category));
  const ordered = state.categories.filter((c) => used.has(c));
  for (const c of used) if (!ordered.includes(c)) ordered.push(c);
  return ordered;
}

function groupByCategory(products) {
  const groups = new Map();
  for (const c of categoryList()) groups.set(c, []);
  for (const p of products) {
    if (!groups.has(p.category)) groups.set(p.category, []);
    groups.get(p.category).push(p);
  }
  return [...groups].filter(([, list]) => list.length);
}

/* ---------- UI state ---------- */

const ui = {
  tab: 'vender',
  cat: 'Todos',
  search: '',
  cart: {}, // pid -> qty
  invMode: 'lista',
  invSearch: '',
};

const TAB_TITLES = {
  vender: 'Vender',
  inventario: 'Inventario',
  cierre: 'Cierre del día',
  historial: 'Historial',
  ajustes: 'Ajustes',
};

/* ---------- Render root ---------- */

function render() {
  $('#brandName').textContent = state.settings.businessName || 'Mi negocio';
  document.title = state.settings.businessName || 'Mi negocio';
  $('#viewTitle').textContent = TAB_TITLES[ui.tab];
  for (const b of $$('#tabbar button')) b.classList.toggle('on', b.dataset.tab === ui.tab);

  const views = { vender: viewVender, inventario: viewInventario, cierre: viewCierre, historial: viewHistorial, ajustes: viewAjustes };
  $('#view').innerHTML = views[ui.tab]();
  renderCartBar();
}

function switchTab(tab) {
  ui.tab = tab;
  render();
  window.scrollTo(0, 0);
}

/* ---------- Toast & sheet ---------- */

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

let sheetOnClose = null;
function openSheet(html, onClose = null) {
  $('#sheet').innerHTML = `<div class="sheet-handle"></div>${html}`;
  $('#sheetWrap').hidden = false;
  document.body.style.overflow = 'hidden';
  sheetOnClose = onClose;
}

function closeSheet() {
  $('#sheetWrap').hidden = true;
  $('#sheet').innerHTML = '';
  document.body.style.overflow = '';
  const cb = sheetOnClose;
  sheetOnClose = null;
  if (cb) cb();
}

function installTipHtml() {
  const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  if (standalone || state.settings.hideInstallTip) return '';
  return `
    <div class="banner">
      <div class="grow"><b>Instálala en el iPhone</b>
        En Safari toca <b style="display:inline">Compartir</b> y luego <b style="display:inline">“Agregar a inicio”</b>. Así se abre como una app y funciona sin internet.</div>
      <button class="x" data-action="hideInstallTip" aria-label="Cerrar">×</button>
    </div>`;
}

/* =========================================================================
   VENDER
   ========================================================================= */

function viewVender() {
  const cats = ['Todos', ...categoryList()];
  return `
    ${installTipHtml()}
    <div class="daybar">
      <div>
        <div class="muted small">Registrado hoy</div>
        <div class="big" id="dayTotal">${money(dayRegisteredTotal())}</div>
      </div>
      <div class="muted small right">${state.day.sales.length} ventas<br>Día abierto ${fmtDayOpened(state.day.openedAt)}</div>
    </div>
    <input type="search" id="sellSearch" placeholder="Buscar producto…" value="${esc(ui.search)}" autocomplete="off">
    <div class="chips">
      ${cats.map((c) => `<button class="chip ${c === ui.cat ? 'on' : ''}" data-action="cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
    </div>
    <div class="grid" id="sellGrid">${sellGridHtml()}</div>
    <h3 class="section-title">Ventas de hoy <span class="muted">(${state.day.sales.length})</span></h3>
    ${salesListHtml()}
  `;
}

function sellGridHtml() {
  const q = normalize(ui.search.trim());
  const sold = soldMap();
  const list = activeProducts().filter((p) =>
    (ui.cat === 'Todos' || p.category === ui.cat) && (!q || normalize(p.name).includes(q))
  );
  if (!list.length) return `<div class="empty" style="grid-column:1/-1">No hay productos que coincidan.</div>`;
  return list.map((p) => {
    const inCart = ui.cart[p.id] || 0;
    const stock = p.trackStock ? stockOf(p, sold) - inCart : null;
    return `
      <button class="tile ${inCart ? 'in-cart' : ''}" data-action="add" data-id="${p.id}">
        ${inCart ? `<span class="badge">${qty(inCart)}</span>` : ''}
        <span class="tile-name">${esc(p.name)}</span>
        <span class="tile-meta">
          ${p.price ? `<span class="tile-price">${money(p.price)}</span>` : `<span class="tile-price none">sin precio</span>`}
          ${stock !== null ? `<span class="stock ${stock <= 0 ? 'low' : ''}">${qty(stock)}</span>` : ''}
        </span>
      </button>`;
  }).join('');
}

function saleSummary(sale) {
  return sale.items.map((it) => {
    const p = productById(it.pid);
    return `${qty(it.qty)}× ${esc(p ? p.name : 'Producto eliminado')}`;
  }).join(', ');
}

function salesListHtml() {
  if (!state.day.sales.length) {
    return `<div class="card empty">Todavía no hay ventas registradas hoy.<br><span class="small">Toca los productos de arriba para vender.</span></div>`;
  }
  const rows = [...state.day.sales].reverse().map((s) => `
    <div class="sale">
      <div class="sale-time">${fmtTime(s.time)}</div>
      <div class="grow sale-items">${saleSummary(s)}</div>
      <div class="sale-total">${money(saleTotal(s))}</div>
      <button class="icon-btn" data-action="deleteSale" data-id="${s.id}" aria-label="Anular venta">
        <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`).join('');
  return `<div class="card list">${rows}</div>`;
}

function refreshSellGrid() {
  const grid = $('#sellGrid');
  if (grid) grid.innerHTML = sellGridHtml();
  renderCartBar();
}

function cartCount() {
  return Object.values(ui.cart).reduce((a, b) => a + b, 0);
}

function cartTotal() {
  return Object.entries(ui.cart).reduce((sum, [pid, q]) => {
    const p = productById(pid);
    return sum + (p ? p.price * q : 0);
  }, 0);
}

function renderCartBar() {
  const bar = $('#cartbar');
  const n = cartCount();
  if (ui.tab !== 'vender' || !n) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.innerHTML = `
    <div class="cartbar-inner">
      <div class="grow" data-action="openCart">${qty(n)} ${n === 1 ? 'artículo' : 'artículos'}<b>${money(cartTotal())}</b></div>
      <button class="btn sm" style="background:transparent;color:inherit;border-color:rgba(127,127,127,.5)" data-action="openCart">Ver</button>
      <button class="btn primary" data-action="registerSale">Cobrar</button>
    </div>`;
}

function addToCart(pid) {
  ui.cart[pid] = (ui.cart[pid] || 0) + 1;
  refreshSellGrid();
}

function cartSheetHtml() {
  const entries = Object.entries(ui.cart).filter(([, q]) => q > 0);
  if (!entries.length) return `<h2>Venta</h2><div class="empty">No hay productos en la venta.</div>`;
  const lines = entries.map(([pid, q]) => {
    const p = productById(pid);
    return `
      <div class="cart-line">
        <div class="grow">
          <div class="item-name">${esc(p.name)}</div>
          <div class="item-sub">${money(p.price)} c/u · ${money(p.price * q)}</div>
        </div>
        <div class="stepper">
          <button data-action="cartDec" data-id="${pid}" aria-label="Menos">−</button>
          <span class="q">${qty(q)}</span>
          <button data-action="cartInc" data-id="${pid}" aria-label="Más">+</button>
        </div>
      </div>`;
  }).join('');
  return `
    <h2>Venta actual</h2>
    ${lines}
    <div class="sum-line" style="margin-top:8px"><span>Total</span><span class="sum-total">${money(cartTotal())}</span></div>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn danger" data-action="clearCart">Vaciar</button>
      <button class="btn primary" data-action="registerSale">Cobrar ${money(cartTotal())}</button>
    </div>`;
}

function openCart() {
  openSheet(cartSheetHtml());
}

function refreshCartSheet() {
  if (!cartCount()) {
    closeSheet();
  } else {
    $('#sheet').innerHTML = `<div class="sheet-handle"></div>${cartSheetHtml()}`;
  }
  refreshSellGrid();
}

function registerSale() {
  const items = Object.entries(ui.cart)
    .filter(([, q]) => q > 0)
    .map(([pid, q]) => ({ pid, qty: q, price: productById(pid).price }));
  if (!items.length) return;
  const sale = { id: uid(), time: new Date().toISOString(), items };
  state.day.sales.push(sale);
  save();
  ui.cart = {};
  if (!$('#sheetWrap').hidden) closeSheet();
  render();
  toast(`Venta registrada: ${money(saleTotal(sale))}`);
}

function deleteSale(id) {
  const sale = state.day.sales.find((s) => s.id === id);
  if (!sale) return;
  if (!confirm(`¿Anular esta venta de ${money(saleTotal(sale))}?\n\n${saleSummary(sale).replace(/&[^;]+;/g, '')}`)) return;
  state.day.sales = state.day.sales.filter((s) => s.id !== id);
  save();
  render();
  toast('Venta anulada');
}

/* =========================================================================
   INVENTARIO
   ========================================================================= */

function viewInventario() {
  return `
    <div class="toolbar">
      <div class="segmented">
        <button class="${ui.invMode === 'lista' ? 'on' : ''}" data-action="invMode" data-mode="lista">Lista</button>
        <button class="${ui.invMode === 'rapida' ? 'on' : ''}" data-action="invMode" data-mode="rapida">Edición rápida</button>
      </div>
      <button class="btn primary sm" style="min-height:42px" data-action="newProduct">+ Nuevo</button>
    </div>
    <input type="search" id="invSearch" placeholder="Buscar producto…" value="${esc(ui.invSearch)}" autocomplete="off">
    <div id="invList">${invListHtml()}</div>
  `;
}

function invListHtml() {
  const q = normalize(ui.invSearch.trim());
  const list = activeProducts().filter((p) => !q || normalize(p.name).includes(q));
  if (!list.length) return `<div class="empty">No hay productos que coincidan.</div>`;
  const sold = soldMap();
  const noPrice = activeProducts().filter((p) => !p.price).length;

  const hint = noPrice && ui.invMode === 'lista'
    ? `<div class="banner" style="margin-top:12px"><div class="grow"><b>${noPrice} productos sin precio</b>Usa “Edición rápida” para ponerlos todos de una vez.</div></div>`
    : '';

  return hint + groupByCategory(list).map(([cat, items]) => {
    if (ui.invMode === 'rapida') {
      return `
        <div class="cat-head">${esc(cat)}</div>
        <div class="card list">
          <div class="quick quick-head" style="border:0"><span>Producto</span><span class="right">Precio</span><span class="right">Hay</span></div>
          ${items.map((p) => `
            <div class="quick">
              <div class="quick-name">${esc(p.name)}</div>
              <input inputmode="decimal" data-quick="price" data-id="${p.id}" value="${p.price || ''}" placeholder="0">
              ${p.trackStock
                ? `<input inputmode="decimal" data-quick="stock" data-id="${p.id}" value="${qty(stockOf(p, sold)).replace(/,/g, '')}">`
                : `<div class="na">sin control</div>`}
            </div>`).join('')}
        </div>`;
    }
    return `
      <div class="cat-head">${esc(cat)}</div>
      <div class="card list">
        ${items.map((p) => `
          <button class="item" data-action="editProduct" data-id="${p.id}">
            <div class="grow">
              <div class="item-name">${esc(p.name)}</div>
              <div class="item-sub">${p.trackStock ? `Hay ${qty(stockOf(p, sold))} ${esc(p.unit)}` : 'Sin control de existencia'}</div>
            </div>
            ${p.price ? `<div class="item-price">${money(p.price)}</div>` : `<div class="item-price none">sin precio</div>`}
          </button>`).join('')}
      </div>`;
  }).join('');
}

function productFormHtml(p) {
  const isNew = !p;
  p = p || { name: '', category: ui.cat !== 'Todos' ? ui.cat : categoryList()[0] || '', unit: 'u', price: 0, trackStock: true };
  const stock = isNew ? 0 : stockOf(p);
  const cats = categoryList();
  if (p.category && !cats.includes(p.category)) cats.push(p.category);
  return `
    <h2>${isNew ? 'Nuevo producto' : 'Editar producto'}</h2>
    <form id="productForm" class="stack" data-id="${isNew ? '' : p.id}">
      <label class="field"><span>Nombre</span><input name="name" value="${esc(p.name)}" required autocomplete="off"></label>
      <label class="field"><span>Categoría</span>
        <select name="category">
          ${cats.map((c) => `<option ${c === p.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          <option value="__new">+ Nueva categoría…</option>
        </select>
      </label>
      <label class="field" id="newCatField" hidden><span>Nombre de la nueva categoría</span><input name="newCategory" autocomplete="off"></label>
      <div class="row">
        <label class="field grow"><span>Precio (CUP)</span><input name="price" inputmode="decimal" value="${p.price || ''}" placeholder="0"></label>
        <label class="field" style="width:110px"><span>Unidad</span><input name="unit" value="${esc(p.unit)}" autocomplete="off"></label>
      </div>
      <label class="check"><input type="checkbox" name="trackStock" ${p.trackStock ? 'checked' : ''}> Llevar control de existencia</label>
      <label class="field" id="stockField" ${p.trackStock ? '' : 'hidden'}><span>Existencia actual (lo que hay ahora)</span>
        <input name="stock" inputmode="decimal" value="${qty(stock).replace(/,/g, '')}"></label>
      <button class="btn primary block" type="submit">${isNew ? 'Agregar producto' : 'Guardar cambios'}</button>
    </form>
    ${isNew || !p.trackStock ? '' : `
      <h3 class="section-title">Entrada de mercancía</h3>
      <div class="card">
        <div class="muted small" style="margin-bottom:8px">Suma a la existencia lo que llegó o se produjo hoy.</div>
        <div class="row">
          <input id="entryQty" inputmode="decimal" placeholder="Cantidad" style="flex:1">
          <button class="btn" data-action="addEntry" data-id="${p.id}">Sumar</button>
        </div>
      </div>`}
    ${isNew ? '' : `<button class="btn danger block" style="margin-top:18px" data-action="deleteProduct" data-id="${p.id}">Eliminar producto</button>`}
  `;
}

function openProductForm(id) {
  const p = id ? productById(id) : null;
  openSheet(productFormHtml(p), () => { if (ui.tab === 'inventario') render(); });
}

function submitProductForm(form) {
  const data = new FormData(form);
  const name = String(data.get('name') || '').trim();
  if (!name) return toast('Escribe el nombre del producto');

  let category = String(data.get('category') || '');
  if (category === '__new') {
    category = String(data.get('newCategory') || '').trim();
    if (!category) return toast('Escribe el nombre de la categoría');
  }
  if (!state.categories.includes(category)) state.categories.push(category);

  const fields = {
    name,
    category,
    unit: String(data.get('unit') || 'u').trim() || 'u',
    price: round2(parseNum(data.get('price'))),
    trackStock: data.get('trackStock') === 'on',
  };

  let p;
  if (form.dataset.id) {
    p = productById(form.dataset.id);
    Object.assign(p, fields);
  } else {
    p = { id: uid(), archived: false, ...fields };
    state.products.push(p);
  }
  if (p.trackStock && data.has('stock')) {
    const stock = parseNum(data.get('stock'));
    if (form.dataset.id ? stock !== stockOf(p) : stock) setStock(p, stock);
  }
  save();
  closeSheet();
  toast(form.dataset.id ? 'Cambios guardados' : 'Producto agregado');
}

function addEntry(id) {
  const p = productById(id);
  const n = parseNum($('#entryQty').value);
  if (!n) return toast('Escribe la cantidad que entró');
  state.day.entradas[id] = (state.day.entradas[id] || 0) + n;
  save();
  $('#sheet').innerHTML = `<div class="sheet-handle"></div>${productFormHtml(p)}`;
  toast(`+${qty(n)} ${p.name}`);
}

function deleteProduct(id) {
  const p = productById(id);
  if (!confirm(`¿Eliminar “${p.name}”?\n\nLas ventas que ya tiene en el historial se conservan.`)) return;
  p.archived = true;
  delete ui.cart[id];
  save();
  closeSheet();
  toast('Producto eliminado');
}

function saveQuickField(input) {
  const p = productById(input.dataset.id);
  const value = parseNum(input.value);
  if (input.dataset.quick === 'price') {
    p.price = round2(value);
  } else {
    setStock(p, value);
  }
  save();
}

/* =========================================================================
   CIERRE
   ========================================================================= */

function draft() {
  if (!state.draft) state.draft = { finals: {}, ventas: {}, transfer: '', cashCounted: '', note: '', date: '' };
  return state.draft;
}

function closingLines() {
  const sold = soldMap();
  const d = state.draft || { finals: {}, ventas: {} };
  const day = state.day;
  return state.products
    .filter((p) => !p.archived || sold[p.id] || day.entradas[p.id] || day.inicio[p.id])
    .map((p) => {
      const inicio = day.inicio[p.id] || 0;
      const entradas = day.entradas[p.id] || 0;
      const reg = sold[p.id] || 0;
      let final = 0;
      let venta;
      if (p.trackStock) {
        const expected = inicio + entradas - reg;
        final = d.finals[p.id] !== undefined ? d.finals[p.id] : expected;
        venta = round2(inicio + entradas - final);
      } else {
        venta = d.ventas[p.id] !== undefined ? d.ventas[p.id] : reg;
      }
      return { p, inicio, entradas, reg, final, venta, importe: round2(venta * p.price) };
    });
}

function closingTotals(lines = closingLines()) {
  const d = state.draft || {};
  const total = round2(lines.reduce((s, l) => s + l.importe, 0));
  const transfer = round2(parseNum(d.transfer));
  const cash = round2(total - transfer);
  const counted = d.cashCounted === '' || d.cashCounted === undefined ? null : round2(parseNum(d.cashCounted));
  return { total, transfer, cash, counted, diff: counted === null ? null : round2(counted - cash) };
}

function closeRowOutHtml(l) {
  const warn = l.venta < 0;
  const hint = l.p.trackStock && l.reg && l.venta !== l.reg ? ` <span title="registrado">(reg. ${qty(l.reg)})</span>` : '';
  if (l.p.trackStock) {
    return `<div class="v">${warn ? 'Revisar' : `Vendió ${qty(l.venta)}`}${hint}</div><div class="imp">${money(l.importe)}</div>`;
  }
  return `<div class="v">× ${money(l.p.price)}</div><div class="imp">${money(l.importe)}</div>`;
}

function viewCierre() {
  const lines = closingLines();
  const d = state.draft || {};
  const noPrice = lines.filter((l) => l.venta && !l.p.price).length;

  const groups = new Map();
  for (const l of lines) {
    const cat = l.p.category;
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(l);
  }
  const order = [...categoryList(), ...[...groups.keys()].filter((c) => !categoryList().includes(c))];

  const rows = order.filter((c) => groups.has(c)).map((cat) => `
    <div class="cat-head">${esc(cat)}</div>
    <div class="card list">
      ${groups.get(cat).map((l) => `
        <div class="crow ${l.venta < 0 ? 'warn' : ''} ${l.venta === 0 ? 'zero' : ''}" id="crow-${l.p.id}">
          <div>
            <div class="crow-name">${esc(l.p.name)}</div>
            <div class="crow-meta">${l.p.trackStock
              ? `Inicio ${qty(l.inicio)}${l.entradas ? ` · Entró ${qty(l.entradas)}` : ''}`
              : `Registrado ${qty(l.reg)}`}</div>
          </div>
          <label class="crow-in">
            <span>${l.p.trackStock ? 'Queda' : 'Vendió'}</span>
            <input inputmode="decimal" data-close="${l.p.trackStock ? 'final' : 'venta'}" data-id="${l.p.id}"
              value="${qty(l.p.trackStock ? l.final : l.venta).replace(/,/g, '')}">
          </label>
          <div class="crow-out">${closeRowOutHtml(l)}</div>
        </div>`).join('')}
    </div>`).join('');

  return `
    <div class="banner">
      <div class="grow"><b>Cómo cerrar</b>
        Cuenta lo que queda de cada producto y escríbelo en “Queda”. La app calcula lo vendido. Después pon lo que entró por transferencia.</div>
    </div>
    ${noPrice ? `<div class="banner" style="background:var(--bad-soft)"><div class="grow"><b>${noPrice} productos vendidos no tienen precio</b>Ponles precio en Inventario para que el total sea correcto.</div></div>` : ''}
    ${rows}
    <h3 class="section-title">Cuadre de caja</h3>
    <div class="card" id="closeSummary">${closeSummaryHtml()}</div>
    <div class="card stack" style="margin-top:12px">
      <label class="field"><span>Fecha del cierre</span><input type="date" id="closeDate" value="${esc(d.date || defaultCloseDate())}"></label>
      <label class="field"><span>Nota (opcional)</span><textarea id="closeNote" placeholder="Ej: se rompió un vaso, faltó gas…">${esc(d.note || '')}</textarea></label>
    </div>
    <button class="btn primary block" style="margin-top:16px;min-height:54px;font-size:17px" data-action="doClose">Cerrar el día</button>
    <div class="right" style="margin-top:6px"><button class="link" data-action="resetDraft">Borrar lo que escribí</button></div>
  `;
}

function closeSummaryHtml() {
  const t = closingTotals();
  const d = state.draft || {};
  let diffHtml = '';
  if (t.diff !== null) {
    diffHtml = t.diff === 0
      ? `<span class="pill good">Cuadra exacto</span>`
      : t.diff > 0
        ? `<span class="pill good">Sobran ${money(t.diff)}</span>`
        : `<span class="pill bad">Faltan ${money(-t.diff)}</span>`;
  }
  return `
    <div class="sum-line"><span class="muted">Total vendido</span><span class="sum-total" id="sumTotal">${money(t.total)}</span></div>
    <div class="sum-line"><span>Transferencias</span>
      <input class="input" inputmode="decimal" id="closeTransfer" value="${esc(d.transfer || '')}" placeholder="0"></div>
    <div class="sum-line"><span><b>Debe haber en efectivo</b></span><b id="sumCash" style="font-size:20px">${money(t.cash)}</b></div>
    <div class="sum-line"><span>Efectivo contado <span class="muted small">(opcional)</span></span>
      <input class="input" inputmode="decimal" id="closeCounted" value="${esc(d.cashCounted || '')}" placeholder="—"></div>
    <div class="sum-line" id="sumDiff" ${diffHtml ? '' : 'hidden'}><span>Diferencia</span>${diffHtml}</div>
  `;
}

// Updates computed numbers without re-rendering, so the keyboard stays open.
function refreshClosingNumbers() {
  const lines = closingLines();
  for (const l of lines) {
    const row = $(`#crow-${l.p.id}`);
    if (!row) continue;
    row.classList.toggle('warn', l.venta < 0);
    row.classList.toggle('zero', l.venta === 0);
    $('.crow-out', row).innerHTML = closeRowOutHtml(l);
  }
  const t = closingTotals(lines);
  $('#sumTotal').textContent = money(t.total);
  $('#sumCash').textContent = money(t.cash);
  const diffRow = $('#sumDiff');
  if (t.diff === null) {
    diffRow.hidden = true;
  } else {
    diffRow.hidden = false;
    diffRow.innerHTML = `<span>Diferencia</span>${t.diff === 0
      ? `<span class="pill good">Cuadra exacto</span>`
      : t.diff > 0 ? `<span class="pill good">Sobran ${money(t.diff)}</span>` : `<span class="pill bad">Faltan ${money(-t.diff)}</span>`}`;
  }
}

function doClose() {
  const lines = closingLines();
  const bad = lines.filter((l) => l.venta < 0);
  if (bad.length) {
    return alert(`Revisa estos productos: lo que queda es más de lo que había.\n\n${bad.map((l) => '• ' + l.p.name).join('\n')}`);
  }
  const t = closingTotals(lines);
  const d = draft();
  const date = $('#closeDate').value || defaultCloseDate();
  if (state.closes.some((c) => c.date === date)) {
    if (!confirm(`Ya hay un cierre guardado para el ${fmtDateNumeric(date)}. ¿Guardar otro cierre con la misma fecha?`)) return;
  }
  if (!confirm(`¿Cerrar el día ${fmtDateNumeric(date)}?\n\nTotal vendido: ${money(t.total)}\nTransferencias: ${money(t.transfer)}\nEfectivo: ${money(t.cash)}\n\nLo que queda de cada producto pasa a ser el inicio de mañana.`)) return;

  const close = {
    id: uid(),
    date,
    openedAt: state.day.openedAt,
    closedAt: new Date().toISOString(),
    salesCount: state.day.sales.length,
    lines: lines.map((l) => ({
      pid: l.p.id,
      name: l.p.name,
      category: l.p.category,
      unit: l.p.unit,
      tracked: !!l.p.trackStock,
      inicio: l.inicio,
      entradas: l.entradas,
      venta: l.venta,
      final: l.final,
      registrado: l.reg,
      precio: l.p.price,
      importe: l.importe,
    })),
    total: t.total,
    transfer: t.transfer,
    cash: t.cash,
    cashCounted: t.counted,
    note: String(d.note || '').trim(),
  };
  state.closes.push(close);

  const nextInicio = {};
  for (const l of lines) if (l.p.trackStock && !l.p.archived) nextInicio[l.p.id] = l.final;
  state.day = newDay(nextInicio);
  state.draft = null;
  save();

  ui.tab = 'historial';
  render();
  openCloseDetail(close.id, true);
}

/* =========================================================================
   HISTORIAL
   ========================================================================= */

function closesSorted() {
  return [...state.closes].sort((a, b) => (b.date + b.closedAt).localeCompare(a.date + a.closedAt));
}

function viewHistorial() {
  if (!state.closes.length) {
    return `<div class="card empty">Todavía no hay cierres guardados.<br><span class="small">Cuando cierres el primer día aparecerá aquí.</span></div>`;
  }
  const today = parseLocalDate(localDate());
  const daysAgo = (ymd) => Math.round((today - parseLocalDate(ymd)) / 86400000);
  const monthKey = localDate().slice(0, 7);

  const last7 = state.closes.filter((c) => daysAgo(c.date) < 7);
  const month = state.closes.filter((c) => c.date.startsWith(monthKey));
  const last30 = state.closes.filter((c) => daysAgo(c.date) < 30);
  const sum = (arr) => arr.reduce((s, c) => s + c.total, 0);
  const avg = last30.length ? sum(last30) / last30.length : 0;

  // Last 14 days bar chart
  const byDate = {};
  for (const c of state.closes) byDate[c.date] = (byDate[c.date] || 0) + c.total;
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push({ ymd: localDate(d), d });
  }
  const max = Math.max(1, ...days.map((x) => byDate[x.ymd] || 0));

  // Top products, last 30 days
  const top = {};
  for (const c of last30) {
    for (const l of c.lines) {
      if (!l.venta) continue;
      top[l.name] = top[l.name] || { qty: 0, importe: 0 };
      top[l.name].qty += l.venta;
      top[l.name].importe += l.importe;
    }
  }
  const topList = Object.entries(top).sort((a, b) => b[1].importe - a[1].importe).slice(0, 6);

  return `
    <div class="stats">
      <div class="stat"><div class="l">Últimos 7 días</div><div class="v">${money(sum(last7))}</div></div>
      <div class="stat"><div class="l">Este mes</div><div class="v">${money(sum(month))}</div></div>
      <div class="stat"><div class="l">Promedio/día</div><div class="v">${money(avg)}</div></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="muted small" style="font-weight:600">Ventas de los últimos 14 días</div>
      <div class="bars">${days.map((x) => `<div class="b" style="height:${((byDate[x.ymd] || 0) / max) * 100}%" title="${fmtDateNumeric(x.ymd)}: ${money(byDate[x.ymd] || 0)}"></div>`).join('')}</div>
      <div class="bars-labels">${days.map((x) => `<span>${x.d.getDate()}</span>`).join('')}</div>
    </div>
    ${topList.length ? `
      <h3 class="section-title">Más vendidos <span class="muted">(30 días)</span></h3>
      <div class="card">${topList.map(([name, v]) => `
        <div class="top-line"><span>${esc(name)} <span class="muted">× ${qty(v.qty)}</span></span><b>${money(v.importe)}</b></div>`).join('')}
      </div>` : ''}
    <h3 class="section-title">Cierres</h3>
    <div class="card list">
      ${closesSorted().map((c) => `
        <button class="item" data-action="openClose" data-id="${c.id}">
          <div class="grow">
            <div class="item-name">${fmtDate(c.date)}</div>
            <div class="item-sub">Transf. ${money(c.transfer)} · Efectivo ${money(c.cash)}${c.cashCounted !== null && c.cashCounted !== c.cash ? ' · <span style="color:var(--bad)">descuadre</span>' : ''}</div>
          </div>
          <div class="item-price">${money(c.total)}</div>
        </button>`).join('')}
    </div>
    <button class="btn block" style="margin-top:14px" data-action="exportAllExcel">Exportar todo el historial a Excel</button>
  `;
}

function closeDetailHtml(c, justClosed) {
  const sold = c.lines.filter((l) => l.venta);
  const diff = c.cashCounted === null ? null : round2(c.cashCounted - c.cash);
  const backupOld = daysSince(state.settings.lastBackup) >= 3;
  return `
    ${justClosed ? `<div class="banner" style="background:var(--good-soft)"><div class="grow"><b>Día cerrado</b>Mañana empieza con lo que contaste hoy.</div></div>` : ''}
    <h2>${fmtDate(c.date)}</h2>
    <div class="card">
      <div class="sum-line"><span class="muted">Total vendido</span><span class="sum-total">${money(c.total)}</span></div>
      <div class="sum-line"><span>Transferencias</span><b>${money(c.transfer)}</b></div>
      <div class="sum-line"><span>Efectivo</span><b>${money(c.cash)}</b></div>
      ${diff !== null ? `<div class="sum-line"><span>Efectivo contado</span><span><b>${money(c.cashCounted)}</b> ${diff === 0 ? '<span class="pill good">cuadra</span>' : diff > 0 ? `<span class="pill good">+${money(diff)}</span>` : `<span class="pill bad">−${money(-diff)}</span>`}</span></div>` : ''}
      ${c.note ? `<div class="sum-line"><span class="muted">Nota</span><span>${esc(c.note)}</span></div>` : ''}
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn" data-action="shareClose" data-id="${c.id}">Compartir</button>
      <button class="btn" data-action="exportCloseExcel" data-id="${c.id}">Excel</button>
    </div>
    ${justClosed && backupOld ? `<button class="btn primary block" style="margin-top:10px" data-action="backup">Guardar copia de seguridad</button>` : ''}
    <h3 class="section-title">Productos vendidos <span class="muted">(${sold.length})</span></h3>
    ${sold.length ? `
      <div class="card" style="padding:6px 10px">
        <table class="dtable">
          <thead><tr><th>Producto</th><th class="r">Cant.</th><th class="r">Precio</th><th class="r">Importe</th></tr></thead>
          <tbody>${sold.map((l) => `<tr><td>${esc(l.name)}</td><td class="r">${qty(l.venta)}</td><td class="r">${money(l.precio)}</td><td class="r"><b>${money(l.importe)}</b></td></tr>`).join('')}</tbody>
        </table>
      </div>` : `<div class="card empty">No se vendió nada.</div>`}
    ${justClosed ? '' : `<button class="btn danger block" style="margin-top:18px" data-action="deleteClose" data-id="${c.id}">Eliminar este cierre</button>`}
  `;
}

function openCloseDetail(id, justClosed = false) {
  const c = state.closes.find((x) => x.id === id);
  if (c) openSheet(closeDetailHtml(c, justClosed));
}

function deleteClose(id) {
  const c = state.closes.find((x) => x.id === id);
  if (!confirm(`¿Eliminar el cierre del ${fmtDateNumeric(c.date)}?\n\nNo cambia el inventario actual. Esto no se puede deshacer.`)) return;
  state.closes = state.closes.filter((x) => x.id !== id);
  save();
  closeSheet();
  render();
  toast('Cierre eliminado');
}

function closeShareText(c) {
  const name = state.settings.businessName || 'Mi negocio';
  const lines = [
    `*${name} — Cierre ${fmtDateNumeric(c.date)}*`,
    `Total vendido: ${money(c.total)}`,
    `Transferencias: ${money(c.transfer)}`,
    `Efectivo: ${money(c.cash)}`,
  ];
  if (c.cashCounted !== null) {
    const diff = round2(c.cashCounted - c.cash);
    lines.push(`Efectivo contado: ${money(c.cashCounted)}${diff ? (diff > 0 ? ` (sobran ${money(diff)})` : ` (faltan ${money(-diff)})`) : ' (cuadra)'}`);
  }
  if (c.note) lines.push(`Nota: ${c.note}`);
  const sold = c.lines.filter((l) => l.venta);
  if (sold.length) {
    lines.push('', 'Vendido:');
    for (const l of sold) lines.push(`• ${l.name}: ${qty(l.venta)} × ${money(l.precio)} = ${money(l.importe)}`);
  }
  return lines.join('\n');
}

async function shareClose(id) {
  const c = state.closes.find((x) => x.id === id);
  const text = closeShareText(c);
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Resumen copiado. Pégalo en WhatsApp.');
  } catch {
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
  }
}

/* ---------- Files: Excel & backups ---------- */

let xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  if (!xlsxLoading) {
    xlsxLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/xlsx.full.min.js';
      s.onload = resolve;
      s.onerror = () => { xlsxLoading = null; reject(new Error('xlsx')); };
      document.head.appendChild(s);
    });
  }
  return xlsxLoading;
}

const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches;

async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (isTouchDevice() && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

function closeSheetRows(c) {
  const rows = [
    [state.settings.businessName || ''],
    ['FECHA:', fmtDateNumeric(c.date)],
    ['No', 'Productos', 'U/M', 'Inicio', 'Entrada', 'Venta', 'Final', 'Precio', 'Importe'],
  ];
  c.lines.forEach((l, i) => {
    rows.push([
      i + 1, l.name, l.unit,
      l.tracked ? l.inicio : '', l.tracked ? l.entradas || '' : '',
      l.venta, l.tracked ? l.final : '',
      l.precio, l.importe,
    ]);
  });
  rows.push([]);
  rows.push(['', 'TOTAL VENDIDO', '', '', '', '', '', '', c.total]);
  rows.push(['', 'Transferencias', '', '', '', '', '', '', c.transfer]);
  rows.push(['', 'Efectivo', '', '', '', '', '', '', c.cash]);
  if (c.cashCounted !== null) rows.push(['', 'Efectivo contado', '', '', '', '', '', '', c.cashCounted]);
  if (c.note) rows.push(['', 'Nota: ' + c.note]);
  return rows;
}

function makeSheet(rows, widths) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = widths.map((wch) => ({ wch }));
  return ws;
}

async function exportCloseExcel(id) {
  const c = state.closes.find((x) => x.id === id);
  try {
    await loadXlsx();
  } catch {
    return toast('No se pudo cargar el generador de Excel');
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, makeSheet(closeSheetRows(c), [5, 32, 6, 8, 8, 8, 8, 10, 12]), 'Reporte de Ventas');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  await saveFile(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Cierre ${c.date}.xlsx`);
}

async function exportAllExcel() {
  try {
    await loadXlsx();
  } catch {
    return toast('No se pudo cargar el generador de Excel');
  }
  const closes = [...state.closes].sort((a, b) => a.date.localeCompare(b.date));
  const summary = [['Fecha', 'Total vendido', 'Transferencias', 'Efectivo', 'Efectivo contado', 'Diferencia', 'Nota']];
  const detail = [['Fecha', 'Producto', 'Categoría', 'U/M', 'Inicio', 'Entrada', 'Venta', 'Final', 'Precio', 'Importe']];
  for (const c of closes) {
    summary.push([
      fmtDateNumeric(c.date), c.total, c.transfer, c.cash,
      c.cashCounted === null ? '' : c.cashCounted,
      c.cashCounted === null ? '' : round2(c.cashCounted - c.cash),
      c.note || '',
    ]);
    for (const l of c.lines) {
      if (!l.venta && !l.entradas) continue;
      detail.push([fmtDateNumeric(c.date), l.name, l.category, l.unit,
        l.tracked ? l.inicio : '', l.entradas || '', l.venta, l.tracked ? l.final : '', l.precio, l.importe]);
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, makeSheet(summary, [12, 14, 14, 12, 16, 12, 30]), 'Resumen');
  XLSX.utils.book_append_sheet(wb, makeSheet(detail, [12, 32, 18, 6, 8, 8, 8, 8, 10, 12]), 'Detalle');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  await saveFile(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Historial ${localDate()}.xlsx`);
}

async function backup() {
  const payload = { app: 'peter-mipyme', exportedAt: new Date().toISOString(), state };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const ok = await saveFile(blob, `Copia Peter Mipyme ${localDate()}.json`);
  if (ok) {
    state.settings.lastBackup = new Date().toISOString();
    save();
    toast('Copia de seguridad lista');
    if (ui.tab === 'ajustes') render();
  }
}

function restoreBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (data.app !== 'peter-mipyme' || !data.state || !Array.isArray(data.state.products)) throw new Error('format');
      const when = data.exportedAt ? new Date(data.exportedAt).toLocaleString('es') : 'fecha desconocida';
      if (!confirm(`¿Restaurar la copia del ${when}?\n\nSe reemplazan TODOS los datos actuales de este teléfono.`)) return;
      state = migrate(data.state);
      save();
      ui.cart = {};
      render();
      toast('Datos restaurados');
    } catch {
      alert('Ese archivo no es una copia de seguridad válida de la app.');
    }
  };
  reader.readAsText(file);
}

/* =========================================================================
   AJUSTES
   ========================================================================= */

function viewAjustes() {
  const last = state.settings.lastBackup;
  const lastText = last ? `Última copia: ${new Date(last).toLocaleDateString('es')} (hace ${daysSince(last)} días)` : 'Nunca se ha hecho una copia.';
  return `
    ${installTipHtml()}
    <div class="card stack">
      <label class="field"><span>Nombre del negocio</span><input id="bizName" value="${esc(state.settings.businessName)}" autocomplete="off"></label>
      <div class="muted small">Aparece arriba en la app y en los reportes.</div>
    </div>

    <h3 class="section-title">Copia de seguridad</h3>
    <div class="card stack">
      <div class="small">Los datos se guardan solo en este teléfono. Si se pierde o se borra Safari, se pierden. Haz una copia cada pocos días y guárdala en Archivos o mándala por WhatsApp.</div>
      <div class="small ${!last || daysSince(last) >= 7 ? '' : 'muted'}" style="${!last || daysSince(last) >= 7 ? 'color:var(--bad);font-weight:600' : ''}">${lastText}</div>
      <div class="btn-row">
        <button class="btn primary" data-action="backup">Hacer copia</button>
        <button class="btn" data-action="restore">Restaurar copia</button>
      </div>
      <input type="file" id="restoreFile" accept=".json,application/json" hidden>
    </div>

    <h3 class="section-title">Cómo funciona</h3>
    <div class="card small stack">
      <div><b>1. Al empezar:</b> en Inventario → “Edición rápida” pon el precio y lo que hay de cada producto.</div>
      <div><b>2. Durante el día (opcional):</b> en Vender toca los productos y “Cobrar”. Si no quieres registrar cada venta, no pasa nada: el cierre lo calcula igual.</div>
      <div><b>3. Si llega mercancía:</b> en Inventario abre el producto y usa “Entrada de mercancía”.</div>
      <div><b>4. Por la noche:</b> en Cierre escribe lo que queda de cada producto y lo que entró por transferencia. Toca “Cerrar el día”.</div>
    </div>

    <h3 class="section-title">Zona peligrosa</h3>
    <div class="card">
      <button class="btn danger block" data-action="resetAll">Borrar todos los datos</button>
    </div>
    <div class="muted small" style="text-align:center;margin-top:18px">Peter Mipyme · versión 1.0</div>
  `;
}

function resetAll() {
  if (!confirm('¿Borrar TODOS los datos? Se pierden precios, inventario e historial.')) return;
  if (!confirm('¿Seguro? Esto no se puede deshacer. Haz una copia antes si tienes dudas.')) return;
  state = defaultState();
  save();
  ui.cart = {};
  render();
  toast('Datos borrados');
}

/* =========================================================================
   Events
   ========================================================================= */

document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('#tabbar button');
  if (tabBtn) return switchTab(tabBtn.dataset.tab);

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case 'closeSheet': return closeSheet();
    case 'hideInstallTip': state.settings.hideInstallTip = true; save(); return render();

    case 'cat': ui.cat = el.dataset.cat; return render();
    case 'add': return addToCart(id);
    case 'openCart': return openCart();
    case 'cartInc': ui.cart[id] = (ui.cart[id] || 0) + 1; return refreshCartSheet();
    case 'cartDec':
      ui.cart[id] = Math.max(0, (ui.cart[id] || 0) - 1);
      if (!ui.cart[id]) delete ui.cart[id];
      return refreshCartSheet();
    case 'clearCart': ui.cart = {}; return refreshCartSheet();
    case 'registerSale': return registerSale();
    case 'deleteSale': return deleteSale(id);

    case 'invMode': ui.invMode = el.dataset.mode; return render();
    case 'newProduct': return openProductForm(null);
    case 'editProduct': return openProductForm(id);
    case 'addEntry': return addEntry(id);
    case 'deleteProduct': return deleteProduct(id);

    case 'doClose': return doClose();
    case 'resetDraft':
      if (confirm('¿Borrar lo que escribiste en el cierre?')) { state.draft = null; save(); render(); }
      return;

    case 'openClose': return openCloseDetail(id);
    case 'deleteClose': return deleteClose(id);
    case 'shareClose': return shareClose(id);
    case 'exportCloseExcel': return exportCloseExcel(id);
    case 'exportAllExcel': return exportAllExcel();

    case 'backup': return backup();
    case 'restore': return $('#restoreFile').click();
    case 'resetAll': return resetAll();
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'sellSearch') {
    ui.search = t.value;
    const grid = $('#sellGrid');
    if (grid) grid.innerHTML = sellGridHtml();
    return;
  }
  if (t.id === 'invSearch') {
    ui.invSearch = t.value;
    $('#invList').innerHTML = invListHtml();
    return;
  }
  if (t.dataset.close) {
    const d = draft();
    const map = t.dataset.close === 'final' ? d.finals : d.ventas;
    if (t.value.trim() === '') delete map[t.dataset.id];
    else map[t.dataset.id] = parseNum(t.value);
    save();
    return refreshClosingNumbers();
  }
  if (t.id === 'closeTransfer' || t.id === 'closeCounted') {
    draft()[t.id === 'closeTransfer' ? 'transfer' : 'cashCounted'] = t.value;
    save();
    return refreshClosingNumbers();
  }
  if (t.id === 'closeNote') {
    draft().note = t.value;
    return save();
  }
  if (t.id === 'bizName') {
    state.settings.businessName = t.value;
    save();
    $('#brandName').textContent = t.value || 'Mi negocio';
    document.title = t.value || 'Mi negocio';
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.quick) return saveQuickField(t);
  if (t.id === 'closeDate') {
    draft().date = t.value;
    return save();
  }
  if (t.id === 'restoreFile' && t.files[0]) {
    restoreBackup(t.files[0]);
    t.value = '';
    return;
  }
  if (t.form && t.form.id === 'productForm') {
    if (t.name === 'category') $('#newCatField').hidden = t.value !== '__new';
    if (t.name === 'trackStock') $('#stockField').hidden = !t.checked;
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'productForm') {
    e.preventDefault();
    submitProductForm(e.target);
  }
});

// Select the whole number when tapping a numeric field, so it can be overwritten directly.
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (t.matches('input[inputmode="decimal"]')) setTimeout(() => t.select(), 0);
});

/* ---------- Service worker & start ---------- */

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Hay una versión nueva. Se aplicará al volver a abrir la app.');
          nw.postMessage('skipWaiting');
        }
      });
    });
  }).catch(console.error);
}

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

save();
render();
