// /api/attendance — face check-in / check-out with GPS, geofence and location pings.
//
// Face matching: the browser turns the camera image into a 128-number face signature
// (face-api.js). The server compares it with the signatures saved at enrolment.
// A small photo of every punch is kept for 90 days as proof.
const ExcelJS = require('exceljs');
const { q, tx, audit, NOW } = require('./db');
const { requirePerm } = require('./auth');
const { todayLocal, str, httpError, asyncRouter, isIsoDate } = require('./util');
const { saveFile } = require('./impl/engine');

const router = asyncRouter();
const MATCH_THRESHOLD = 0.5; // lower = stricter; 0.6 is the face-api default
const PHOTO_DAYS = 90;
const PING_MIN_GAP_MS = 5 * 60 * 1000;
const JPG = { jpg: 'image/jpeg', jpeg: 'image/jpeg' };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS att_enrol (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  descriptors TEXT NOT NULL,
  photo_file  INTEGER,
  consent_at  TEXT NOT NULL,
  enrolled_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS att_days (
  id        SERIAL PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id),
  adate     TEXT NOT NULL,
  in_time   TEXT, in_lat DOUBLE PRECISION, in_lng DOUBLE PRECISION, in_acc DOUBLE PRECISION, in_loc INTEGER, in_geo TEXT, in_dist DOUBLE PRECISION, in_score DOUBLE PRECISION, in_photo INTEGER,
  out_time  TEXT, out_lat DOUBLE PRECISION, out_lng DOUBLE PRECISION, out_acc DOUBLE PRECISION, out_loc INTEGER, out_geo TEXT, out_dist DOUBLE PRECISION, out_score DOUBLE PRECISION, out_photo INTEGER,
  hours     DOUBLE PRECISION,
  UNIQUE (user_id, adate)
);
CREATE TABLE IF NOT EXISTS att_pings (
  id      SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  day_id  INTEGER,
  ts      TEXT NOT NULL DEFAULT ${NOW},
  lat     DOUBLE PRECISION NOT NULL,
  lng     DOUBLE PRECISION NOT NULL,
  acc     DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS ix_att_pings_user ON att_pings (user_id, ts);
CREATE INDEX IF NOT EXISTS ix_att_days_date ON att_days (adate);
`;

/* -------------------------------- Helpers -------------------------------- */

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function readDescriptor(v) {
  if (!Array.isArray(v) || v.length !== 128 || !v.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 2)) {
    throw httpError(400, 'Face could not be read. Please try again in good light.');
  }
  return v;
}
const euclid = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));

function readGps(b) {
  const lat = Number(b.lat);
  const lng = Number(b.lng);
  const acc = b.acc === undefined || b.acc === null ? null : Number(b.acc);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    throw httpError(400, 'Location is required. Please allow location access and try again.');
  }
  return { lat, lng, acc: Number.isFinite(acc) ? Math.round(acc) : null };
}

// Users the Implementation Manager has switched face attendance ON for.
const fieldStaff = () => q.all(
  `SELECT u.id, u.employee_name AS name, u.employee_code AS code, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.status = 'Active' AND u.face_attendance = 1 ORDER BY u.employee_name`);

function requireFace(req, res, next) {
  if (req.user.must_change_password) return res.status(403).json({ error: 'Please change your password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
  if (!req.user.face_attendance) return res.status(403).json({ error: 'Face attendance is not switched on for you. Ask your Implementation Manager.' });
  next();
}

// Locations the user may punch at: those of their current assignments (plus all locations of assigned clients).
async function myLocations(userId) {
  const today = todayLocal();
  const assigned = await q.all('SELECT client, loc FROM im_assign WHERE eng = ? AND from_date <= ? AND to_date >= ?', userId, today, today);
  if (!assigned.length) return [];
  const clients = [...new Set(assigned.map((a) => a.client))];
  const locs = await q.all(
    `SELECT l.id, l.name, l.city, l.lat, l.lng, l.radius_m, c.name AS client_name FROM im_locations l JOIN clients c ON c.id = l.client
      WHERE l.client IN (${clients.map(() => '?').join(',')}) ORDER BY c.name, l.name`, ...clients);
  const primary = new Set(assigned.map((a) => a.loc).filter(Boolean));
  return locs.map((l) => ({ ...l, assigned: primary.has(l.id) }));
}

const hoursBetween = (a, b) => {
  const t = (s) => Date.parse(s.replace(' ', 'T') + 'Z');
  return Math.round(((t(b) - t(a)) / 3600000) * 100) / 100;
};

/* --------------------------------- Self ---------------------------------- */

router.get('/me', async (req, res) => {
  const u = req.user;
  const enrol = await q.get('SELECT enrolled_at, photo_file FROM att_enrol WHERE user_id = ?', u.id);
  const today = await q.get('SELECT * FROM att_days WHERE user_id = ? AND adate = ?', u.id, todayLocal());
  const history = await q.all(
    `SELECT d.*, li.name AS in_loc_name, lo.name AS out_loc_name FROM att_days d
       LEFT JOIN im_locations li ON li.id = d.in_loc LEFT JOIN im_locations lo ON lo.id = d.out_loc
      WHERE d.user_id = ? ORDER BY d.adate DESC LIMIT 31`, u.id);
  const pings = await q.get('SELECT COUNT(*) AS n, MAX(ts) AS last FROM att_pings WHERE user_id = ? AND ts LIKE ?', u.id, `${todayLocal()}%`);
  const now = await q.get(`SELECT ${NOW} AS t`);
  res.json({
    required: !!u.face_attendance, canConfigure: u.permissions.includes('attendance.config'),
    enrolled: !!enrol, enrolledAt: enrol ? enrol.enrolled_at : null, now: now.t,
    today: today || null, history, locations: await myLocations(u.id), photoDays: PHOTO_DAYS,
    pings: { count: pings.n, last: pings.last }, pingMinutes: 15,
  });
});

router.post('/enrol', requireFace, async (req, res) => {
  if (req.body.consent !== true) throw httpError(400, 'Please give consent to use your face for attendance.');
  if (await q.get('SELECT 1 AS x FROM att_enrol WHERE user_id = ?', req.user.id)) {
    throw httpError(409, 'Your face is already enrolled. Ask your manager to reset it if you need to enrol again.');
  }
  const list = Array.isArray(req.body.descriptors) ? req.body.descriptors.map(readDescriptor) : [];
  if (list.length < 3 || list.length > 6) throw httpError(400, 'Enrolment needs 3 face captures.');
  // All captures must be the same person.
  for (let i = 1; i < list.length; i++) if (euclid(list[0], list[i]) > MATCH_THRESHOLD) throw httpError(400, 'The captures do not look like the same face. Please try again.');
  if (!req.body.photo || !req.body.photo.data) throw httpError(400, 'Enrolment photo is missing.');
  await tx(async () => {
    const photo = await saveFile({ name: `enrol-${req.user.id}.jpg`, data: req.body.photo.data }, 'att:enrol', null, req.user.id, { types: JPG, max: 400 * 1024 });
    await q.run(`INSERT INTO att_enrol (user_id, descriptors, photo_file, consent_at) VALUES (?,?,?,${NOW})`, req.user.id, JSON.stringify(list), photo);
    await audit({ entity: 'ATTENDANCE', entityId: req.user.id, action: 'ENROL', remarks: `${req.user.employee_name} enrolled face for attendance (consent given)`, user: req.user });
  });
  res.status(201).json({ ok: true });
});

router.post('/punch', requireFace, async (req, res) => {
  const u = req.user;
  const kind = req.body.kind === 'out' ? 'out' : 'in';
  const enrol = await q.get('SELECT descriptors FROM att_enrol WHERE user_id = ?', u.id);
  if (!enrol) throw httpError(400, 'Please enrol your face first.');
  if (req.body.liveness !== true) throw httpError(400, 'Liveness check was not completed. Please follow the on-screen head movement.');
  const desc = readDescriptor(req.body.descriptor);
  const score = Math.min(...JSON.parse(enrol.descriptors).map((d) => euclid(d, desc)));
  const gps = readGps(req.body);
  const today = todayLocal();
  const day = await q.get('SELECT * FROM att_days WHERE user_id = ? AND adate = ?', u.id, today);

  if (score > MATCH_THRESHOLD) {
    await audit({ entity: 'ATTENDANCE', entityId: u.id, action: 'FACE_MISMATCH', remarks: `Face did not match at check-${kind} (score ${score.toFixed(2)})`, user: u });
    throw httpError(400, 'Face did not match your enrolled face. Please try again facing the camera in good light.');
  }
  if (kind === 'in' && day && day.in_time) throw httpError(409, 'You have already checked in today.');
  if (kind === 'out' && (!day || !day.in_time)) throw httpError(400, 'Please check in first.');
  if (kind === 'out' && day.out_time) throw httpError(409, 'You have already checked out today.');

  // Geofence against the chosen client location (empty = office / remote work).
  let loc = null, geo = 'Remote', dist = null;
  const locId = parseInt(req.body.loc, 10);
  if (Number.isInteger(locId)) {
    const allowed = await myLocations(u.id);
    loc = allowed.find((l) => l.id === locId);
    if (!loc) throw httpError(400, 'That location is not part of your current assignment.');
    if (loc.lat != null && loc.lng != null) {
      dist = distanceM(gps.lat, gps.lng, loc.lat, loc.lng);
      geo = dist <= (loc.radius_m || 300) ? 'Inside' : 'Outside';
    } else geo = 'No geofence';
  }
  if (!req.body.photo || !req.body.photo.data) throw httpError(400, 'Photo is missing.');

  const result = await tx(async () => {
    const photo = await saveFile({ name: `${kind}-${u.id}-${today}.jpg`, data: req.body.photo.data }, 'att:photo', null, u.id, { types: JPG, max: 300 * 1024 });
    const p = kind;
    const vals = [gps.lat, gps.lng, gps.acc, loc ? loc.id : null, geo, dist, Math.round(score * 1000) / 1000, photo];
    let id;
    if (kind === 'in') {
      id = (await q.insert(
        `INSERT INTO att_days (user_id, adate, in_time, in_lat, in_lng, in_acc, in_loc, in_geo, in_dist, in_score, in_photo)
         VALUES (?, ?, ${NOW}, ?,?,?,?,?,?,?,?)`, u.id, today, ...vals)).lastInsertRowid;
    } else {
      id = day.id;
      await q.run(`UPDATE att_days SET out_time = ${NOW}, out_lat = ?, out_lng = ?, out_acc = ?, out_loc = ?, out_geo = ?, out_dist = ?, out_score = ?, out_photo = ? WHERE id = ?`, ...vals, id);
      const d = await q.get('SELECT in_time, out_time FROM att_days WHERE id = ?', id);
      await q.run('UPDATE att_days SET hours = ? WHERE id = ?', hoursBetween(d.in_time, d.out_time), id);
    }
    await q.run(`INSERT INTO att_pings (user_id, day_id, lat, lng, acc) VALUES (?,?,?,?,?)`, u.id, id, gps.lat, gps.lng, gps.acc);
    await audit({
      entity: 'ATTENDANCE', entityId: id, action: kind === 'in' ? 'CHECK_IN' : 'CHECK_OUT',
      remarks: `Check-${p} at ${loc ? `${loc.client_name} / ${loc.name}` : 'office / remote'} - ${geo}${dist != null ? ` (${dist} m)` : ''}`, user: u,
    });
    return q.get('SELECT * FROM att_days WHERE id = ?', id);
  });
  res.json({ day: result, geo, distance: dist });
});

router.post('/ping', requireFace, async (req, res) => {
  const gps = readGps(req.body);
  const day = await q.get('SELECT id, in_time, out_time FROM att_days WHERE user_id = ? AND adate = ?', req.user.id, todayLocal());
  if (!day || !day.in_time || day.out_time) return res.json({ tracking: false });
  const last = await q.get('SELECT ts FROM att_pings WHERE user_id = ? ORDER BY id DESC LIMIT 1', req.user.id);
  const now = await q.get(`SELECT ${NOW} AS t`);
  if (last && Date.parse(now.t.replace(' ', 'T')) - Date.parse(last.ts.replace(' ', 'T')) < PING_MIN_GAP_MS) return res.json({ tracking: true, skipped: true });
  await q.run('INSERT INTO att_pings (user_id, day_id, lat, lng, acc) VALUES (?,?,?,?,?)', req.user.id, day.id, gps.lat, gps.lng, gps.acc);
  res.json({ tracking: true });
});

/* ------------------------------- Managers -------------------------------- */

router.get('/team', requirePerm('attendance.view'), async (req, res) => {
  const date = isIsoDate(req.query.date) ? req.query.date : todayLocal();
  const staff = await fieldStaff();
  const days = await q.all(
    `SELECT d.*, li.name AS in_loc_name, lo.name AS out_loc_name, ci.name AS in_client, co.name AS out_client FROM att_days d
       LEFT JOIN im_locations li ON li.id = d.in_loc LEFT JOIN im_locations lo ON lo.id = d.out_loc
       LEFT JOIN clients ci ON ci.id = li.client LEFT JOIN clients co ON co.id = lo.client
      WHERE d.adate = ?`, date);
  const enrol = new Set((await q.all('SELECT user_id FROM att_enrol')).map((r) => r.user_id));
  const pings = await q.all('SELECT user_id, COUNT(*) AS n, MAX(ts) AS last FROM att_pings WHERE ts LIKE ? GROUP BY user_id', `${date}%`);
  res.json({
    date,
    rows: staff.map((s) => ({ ...s, enrolled: enrol.has(s.id), day: days.find((d) => d.user_id === s.id) || null, pings: pings.find((p) => p.user_id === s.id) || null })),
  });
});

router.get('/live', requirePerm('attendance.view'), async (req, res) => {
  const date = isIsoDate(req.query.date) ? req.query.date : todayLocal();
  const staff = await fieldStaff();
  const latest = await q.all(
    `SELECT DISTINCT ON (user_id) user_id, ts, lat, lng, acc FROM att_pings WHERE ts LIKE ? ORDER BY user_id, id DESC`, `${date}%`);
  const days = await q.all('SELECT user_id, in_time, out_time, in_geo, out_geo FROM att_days WHERE adate = ?', date);
  const trail = req.query.user ? await q.all('SELECT ts, lat, lng, acc FROM att_pings WHERE user_id = ? AND ts LIKE ? ORDER BY id', +req.query.user, `${date}%`) : [];
  const geofences = await q.all(
    `SELECT l.id, l.name, l.lat, l.lng, l.radius_m, c.name AS client FROM im_locations l JOIN clients c ON c.id = l.client WHERE l.lat IS NOT NULL`);
  res.json({
    date,
    people: latest.map((p) => {
      const s = staff.find((x) => x.id === p.user_id) || {};
      const d = days.find((x) => x.user_id === p.user_id) || {};
      return { ...p, name: s.name || `User ${p.user_id}`, role: s.role, in_time: d.in_time, out_time: d.out_time, geo: d.out_geo || d.in_geo };
    }),
    trail, geofences,
  });
});

router.get('/enrolments', requirePerm('attendance.view'), async (req, res) => {
  const staff = await fieldStaff();
  const enrol = await q.all('SELECT user_id, enrolled_at, photo_file FROM att_enrol');
  res.json(staff.map((s) => { const e = enrol.find((x) => x.user_id === s.id); return { ...s, enrolled_at: e ? e.enrolled_at : null, photo: e ? e.photo_file : null }; }));
});

router.delete('/enrol/:userId', requirePerm('attendance.view'), async (req, res) => {
  const id = +req.params.userId;
  const e = await q.get('SELECT photo_file FROM att_enrol WHERE user_id = ?', id);
  if (!e) throw httpError(404, 'This user is not enrolled.');
  const u = await q.get('SELECT employee_name FROM users WHERE id = ?', id);
  await tx(async () => {
    await q.run('DELETE FROM att_enrol WHERE user_id = ?', id);
    if (e.photo_file) await q.run('DELETE FROM files WHERE id = ?', e.photo_file);
    await audit({ entity: 'ATTENDANCE', entityId: id, action: 'RESET_ENROL', remarks: `Face enrolment reset for ${u ? u.employee_name : id}`, user: req.user });
  });
  res.json({ ok: true });
});

// Punch / enrolment photos: managers, or the person themselves.
router.get('/photo/:id', async (req, res) => {
  const f = Number.isInteger(+req.params.id) && (await q.get("SELECT name, type, data, kind, created_by FROM files WHERE id = ? AND kind LIKE 'att:%'", +req.params.id));
  if (!f) throw httpError(404, 'Photo not found (photos are kept for 90 days).');
  if (f.created_by !== req.user.id && !req.user.permissions.includes('attendance.view')) throw httpError(404, 'Photo not found.');
  res.setHeader('Content-Type', f.type);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(f.data);
});

router.get('/report', async (req, res) => {
  const mgr = req.user.permissions.includes('attendance.view');
  if (!mgr && !req.user.face_attendance) throw httpError(403, 'You do not have permission to view attendance.');
  const from = isIsoDate(req.query.from) ? req.query.from : todayLocal().slice(0, 8) + '01';
  const to = isIsoDate(req.query.to) ? req.query.to : todayLocal();
  const userId = mgr ? parseInt(req.query.user, 10) : req.user.id;
  const rows = await q.all(
    `SELECT d.*, u.employee_name AS name, u.employee_code AS code, li.name AS in_loc_name, lo.name AS out_loc_name FROM att_days d
       JOIN users u ON u.id = d.user_id LEFT JOIN im_locations li ON li.id = d.in_loc LEFT JOIN im_locations lo ON lo.id = d.out_loc
      WHERE d.adate BETWEEN ? AND ? ${Number.isInteger(userId) ? 'AND d.user_id = ?' : ''} ORDER BY d.adate DESC, u.employee_name`,
    from, to, ...(Number.isInteger(userId) ? [userId] : []));
  if (req.query.format !== 'xlsx') return res.json({ from, to, rows });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Attendance');
  ws.addRow([`Attendance ${from.split('-').reverse().join('-')} to ${to.split('-').reverse().join('-')}`]).font = { bold: true, size: 14 };
  ws.addRow([]);
  const h = ws.addRow(['Date', 'Employee', 'Code', 'Check-in', 'In location', 'In geofence', 'In distance (m)', 'Check-out', 'Out location', 'Out geofence', 'Out distance (m)', 'Hours']);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C6A98' } }; });
  rows.forEach((r) => ws.addRow([r.adate.split('-').reverse().join('-'), r.name, r.code, (r.in_time || '').slice(11, 16), r.in_loc_name || 'Office / remote', r.in_geo,
    r.in_dist, (r.out_time || '').slice(11, 16) || 'Not checked out', r.out_time ? r.out_loc_name || 'Office / remote' : '', r.out_geo || '', r.out_dist, r.hours]));
  ws.columns.forEach((c) => { c.width = 16; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${from}-to-${to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

/* ---------------------------- Attendance settings ---------------------------- */

router.get('/settings', requirePerm('attendance.config'), async (req, res) => {
  const users = await q.all(
    `SELECT u.id, u.employee_name AS name, u.employee_code AS code, u.username, u.status, u.face_attendance, r.name AS role, d.name AS department,
            (SELECT enrolled_at FROM att_enrol e WHERE e.user_id = u.id) AS enrolled_at
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN departments d ON d.id = u.department_id
      ORDER BY u.status, u.employee_name`);
  res.json(users);
});

router.put('/settings/:userId', requirePerm('attendance.config'), async (req, res) => {
  const id = +req.params.userId;
  const u = Number.isInteger(id) && (await q.get('SELECT id, employee_name, face_attendance FROM users WHERE id = ?', id));
  if (!u) throw httpError(404, 'User not found.');
  const on = req.body.enabled === true || req.body.enabled === 1 || req.body.enabled === '1' ? 1 : 0;
  if (on === u.face_attendance) return res.json({ ok: true });
  await tx(async () => {
    await q.run('UPDATE users SET face_attendance = ? WHERE id = ?', on, id);
    await audit({ entity: 'ATTENDANCE', entityId: id, action: on ? 'ENABLE' : 'DISABLE', remarks: `Face attendance switched ${on ? 'ON' : 'OFF'} for ${u.employee_name}`, user: req.user });
  });
  res.json({ ok: true });
});

/* ------------------------------- Retention ------------------------------- */

async function prune() {
  const d = new Date(todayLocal() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - PHOTO_DAYS);
  const cutoff = d.toISOString().slice(0, 10);
  const old = await q.all("SELECT id FROM files WHERE kind = 'att:photo' AND created_at < ?", cutoff);
  if (old.length) {
    const ids = old.map((r) => r.id);
    const list = ids.map(() => '?').join(',');
    await q.run(`UPDATE att_days SET in_photo = NULL WHERE in_photo IN (${list})`, ...ids);
    await q.run(`UPDATE att_days SET out_photo = NULL WHERE out_photo IN (${list})`, ...ids);
    await q.run(`DELETE FROM files WHERE id IN (${list})`, ...ids);
  }
  await q.run('DELETE FROM att_pings WHERE ts < ?', cutoff);
  if (old.length) console.log(`Attendance: removed ${old.length} punch photo(s) older than ${PHOTO_DAYS} days.`);
}

module.exports = { router, SCHEMA, prune, distanceM };
