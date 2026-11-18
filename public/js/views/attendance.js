import { api, can, esc, icon, fmtDate, fmtNum, today, toast, modal, busy, download, confirmDialog, loadScript, loadCss, qs } from '../core.js';
import { getPosition } from './impl.js';

/* ------------------------------ Face engine ------------------------------ */

let faceapi = null;
async function loadFace(status) {
  if (faceapi) return faceapi;
  status('Loading face recognition (first time only, about 7 MB)…');
  faceapi = await import('/vendor/face-api/face-api.esm.js');
  const url = '/vendor/face-models';
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(url),
    faceapi.nets.faceLandmark68Net.loadFromUri(url),
    faceapi.nets.faceRecognitionNet.loadFromUri(url),
  ]);
  return faceapi;
}

const avgPt = (pts) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });
// Head turn: nose position relative to the centre of the eyes (0 = straight; about ±0.3 = clearly turned).
function yaw(landmarks) {
  const p = landmarks.positions;
  const le = avgPt(p.slice(36, 42));
  const re = avgPt(p.slice(42, 48));
  return (p[30].x - (le.x + re.x) / 2) / Math.max(1, re.x - le.x);
}
const dist = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens the camera and returns { descriptors, photo } after a liveness check
 * (look straight, then turn the head). samples = how many straight captures to collect.
 */
function captureFace({ title, samples = 1 }) {
  return new Promise((resolve, reject) => {
    let stream = null;
    let done = false;
    const m = modal({
      title, size: 'narrow',
      body: `<div class="cam"><video playsinline muted autoplay></video><div class="cam-ring" data-ring></div></div>
        <div class="cam-status" data-s>Starting camera…</div><div class="cam-steps"><span data-st1>1. Look straight</span><span data-st2>2. Turn your head</span></div>`,
      footer: '<button class="btn" data-close>Cancel</button>',
    });
    const video = m.$('video');
    const status = (t, cls = '') => { const s = m.$('[data-s]'); if (s) { s.textContent = t; s.className = `cam-status ${cls}`; } };
    const stop = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
    const finish = (err, val) => { if (done) return; done = true; stop(); if (err) reject(err); else { m.close(); resolve(val); } };
    // Closing the dialog cancels.
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); finish(new Error('cancelled')); } });
    obs.observe(document.getElementById('modal-root'), { childList: true });

    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot use the camera. Use Chrome or Edge on your phone.');
        const fa = await loadFace(status);
        status('Allow camera access…');
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
        } catch { throw new Error('Camera permission was denied. Allow the camera for this site and try again.'); }
        if (done) return stop();
        video.srcObject = stream;
        await new Promise((r) => { if (video.readyState >= 2) r(); else video.onloadeddata = r; });
        const opts = new fa.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
        const detect = () => fa.detectSingleFace(video, opts).withFaceLandmarks().withFaceDescriptor();

        // Step 1: straight captures
        const descriptors = [];
        let photo = null;
        const t1 = Date.now();
        status('Look straight at the camera');
        while (descriptors.length < samples) {
          if (done) return;
          if (Date.now() - t1 > 30000) throw new Error('No clear face found. Use good light and hold the phone at eye level.');
          const r = await detect();
          if (!r) { status('No face found — move into the frame', 'warn'); await sleep(150); continue; }
          const w = r.detection.box.width / video.videoWidth;
          const y = yaw(r.landmarks);
          if (w < 0.22) { status('Come a little closer', 'warn'); await sleep(150); continue; }
          if (Math.abs(y) > 0.12) { status('Look straight at the camera', 'warn'); await sleep(150); continue; }
          if (descriptors.length && dist(descriptors[0], Array.from(r.descriptor)) > 0.45) { status('Hold still…', 'warn'); continue; }
          descriptors.push(Array.from(r.descriptor));
          if (!photo) {
            const c = document.createElement('canvas');
            const scale = 320 / video.videoWidth;
            c.width = 320; c.height = Math.round(video.videoHeight * scale);
            c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
            photo = c.toDataURL('image/jpeg', 0.72).split(',')[1];
          }
          status(samples > 1 ? `Captured ${descriptors.length} of ${samples}…` : 'Got it', 'ok');
          await sleep(samples > 1 ? 450 : 100);
        }
        m.$('[data-st1]').classList.add('done');

        // Step 2: liveness — the same face must turn clearly to one side.
        // Either direction counts (some phones mirror the front camera).
        status('Now slowly turn your head to the left or right');
        m.$('[data-ring]').classList.add('turn');
        const t2 = Date.now();
        while (true) {
          if (done) return;
          if (Date.now() - t2 > 15000) throw new Error('Head turn not detected. Please try again and turn your head slowly.');
          const r = await detect();
          if (!r) { await sleep(100); continue; }
          const y = yaw(r.landmarks);
          if (Math.abs(y) > 0.22 && dist(descriptors[0], Array.from(r.descriptor)) < 0.65) break;
          await sleep(80);
        }
        m.$('[data-st2]').classList.add('done');
        status('Done', 'ok');
        await sleep(250);
        obs.disconnect();
        finish(null, { descriptors, photo });
      } catch (err) { obs.disconnect(); if (!done) { status(err.message, 'bad'); stop(); done = true; reject(err); } }
    })();
  });
}

/* ------------------------------ Location pings ----------------------------- */

let pingTimer = null;
// While checked in and the app is open, share location every 15 minutes.
export function startLocationPings() {
  if (pingTimer || !can('attendance.self')) return;
  const tick = async () => {
    if (document.hidden) return;
    try {
      const p = await getPosition();
      const r = await api('/attendance/ping', { method: 'POST', body: { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy } });
      if (!r.tracking) { clearInterval(pingTimer); pingTimer = null; }
    } catch { /* no permission or offline: try again next time */ }
  };
  pingTimer = setInterval(tick, 15 * 60 * 1000);
  tick();
}
export function stopLocationPings() { clearInterval(pingTimer); pingTimer = null; }

/* ------------------------------ My attendance ------------------------------ */

const GEO = { Inside: 'ok', Outside: 'bad', Remote: 'info', 'No geofence': 'off' };
const geoBadge = (g, d) => (g ? `<span class="badge ${GEO[g] || 'off'}">${esc(g)}${d != null ? ` · ${fmtNum(d)} m` : ''}</span>` : '');
const hm = (t) => (t ? t.slice(11, 16) : '—');
const photo = (id, label) => (id ? `<button type="button" class="ph-btn" data-ph="${id}" title="${esc(label)}"><img src="/api/attendance/photo/${id}" alt="${esc(label)}" loading="lazy"></button>` : '');

function photoClicks(root) {
  root.querySelectorAll('[data-ph]').forEach((b) => b.addEventListener('click', () => modal({
    title: b.title, size: 'narrow', body: `<img class="ph-big" src="/api/attendance/photo/${b.dataset.ph}" alt="${esc(b.title)}">`, footer: '<button class="btn" data-close>Close</button>',
  })));
}

export async function renderAttendance(root) {
  const d = await api('/attendance/me');
  if (!d.required) {
    root.innerHTML = `<div class="page-head"><div><h1>My Attendance</h1></div></div><div class="card empty"><b>Face attendance is not required for your role</b></div>`;
    return;
  }
  const t = d.today;
  const primary = d.locations.find((l) => l.assigned);
  const state = !t ? 'none' : !t.out_time ? 'in' : 'out';
  root.innerHTML = `<div class="page-head"><div><h1>My Attendance</h1><p>Face check-in and check-out with your location.</p></div></div>
    ${!d.enrolled ? `<div class="card card-body enrol">
        <div class="enrol-ico">${icon('user')}</div>
        <div><h3>Enrol your face (one time)</h3>
        <p>The app saves a numeric face signature and one photo so it can recognise you at check-in. During each check-in and check-out it also records your GPS location and a small photo (kept ${d.photoDays} days). While you are checked in and this app is open, your location is shared every 15 minutes.</p>
        <label class="check"><input type="checkbox" data-consent> I agree to the use of my face and location for attendance.</label>
        <div style="margin-top:12px"><button class="btn btn-primary" data-enrol disabled>${icon('user')} Enrol my face</button></div></div></div>`
    : `<div class="card card-body att-today">
        <div class="att-status">
          <div class="att-big ${state}">${state === 'none' ? 'Not checked in' : state === 'in' ? 'Checked in' : 'Checked out'}</div>
          <div class="help">${fmtDate(today())}</div>
          ${t ? `<div class="att-line">In: <b>${hm(t.in_time)}</b> ${geoBadge(t.in_geo, t.in_dist)} ${photo(t.in_photo, 'Check-in photo')}</div>` : ''}
          ${t && t.out_time ? `<div class="att-line">Out: <b>${hm(t.out_time)}</b> ${geoBadge(t.out_geo, t.out_dist)} ${photo(t.out_photo, 'Check-out photo')} · ${fmtNum(t.hours)} h</div>` : ''}
        </div>
        ${state !== 'out' ? `<div class="att-action">
          <label for="att-loc">Where are you working?</label>
          <select id="att-loc" class="input"><option value="">Office / remote (no geofence)</option>
            ${d.locations.map((l) => `<option value="${l.id}" ${(state === 'in' ? t.in_loc === l.id : primary && primary.id === l.id) ? 'selected' : ''}>${esc(l.client_name)} – ${esc(l.name)}${l.lat == null ? ' (no geofence set)' : ''}</option>`).join('')}</select>
          <button class="btn btn-primary btn-lg btn-block" data-punch="${state === 'none' ? 'in' : 'out'}">${icon('user')} ${state === 'none' ? 'Face check-in' : 'Face check-out'}</button>
          <span class="help">${state === 'in' ? 'Location is shared every 15 minutes while this app is open.' : 'Uses your camera and GPS.'}</span></div>` : '<div class="att-action"><span class="badge ok">Done for today</span></div>'}
      </div>`}
    <div class="card"><div class="card-head"><h3>My last 31 days</h3><button class="btn btn-sm" data-xl>${icon('excel')} Excel</button></div><div class="table-wrap">${d.history.length ? `<table class="tbl tbl-compact"><thead><tr><th>Date</th><th>Check-in</th><th>Location</th><th>Check-out</th><th>Location</th><th class="num">Hours</th></tr></thead><tbody>
      ${d.history.map((h) => `<tr><td>${fmtDate(h.adate)}</td><td>${hm(h.in_time)} ${photo(h.in_photo, 'Check-in photo')}</td><td>${esc(h.in_loc_name || 'Office / remote')} ${geoBadge(h.in_geo, h.in_dist)}</td>
        <td>${h.out_time ? `${hm(h.out_time)} ${photo(h.out_photo, 'Check-out photo')}` : '<span class="badge warn">Not checked out</span>'}</td><td>${h.out_time ? `${esc(h.out_loc_name || 'Office / remote')} ${geoBadge(h.out_geo, h.out_dist)}` : ''}</td><td class="num">${h.hours != null ? fmtNum(h.hours) : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty small">No attendance yet.</div>'}</div></div>`;
  photoClicks(root);
  root.querySelector('[data-xl]').addEventListener('click', () => download(`/attendance/report${qs({ from: d.history.length ? d.history[d.history.length - 1].adate : today(), to: today(), format: 'xlsx' })}`).catch((err) => toast(err.message, 'err')));
  const consent = root.querySelector('[data-consent]');
  if (consent) {
    const btn = root.querySelector('[data-enrol]');
    consent.addEventListener('change', () => { btn.disabled = !consent.checked; });
    btn.addEventListener('click', async () => {
      try {
        const r = await captureFace({ title: 'Enrol your face', samples: 3 });
        busy(btn, true, 'Saving…');
        await api('/attendance/enrol', { method: 'POST', body: { consent: true, descriptors: r.descriptors, photo: { data: r.photo } } });
        toast('Face enrolled. You can now check in.');
        renderAttendance(root);
      } catch (err) { busy(btn, false); if (err.message !== 'cancelled') toast(err.message, 'err'); }
    });
  }
  const pb = root.querySelector('[data-punch]');
  if (pb) pb.addEventListener('click', async () => {
    const kind = pb.dataset.punch;
    try {
      busy(pb, true, 'Getting your location…');
      const pos = await getPosition();
      busy(pb, false);
      const face = await captureFace({ title: kind === 'in' ? 'Face check-in' : 'Face check-out' });
      busy(pb, true, 'Verifying…');
      const r = await api('/attendance/punch', { method: 'POST', body: {
        kind, liveness: true, descriptor: face.descriptors[0], photo: { data: face.photo }, loc: root.querySelector('#att-loc').value,
        lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy,
      } });
      toast(`Checked ${kind} — ${r.geo}${r.distance != null ? ` (${r.distance} m from site)` : ''}.`, r.geo === 'Outside' ? 'err' : 'ok');
      if (kind === 'in') startLocationPings(); else stopLocationPings();
      renderAttendance(root);
    } catch (err) { busy(pb, false); if (err.message !== 'cancelled') toast(err.message, 'err'); }
  });
}

/* ------------------------------ Team attendance ---------------------------- */

const team = { date: '' };
let map = null;
export async function renderTeamAttendance(root) {
  team.date = team.date || today();
  const [d, live] = await Promise.all([api(`/attendance/team?date=${team.date}`), api(`/attendance/live?date=${team.date}`)]);
  const present = d.rows.filter((r) => r.day && r.day.in_time).length;
  const outside = d.rows.filter((r) => r.day && (r.day.in_geo === 'Outside' || r.day.out_geo === 'Outside')).length;
  root.innerHTML = `<div class="page-head"><div><h1>Team Attendance</h1><p>Face check-in / check-out, geofence and live location of field staff.</p></div>
      <div class="actions"><input class="input" type="date" data-date value="${team.date}" max="${today()}" aria-label="Date"><button class="btn" data-xl>${icon('excel')} Month Excel</button></div></div>
    <div class="grid kpis">
      <div class="card kpi k1"><span class="kpi-icon">${icon('users')}</span><div class="label">Field staff</div><div class="value">${d.rows.length}</div><div class="hint">${d.rows.filter((r) => r.enrolled).length} enrolled</div></div>
      <div class="card kpi k2"><span class="kpi-icon">${icon('check')}</span><div class="label">Checked in</div><div class="value">${present}</div><div class="hint">${d.rows.filter((r) => r.day && r.day.out_time).length} checked out</div></div>
      <div class="card kpi k4"><span class="kpi-icon">${icon('calendar')}</span><div class="label">Not checked in</div><div class="value">${d.rows.length - present}</div><div class="hint">on ${fmtDate(team.date)}</div></div>
      <div class="card kpi k5"><span class="kpi-icon">${icon('pin')}</span><div class="label">Outside geofence</div><div class="value">${outside}</div><div class="hint">check-in or check-out</div></div>
    </div>
    <div class="card"><div class="card-head"><h3>Live location</h3><small>Last known position today · tap a name below for the route</small></div><div class="map" data-map></div></div>
    <div class="card"><div class="table-wrap">${d.rows.length ? `<table class="tbl tbl-compact"><thead><tr><th>Employee</th><th>Face</th><th>Check-in</th><th>Check-out</th><th class="num">Hours</th><th>Last location</th><th class="row-actions"></th></tr></thead><tbody>
      ${d.rows.map((r) => { const x = r.day || {}; return `<tr>
        <td><b>${esc(r.name)}</b><span class="sub">${esc(r.role)} · ${esc(r.code)}</span></td>
        <td>${r.enrolled ? '<span class="badge ok">Enrolled</span>' : '<span class="badge warn">Not enrolled</span>'}</td>
        <td>${x.in_time ? `${hm(x.in_time)} ${photo(x.in_photo, `${r.name} check-in`)}<span class="sub">${esc(x.in_client ? `${x.in_client} – ${x.in_loc_name}` : 'Office / remote')} ${geoBadge(x.in_geo, x.in_dist)}</span>` : '<span class="badge bad">Absent</span>'}</td>
        <td>${x.out_time ? `${hm(x.out_time)} ${photo(x.out_photo, `${r.name} check-out`)}<span class="sub">${esc(x.out_client ? `${x.out_client} – ${x.out_loc_name}` : 'Office / remote')} ${geoBadge(x.out_geo, x.out_dist)}</span>` : x.in_time ? '<span class="badge warn">Not yet</span>' : '—'}</td>
        <td class="num">${x.hours != null ? fmtNum(x.hours) : '—'}</td>
        <td>${r.pings ? `${hm(r.pings.last)}<span class="sub">${r.pings.n} location point(s)</span>` : '—'}</td>
        <td class="row-actions">${r.pings ? `<button class="btn btn-sm" data-route="${r.id}">${icon('pin')} Route</button>` : ''}
          ${r.enrolled ? `<button class="btn btn-sm btn-ghost" data-reset="${r.id}" title="Reset face enrolment">Reset face</button>` : ''}</td></tr>`; }).join('')}</tbody></table>`
      : '<div class="empty"><b>No field staff</b>Give a role the “Face attendance” permission (e.g. Implementation Engineer) and assign users to it.</div>'}</div></div>`;
  photoClicks(root);
  root.querySelector('[data-date]').addEventListener('change', (ev) => { team.date = ev.target.value || today(); renderTeamAttendance(root); });
  root.querySelector('[data-xl]').addEventListener('click', () => download(`/attendance/report${qs({ from: team.date.slice(0, 8) + '01', to: team.date, format: 'xlsx' })}`).catch((err) => toast(err.message, 'err')));
  root.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
    const r = d.rows.find((x) => x.id === +b.dataset.reset);
    if (!(await confirmDialog({ title: 'Reset face enrolment', message: `Reset the face enrolment of <b>${esc(r.name)}</b>? They must enrol again before their next check-in.`, confirmText: 'Reset', danger: true }))) return;
    try { await api(`/attendance/enrol/${r.id}`, { method: 'DELETE', body: {} }); toast('Enrolment reset.'); renderTeamAttendance(root); } catch (err) { toast(err.message, 'err'); }
  }));

  // Map
  try {
    loadCss('/vendor/leaflet/leaflet.css');
    await loadScript('/vendor/leaflet/leaflet.js');
  } catch { root.querySelector('[data-map]').innerHTML = '<div class="empty small">Map could not be loaded.</div>'; return; }
  const L = window.L;
  if (map) { map.remove(); map = null; }
  const el = root.querySelector('[data-map]');
  map = L.map(el, { scrollWheelZoom: false }).setView([17.385, 78.4867], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  const bounds = [];
  live.geofences.forEach((g) => {
    L.circle([g.lat, g.lng], { radius: g.radius_m || 300, color: '#12932f', weight: 1, fillOpacity: 0.08 }).addTo(map).bindTooltip(`${esc(g.client)} – ${esc(g.name)}`);
    bounds.push([g.lat, g.lng]);
  });
  live.people.forEach((p) => {
    const out = !!p.out_time;
    L.circleMarker([p.lat, p.lng], { radius: 9, color: '#fff', weight: 2, fillColor: out ? '#64748b' : p.geo === 'Outside' ? '#dc2626' : '#2c6a98', fillOpacity: 1 })
      .addTo(map).bindPopup(`<b>${esc(p.name)}</b><br>${esc(p.role || '')}<br>Last seen ${hm(p.ts)}${p.acc ? ` (±${Math.round(p.acc)} m)` : ''}<br>${out ? 'Checked out' : 'On duty'}`);
    bounds.push([p.lat, p.lng]);
  });
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  let trail = null;
  root.querySelectorAll('[data-route]').forEach((b) => b.addEventListener('click', async () => {
    const t = await api(`/attendance/live?date=${team.date}&user=${b.dataset.route}`);
    if (trail) trail.remove();
    const pts = t.trail.map((x) => [x.lat, x.lng]);
    if (!pts.length) return toast('No location points for this day.', 'err');
    trail = L.layerGroup([
      L.polyline(pts, { color: '#f59e0b', weight: 4 }),
      ...t.trail.map((x, i) => L.circleMarker([x.lat, x.lng], { radius: 4, color: '#b45309', fillOpacity: 1 }).bindTooltip(`${i + 1}. ${hm(x.ts)}`)),
    ]).addTo(map);
    map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
  return () => { if (map) { map.remove(); map = null; } };
}
