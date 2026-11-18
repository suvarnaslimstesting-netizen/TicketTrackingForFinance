// /api/impl — Implementation module API.
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { q, tx, audit, NOW } = require('../db');
const { requirePerm } = require('../auth');
const { todayLocal, str, httpError, asyncRouter, isIsoDate } = require('../util');
const { ENTITIES, STATUS, GO_LIVE_STAGES } = require('./defs');
const E = require('./engine');

const router = asyncRouter();
router.use(requirePerm('impl.view'));

const entity = (key, user) => {
  const e = ENTITIES[key];
  if (!e || !E.canSee(e, user)) throw httpError(404, 'Not found.');
  return e;
};
const inList = (a) => a.map(() => '?').join(',');
const avg = (rows) => (rows.length ? Math.round(rows.reduce((s, r) => s + (Number(r.pct) || 0), 0) / rows.length) : 0);
const sum = (rows, k) => Math.round(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100;
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/* ----------------------------- Meta & lookups ----------------------------- */

router.get('/meta', async (req, res) => {
  const u = req.user;
  const entities = {};
  for (const [k, e] of Object.entries(ENTITIES)) {
    if (!E.canSee(e, u)) continue;
    entities[k] = { key: k, title: e.title, cols: e.cols, fields: e.fields, owner: e.owner || null, canWrite: E.canWrite(e, u) };
  }
  res.json({
    entities, statuses: STATUS, goLiveStages: GO_LIVE_STAGES, today: todayLocal(), settings: await E.settings(),
    seesAll: E.seesAll(u), userId: u.id,
  });
});

router.get('/lookups', async (req, res) => {
  const allowed = await E.allowedClients(req.user);
  const scope = allowed ? (allowed.length ? `WHERE id IN (${inList(allowed)})` : 'WHERE 1 = 0') : '';
  const lscope = allowed ? (allowed.length ? `WHERE client IN (${inList(allowed)})` : 'WHERE 1 = 0') : '';
  const masters = await q.all('SELECT mtype, name FROM im_masters WHERE enabled = 1 ORDER BY name');
  const byType = {};
  masters.forEach((m) => { (byType[m.mtype] = byType[m.mtype] || []).push(m.name); });
  res.json({
    clients: await q.all(`SELECT id, name, client_code, client_type, city, status, task_approval FROM clients ${scope} ORDER BY name`, ...(allowed || [])),
    locations: await q.all(`SELECT id, client, name, city, lat, lng, radius_m FROM im_locations ${lscope} ORDER BY name`, ...(allowed || [])),
    users: await q.all(`SELECT u.id, u.employee_name AS name, r.name AS role, u.status FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.employee_name`),
    templates: await q.all('SELECT id, name, version FROM im_templates ORDER BY name'),
    sorders: E.canSee(ENTITIES.sorders, req.user) ? await q.all('SELECT id, so_no AS name FROM im_sorders ORDER BY id DESC') : [],
    masters: byType,
  });
});

/* --------------------------------- Records -------------------------------- */

router.get('/e/:entity', async (req, res) => {
  const e = entity(req.params.entity, req.user);
  res.json(await E.listRows(e, req.user, req.query));
});
router.post('/e/:entity', async (req, res) => {
  const e = entity(req.params.entity, req.user);
  res.status(201).json(await E.saveRecord(e, req.body, req.user, 0));
});
router.put('/e/:entity/:id', async (req, res) => {
  const e = entity(req.params.entity, req.user);
  res.json(await E.saveRecord(e, req.body, req.user, +req.params.id));
});
router.delete('/e/:entity/:id', async (req, res) => {
  const e = entity(req.params.entity, req.user);
  await E.deleteRecord(e, +req.params.id, req.user);
  res.json({ ok: true });
});

// Quick-add the same modules or templates to several locations of a client.
router.post('/bulk', requirePerm('impl.manage'), async (req, res) => {
  const kind = req.body.kind === 'templates' ? 'templates' : 'modules';
  const client = parseInt(req.body.client, 10);
  if (!(await q.get('SELECT id FROM clients WHERE id = ?', client))) throw httpError(400, 'Client is required.');
  const locs = (Array.isArray(req.body.locs) ? req.body.locs : []).map((x) => parseInt(x, 10)).filter(Number.isInteger);
  const values = (Array.isArray(req.body.values) ? req.body.values : []).map(str).filter(Boolean);
  if (!locs.length || !values.length) throw httpError(400, 'Select at least one location and one item.');
  const owned = await q.all(`SELECT id FROM im_locations WHERE client = ? AND id IN (${inList(locs)})`, client, ...locs);
  if (owned.length !== locs.length) throw httpError(400, 'A selected location does not belong to the client.');
  let added = 0, tasks = 0;
  await tx(async () => {
    for (const loc of locs) {
      for (const v of values) {
        if (kind === 'modules') {
          if (v.length > 150) throw httpError(400, 'Module name is too long.');
          if (await q.get('SELECT id FROM im_cmods WHERE client = ? AND loc = ? AND module = ?', client, loc, v)) continue;
          tasks += await E.ensureModule(client, loc, v, req.user.id);
        } else {
          const t = parseInt(v, 10);
          if (!(await q.get('SELECT id FROM im_templates WHERE id = ?', t))) throw httpError(400, 'Invalid template.');
          if (await q.get('SELECT id FROM im_ctemplates WHERE client = ? AND loc = ? AND template = ?', client, loc, t)) continue;
          await q.run('INSERT INTO im_ctemplates (client, loc, template, enabled, created_by) VALUES (?,?,?,1,?)', client, loc, t, req.user.id);
        }
        added++;
      }
    }
    await audit({ entity: 'IMPLEMENTATION', action: 'CREATE', remarks: `Quick add ${kind}: ${added} added${tasks ? `, ${tasks} standard tasks created` : ''}`, user: req.user });
  });
  res.json({ added, tasks });
});

router.post('/generate-tasks', requirePerm('impl.manage', 'impl.work'), async (req, res) => {
  const client = parseInt(req.body.client, 10);
  const loc = parseInt(req.body.loc, 10);
  const allowed = await E.allowedClients(req.user);
  if (allowed && !allowed.includes(client)) throw httpError(404, 'Client not found.');
  const mods = await q.all(`SELECT client, loc, module FROM im_cmods WHERE client = ? AND enabled = 1 ${Number.isInteger(loc) ? 'AND loc = ?' : ''}`,
    client, ...(Number.isInteger(loc) ? [loc] : []));
  let n = 0;
  await tx(async () => {
    for (const m of mods) n += await E.generateTasks(m.client, m.loc, m.module, req.user.id);
    if (n) await audit({ entity: 'IMPLEMENTATION', action: 'CREATE', remarks: `${n} standard tasks generated`, user: req.user });
  });
  res.json({ created: n });
});

/* ------------------------------- Approvals ------------------------------- */

router.get('/approvals', async (req, res) => {
  const rows = (await E.listRows(ENTITIES.tasks, req.user, { approval: 'Pending approval' }));
  res.json(rows);
});
router.post('/tasks/:id/approve', requirePerm('task.approve'), async (req, res) => {
  const t = await E.getRow(ENTITIES.tasks, +req.params.id, req.user);
  if (t.approval !== 'Pending approval') throw httpError(400, 'This task is not waiting for approval.');
  await tx(async () => {
    await q.run(`UPDATE im_tasks SET status = 'Completed', approval = 'Approved', pct = 100, done_on = COALESCE(done_on, ?), reject_reason = NULL,
                 updated_by = ?, updated_at = ${NOW} WHERE id = ?`, todayLocal(), req.user.id, t.id);
    await audit({ entity: 'IMPLEMENTATION', entityId: t.id, action: 'APPROVED', remarks: `Task approved: ${t.task}`, user: req.user });
  });
  res.json({ ok: true });
});
router.post('/tasks/:id/reject', requirePerm('task.approve'), async (req, res) => {
  const t = await E.getRow(ENTITIES.tasks, +req.params.id, req.user);
  if (t.approval !== 'Pending approval') throw httpError(400, 'This task is not waiting for approval.');
  const reason = str(req.body.reason);
  if (reason.length < 5) throw httpError(400, 'Reason is required (at least 5 characters).');
  await tx(async () => {
    await q.run(`UPDATE im_tasks SET status = 'In Progress', approval = 'Rejected', reject_reason = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`, reason.slice(0, 500), req.user.id, t.id);
    await audit({ entity: 'IMPLEMENTATION', entityId: t.id, action: 'REJECTED', remarks: `Task rejected: ${t.task} - ${reason}`, user: req.user });
  });
  res.json({ ok: true });
});

/* ------------------------------ Break requests ------------------------------ */

router.get('/breaks/pending', requirePerm('break.approve'), async (req, res) => {
  res.json(await E.listRows(ENTITIES.abreaks, req.user, { status: 'Pending' }));
});

async function decideBreak(req, status) {
  const b = await E.getRow(ENTITIES.abreaks, +req.params.id, req.user);
  if (b.status !== 'Pending') throw httpError(400, `This request is already ${(b.status || 'approved').toLowerCase()}.`);
  const reason = str(req.body.reason);
  if (status === 'Rejected' && reason.length < 3) throw httpError(400, 'Please give a reason for rejecting.');
  const who = await q.get('SELECT employee_name FROM users WHERE id = ?', b.eng);
  await tx(async () => {
    await q.run(`UPDATE im_abreaks SET status = ?, decision = ?, decided_by = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`, status, reason.slice(0, 500) || null, req.user.id, req.user.id, b.id);
    await audit({ entity: 'IMPLEMENTATION', entityId: b.id, action: status === 'Approved' ? 'APPROVED' : 'REJECTED',
      remarks: `Break request of ${who ? who.employee_name : ''} (${b.from_date} to ${b.to_date}) ${status.toLowerCase()}${reason ? `: ${reason}` : ''}`, user: req.user });
  });
}
router.post('/breaks/:id/approve', requirePerm('break.approve'), async (req, res) => { await decideBreak(req, 'Approved'); res.json({ ok: true }); });
router.post('/breaks/:id/reject', requirePerm('break.approve'), async (req, res) => { await decideBreak(req, 'Rejected'); res.json({ ok: true }); });

/* ------------------------- Credentials and files ------------------------- */

router.post('/servers/:id/reveal', requirePerm('credential.view'), async (req, res) => {
  const s = await E.getRow(ENTITIES.servers, +req.params.id, req.user);
  const client = await q.get('SELECT name FROM clients WHERE id = ?', s.client);
  await audit({ entity: 'IMPLEMENTATION', entityId: s.id, action: 'VIEW_PASSWORD', remarks: `Viewed ${s.cred_type} credential for ${client ? client.name : ''}`, user: req.user });
  res.json({ username: s.username, password: E.decrypt(s.secret) });
});

router.get('/files/:id', async (req, res) => {
  const f = Number.isInteger(+req.params.id) && (await q.get('SELECT id, name, type, data, kind, client_id FROM files WHERE id = ?', +req.params.id));
  if (!f || !f.kind.startsWith('impl:')) throw httpError(404, 'File not found.');
  const e = ENTITIES[f.kind.slice(5)];
  if (!e || !E.canSee(e, req.user)) throw httpError(404, 'File not found.');
  if (f.client_id) {
    const allowed = await E.allowedClients(req.user);
    if (allowed && !allowed.includes(f.client_id)) throw httpError(404, 'File not found.');
  }
  res.setHeader('Content-Type', f.type);
  res.setHeader('Content-Disposition', `${req.query.inline ? 'inline' : 'attachment'}; filename="${f.name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.send(f.data);
});

/* -------------------------------- Settings -------------------------------- */

router.put('/settings', requirePerm('impl.settings'), async (req, res) => {
  const appr = req.body.approval_global === '0' || req.body.approval_global === 0 ? '0' : '1';
  const alert = str(req.body.amc_alert_days);
  if (!/^\d{1,3}(,\s*\d{1,3})*$/.test(alert)) throw httpError(400, 'AMC alert days must be numbers like 30,15,7.');
  await tx(async () => {
    await q.run("UPDATE im_settings SET value = ? WHERE key = 'approval_global'", appr);
    await q.run("UPDATE im_settings SET value = ? WHERE key = 'amc_alert_days'", alert.replace(/\s/g, ''));
    await audit({ entity: 'IMPLEMENTATION', action: 'UPDATE', remarks: `Implementation settings: approval ${appr === '1' ? 'ON' : 'OFF'}, AMC alerts ${alert}`, user: req.user });
  });
  res.json(await E.settings());
});

/* ----------------------------- Shared data --------------------------------- */

async function scoped(key, user, extra = {}) {
  const e = ENTITIES[key];
  if (!E.canSee(e, user)) return [];
  return E.listRows(e, user, extra);
}

async function engineers(user) {
  const rows = await q.all(`SELECT u.id, u.employee_name AS name, r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.status = 'Active' ORDER BY u.employee_name`);
  const assigned = new Set((await q.all('SELECT DISTINCT eng FROM im_assign')).map((r) => r.eng));
  let list = rows.filter((u) => {
    const p = JSON.parse(u.permissions || '[]');
    return assigned.has(u.id) || (p.includes('impl.work') && !p.includes('impl.manage'));
  }).map(({ id, name }) => ({ id, name }));
  if (!E.seesAll(user)) list = list.filter((u) => u.id === user.id);
  return list;
}

async function engineerStats(user) {
  const today = todayLocal();
  const [engs, assign, tasks, daily, visits, comms] = await Promise.all([
    engineers(user), scoped('assign', user), scoped('tasks', user), scoped('daily', user), scoped('visits', user), scoped('comms', user),
  ]);
  const att = await q.all('SELECT user_id, in_time, out_time FROM att_days WHERE adate = ?', today).catch(() => []);
  const locs = Object.fromEntries((await q.all('SELECT id, name FROM im_locations')).map((l) => [l.id, l.name]));
  const clients = Object.fromEntries((await q.all('SELECT id, name FROM clients')).map((c) => [c.id, c.name]));
  return engs.map((u) => {
    const as = assign.filter((a) => a.eng === u.id);
    const ls = [...new Set(as.map((a) => a.loc).filter(Boolean))];
    const cs = [...new Set(as.map((a) => a.client))];
    const ts = tasks.filter((t) => (t.loc ? ls.includes(t.loc) : cs.includes(t.client)));
    const pend = ts.filter((t) => t.status !== 'Completed');
    const dy = daily.filter((d) => d.eng === u.id);
    const td = dy.find((d) => d.work_date === today);
    const a = att.find((x) => x.user_id === u.id);
    return {
      id: u.id, name: u.name, clients: cs.map((c) => clients[c]).filter(Boolean), locations: ls.map((l) => locs[l]).filter(Boolean),
      progress: avg(ts), done: ts.length - pend.length, pending: pend.length, overdue: pend.filter((t) => t.target_on < today).length,
      reports: dy.length, hours: sum(dy, 'hours'), today: td ? { module: td.module, task: td.task, pct: td.pct, hours: td.hours, mode: td.work_mode } : null,
      visits: visits.filter((v) => v.eng === u.id).length, calls: comms.filter((c) => c.eng === u.id).length,
      attendance: a ? { in: a.in_time, out: a.out_time } : null,
    };
  });
}

/* -------------------------------- Dashboard -------------------------------- */

router.get('/dashboard', async (req, res) => {
  const u = req.user;
  const today = todayLocal();
  const [clientsAll, locations, tasks, issues, amc, sorders, solines, daily] = await Promise.all([
    q.all('SELECT id, name FROM clients ORDER BY name'), scoped('locations', u), scoped('tasks', u), scoped('issues', u),
    scoped('amc', u), scoped('sorders', u), scoped('solines', u), scoped('daily', u),
  ]);
  const allowed = await E.allowedClients(u);
  const clients = allowed ? clientsAll.filter((c) => allowed.includes(c.id)) : clientsAll;
  const pending = tasks.filter((t) => t.status !== 'Completed');
  const stats = await engineerStats(u);
  const from = addDays(today, -13);
  const days = [];
  for (let d = from; d <= today; d = addDays(d, 1)) days.push(d);
  const alertMax = Math.max(...String((await E.settings()).amc_alert_days || '30').split(',').map(Number));
  const clientName = Object.fromEntries(clientsAll.map((c) => [c.id, c.name]));
  res.json({
    kpi: {
      todaysSalesOrders: sorders.filter((s) => s.so_date === today).length, clients: clients.length, locations: locations.length,
      pendingTasks: pending.length, overdueTasks: pending.filter((t) => t.target_on < today).length,
      amcExpiring: amc.filter((a) => a.end_on >= today && a.end_on <= addDays(today, alertMax)).length,
      openIssues: issues.filter((i) => ['Open', 'In Progress'].includes(i.status)).length,
      missingReports: E.seesAll(u) ? stats.filter((s) => s.locations.length && !s.today).length : null,
      pendingApprovals: tasks.filter((t) => t.approval === 'Pending approval').length,
    },
    taskStatus: STATUS.map((s) => tasks.filter((t) => t.status === s).length),
    statuses: STATUS,
    locationProgress: locations.map((l) => {
      const ts = tasks.filter((t) => t.loc === l.id);
      return { client: clientName[l.client], name: l.name, tasks: ts.length, done: ts.filter((t) => t.status === 'Completed').length, progress: avg(ts) };
    }),
    engineers: stats,
    dailyHours: { days, hours: days.map((d) => sum(daily.filter((x) => x.work_date === d), 'hours')) },
    salesBySource: E.canSee(ENTITIES.sorders, u) ? Object.entries(sorders.reduce((m, s) => ({ ...m, [s.source]: (m[s.source] || 0) + 1 }), {})) : null,
    latestSalesOrders: sorders.slice(0, 8).map((s) => ({
      ...s, clients: [...new Set(solines.filter((l) => l.so === s.id).map((l) => clientName[l.client]))].join(', '),
    })),
  });
});

/* ------------------------------- My Day ------------------------------------ */

router.get('/myday', async (req, res) => {
  const u = req.user;
  const today = todayLocal();
  const soon = addDays(today, 3);
  const myLocs = new Set((await q.all('SELECT loc, client FROM im_assign WHERE eng = ? AND from_date <= ? AND (to_date IS NULL OR to_date >= ?)', u.id, today, today)).map((a) => a.loc));
  const [tasks, visits, comms, issues, daily] = await Promise.all([scoped('tasks', u), scoped('visits', u), scoped('comms', u), scoped('issues', u), scoped('daily', u)]);
  res.json({
    today,
    tasks: tasks.filter((t) => t.status !== 'Completed' && t.target_on <= soon && (!t.loc || myLocs.has(t.loc) || E.seesAll(u))).sort((a, b) => (a.target_on < b.target_on ? -1 : 1)),
    visits: visits.filter((v) => v.eng === u.id && !v.actual_on),
    followUps: comms.filter((c) => c.eng === u.id && c.next_on && c.next_on <= soon),
    issues: issues.filter((i) => !['Resolved', 'Closed'].includes(i.status) && (i.assigned_to === u.id || (i.loc && myLocs.has(i.loc)))),
    todayReports: daily.filter((d) => d.eng === u.id && d.work_date === today),
  });
});

/* ------------------------------ Client 360 --------------------------------- */

router.get('/client/:id', async (req, res) => {
  const u = req.user;
  const id = +req.params.id;
  const allowed = await E.allowedClients(u);
  if (allowed && !allowed.includes(id)) throw httpError(404, 'Client not found.');
  const client = await q.get(`SELECT id, name, client_code, client_type, city, state_code, gstin, phone, contact_email, contact_person, billing_address, status, task_approval
                                FROM clients WHERE id = ?`, id);
  if (!client) throw httpError(404, 'Client not found.');
  const f = { client: id };
  const [locations, cmods, ctemplates, golive, solines, tasks, assign, training, visits, comms, issues, sodocs] = await Promise.all([
    scoped('locations', u, f), scoped('cmods', u, f), scoped('ctemplates', u, f), scoped('golive', u, f), scoped('solines', u, f),
    scoped('tasks', u, f), scoped('assign', u, f), scoped('training', u, f), scoped('visits', u, f), scoped('comms', u, f), scoped('issues', u, f),
    scoped('sodocs', u),
  ]);
  const users = Object.fromEntries((await q.all('SELECT id, employee_name FROM users')).map((x) => [x.id, x.employee_name]));
  const tmpl = Object.fromEntries((await q.all('SELECT id, name FROM im_templates')).map((x) => [x.id, x.name]));
  const sos = Object.fromEntries((await q.all('SELECT id, so_no, so_date, source FROM im_sorders')).map((x) => [x.id, x]));
  const locName = Object.fromEntries(locations.map((l) => [l.id, l.name]));

  const overview = locations.map((l) => {
    const m = cmods.filter((x) => x.loc === l.id && x.enabled);
    const t = ctemplates.filter((x) => x.loc === l.id && x.enabled);
    const ts = tasks.filter((x) => x.loc === l.id);
    const stage = GO_LIVE_STAGES.find((g) => { const r = golive.find((x) => x.loc === l.id && x.stage === g); return !r || r.status !== 'Completed'; }) || 'All completed';
    const lines = solines.filter((p) => p.loc === l.id);
    return {
      id: l.id, name: l.name, address: `${l.address}, ${l.city}`, engineers: assign.filter((a) => a.loc === l.id).map((a) => users[a.eng]).join(', '),
      modules: m.length, modulesDone: m.filter((x) => x.status === 'Completed').length, templates: t.length, templatesBack: t.filter((x) => x.received_on).length,
      stage, beds: sum(lines, 'beds'), licences: sum(lines, 'user_licences'), tasks: ts.length, progress: avg(ts),
      geofence: l.lat != null ? `${l.radius_m || 300} m` : 'Not set',
    };
  });

  const docs = [];
  const add = (type, record, loc, date, fileId, name) => fileId && docs.push({ type, record, location: loc ? locName[loc] || '-' : 'All', date: date || '', file: fileId, name });
  const soIds = new Set(solines.map((l) => l.so));
  sodocs.filter((d) => soIds.has(d.so)).forEach((d) => add(d.doc_type, sos[d.so] ? sos[d.so].so_no : '', null, sos[d.so] && sos[d.so].so_date, d.file, d.file_name));
  ctemplates.forEach((x) => add('Filled template', tmpl[x.template], x.loc, x.received_on, x.file, x.file_name));
  tasks.forEach((x) => add('Task evidence', x.task, x.loc, x.done_on, x.evidence, x.evidence_name));
  golive.forEach((x) => add('Sign-off', x.stage, x.loc, x.actual_on, x.signoff, x.signoff_name));
  training.forEach((x) => add('Attendance sheet', x.topic, x.loc, x.train_date, x.sheet, x.sheet_name));
  visits.forEach((x) => { add('Visit report', x.purpose, x.loc, x.actual_on || x.planned_on, x.report, x.report_name); add('Client signature', x.purpose, x.loc, x.actual_on || x.planned_on, x.signature, x.signature_name); });
  docs.sort((a, b) => (a.date < b.date ? 1 : -1));

  const tl = [];
  const ev = (date, icon, text, loc) => date && tl.push({ date, icon, text, location: loc ? locName[loc] || '' : '' });
  solines.forEach((l) => { const s = sos[l.so]; if (s) ev(s.so_date, 'order', `Sales order ${s.so_no} received from ${s.source}`, l.loc); });
  golive.forEach((x) => ev(x.actual_on, 'rocket', `Stage ${x.stage}: ${x.status}`, x.loc));
  visits.forEach((x) => ev(x.actual_on || x.planned_on, 'pin', `${x.actual_on ? 'Visit done' : 'Visit planned'}: ${x.purpose}`, x.loc));
  training.forEach((x) => ev(x.train_date, 'cap', `Training: ${x.topic} (${x.attendees} attendees)`, x.loc));
  comms.forEach((x) => ev(x.comm_date, 'chat', `${x.mode} with ${x.spoke_to}: ${x.summary || ''}`, x.loc));
  issues.forEach((x) => { ev(x.raised_on, 'bug', `${x.issue_type} raised: ${x.title}`, x.loc); ev(x.resolved_on, 'check', `${x.issue_type} resolved: ${x.title}`, x.loc); });
  tasks.forEach((x) => ev(x.done_on, 'check', `Task completed: ${x.task}`, x.loc));
  ctemplates.forEach((x) => { ev(x.sent_on, 'file', `Template sent: ${tmpl[x.template]}`, x.loc); ev(x.received_on, 'file', `Template received: ${tmpl[x.template]}`, x.loc); });
  tl.sort((a, b) => (a.date < b.date ? 1 : -1));

  res.json({ client, overview, documents: docs, timeline: tl.slice(0, 300), goLive: golive });
});

/* --------------------------------- Reports --------------------------------- */

const REPORTS = {
  eng: 'Engineer performance', loc: 'Client and location status', task: 'Task status', daily: 'Daily status log', miss: 'Missing daily reports',
  onsite: 'Onsite days by client & employee', vis: 'Client visits', mods: 'Client and location modules', tmpl: 'Client and location templates', golive: 'Go-Live stages', trn: 'Training log',
  iss: 'Issues and change requests', hw: 'Hardware readiness', amc: 'AMC due and expired', so: 'Sales order register',
};

async function buildReport(key, user, f) {
  const today = todayLocal();
  const names = {
    c: Object.fromEntries((await q.all('SELECT id, name FROM clients')).map((x) => [x.id, x.name])),
    l: Object.fromEntries((await q.all('SELECT id, name FROM im_locations')).map((x) => [x.id, x.name])),
    u: Object.fromEntries((await q.all('SELECT id, employee_name FROM users')).map((x) => [x.id, x.employee_name])),
  };
  const C = (id) => names.c[id] || '-';
  const L = (id) => (id ? names.l[id] || '-' : 'All');
  const U = (id) => (id ? names.u[id] || '-' : '-');
  const fc = (x) => (!f.client || x.client === f.client) && (!f.loc || !x.loc || x.loc === f.loc);
  const fd = (v) => (!f.from || (v && v >= f.from)) && (!f.to || (v && v <= f.to));
  const fe = (x) => !f.eng || x.eng === f.eng;
  const dmy = (v) => (v ? v.split('-').reverse().join('-') : '-');
  const statusChart = (rows) => ({ type: 'doughnut', labels: STATUS, data: [STATUS.map((s) => rows.filter((r) => r.status === s).length)] });

  switch (key) {
    case 'eng': {
      let s = await engineerStats(user);
      if (f.eng) s = s.filter((x) => x.id === f.eng);
      return { headers: ['Engineer', 'Clients', 'Locations', 'Completed', 'Pending', 'Overdue', 'Avg progress %', 'Report days', 'Hours', 'Visits', 'Today'],
        rows: s.map((x) => [x.name, x.clients.join(', '), x.locations.join(', '), x.done, x.pending, x.overdue, x.progress, x.reports, x.hours, x.visits, x.today ? 'Submitted' : 'Missing']),
        chart: { type: 'bar', labels: s.map((x) => x.name), series: ['Avg progress %', 'Hours'], data: [s.map((x) => x.progress), s.map((x) => x.hours)] } };
    }
    case 'loc': {
      const [locs, tasks, assign] = await Promise.all([scoped('locations', user), scoped('tasks', user), scoped('assign', user)]);
      const rows = locs.filter((l) => !f.client || l.client === f.client).map((l) => {
        const t = tasks.filter((x) => x.loc === l.id);
        const p = t.filter((x) => x.status !== 'Completed');
        return [C(l.client), l.name, assign.filter((a) => a.loc === l.id).map((a) => U(a.eng)).join(', ') || '-', t.length, t.length - p.length, p.length, p.filter((x) => x.target_on < today).length, avg(t)];
      });
      return { headers: ['Client', 'Location', 'Engineers', 'Tasks', 'Completed', 'Pending', 'Overdue', 'Progress %'], rows,
        chart: { type: 'bar', labels: rows.map((r) => r[1]), series: ['Progress %'], data: [rows.map((r) => r[7])] } };
    }
    case 'task': {
      const t = (await scoped('tasks', user)).filter(fc);
      return { headers: ['Client', 'Location', 'Module', 'Task', 'Informed', 'Target', 'Status', 'Progress %', 'Evidence', 'Approval'],
        rows: t.map((x) => [C(x.client), L(x.loc), x.module, x.task, dmy(x.informed_on), dmy(x.target_on), x.status, x.pct, x.evidence ? 'Yes' : 'No', x.approval || '-']), chart: statusChart(t) };
    }
    case 'daily': {
      const d = (await scoped('daily', user)).filter((x) => fc(x) && fe(x) && fd(x.work_date)).sort((a, b) => (a.work_date < b.work_date ? -1 : 1));
      const ds = [...new Set(d.map((x) => x.work_date))];
      return { headers: ['Date', 'Engineer', 'Client', 'Location', 'Module', 'Task', 'Progress %', 'Status', 'Hours', 'Mode'],
        rows: d.map((x) => [dmy(x.work_date), U(x.eng), C(x.client), L(x.loc), x.module, x.task, x.pct, x.status, x.hours, x.work_mode]),
        chart: { type: 'line', labels: ds.map(dmy), series: ['Hours'], data: [ds.map((k) => sum(d.filter((x) => x.work_date === k), 'hours'))] } };
    }
    case 'miss': {
      const engs = (await engineers(user)).filter((x) => !f.eng || x.id === f.eng);
      const from = f.from || addDays(today, -13);
      const to = f.to && f.to < today ? f.to : today;
      const daily = await scoped('daily', user);
      const rows = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const wd = new Date(d + 'T00:00:00Z').getUTCDay();
        if (wd === 0 || wd === 6) continue;
        for (const u of engs) if (!daily.some((x) => x.eng === u.id && x.work_date === d)) rows.push([dmy(d), u.name]);
      }
      return { headers: ['Date', 'Engineer'], rows, chart: { type: 'bar', labels: engs.map((u) => u.name), series: ['Missing days'], data: [engs.map((u) => rows.filter((r) => r[1] === u.name).length)] } };
    }
    case 'onsite': {
      const r = await onsiteDays(user, f);
      return { headers: ['Client', 'Engineer', 'Assignment', 'Assigned onsite days', 'Break days', 'Net onsite days', 'Days checked in at client', 'Today'],
        rows: r.map((x) => [x.client, x.engineer, x.period, x.assigned, x.breaks, x.net, x.checkedIn, x.today]),
        chart: { type: 'bar', labels: r.map((x) => `${x.engineer} – ${x.client}`), series: ['Net onsite days', 'Break days', 'Days checked in'], data: [r.map((x) => x.net), r.map((x) => x.breaks), r.map((x) => x.checkedIn)] } };
    }
    case 'vis': {
      const v = (await scoped('visits', user)).filter((x) => fc(x) && fe(x) && fd(x.planned_on));
      return { headers: ['Client', 'Location', 'Engineer', 'Planned', 'Actual', 'Purpose', 'Check-in', 'Check-out', 'Status'],
        rows: v.map((x) => [C(x.client), L(x.loc), U(x.eng), dmy(x.planned_on), dmy(x.actual_on), x.purpose, x.check_in || '-', x.check_out || '-', x.actual_on ? 'Completed' : 'Planned']),
        chart: { type: 'doughnut', labels: ['Completed', 'Planned'], data: [[v.filter((x) => x.actual_on).length, v.filter((x) => !x.actual_on).length]] } };
    }
    case 'mods': {
      const [m, tasks] = await Promise.all([scoped('cmods', user), scoped('tasks', user)]);
      const r = m.filter(fc);
      return { headers: ['Client', 'Location', 'Module', 'Source', 'Applicable', 'Planned end', 'Progress %', 'Status'],
        rows: r.map((x) => [C(x.client), L(x.loc), x.module, x.source, x.enabled ? 'Yes' : 'No', dmy(x.plan_end), avg(tasks.filter((t) => t.client === x.client && t.loc === x.loc && t.module === x.module)), x.status]),
        chart: statusChart(r) };
    }
    case 'tmpl': {
      const t = (await scoped('ctemplates', user)).filter(fc);
      const tm = Object.fromEntries((await q.all('SELECT id, name, category, version FROM im_templates')).map((x) => [x.id, x]));
      return { headers: ['Client', 'Location', 'Template', 'Category', 'Version', 'Enabled', 'Sent', 'Received', 'Filled file'],
        rows: t.map((x) => { const y = tm[x.template] || {}; return [C(x.client), L(x.loc), y.name, y.category, y.version, x.enabled ? 'Yes' : 'No', dmy(x.sent_on), dmy(x.received_on), x.file_name || '-']; }),
        chart: { type: 'doughnut', labels: ['Received back', 'Sent, waiting', 'Not sent'], data: [[t.filter((x) => x.received_on).length, t.filter((x) => x.sent_on && !x.received_on).length, t.filter((x) => !x.sent_on).length]] } };
    }
    case 'golive': {
      const g = (await scoped('golive', user)).filter(fc);
      return { headers: ['Client', 'Location', 'Stage', 'Planned', 'Actual', 'Status', 'Sign-off'],
        rows: g.map((x) => [C(x.client), L(x.loc), x.stage, dmy(x.planned_on), dmy(x.actual_on), x.status, x.signoff_name || '-']), chart: statusChart(g) };
    }
    case 'trn': {
      const t = (await scoped('training', user)).filter((x) => fc(x) && fe(x) && fd(x.train_date));
      const ms = [...new Set(t.map((x) => x.module))];
      return { headers: ['Date', 'Client', 'Location', 'Module', 'Topic', 'Trainer', 'Attendees', 'Hours'],
        rows: t.map((x) => [dmy(x.train_date), C(x.client), L(x.loc), x.module, x.topic, U(x.eng), x.attendees, x.hours || '-']),
        chart: { type: 'bar', labels: ms, series: ['Attendees'], data: [ms.map((m) => sum(t.filter((x) => x.module === m), 'attendees'))] } };
    }
    case 'iss': {
      const i = (await scoped('issues', user)).filter((x) => fc(x) && fd(x.raised_on));
      const S = ['Open', 'In Progress', 'Resolved', 'Closed'];
      return { headers: ['Type', 'Client', 'Location', 'Title', 'Priority', 'Status', 'Raised', 'Resolved', 'Assigned to', 'Est. man-days'],
        rows: i.map((x) => [x.issue_type, C(x.client), x.loc ? L(x.loc) : '-', x.title, x.priority, x.status, dmy(x.raised_on), dmy(x.resolved_on), U(x.assigned_to), x.est_man_days ?? '-']),
        chart: { type: 'bar', labels: S, series: ['Count'], data: [S.map((s) => i.filter((x) => x.status === s).length)] } };
    }
    case 'hw': {
      const h = (await scoped('hw', user)).filter(fc);
      const S = ['Ready', 'Partial', 'Not Ready'];
      return { headers: ['Client', 'Location', 'Item', 'Required', 'Available', 'Status'], rows: h.map((x) => [C(x.client), L(x.loc), x.item, x.required, x.available, x.status]),
        chart: { type: 'doughnut', labels: S, data: [S.map((s) => h.filter((x) => x.status === s).length)] } };
    }
    case 'amc': {
      if (!E.canSee(ENTITIES.amc, user)) throw httpError(403, 'Not available for your role.');
      const a = (await scoped('amc', user)).filter(fc);
      const left = (x) => Math.round((new Date(x.end_on) - new Date(today)) / 864e5);
      return { headers: ['Client', 'Type', 'Start', 'End', 'Days left', 'Amount (Rs)', 'Invoice', 'Status'],
        rows: a.map((x) => [C(x.client), x.amc_type, dmy(x.start_on), dmy(x.end_on), left(x), x.amount, x.invoice_no || '-', x.status]),
        chart: { type: 'bar', labels: a.map((x) => C(x.client)), series: ['Days left'], data: [a.map(left)] } };
    }
    case 'so': {
      if (!E.canSee(ENTITIES.sorders, user)) throw httpError(403, 'Not available for your role.');
      const [s, lines] = await Promise.all([scoped('sorders', user), scoped('solines', user)]);
      const r = s.filter((x) => fd(x.so_date) && (!f.client || lines.some((l) => l.so === x.id && l.client === f.client)));
      const src = [...new Set(r.map((x) => x.source))];
      return { headers: ['Sales order', 'Date', 'Clients', 'Source', 'Person', 'Beds', 'Users', 'Amount (Rs)'],
        rows: r.map((x) => { const l = lines.filter((y) => y.so === x.id); return [x.so_no, dmy(x.so_date), [...new Set(l.map((y) => C(y.client)))].join(', '), x.source, x.person, sum(l, 'beds'), sum(l, 'user_licences'), x.amount]; }),
        chart: { type: 'pie', labels: src, data: [src.map((k) => r.filter((x) => x.source === k).length)] } };
    }
    default: throw httpError(404, 'Unknown report.');
  }
}

function reportFilters(qs) {
  const int = (v) => (Number.isInteger(parseInt(v, 10)) ? parseInt(v, 10) : null);
  return { client: int(qs.client), loc: int(qs.loc), eng: int(qs.eng), from: isIsoDate(qs.from) ? qs.from : null, to: isIsoDate(qs.to) ? qs.to : null };
}

/* ---------------------------- Onsite day counts ---------------------------- */

// Per client + engineer: calendar days on Onsite assignments (up to today or the end date),
// minus break days, plus the days the engineer actually face-checked-in at that client's locations.
async function onsiteDays(user, f = {}) {
  const today = todayLocal();
  const [assign, breaks] = await Promise.all([scoped('assign', user), scoped('abreaks', user)]);
  const names = {
    c: Object.fromEntries((await q.all('SELECT id, name FROM clients')).map((x) => [x.id, x.name])),
    u: Object.fromEntries((await q.all('SELECT id, employee_name FROM users')).map((x) => [x.id, x.employee_name])),
  };
  const lo = f.from || '0000-01-01';
  const hi = f.to && f.to < today ? f.to : today;
  const days = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
  const groups = new Map();
  for (const a of assign) {
    if (a.work_mode !== 'Onsite') continue;
    if ((f.client && a.client !== f.client) || (f.eng && a.eng !== f.eng)) continue;
    const key = `${a.client}|${a.eng}`;
    if (!groups.has(key)) groups.set(key, { client: a.client, eng: a.eng, dates: new Set(), periods: [], locs: new Set() });
    const g = groups.get(key);
    if (a.loc) g.locs.add(a.loc);
    g.periods.push(`${a.from_date.split('-').reverse().join('-')} → ${a.to_date ? a.to_date.split('-').reverse().join('-') : 'ongoing'}`);
    const s = a.from_date > lo ? a.from_date : lo;
    const e = (a.to_date || today) < hi ? (a.to_date || today) : hi;
    if (s <= e) days(s, e).forEach((d) => g.dates.add(d));
  }
  const out = [];
  for (const g of groups.values()) {
    const off = new Set();
    let onBreakToday = false;
    for (const b of breaks.filter((x) => x.client === g.client && x.eng === g.eng && (x.status || 'Approved') === 'Approved')) {
      days(b.from_date, b.to_date).forEach((d) => { if (g.dates.has(d)) off.add(d); });
      if (b.from_date <= today && b.to_date >= today) onBreakToday = true;
    }
    const locs = (await q.all('SELECT id FROM im_locations WHERE client = ?', g.client)).map((l) => l.id);
    const checkedIn = locs.length ? (await q.get(
      `SELECT COUNT(DISTINCT adate) AS n FROM att_days WHERE user_id = ? AND in_loc IN (${locs.map(() => '?').join(',')}) AND adate BETWEEN ? AND ?`,
      g.eng, ...locs, lo, hi)).n : 0;
    const active = assign.some((a) => a.client === g.client && a.eng === g.eng && a.work_mode === 'Onsite' && a.from_date <= today && (!a.to_date || a.to_date >= today));
    out.push({
      client: `${names.c[g.client] || '-'}${await locSuffix(g)}`, engineer: names.u[g.eng] || '-', period: g.periods.join(', '),
      assigned: g.dates.size, breaks: off.size, net: g.dates.size - off.size, checkedIn,
      today: onBreakToday ? 'On break' : active ? 'Onsite' : 'Not assigned today',
    });
  }
  return out.sort((a, b) => a.client.localeCompare(b.client) || a.engineer.localeCompare(b.engineer));
}

// " (PUNE, Kondapur)": assigned locations, or all of the client's locations when none was chosen.
async function locSuffix(g) {
  const rows = g.locs.size
    ? await q.all(`SELECT name FROM im_locations WHERE id IN (${[...g.locs].map(() => '?').join(',')}) ORDER BY name`, ...g.locs)
    : await q.all('SELECT name FROM im_locations WHERE client = ? ORDER BY name', g.client);
  return rows.length ? ` (${rows.map((r) => r.name).join(', ')})` : '';
}

router.get('/onsite-days', async (req, res) => res.json(await onsiteDays(req.user, reportFilters(req.query))));

router.get('/reports', (req, res) => res.json(Object.entries(REPORTS).filter(([k]) => (k === 'amc' ? E.canSee(ENTITIES.amc, req.user) : k === 'so' ? E.canSee(ENTITIES.sorders, req.user) : true)).map(([key, title]) => ({ key, title }))));

router.get('/reports/:key', async (req, res) => {
  const key = req.params.key;
  if (!REPORTS[key]) throw httpError(404, 'Unknown report.');
  const f = reportFilters(req.query);
  if (!E.seesAll(req.user)) f.eng = ['eng', 'daily', 'miss', 'vis', 'trn'].includes(key) ? req.user.id : f.eng;
  const r = await buildReport(key, req.user, f);
  r.title = REPORTS[key];
  if (req.query.format === 'xlsx') return sendXlsx(res, r, req.user, key);
  if (req.query.format === 'pdf') return sendPdf(res, r, req.user, key);
  res.json(r);
});

// Excel export of any record list (what the user can see).
router.get('/export/:entity', async (req, res) => {
  const e = entity(req.params.entity, req.user);
  const rows = await E.listRows(e, req.user, req.query);
  const names = await refNames();
  const fields = e.fields.filter((f) => !['p', 'sys'].includes(f.type) || f.key === 'approval');
  const r = { title: e.title, headers: fields.map((f) => f.label), rows: rows.map((x) => fields.map((f) => cellText(f, x, names))) };
  sendXlsx(res, r, req.user, e.key);
});

async function refNames() {
  const map = async (sql) => Object.fromEntries((await q.all(sql)).map((x) => [x.id, x.name]));
  return {
    clients: await map('SELECT id, name FROM clients'), locations: await map('SELECT id, name FROM im_locations'),
    users: await map('SELECT id, employee_name AS name FROM users'), templates: await map("SELECT id, name || ' ' || version AS name FROM im_templates"),
    sorders: await map('SELECT id, so_no AS name FROM im_sorders'),
  };
}
function cellText(f, x, names) {
  const v = x[f.key];
  if (f.type === 'f') return x[`${f.key}_name`] || '';
  if (v === null || v === undefined) return '';
  if (f.type === 'r' || f.type === 'h') return (names[f.ref] || {})[v] || '';
  if (f.type === 'c') return v ? 'Yes' : 'No';
  if (f.type === 'x') return (v || []).join(', ');
  if (f.type === 'd') return v.split('-').reverse().join('-');
  return v;
}

async function sendXlsx(res, r, user, key) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report');
  ws.addRow([`HIMS Implementation - ${r.title}`]).font = { bold: true, size: 14, color: { argb: 'FF2C6A98' } };
  ws.addRow([`Generated ${todayLocal().split('-').reverse().join('-')} by ${user.employee_name}`]).font = { italic: true, color: { argb: 'FF666666' } };
  ws.addRow([]);
  const h = ws.addRow(r.headers);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C6A98' } }; });
  r.rows.forEach((row) => ws.addRow(row));
  ws.columns.forEach((c, i) => { c.width = Math.min(45, Math.max(12, ...[r.headers[i], ...r.rows.map((x) => x[i])].map((v) => String(v ?? '').length + 2))); });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${key}-${todayLocal()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

function sendPdf(res, r, user, key) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${key}-${todayLocal()}.pdf"`);
  doc.pipe(res);
  const L = doc.page.margins.left;
  const W = doc.page.width - L * 2;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#2C6A98').text(`HIMS Implementation - ${r.title}`, L, 30);
  doc.font('Helvetica').fontSize(8).fillColor('#555').text(`Generated ${todayLocal().split('-').reverse().join('-')} by ${user.employee_name} · ${r.rows.length} rows`);
  doc.moveDown(0.6);
  const cw = W / r.headers.length;
  const row = (vals, head) => {
    doc.font(head ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
    const h = Math.max(...vals.map((v) => doc.heightOfString(String(v ?? ''), { width: cw - 6 }))) + 6;
    if (doc.y + h > doc.page.height - 40) { doc.addPage(); doc.y = 30; if (!head) row(r.headers, true); }
    const y = doc.y;
    if (head) doc.rect(L, y, W, h).fill('#2C6A98');
    vals.forEach((v, i) => doc.fillColor(head ? '#fff' : '#222').text(String(v ?? ''), L + i * cw + 3, y + 3, { width: cw - 6 }));
    doc.y = y + h;
    doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.3).strokeColor('#D5DCE5').stroke();
  };
  row(r.headers, true);
  r.rows.forEach((x) => row(x, false));
  doc.end();
}

module.exports = router;
