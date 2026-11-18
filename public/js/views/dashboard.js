import { api, esc, fmtNum, fmtDate, fmtMonth, fmtDateTime, qs, multiSelect, loadLookups, attachTips, icon, can } from '../core.js';

const filters = { fromDate: '', toDate: '', clientIds: [] };

export async function renderDashboard(root) {
  const lookups = await loadLookups();
  root.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>Approved effort across clients, months and departments.</p></div>
      <form class="actions" data-f novalidate>
        <div style="width:220px" data-clients></div>
        <label class="sr-only" for="d-from">From date</label><input id="d-from" class="input" type="date" name="fromDate" value="${esc(filters.fromDate)}" style="width:160px" title="From date">
        <label class="sr-only" for="d-to">To date</label><input id="d-to" class="input" type="date" name="toDate" value="${esc(filters.toDate)}" style="width:160px" title="To date">
        <button class="btn btn-primary" type="submit">Apply</button>
        <button class="btn" type="button" data-reset>Reset</button>
      </form>
    </div>
    <div data-body><div class="empty">Loading…</div></div>`;

  const clientSel = multiSelect(root.querySelector('[data-clients]'), {
    options: lookups.clients.map((c) => ({ value: c.id, label: c.name })),
    selected: filters.clientIds,
    placeholder: 'All clients',
  });
  const form = root.querySelector('[data-f]');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    filters.fromDate = form.fromDate.value;
    filters.toDate = form.toDate.value;
    filters.clientIds = clientSel.value;
    load();
  });
  root.querySelector('[data-reset]').addEventListener('click', () => {
    form.fromDate.value = '';
    form.toDate.value = '';
    clientSel.set([]);
    Object.assign(filters, { fromDate: '', toDate: '', clientIds: [] });
    load();
  });

  async function load() {
    const body = root.querySelector('[data-body]');
    let d;
    try {
      d = await api('/dashboard' + qs(filters));
    } catch (err) {
      body.innerHTML = `<div class="alert err">${esc(err.message)}</div>`;
      return;
    }
    const t = d.totals;
    body.innerHTML = `
      <div class="grid kpis">
        <div class="card kpi k1"><span class="kpi-icon">${icon('ticket')}</span><div class="label">Total Approved Tickets</div><div class="value">${fmtNum(t.tickets)}</div><div class="hint">across ${fmtNum(t.clients)} client(s)</div></div>
        <div class="card kpi k2"><span class="kpi-icon">${icon('layers')}</span><div class="label">Total Approved Man-Days</div><div class="value">${fmtNum(t.man_days)}</div><div class="hint">avg ${t.tickets ? fmtNum(t.man_days / t.tickets) : 0} per ticket</div></div>
        <div class="card kpi k3"><span class="kpi-icon">${icon('calendar')}</span><div class="label">This Month · Tickets</div><div class="value">${fmtNum(t.month_tickets)}</div><div class="hint">approved this calendar month</div></div>
        <div class="card kpi k4"><span class="kpi-icon">${icon('trend')}</span><div class="label">This Month · Man-Days</div><div class="value">${fmtNum(t.month_man_days)}</div><div class="hint">approved this calendar month</div></div>
      </div>
      <div class="grid two-col">
        ${chartCard('client', 'Client-Wise Approved Man-Days', 'Man-days', d.byClient.slice(0, 10), 'man_days', 'h')}
        ${chartCard('month', 'Month-Wise Approved Man-Days', 'Man-days', d.byMonth.map((r) => ({ ...r, label: fmtMonth(r.label) })), 'man_days', 'v')}
      </div>
      <div class="grid two-col">
        ${chartCard('dept', 'Department-Wise Ticket Count', 'Tickets', d.byDepartment, 'tickets', 'h')}
        ${chartCard('type', 'Ticket Type-Wise Approved Man-Days', 'Man-days', d.byType, 'man_days', 'h')}
      </div>
      <div class="card">
        <div class="card-head"><h3>Recent Approvals</h3>${can('approval.view') ? '<a href="#/approvals" class="btn btn-sm">View all</a>' : ''}</div>
        ${d.recent.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Ticket Number</th><th>Client Name</th><th class="num">Man-Days</th><th>Approved By</th><th>Approved Date</th><th>Last Activity</th></tr></thead><tbody>
          ${d.recent.map((r) => `<tr><td class="ticket">${esc(r.ticket_number)}</td><td>${esc(r.client_name)}</td><td class="num"><span class="md-pill">${fmtNum(r.approved_man_days)}</span></td><td>${esc(r.approved_by)}</td><td>${fmtDate(r.approved_date)}</td>
            <td>${fmtDateTime(r.updated_at || r.created_at)} · ${esc(r.updated_by_name || r.created_by_name)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No approvals yet.</div>'}
      </div>`;

    body.querySelectorAll('[data-toggle]').forEach((b) =>
      b.addEventListener('click', () => {
        const card = b.closest('.card');
        card.querySelectorAll('[data-toggle]').forEach((x) => x.classList.toggle('on', x === b));
        card.querySelector('[data-chart]').hidden = b.dataset.toggle !== 'chart';
        card.querySelector('[data-tablev]').hidden = b.dataset.toggle !== 'table';
      })
    );
    attachTips(body);
  }

  await load();
}

function chartCard(id, title, unit, rows, key, kind) {
  const max = Math.max(1, ...rows.map((r) => r[key] || 0));
  const tip = (r) => `<b>${esc(r.label)}</b>${fmtNum(r.man_days)} man-days · ${fmtNum(r.tickets)} ticket(s)`;
  let chart;
  if (!rows.length) chart = '<div class="chart-empty">No data for the selected filters.</div>';
  else if (kind === 'h') {
    chart = `<div class="hbars">${rows.map((r) => `
      <div class="hbar" data-tip="${esc(tip(r))}">
        <span class="lbl" title="${esc(r.label)}">${esc(r.label)}</span>
        <span class="track"><span class="fill" style="display:block;width:${((r[key] || 0) / max) * 100}%"></span></span>
        <span class="val">${fmtNum(r[key])}</span>
      </div>`).join('')}</div>`;
  } else {
    chart = `<div class="vbars">${rows.map((r) => `
      <div class="vbar" data-tip="${esc(tip(r))}"><span class="top">${fmtNum(r[key])}</span><span class="fill" style="height:${((r[key] || 0) / max) * 85}%"></span></div>`).join('')}</div>
      <div class="vlabels">${rows.map((r) => `<span>${esc(r.label)}</span>`).join('')}</div>`;
  }
  return `
    <div class="card">
      <div class="card-head"><div><h3>${esc(title)}</h3><small>${esc(unit)}</small></div>
        <div class="chart-toggle" role="group" aria-label="View as"><button class="on" data-toggle="chart">Chart</button><button data-toggle="table">Table</button></div></div>
      <div class="card-body">
        <div data-chart>${chart}</div>
        <div data-tablev hidden>
          <table class="tbl"><thead><tr><th>${id === 'month' ? 'Month' : id === 'dept' ? 'Department' : id === 'type' ? 'Ticket Type' : 'Client'}</th><th class="num">Tickets</th><th class="num">Man-Days</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${fmtNum(r.tickets)}</td><td class="num">${fmtNum(r.man_days)}</td></tr>`).join('') || '<tr><td colspan="3" class="chart-empty">No data</td></tr>'}</tbody></table>
        </div>
      </div>
    </div>`;
}
