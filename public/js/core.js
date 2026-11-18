// Shared helpers: API client, formatting, modal, toast, small widgets.

export const state = { user: null, permissions: [], lookups: null };

export const can = (perm) => !!state.user && state.user.permissions.includes(perm);

/* --------------------------------- API --------------------------------- */

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TTF' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data || {};
    if (res.status === 401 && !path.startsWith('/auth/login')) window.dispatchEvent(new CustomEvent('ttf:logout'));
    if (err.data.code === 'PASSWORD_CHANGE_REQUIRED') window.dispatchEvent(new CustomEvent('ttf:pwd'));
    throw err;
  }
  return data;
}

export async function download(path) {
  const res = await fetch('/api' + path, { credentials: 'same-origin' });
  if (!res.ok) {
    let msg = 'Export failed.';
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'export';
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : v);
  }
  const s = p.toString();
  return s ? '?' + s : '';
}

export async function loadLookups(force = false) {
  if (!state.lookups || force) state.lookups = await api('/lookups');
  return state.lookups;
}

/* ------------------------------ Formatting ------------------------------ */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));

export const fmtDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('-') : '—');
export const fmtDateTime = (s) => (s ? `${fmtDate(s)} ${s.slice(11, 16)}` : '—');
export const fmtNum = (n) => {
  const v = Number(n) || 0;
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtMonth = (ym) => (ym ? `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(2, 4)}` : '');
export const initials = (name) => (name || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const statusBadge = (s) => `<span class="badge ${s === 'Active' ? 'ok' : 'off'}">${esc(s)}</span>`;

/* --------------------------------- Icons -------------------------------- */

const P = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/><path d="M13 6v12" stroke-dasharray="2 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  building: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  addmore: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  excel: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 13l4 5M13 13l-4 5"/>',
  pdf: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 16h8M8 12h3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 7a8 8 0 1 0 11.4 0"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7L20 8"/><path d="M20 3v5h-5"/>',
};
export const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;

/* --------------------------------- Toast -------------------------------- */

export function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 5000 : 3200);
}

/* --------------------------------- Modal -------------------------------- */

export function modal({ title, body, footer = '', size = '', dismissible = true }) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h2>${esc(title)}</h2>${dismissible ? `<button class="icon-btn" data-close aria-label="Close">${icon('close')}</button>` : ''}</div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  const prevFocus = document.activeElement;
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape' && dismissible && root.lastElementChild === wrap) close(); };
  document.addEventListener('keydown', onKey);
  // Clicking outside the dialog does not close it, so a half-filled form is never lost by accident.
  wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  root.appendChild(wrap);
  const first = wrap.querySelector('.modal-body input:not([type=hidden]):not([disabled]), .modal-body select, .modal-body textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return { el: wrap, close, $: (s) => wrap.querySelector(s), $$: (s) => [...wrap.querySelectorAll(s)] };
}

export function confirmDialog({ title, message, confirmText = 'Confirm', danger = false, reasonLabel = '' }) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title,
      size: 'narrow',
      body: `<p style="margin:0">${message}</p>
        ${reasonLabel ? `<div class="field"><label>${esc(reasonLabel)} <span class="req">*</span></label><textarea class="input" name="reason" maxlength="500"></textarea></div>` : ''}
        <div class="alert err" hidden data-err></div>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>`,
    });
    m.$('[data-ok]').addEventListener('click', () => {
      const reason = reasonLabel ? m.$('[name=reason]').value.trim() : true;
      if (reasonLabel && !reason) {
        const e = m.$('[data-err]');
        e.hidden = false;
        e.textContent = `${reasonLabel} is required.`;
        return;
      }
      done = true;
      m.close();
      resolve(reason);
    });
    const obs = new MutationObserver(() => {
      if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); }
    });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      if (!out[el.name]) out[el.name] = [];
      if (el.checked) out[el.name].push(el.value);
    } else out[el.name] = el.value;
  }
  return out;
}

export function showFormError(container, err) {
  const box = container.querySelector('[data-err]');
  if (!box) return toast(err.message || String(err), 'err');
  box.hidden = !err;
  box.textContent = err ? err.message || String(err) : '';
}

export function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.textContent = label || 'Saving…'; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

/* ------------------------------ Pagination ------------------------------ */

export function pager({ page, pageSize, total }, onChange) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  const nums = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(pages, page + 2); i++) nums.push(i);
  const el = document.createElement('div');
  el.className = 'table-foot';
  el.innerHTML = `
    <div>Showing <b>${from}</b>–<b>${to}</b> of <b>${total}</b></div>
    <div class="pager">
      <label class="sr-only" for="pg-size">Rows per page</label>
      <select id="pg-size">${[10, 25, 50, 100].map((n) => `<option ${n === pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <button data-p="1" ${page === 1 ? 'disabled' : ''} aria-label="First page">«</button>
      <button data-p="${page - 1}" ${page === 1 ? 'disabled' : ''} aria-label="Previous page">‹</button>
      ${nums.map((n) => `<button data-p="${n}" class="${n === page ? 'active' : ''}">${n}</button>`).join('')}
      <button data-p="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Next page">›</button>
      <button data-p="${pages}" ${page >= pages ? 'disabled' : ''} aria-label="Last page">»</button>
    </div>`;
  el.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => onChange({ page: +b.dataset.p, pageSize })));
  el.querySelector('select').addEventListener('change', (e) => onChange({ page: 1, pageSize: +e.target.value }));
  return el;
}

/* ----------------------------- Multi-select ----------------------------- */

export function multiSelect(host, { options, selected = [], placeholder = 'All', onChange }) {
  let sel = new Set(selected.map(String));
  host.classList.add('ms');
  host.innerHTML = `<button type="button" class="input ms-btn" aria-haspopup="listbox"><span></span>${icon('chevron').replace('<svg', '<svg width="16" height="16"')}</button>`;
  const btn = host.querySelector('button');
  const label = () => {
    const names = options.filter((o) => sel.has(String(o.value))).map((o) => o.label);
    btn.querySelector('span').textContent = !names.length ? placeholder : names.length === 1 ? names[0] : `${names.length} selected`;
    btn.title = names.join(', ');
  };
  let panel = null;
  const closePanel = () => { if (panel) { panel.remove(); panel = null; document.removeEventListener('mousedown', outside); } };
  const outside = (e) => { if (!host.contains(e.target)) closePanel(); };
  const renderList = (filter = '') => {
    const f = filter.toLowerCase();
    panel.querySelector('.ms-list').innerHTML =
      options.filter((o) => o.label.toLowerCase().includes(f))
        .map((o) => `<label><input type="checkbox" value="${esc(o.value)}" ${sel.has(String(o.value)) ? 'checked' : ''}> ${esc(o.label)}${o.note ? ` <span class="tag">${esc(o.note)}</span>` : ''}</label>`)
        .join('') || '<div class="chart-empty">No matches</div>';
  };
  btn.addEventListener('click', () => {
    if (panel) return closePanel();
    panel = document.createElement('div');
    panel.className = 'ms-panel';
    panel.innerHTML = `<input class="input" placeholder="Search…" aria-label="Search options"><div class="ms-list" role="listbox"></div>
      <div class="ms-foot"><button type="button" class="btn btn-sm btn-ghost" data-all>Select all</button><button type="button" class="btn btn-sm btn-ghost" data-clear>Clear</button></div>`;
    host.appendChild(panel);
    renderList();
    const search = panel.querySelector('input');
    search.focus();
    search.addEventListener('input', () => renderList(search.value));
    panel.querySelector('.ms-list').addEventListener('change', (e) => {
      if (e.target.checked) sel.add(e.target.value); else sel.delete(e.target.value);
      label(); onChange && onChange([...sel]);
    });
    panel.querySelector('[data-all]').addEventListener('click', () => { options.forEach((o) => sel.add(String(o.value))); renderList(search.value); label(); onChange && onChange([...sel]); });
    panel.querySelector('[data-clear]').addEventListener('click', () => { sel.clear(); renderList(search.value); label(); onChange && onChange([]); });
    setTimeout(() => document.addEventListener('mousedown', outside));
  });
  label();
  return {
    get value() { return [...sel]; },
    set(values) { sel = new Set(values.map(String)); label(); },
  };
}

/* ------------------------------- Tooltip -------------------------------- */

let tipEl = null;
export function attachTips(root) {
  root.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mouseenter', () => {
      tipEl = document.createElement('div');
      tipEl.className = 'tip';
      tipEl.innerHTML = el.dataset.tip;
      document.body.appendChild(tipEl);
    });
    el.addEventListener('mousemove', (e) => {
      if (!tipEl) return;
      const w = tipEl.offsetWidth;
      const x = Math.min(window.innerWidth - w - 8, e.clientX + 14);
      tipEl.style.left = `${x}px`;
      tipEl.style.top = `${e.clientY - tipEl.offsetHeight - 10}px`;
    });
    el.addEventListener('mouseleave', () => { if (tipEl) tipEl.remove(); tipEl = null; });
  });
}
export function clearTips() { if (tipEl) tipEl.remove(); tipEl = null; }
