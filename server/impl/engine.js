// Generic storage, validation and access rules for the Implementation module.
const crypto = require('crypto');
const { q, tx, audit, NOW } = require('../db');
const { isIsoDate, todayLocal, str, httpError } = require('../util');
const { ENTITIES, DATE_ORDER, MASTER_SEED, STD_TASKS } = require('./defs');

/* --------------------------------- Schema --------------------------------- */

const SQL_TYPE = { n: 'DOUBLE PRECISION', c: 'INTEGER', r: 'INTEGER', f: 'INTEGER', h: 'INTEGER' };

function schemaSql() {
  const parts = [`
CREATE TABLE IF NOT EXISTS files (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BYTEA NOT NULL,
  kind       TEXT NOT NULL,
  client_id  INTEGER,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS im_settings (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO im_settings (key, value) VALUES ('approval_global', '1'), ('amc_alert_days', '30,15,7') ON CONFLICT (key) DO NOTHING;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS client_code TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS client_type TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS task_approval TEXT;
`];
  for (const e of Object.values(ENTITIES)) {
    parts.push(`CREATE TABLE IF NOT EXISTS ${e.table} (id SERIAL PRIMARY KEY, created_by INTEGER, created_at TEXT NOT NULL DEFAULT ${NOW}, updated_by INTEGER, updated_at TEXT);`);
    for (const f of e.fields) parts.push(`ALTER TABLE ${e.table} ADD COLUMN IF NOT EXISTS ${f.key} ${SQL_TYPE[f.type] || 'TEXT'};`);
    if (e.hasClient) parts.push(`CREATE INDEX IF NOT EXISTS ix_${e.table}_client ON ${e.table} (client);`);
  }
  return parts.join('\n');
}

async function seedImpl() {
  if ((await q.get('SELECT COUNT(*) AS c FROM im_masters')).c === 0) {
    for (const [mtype, list] of Object.entries(MASTER_SEED)) {
      for (const name of list.split(',')) await q.run('INSERT INTO im_masters (mtype, name, enabled) VALUES (?,?,1)', mtype, name);
    }
  }
  if ((await q.get('SELECT COUNT(*) AS c FROM im_stdtasks')).c === 0) {
    for (const [module, tasks] of Object.entries(STD_TASKS)) {
      for (const task of tasks) await q.run('INSERT INTO im_stdtasks (module, task, days) VALUES (?,?,14)', module, task);
    }
  }
}

/* ------------------------------- Secrets -------------------------------- */

const KEY = crypto.createHash('sha256').update(process.env.CRED_KEY || `${process.env.SESSION_SECRET || 'dev-only'}:credentials`).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  if (!blob || !blob.startsWith('v1:')) return blob || '';
  const raw = Buffer.from(blob.slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/* -------------------------------- Files --------------------------------- */

const DOC_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', txt: 'text/plain',
};
const MAX_FILE = 10 * 1024 * 1024;

async function saveFile(file, kind, clientId, userId, { types = DOC_TYPES, max = MAX_FILE } = {}) {
  const name = str(file.name).replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 200) || 'file';
  const ext = ((name.match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
  const type = types[ext];
  if (!type) throw httpError(400, `File type not allowed. Allowed: ${Object.keys(types).join(', ').toUpperCase()}.`);
  const data = Buffer.from(String(file.data || ''), 'base64');
  if (!data.length) throw httpError(400, 'The selected file is empty.');
  if (data.length > max) throw httpError(400, `The file is larger than ${Math.round(max / 1024 / 1024)} MB.`);
  const r = await q.insert('INSERT INTO files (name, type, size, data, kind, client_id, created_by) VALUES (?,?,?,?,?,?,?)',
    name, type, data.length, data, kind, clientId || null, userId || null);
  return r.lastInsertRowid;
}

/* ------------------------------- Access --------------------------------- */

const has = (user, ...keys) => keys.some((k) => user.permissions.includes(k));
const seesAll = (user) => has(user, 'impl.view_all');

// Client ids the user may see; null means all clients.
async function allowedClients(user) {
  if (seesAll(user)) return null;
  const rows = await q.all('SELECT DISTINCT client FROM im_assign WHERE eng = ?', user.id);
  return rows.map((r) => r.client);
}

function canSee(e, user) {
  if (!has(user, 'impl.view')) return false;
  if (e.needsAll && !seesAll(user) && !has(user, ...e.write)) return false;
  return true;
}
const canWrite = (e, user) => has(user, ...e.write);

async function settings() {
  const rows = await q.all('SELECT key, value FROM im_settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function masterOptions(mtype) {
  return (await q.all('SELECT name FROM im_masters WHERE mtype = ? AND enabled = 1 ORDER BY name', mtype)).map((r) => r.name);
}

// Does a completed task for this client need approval? Client setting overrides the global one.
async function approvalNeeded(clientId) {
  const c = await q.get('SELECT task_approval FROM clients WHERE id = ?', clientId);
  if (c && c.task_approval === 'On') return true;
  if (c && c.task_approval === 'Off') return false;
  return (await settings()).approval_global === '1';
}

/* ------------------------------ Validation ------------------------------ */

const RX = {
  e: [/^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i, 'must be a valid email address'],
  m: [/^[6-9]\d{9}$/, 'must be a valid 10-digit mobile number'],
  z: [/^\d{6}$/, 'must be 6 digits'],
  i: [/^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/, 'must be a valid IP address, e.g. 10.10.1.25'],
  u: [/^https?:\/\/[^\s.]+\.\S+$/i, 'must start with http:// or https://'],
  tm: [/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time like 09:30'],
};

async function readRecord(e, body, user, before, allowed) {
  const out = {};
  const pendingFiles = [];
  for (const f of e.fields) {
    if (f.type === 'sys') continue;
    const fail = (msg) => { throw httpError(400, `${f.label} ${msg}`, { field: f.key }); };
    if (f.type === 'h') { out[f.key] = before ? before[f.key] : user.id; continue; }
    let v = body[f.key];

    if (f.type === 'c') { out[f.key] = v === true || v === 1 || v === '1' || v === 'on' || (Array.isArray(v) && v.length > 0) ? 1 : 0; continue; }
    if (f.type === 'f') {
      if (v && typeof v === 'object' && v.data) { pendingFiles.push([f.key, v]); out[f.key] = null; continue; }
      const keep = before ? before[f.key] : null;
      if (v === '' || v === null) out[f.key] = body[`${f.key}_remove`] ? null : keep;
      else out[f.key] = keep;
      if (f.required && !out[f.key]) fail('is required.');
      continue;
    }
    if (f.type === 'p') {
      v = str(v);
      if (!v) { if (before && before[f.key]) { out[f.key] = before[f.key]; continue; } if (f.required) fail('is required.'); out[f.key] = null; continue; }
      if (v.length > 200) fail('is too long.');
      out[f.key] = encrypt(v);
      continue;
    }
    if (f.type === 'x') {
      const list = (Array.isArray(v) ? v : []).map(str).filter(Boolean);
      if (f.required && !list.length) fail('- select at least one.');
      const opts = f.master ? await masterOptions(f.master) : f.options;
      const bad = list.find((x) => !opts.includes(x));
      if (bad) fail(`has an unknown value "${bad}".`);
      out[f.key] = list.length ? JSON.stringify([...new Set(list)]) : null;
      continue;
    }

    v = str(v);
    if (!v) { if (f.required) fail('is required.'); out[f.key] = null; continue; }
    switch (f.type) {
      case 't': if (v.length > 300) fail('must be 300 characters or fewer.'); break;
      case 'a': if (v.length > 3000) fail('must be 3000 characters or fewer.'); break;
      case 'o': if (v.length > 150) fail('must be 150 characters or fewer.'); break;
      case 'n': {
        if (!/^-?\d+(\.\d{1,6})?$/.test(v)) fail('must be a number.');
        v = Number(v);
        const signed = f.key === 'lat' || f.key === 'lng';
        if (!signed && v < 0) fail('cannot be negative.');
        if (f.key === 'pct' && v > 100) fail('cannot be more than 100.');
        if (f.key === 'lat' && Math.abs(v) > 90) fail('must be between -90 and 90.');
        if (f.key === 'lng' && Math.abs(v) > 180) fail('must be between -180 and 180.');
        if (v > 1e12) fail('is too large.');
        break;
      }
      case 'd': if (!isIsoDate(v)) fail('must be a valid date.'); break;
      case 's': {
        const opts = f.master ? await masterOptions(f.master) : f.options;
        if (!opts.includes(v) && !(before && before[f.key] === v)) fail('has an invalid choice.');
        break;
      }
      case 'r': {
        v = parseInt(v, 10);
        if (!Number.isInteger(v)) fail('is invalid.');
        await checkRef(f, v, out, allowed, fail);
        break;
      }
      default: {
        const rx = RX[f.type];
        if (f.type === 'e') { if (!v.split(/[,;]\s*/).filter(Boolean).every((x) => RX.e[0].test(x.trim()))) fail(RX.e[1] + '.'); }
        else if (rx && !rx[0].test(v)) fail(rx[1] + '.');
      }
    }
    out[f.key] = v;
  }

  for (const [a, b] of DATE_ORDER) {
    if (out[a] && out[b] && out[a] < out[b]) {
      const fa = e.fields.find((f) => f.key === a);
      const fb = e.fields.find((f) => f.key === b);
      throw httpError(400, `${fa.label} cannot be before ${fb.label}.`, { field: a });
    }
  }
  return { rec: out, pendingFiles };
}

async function checkRef(f, id, out, allowed, fail) {
  if (f.ref === 'clients') {
    const c = await q.get('SELECT id, status FROM clients WHERE id = ?', id);
    if (!c) fail('is not valid.');
    if (allowed && !allowed.includes(id)) fail('is not one of your assigned clients.');
  } else if (f.ref === 'locations') {
    const l = await q.get('SELECT id, client FROM im_locations WHERE id = ?', id);
    if (!l) fail('is not valid.');
    if (out.client && l.client !== out.client) fail('does not belong to the selected client.');
  } else if (f.ref === 'users') {
    const u = await q.get("SELECT id FROM users WHERE id = ? AND status = 'Active'", id);
    if (!u) fail('is not an active user.');
  } else {
    const t = ENTITIES[f.ref];
    if (!(await q.get(`SELECT id FROM ${t.table} WHERE id = ?`, id))) fail('is not valid.');
  }
}

/* --------------------------- Business rules ---------------------------- */

async function applyRules(e, rec, before, user) {
  const id = before ? before.id : 0;
  if (e.key === 'tasks') {
    if (rec.status === 'Completed' && !rec.evidence) throw httpError(400, 'Evidence upload is required to mark a task Completed.', { field: 'evidence' });
    const need = await approvalNeeded(rec.client);
    if (rec.status === 'Completed') {
      rec.pct = 100;
      rec.done_on = rec.done_on || todayLocal();
      if (need && !has(user, 'task.approve')) { rec.status = 'Pending'; rec.approval = 'Pending approval'; rec.reject_reason = null; }
      else rec.approval = need ? 'Approved' : null;
    } else {
      rec.approval = before && before.approval === 'Pending approval' ? null : before ? before.approval : null;
      if (rec.approval === 'Approved') rec.approval = null;
      rec.reject_reason = before ? before.reject_reason : null;
    }
  }
  if (e.key === 'golive') {
    if (['UAT', 'Go-Live', 'Handover'].includes(rec.stage) && rec.status === 'Completed' && !rec.signoff) {
      throw httpError(400, `Sign-off upload is required to complete ${rec.stage}.`, { field: 'signoff' });
    }
    if (await q.get('SELECT id FROM im_golive WHERE client = ? AND loc = ? AND stage = ? AND id <> ?', rec.client, rec.loc, rec.stage, id)) {
      throw httpError(400, 'This stage already exists for the location.', { field: 'stage' });
    }
    if (rec.status === 'Completed' && !rec.actual_on) rec.actual_on = todayLocal();
  }
  if (e.key === 'issues' && ['Resolved', 'Closed'].includes(rec.status) && !rec.resolved_on) {
    throw httpError(400, 'Resolved date is required when the status is Resolved or Closed.', { field: 'resolved_on' });
  }
  if (e.key === 'cmods' && (await q.get('SELECT id FROM im_cmods WHERE client = ? AND loc = ? AND module = ? AND id <> ?', rec.client, rec.loc, rec.module, id))) {
    throw httpError(400, 'This module is already added for the location.', { field: 'module' });
  }
  if (e.key === 'ctemplates' && (await q.get('SELECT id FROM im_ctemplates WHERE client = ? AND loc IS NOT DISTINCT FROM ? AND template = ? AND id <> ?',
    rec.client, rec.loc, rec.template, id))) {
    throw httpError(400, 'This template is already enabled for the location.', { field: 'template' });
  }
  if (e.key === 'training' && rec.attendees !== null && rec.attendees < 1) throw httpError(400, 'At least 1 attendee is required.', { field: 'attendees' });
  if (e.key === 'hw' && rec.available > rec.required && rec.status !== 'Ready') rec.status = 'Ready';
  if (e.key === 'locations' && (rec.lat === null) !== (rec.lng === null)) throw httpError(400, 'Enter both latitude and longitude, or neither.', { field: 'lat' });
}

// Creates standard tasks for a module at a location (skips ones that already exist).
async function generateTasks(client, loc, module, userId) {
  const std = await q.all('SELECT task, days FROM im_stdtasks WHERE module = ?', module);
  let n = 0;
  const today = todayLocal();
  for (const s of std) {
    if (await q.get('SELECT id FROM im_tasks WHERE client = ? AND loc IS NOT DISTINCT FROM ? AND module = ? AND task = ?', client, loc, module, s.task)) continue;
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + (Number(s.days) || 14));
    await q.run(`INSERT INTO im_tasks (client, loc, module, task, informed_on, target_on, status, pct, created_by)
                 VALUES (?,?,?,?,?,?,'Not Started',0,?)`, client, loc, module, s.task, today, d.toISOString().slice(0, 10), userId);
    n++;
  }
  return n;
}

async function ensureModule(client, loc, module, userId) {
  const stdMods = await masterOptions('Module');
  if (!(await q.get('SELECT id FROM im_cmods WHERE client = ? AND loc = ? AND module = ?', client, loc, module))) {
    await q.run(`INSERT INTO im_cmods (client, loc, module, source, enabled, status, created_by) VALUES (?,?,?,?,1,'Not Started',?)`,
      client, loc, module, stdMods.includes(module) ? 'Standard HIMS' : 'Manual', userId);
  }
  return generateTasks(client, loc, module, userId);
}

async function afterSave(e, rec, created, user) {
  if (e.key === 'cmods' && created && rec.enabled) return generateTasks(rec.client, rec.loc, rec.module, user.id);
  if (e.key === 'solines') {
    let n = 0;
    for (const m of JSON.parse(rec.modules || '[]')) n += await ensureModule(rec.client, rec.loc, m, user.id);
    return n;
  }
  return 0;
}

/* ------------------------------ Row output ------------------------------ */

async function decorate(e, rows) {
  const fileKeys = e.fields.filter((f) => f.type === 'f').map((f) => f.key);
  const ids = [...new Set(rows.flatMap((r) => fileKeys.map((k) => r[k]).filter(Boolean)))];
  const names = ids.length ? Object.fromEntries((await q.all(`SELECT id, name FROM files WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)).map((f) => [f.id, f.name])) : {};
  for (const r of rows) {
    for (const k of fileKeys) if (r[k]) r[`${k}_name`] = names[r[k]] || 'file';
    for (const f of e.fields) {
      if (f.type === 'p') { r[`${f.key}_set`] = !!r[f.key]; delete r[f.key]; }
      if (f.type === 'x') { try { r[f.key] = JSON.parse(r[f.key] || '[]'); } catch { r[f.key] = []; } }
    }
  }
  return rows;
}

async function listRows(e, user, filters = {}) {
  const allowed = await allowedClients(user);
  const where = [];
  const params = [];
  if (e.hasClient && allowed) {
    if (!allowed.length) return [];
    where.push(`client IN (${allowed.map(() => '?').join(',')})`);
    params.push(...allowed);
  }
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === '' || v === null) continue;
    if (!e.fields.some((f) => f.key === k)) continue;
    where.push(`${k} = ?`);
    params.push(v);
  }
  // sales order lines/documents follow the sales order's visibility
  const rows = await q.all(`SELECT * FROM ${e.table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 5000`, ...params);
  return decorate(e, rows);
}

async function getRow(e, id, user) {
  const row = Number.isInteger(id) && (await q.get(`SELECT * FROM ${e.table} WHERE id = ?`, id));
  if (!row) throw httpError(404, 'Record not found.');
  if (e.hasClient) {
    const allowed = await allowedClients(user);
    if (allowed && !allowed.includes(row.client)) throw httpError(404, 'Record not found.');
  }
  return row;
}

function ownerCheck(e, row, user) {
  if (e.owner && !has(user, 'impl.manage') && row[e.owner] !== user.id) {
    throw httpError(403, 'You can only change your own entries.');
  }
}

/* ------------------------------ Save / delete ----------------------------- */

async function saveRecord(e, body, user, id) {
  if (!canWrite(e, user)) throw httpError(403, 'You do not have permission to change this.');
  const before = id ? await getRow(e, id, user) : null;
  if (before) ownerCheck(e, before, user);
  const allowed = await allowedClients(user);
  const { rec, pendingFiles } = await readRecord(e, body, user, before, allowed);
  if (e.key === 'locations' && rec.radius_m === null) rec.radius_m = 300;

  return tx(async () => {
    for (const [k, file] of pendingFiles) rec[k] = await saveFile(file, `impl:${e.key}`, rec.client, user.id);
    for (const f of e.fields) if (f.type === 'f' && f.required && !rec[f.key]) throw httpError(400, `${f.label} is required.`, { field: f.key });
    await applyRules(e, rec, before, user);
    const keys = Object.keys(rec);
    let newId;
    if (before) {
      await q.run(`UPDATE ${e.table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = ${NOW} WHERE id = ?`,
        ...keys.map((k) => rec[k]), user.id, before.id);
      newId = before.id;
    } else {
      newId = (await q.insert(`INSERT INTO ${e.table} (${keys.join(', ')}, created_by) VALUES (${keys.map(() => '?').join(',')}, ?)`,
        ...keys.map((k) => rec[k]), user.id)).lastInsertRowid;
    }
    const generated = await afterSave(e, rec, !before, user);
    const changes = {};
    if (before) {
      for (const k of keys) {
        const f = e.fields.find((x) => x.key === k);
        if (f && f.type === 'p') { if (before[k] !== rec[k]) changes[k] = { from: '••••', to: '•••• (changed)' }; continue; }
        if (String(before[k] ?? '') !== String(rec[k] ?? '')) changes[k] = { from: before[k], to: rec[k] };
      }
    }
    await audit({
      entity: 'IMPLEMENTATION', entityId: newId, action: before ? 'UPDATE' : 'CREATE', ticket: null,
      changes: before ? changes : null, remarks: `${e.title}: ${rec[e.label] || '#' + newId}${generated ? ` (${generated} standard tasks created)` : ''}`, user,
    });
    return { id: newId, generated, status: rec.status, approval: rec.approval };
  });
}

const DEPENDENTS = {
  locations: (id) => Object.values(ENTITIES).filter((x) => x.fields.some((f) => f.key === 'loc')).map((x) => [x.table, 'loc', id]),
  sorders: (id) => [['im_solines', 'so', id], ['im_sodocs', 'so', id]],
  templates: (id) => [['im_ctemplates', 'template', id]],
};

async function deleteRecord(e, id, user) {
  if (!canWrite(e, user)) throw httpError(403, 'You do not have permission to delete this.');
  const row = await getRow(e, id, user);
  ownerCheck(e, row, user);
  for (const [table, col, val] of (DEPENDENTS[e.key] || (() => []))(id)) {
    if (await q.get(`SELECT 1 AS x FROM ${table} WHERE ${col} = ? LIMIT 1`, val)) throw httpError(409, 'Remove the linked records first.');
  }
  if (e.key === 'locations' && (await q.get('SELECT 1 AS x FROM att_days WHERE in_loc = ? OR out_loc = ? LIMIT 1', id, id))) {
    throw httpError(409, 'Attendance has been recorded at this location, so it cannot be deleted.');
  }
  await tx(async () => {
    await q.run(`DELETE FROM ${e.table} WHERE id = ?`, id);
    await audit({ entity: 'IMPLEMENTATION', entityId: id, action: 'DELETE', remarks: `${e.title}: ${row[e.label] || '#' + id} deleted`, user });
  });
}

// Used by the client master: a client with implementation records cannot be deleted.
async function clientInUse(clientId) {
  for (const e of Object.values(ENTITIES)) {
    if (e.hasClient && (await q.get(`SELECT 1 AS x FROM ${e.table} WHERE client = ? LIMIT 1`, clientId))) return true;
  }
  return false;
}

module.exports = {
  schemaSql, seedImpl, encrypt, decrypt, saveFile, has, seesAll, allowedClients, canSee, canWrite, settings, masterOptions,
  listRows, getRow, saveRecord, deleteRecord, generateTasks, ensureModule, clientInUse, decorate, DOC_TYPES,
};
