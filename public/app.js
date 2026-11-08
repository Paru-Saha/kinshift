import { Calendar, Scheduler, StringHelper } from '/bryntum/calendar.module.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => StringHelper.encodeHtml(String(s ?? ''));
const usd = (n) => `$${Math.round(Number(n || 0)).toLocaleString('en-US')}`;
const usd2 = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (n) => String(n).padStart(2, '0');
const toFloating = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const fromFloating = (s) => new Date(s);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let S = null;               // latest server state
let viewerId = store.get('ks.viewer', 'sib_anika');
let sessionId = null;
let calendar = null;
let scheduler = null;
let paypalRendered = false;
const flash = new Map();    // shiftId -> expiry ms

const STATUS = {
  open: { label: 'Needs cover', color: 'red', pill: 'bad' },
  scheduled: { label: 'Scheduled', pill: 'info' },
  awaiting_approval: { label: 'Finished · awaiting pay', color: 'orange', pill: 'warn' },
  paid: { label: 'Paid', color: 'gray', pill: 'good' },
  done: { label: 'Covered by family', color: 'gray', pill: 'good' },
  missed: { label: 'Missed', color: 'red', pill: 'bad' },
};
const SWATCH = { red: '#e53f2c', orange: '#fd8a2b', gray: '#9aa0a6', violet: '#8f5ff0', indigo: '#5b62e2', purple: '#b04ee0', blue: '#3c87f0', teal: '#21a99b', cyan: '#19b4d6', lime: '#7cc63e' };

// ---------- API ----------
async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error || `Request failed (${res.status})`); Object.assign(e, json); throw e; }
  return json;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6500 : 4000);
}

const person = (id) => S.siblings.find((p) => p.id === id) || S.caregivers.find((p) => p.id === id);
const isFamily = () => viewerId.startsWith('sib_');
const firstName = (id) => person(id)?.name.split(' ')[0] || 'Family';

// ---------- Load + render ----------
async function load() {
  S = await api('/api/state');
  renderHeader();
  renderAlert();
  renderCalendar();
  renderPool();
  renderFair();
  renderNotes();
  renderActivity();
  applyViewer();
}

function renderHeader() {
  $('#familyLine').textContent = `Caring for ${S.family.careRecipient} · ${S.family.name}`;
  const pb = $('#paypalBadge');
  pb.className = S.config.paypalLive ? 'on' : '';
  pb.textContent = S.config.paypalLive ? 'PayPal sandbox' : 'PayPal simulated';
  const ab = $('#aiBadge');
  ab.className = S.config.aiEnabled ? 'on' : '';
  ab.textContent = S.config.aiEnabled ? 'Kin online' : 'Kin offline';
  const sel = $('#viewer');
  if (!sel.options.length) {
    sel.innerHTML = `<optgroup label="Family">${S.siblings.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</optgroup>`
      + `<optgroup label="Caregivers">${S.caregivers.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</optgroup>`;
    if (!person(viewerId)) viewerId = 'sib_anika';
    sel.value = viewerId;
  }
  $('#viewerAvatar').textContent = (person(viewerId)?.name || '?')[0];
}

// One calm summary instead of a wall of numbers
function renderAlert() {
  const p = S.pool;
  const open = S.shifts.filter((x) => x.status === 'open').length;
  const open7 = p.next7Days.openShifts;
  const problems = [];
  if (p.shortfall > 0) problems.push(`the pool runs <b>${usd(p.shortfall)} short</b> this week`);
  if (open) problems.push(`<b>${open} shift${open > 1 ? 's' : ''}</b> ${open > 1 ? 'have' : 'has'} no one${open7 ? ` (${open7} this week)` : ''}`);
  const facts = `<div class="divider"></div><div class="facts">
      <div class="fact"><b>${usd(p.balance)}</b><span>in the pool</span></div>
      <div class="fact"><b>${usd(p.next7Days.scheduledCost)}</b><span>needed next 7 days</span></div>
    </div>`;
  const el = $('#alert');
  if (problems.length) {
    el.className = 'alert warn';
    el.innerHTML = `<div class="alert-icon"><i class="fa fa-triangle-exclamation"></i></div>
      <div class="alert-text"><div class="alert-title">Mom’s care needs attention</div>
        <div class="alert-sub">${problems.join(' and ').replace(/^./, (c) => c.toUpperCase())}.</div></div>
      ${facts}
      <button class="btn" data-family data-ask="Fill the open shifts in the next 7 days as cheaply as possible, then check if the pool covers the next 7 days. If it doesn't, propose fair PayPal top-ups."><i class="fa fa-wand-magic-sparkles"></i> Fix it with Kin</button>`;
  } else {
    el.className = 'alert ok';
    el.innerHTML = `<div class="alert-icon"><i class="fa fa-shield-heart"></i></div>
      <div class="alert-text"><div class="alert-title">Mom is covered</div>
        <div class="alert-sub">Every shift has someone and the pool can pay for the next 7 days.</div></div>${facts}`;
  }
}

// ---------- Calendar (Bryntum) ----------
function buildResources() {
  return [
    { id: 'open', name: 'Needs cover', eventColor: 'red' },
    ...S.caregivers.map((c) => ({ id: c.id, name: c.name, eventColor: c.color })),
    ...S.siblings.map((s) => ({ id: s.id, name: `${s.name} (family)`, eventColor: s.color })),
  ];
}

function buildEvents() {
  const now = Date.now();
  return S.shifts.map((sh) => {
    const st = STATUS[sh.status] || STATUS.scheduled;
    const p = sh.assigneeId ? person(sh.assigneeId) : null;
    const color = st.color || p?.color || 'blue';
    const editable = ['open', 'scheduled'].includes(sh.status) && fromFloating(sh.end).getTime() > now;
    const cls = [sh.status === 'open' ? 'ks-open' : '', (flash.get(sh.id) || 0) > now ? 'ks-flash' : ''].filter(Boolean).join(' ');
    return {
      id: sh.id,
      name: p ? p.name.split(' ')[0] : 'Needs cover',
      startDate: fromFloating(sh.start),
      endDate: fromFloating(sh.end),
      resourceId: sh.assigneeId || 'open',
      eventColor: color,
      cls,
      draggable: editable,
      resizable: false,
      status: sh.status,
      cost: sh.cost,
    };
  });
}

function eventRenderer({ eventRecord }) {
  const sh = S.shifts.find((x) => x.id === eventRecord.id);
  if (!sh) return esc(eventRecord.name);
  const st = STATUS[sh.status] || STATUS.scheduled;
  const sub = sh.status === 'open' ? (sh.note || 'Tap to assign') : sh.assigneeType === 'sibling' ? 'Family · in-kind' : `${st.label === 'Scheduled' ? usd(sh.cost) : st.label}`;
  const icon = { open: 'fa-circle-exclamation', awaiting_approval: 'fa-hourglass-half', paid: 'fa-circle-check', done: 'fa-heart' }[sh.status];
  return `<div class="ks-ev"><b>${icon ? `<i class="fa ${icon}"></i> ` : ''}${esc(eventRecord.name)}</b><small>${esc(sub)}</small></div>`;
}

function renderCalendar() {
  const resources = buildResources();
  const events = buildEvents();
  if (scheduler) {
    scheduler.resourceStore.data = resources;
    scheduler.eventStore.data = buildEvents();
  }
  if (calendar) {
    calendar.resourceStore.data = resources;
    calendar.eventStore.data = events;
    return;
  }
  const timeConfig = { dayStartTime: 7, dayEndTime: 21, hourHeight: 36, showAllDayHeader: false, visibleStartTime: null };
  // On weekends, open on the coming week — that's what the family is planning
  const start = new Date();
  if ([0, 6].includes(start.getDay())) start.setDate(start.getDate() + (start.getDay() === 0 ? 1 : 2));
  calendar = new Calendar({
    appendTo: 'calendar',
    date: start,
    mode: 'week',
    weekStartDay: 1,
    sidebar: false,
    autoCreate: false,
    resources,
    events,
    modeDefaults: { eventRenderer },
    modes: {
      day: { ...timeConfig },
      week: { ...timeConfig },
      month: true,
      year: null,
      agenda: { title: 'List' },
    },
    features: {
      eventEdit: false,
      eventMenu: false,
      scheduleMenu: false,
      drag: { creatable: false, resizable: false },
      eventTooltip: {
        renderer: ({ eventRecord }) => {
          const sh = S.shifts.find((x) => x.id === eventRecord.id);
          if (!sh) return '';
          return `<b>${esc(sh.assigneeName || 'Needs cover')}</b><br>${esc(sh.label)}<br>${esc((STATUS[sh.status] || {}).label || sh.status)}${sh.cost ? ` · ${usd2(sh.cost)}` : ''}${sh.note ? `<br><i>${esc(sh.note)}</i>` : ''}<br><small>Click for details · drag to move</small>`;
        },
      },
    },
    listeners: {
      eventClick: ({ eventRecord }) => openShift(eventRecord.id),
      dragMoveEnd: ({ eventRecord }) => onDragged(eventRecord),
    },
  });
}

// Team timeline: Bryntum Scheduler with one row per person, so gaps and workloads are obvious
function timelineStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function timelineEnd() { const d = timelineStart(); d.setDate(d.getDate() + 14); return d; }
function hoursAhead(resId) {
  const end = toFloating(timelineEnd());
  return S.shifts.filter((x) => (x.assigneeId || 'open') === resId && x.end > S.now && x.start < end).reduce((a, x) => a + x.hours, 0);
}

function renderTimeline() {
  if (scheduler) return;
  scheduler = new Scheduler({
    appendTo: 'timeline',
    startDate: timelineStart(),
    endDate: timelineEnd(),
    viewPreset: { base: 'dayAndWeek', tickWidth: 168 },
    timeAxis: { continuous: false, include: { hour: { from: 7, to: 21 } } },
    rowHeight: 56,
    barMargin: 8,
    eventStyle: 'rounded',
    zoomOnMouseWheel: false,
    columns: [{
      text: 'Who', field: 'name', width: 210,
      renderer: ({ record }) => {
        const p = person(record.id);
        const hrs = hoursAhead(record.id);
        const sub = record.id === 'open' ? `${S.shifts.filter((x) => x.status === 'open').length} shifts uncovered`
          : p?.rate ? `$${p.rate}/h · ${hrs}h booked · max ${p.maxHoursPerWeek}h/wk` : `Family · ${hrs}h booked`;
        return `<div class="ks-who"><b>${esc(record.name)}</b><small>${esc(sub)}</small></div>`;
      },
    }],
    resources: buildResources(),
    events: buildEvents(),
    features: {
      eventEdit: false, eventMenu: false, scheduleMenu: false, eventDragCreate: false,
      eventResize: false, eventTooltip: false, cellEdit: false,
    },
    eventRenderer: ({ eventRecord }) => {
      const sh = S.shifts.find((x) => x.id === eventRecord.id);
      const st = STATUS[sh?.status] || STATUS.scheduled;
      const what = sh?.status === 'scheduled' ? (sh.assigneeType === 'sibling' ? 'family' : usd(sh.cost)) : st.label;
      return `${sh?.start.slice(11, 13) < '12' ? 'AM' : 'PM'} · ${esc(what)}`;
    },
    listeners: {
      eventClick: ({ eventRecord }) => openShift(eventRecord.id),
      eventDrop: ({ eventRecords }) => onDragged(eventRecords[0]),
    },
  });
}

function setView(v) {
  $$('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('#calendar').hidden = v !== 'calendar';
  $('#timeline').hidden = v !== 'timeline';
  if (v === 'timeline') renderTimeline();
}

async function onDragged(rec) {
  const sh = S.shifts.find((x) => x.id === rec.id);
  if (!sh) return;
  const start = toFloating(rec.startDate);
  const end = toFloating(rec.endDate);
  const newRes = rec.resourceId;
  try {
    if (start !== sh.start || end !== sh.end) await api(`/api/shifts/${sh.id}`, { start, end }, 'PATCH');
    if (newRes && newRes !== (sh.assigneeId || 'open')) {
      if (newRes === 'open') await api(`/api/shifts/${sh.id}`, { unassign: true }, 'PATCH');
      else await api(`/api/shifts/${sh.id}`, { assigneeType: newRes.startsWith('cg_') ? 'caregiver' : 'sibling', assigneeId: newRes }, 'PATCH');
    }
    toast('Schedule updated', 'good');
  } catch (e) {
    toast(e.message, 'error');
  }
  await load();
}

// ---------- Shift details modal ----------
function openModal(html) {
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; }

function openShift(id) {
  const sh = S.shifts.find((x) => x.id === id);
  if (!sh) return;
  const st = STATUS[sh.status] || STATUS.scheduled;
  const note = S.careNotes.find((n) => n.shiftId === sh.id);
  const payout = sh.payoutId ? S.payouts.find((p) => p.id === sh.payoutId) : null;
  const mine = sh.assigneeId === viewerId;
  const canEdit = isFamily() && ['open', 'scheduled'].includes(sh.status);
  const startedToday = sh.start.slice(0, 10) <= S.now.slice(0, 10);

  const options = [...S.caregivers.map((c) => `<option value="caregiver:${c.id}" ${sh.assigneeId === c.id ? 'selected' : ''}>${esc(c.name)} · $${c.rate}/h</option>`),
    ...S.siblings.map((s) => `<option value="sibling:${s.id}" ${sh.assigneeId === s.id ? 'selected' : ''}>${esc(s.name)} (family, no cost)</option>`)].join('');

  openModal(`
    <h2>${esc(sh.assigneeName || 'Needs cover')}</h2>
    <span class="pill ${st.pill}">${esc(st.label)}</span>
    <dl class="kv">
      <dt>When</dt><dd>${esc(sh.label)}</dd>
      <dt>Hours</dt><dd>${sh.hours}h</dd>
      ${sh.assigneeType === 'caregiver' ? `<dt>Cost</dt><dd>${usd2(sh.cost)} <span class="muted">($${sh.rate}/h, paid from the pool)</span></dd>` : ''}
      ${sh.assigneeType === 'sibling' ? `<dt>Value</dt><dd>${sh.hours}h of family care · counts toward ${esc(firstName(sh.assigneeId))}’s fair share</dd>` : ''}
      ${sh.note ? `<dt>Note</dt><dd>${esc(sh.note)}</dd>` : ''}
      ${payout ? `<dt>PayPal payout</dt><dd>${usd2(payout.amount)} · <span class="pill ${payout.status === 'SUCCESS' ? 'good' : 'warn'}">${esc(payout.status)}</span><br><span class="muted small">Batch ${esc(payout.batchId)}</span></dd>` : ''}
    </dl>
    ${note ? `<div class="card"><b>Care note from ${esc(firstName(note.authorId))}</b>
      <div class="note"><div class="meta">${note.mood ? `<span class="pill">Mood: ${esc(note.mood)}</span>` : ''}${note.meals ? `<span class="pill">${esc(note.meals)}</span>` : ''}${note.meds ? `<span class="pill">Meds: ${esc(note.meds)}</span>` : ''}</div>${esc(note.text)}</div></div>` : ''}

    ${canEdit ? `<label>Who covers this shift?</label>
      <select id="assignSel" style="width:100%"><option value="">— Nobody yet —</option>${options}</select>
      <div class="actions">
        <button class="btn" id="saveAssign"><i class="fa fa-check"></i> Save</button>
        ${sh.status === 'open' ? `<button class="btn ghost" data-ask="Who can cover the ${esc(sh.label)} shift? Assign the best option.">Ask Kin to find someone</button>` : ''}
      </div>` : ''}

    ${sh.status === 'awaiting_approval' && isFamily() ? `<div class="actions">
      <button class="btn good" id="payShift"><i class="fa-brands fa-paypal"></i> Approve &amp; pay ${usd2(sh.cost)} with PayPal</button></div>
      <p class="muted small">Sends a PayPal payout from the family pool to ${esc(sh.assigneeName)}.</p>` : ''}

    ${mine && sh.assigneeType === 'caregiver' && sh.status === 'scheduled' && startedToday ? `
      <h3 class="mt">Finish shift</h3>
      <label>Mood</label><input class="text" id="nMood" placeholder="e.g. Cheerful, tired, a bit low">
      <label>Meals</label><input class="text" id="nMeals" placeholder="What did she eat?">
      <label>Medication</label><input class="text" id="nMeds" placeholder="Taken / missed / notes">
      <label>Anything the family should know</label><textarea id="nText" rows="3"></textarea>
      <div class="actions"><button class="btn" id="finishShift"><i class="fa fa-flag-checkered"></i> Finish shift &amp; send note</button></div>` : ''}
  `);

  $('#saveAssign')?.addEventListener('click', async () => {
    const v = $('#assignSel').value;
    try {
      if (!v) await api(`/api/shifts/${sh.id}`, { unassign: true }, 'PATCH');
      else {
        const [assigneeType, assigneeId] = v.split(':');
        await api(`/api/shifts/${sh.id}`, { assigneeType, assigneeId }, 'PATCH');
      }
      closeModal(); toast('Shift updated', 'good'); markFlash([sh.id]); await load();
    } catch (e) { toast(e.message, 'error'); }
  });
  $('#payShift')?.addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await api(`/api/shifts/${sh.id}/pay`, { approverId: viewerId });
      closeModal(); toast(`Paid ${sh.assigneeName} ${usd2(sh.cost)} via PayPal`, 'good'); await load();
    } catch (e) {
      ev.currentTarget.disabled = false;
      toast(e.message, 'error');
      if (e.code === 'POOL_SHORT') { closeModal(); sendChat('The pool is too low to pay the caregivers for finished shifts. Propose fair PayPal top-ups so we can pay them.'); }
    }
  });
  $('#finishShift')?.addEventListener('click', async () => {
    try {
      await api(`/api/shifts/${sh.id}/checkout`, { mood: $('#nMood').value, meals: $('#nMeals').value, meds: $('#nMeds').value, text: $('#nText').value });
      closeModal(); toast('Shift finished. The family has been asked to approve your pay.', 'good'); await load();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- Pool ----------
function approvalCard(a) {
  const done = a.status !== 'pending';
  return `<div class="approval ${a.status === 'approved' ? 'done' : a.status === 'rejected' ? 'rejected' : ''}" data-approval="${a.id}">
    <div class="what"><i class="fa ${a.type === 'invoice' ? 'fa-file-invoice-dollar' : 'fa-money-bill-transfer'}"></i> ${esc(a.summary)}</div>
    ${a.params?.reason ? `<div class="small muted">“${esc(a.params.reason)}”</div>` : ''}
    <div class="small muted">Suggested by ${a.requestedBy === 'agent' ? 'Kin' : 'family'}${done ? ` · ${esc(a.status)} by ${esc(a.approvedBy)}` : ''}</div>
    ${!done && isFamily() ? `<div class="actions">
      <button class="btn good small" data-approve="${a.id}"><i class="fa fa-check"></i> Approve</button>
      <button class="btn ghost small" data-reject="${a.id}">Decline</button></div>` : ''}
  </div>`;
}

function renderPool() {
  const pending = S.approvals.filter((a) => a.status === 'pending');
  const recent = S.approvals.filter((a) => a.status !== 'pending').slice(0, 4);
  $('#approvals').innerHTML = pending.length || recent.length ? [...pending, ...recent.slice(0, pending.length ? 2 : 4)].map(approvalCard).join('') : '<div class="empty"><i class="fa fa-circle-check"></i>Nothing waiting for you.<br>When Kin prepares a payment, it shows up here.</div>';

  // Pool card
  const p = S.pool;
  const need = p.awaitingApproval.cost + p.next7Days.scheduledCost;
  $('#poolBalance').textContent = usd(p.balance);
  const pct = need ? Math.min(100, Math.round((p.balance / need) * 100)) : 100;
  $('#poolMeter').style.width = `${pct}%`;
  $('#poolMeter').parentElement.classList.toggle('short', p.shortfall > 0);
  $('#poolLine').innerHTML = p.shortfall > 0
    ? `Covers <b>${pct}%</b> of the next 7 days (${usd(need)} incl. finished shifts). Short by <b>${usd(p.shortfall)}</b>.`
    : `Enough for the next 7 days, with ${usd(p.projectedAfter7Days)} to spare.`;
  const cnt = $('#approvalCount');
  cnt.hidden = !pending.length;
  cnt.textContent = pending.length;

  const sibOpts = S.siblings.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  for (const id of ['#payFrom', '#reqSibling']) {
    const el = $(id);
    const keep = el.value;
    el.innerHTML = sibOpts;
    el.value = keep || (isFamily() ? viewerId : 'sib_anika');
  }

  // One feed for all PayPal money movement, newest first
  const paidStates = ['PAID', 'MARKED_AS_PAID'];
  const day = (d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const feed = [
    ...S.contributions.map((c) => ({ at: c.at, html: `<span class="ico in"><i class="fa fa-arrow-down"></i></span>
      <div class="grow"><div class="who">${esc(firstName(c.siblingId))} added money</div>
        <div class="sub">${day(c.at)} · ${{ paypal_invoice: 'PayPal invoice', paypal_link: 'PayPal payment link' }[c.method] || 'PayPal checkout'}</div></div>
      <div class="amount in">+${usd2(c.amount)}</div>` })),
    ...S.payouts.map((p) => ({ at: p.createdAt, html: `<span class="ico out"><i class="fa fa-arrow-up"></i></span>
      <div class="grow"><div class="who">Paid ${esc(person(p.caregiverId)?.name)}</div>
        <div class="sub">${day(p.createdAt)} · PayPal Payouts · ${p.shiftIds.length} shift${p.shiftIds.length > 1 ? 's' : ''}</div></div>
      <div><div class="amount">−${usd2(p.amount)}</div><span class="pill ${p.status === 'SUCCESS' ? 'good' : ['FAILED', 'RETURNED', 'BLOCKED', 'DENIED'].includes(p.status) ? 'bad' : 'warn'}">${esc(p.status.toLowerCase())}</span></div>` })),
    ...S.invoices.filter((i) => !paidStates.includes(i.status)).map((i) => ({ at: i.createdAt, html: `<span class="ico req"><i class="fa fa-hourglass-half"></i></span>
      <div class="grow"><div class="who">Asked ${esc(firstName(i.siblingId))} to pay</div>
        <div class="sub">${day(i.createdAt)} · ${i.payUrl ? `<a href="${esc(i.payUrl)}" target="_blank" rel="noopener">Open PayPal ${i.kind === 'payment_link' ? 'link' : 'invoice'}</a> · ` : ''}<button class="btn link small" data-markpaid="${i.id}">Mark paid</button></div></div>
      <div><div class="amount">${usd2(i.amount)}</div><span class="pill warn">waiting</span></div>` })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 8);
  $('#moneyFeed').innerHTML = `<div class="list">${feed.map((f) => `<div class="row">${f.html}</div>`).join('')}</div>`;

  renderPayPal();
}

async function renderPayPal() {
  if (paypalRendered) return;
  paypalRendered = true;
  const host = $('#paypalButtons');
  const amount = () => Number($('#payAmount').value);
  const from = () => $('#payFrom').value;
  const done = async (r) => { toast(`${firstName(from())} added ${usd2(r.contribution.amount)} to the pool`, 'good'); await load(); };

  if (!S.config.paypalLive) {
    host.innerHTML = `<button class="btn" id="simPay"><i class="fa-brands fa-paypal"></i> Pay with PayPal (simulated)</button>
      <p class="muted small">Add PayPal sandbox keys to <code>.env</code> to use real PayPal Checkout here.</p>`;
    $('#simPay').addEventListener('click', async () => {
      try {
        const o = await api('/api/paypal/orders', { siblingId: from(), amount: amount() });
        await done(await api(`/api/paypal/orders/${o.id}/capture`, {}));
      } catch (e) { toast(e.message, 'error'); }
    });
    return;
  }
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(S.config.paypalClientId)}&currency=USD&intent=capture&components=buttons`;
    s.onload = resolve; s.onerror = reject;
    document.head.append(s);
  }).catch(() => { host.innerHTML = '<div class="empty">Could not load PayPal. Check your connection.</div>'; });
  if (!window.paypal) return;
  window.paypal.Buttons({
    style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', height: 42 },
    createOrder: async () => (await api('/api/paypal/orders', { siblingId: from(), amount: amount() })).id,
    onApprove: async (data) => {
      try { await done(await api(`/api/paypal/orders/${data.orderID}/capture`, {})); } catch (e) { toast(e.message, 'error'); }
    },
    onError: (err) => toast(`PayPal: ${err?.message || err}`, 'error'),
  }).render('#paypalButtons');
}

// ---------- Fair share ----------
function renderFair() {
  const f = S.fairShare;
  const inKindHours = f.siblings.reduce((a, r) => a + r.inKindHours, 0);
  $('#fairIntro').innerHTML = `Hands-on care counts like money: each hour a sibling spends with Mom is worth $${f.inKindRate}. So far ${inKindHours} family hours (${usd(f.inKindValue)}) plus ${usd(f.paidCare)} paid to caregivers.`;
  const max = Math.max(1, ...f.siblings.map((r) => Math.abs(r.net)));
  $('#fairTable').innerHTML = `<div class="fair-scroll"><table class="fair"><thead><tr>
    <th>Sibling</th><th>Share</th><th>Money</th><th>Time given</th><th>Ahead / behind</th></tr></thead><tbody>
    ${f.siblings.map((r) => {
      const w = (Math.abs(r.net) / max) * 50;
      const color = r.net >= 0 ? 'var(--good)' : 'var(--bad)';
      return `<tr><td><div class="name"><span class="avatar">${esc(r.name[0])}</span><div><b>${esc(r.name)}</b><div class="muted small">${esc(person(r.siblingId)?.about || '')}</div></div></div></td>
      <td>${Math.round(r.weight * 100)}%</td><td>${usd(r.contributed)}</td>
      <td>${r.inKindHours ? `${r.inKindHours}h` : '—'}</td>
      <td><div class="balance-bar"><span class="amount" style="color:${color}">${r.net >= 0 ? '+' : '−'}${usd(Math.abs(r.net))}</span>
        <span class="track"><span class="mid"></span><span class="fill" style="background:${color};${r.net >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`}"></span></span></div></td></tr>`;
    }).join('')}</tbody></table></div>`;
}

// ---------- Notes + activity ----------
function renderNotes() {
  $('#notes').innerHTML = S.careNotes.length ? S.careNotes.slice(0, 8).map((n) => `
    <div class="note"><div><b>${esc(person(n.authorId)?.name)}</b> <span class="muted small">· ${new Date(n.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span></div>
      <div class="meta">${n.mood ? `<span class="pill">Mood: ${esc(n.mood)}</span>` : ''}${n.meals ? `<span class="pill">${esc(n.meals)}</span>` : ''}${n.meds ? `<span class="pill">Meds: ${esc(n.meds)}</span>` : ''}</div>
      <div>${esc(n.text)}</div></div>`).join('') : '<div class="empty">No notes yet.</div>';
}

function renderActivity() {
  const icon = { shift: 'fa-calendar', payout: 'fa-money-bill-transfer', invoice: 'fa-file-invoice-dollar', contribution: 'fa-hand-holding-dollar', approval: 'fa-stamp', note: 'fa-notes-medical', timeoff: 'fa-user-slash', webhook: 'fa-plug', info: 'fa-circle-info' };
  $('#activity').innerHTML = `<div class="list activity">${S.activity.map((a) => `
    <div class="row"><span class="dot"><i class="fa ${icon[a.kind] || 'fa-circle'}"></i></span>
      <div><div>${esc(a.text)}</div><div class="sub">${new Date(a.at.length > 19 ? a.at : a.at).toLocaleString()}</div></div></div>`).join('')}</div>`;
}

function applyViewer() {
  const fam = isFamily();
  $$('[data-family]').forEach((el) => { el.hidden = !fam; });
  const active = $('.tabs button.active');
  if (!fam && active?.hasAttribute('data-family')) switchTab('schedule');
  renderChips();
}

function switchTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
}

// ---------- Kin chat ----------
const STEP_LABEL = {
  get_overview: 'Checked the pool', list_people: 'Looked at who can help', list_shifts: 'Read the schedule',
  find_coverage_gaps: 'Found open shifts', assign_shifts: 'Assigned shifts', unassign_shift: 'Removed someone from a shift',
  mark_unavailable: 'Recorded time off', create_shift: 'Added a shift', get_fair_share: 'Checked fair share',
  request_contribution: 'Drafted a PayPal request', queue_caregiver_payouts: 'Prepared PayPal payouts', get_care_notes: 'Read care notes',
};

function md(text) {
  const lines = esc(text).split('\n');
  let html = ''; let inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const li = line.match(/^\s*[-•*]\s+(.*)/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${li[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (line.trim()) html += `<p>${line.replace(/^#+\s*/, '')}</p>`;
  }
  return html + (inList ? '</ul>' : '');
}

function addMsg(role, html) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = html;
  $('#chatLog').append(el);
  $('#chatLog').scrollTop = 1e9;
  return el;
}

function renderChips() {
  const chips = isFamily() ? [
    ['fa-head-side-cough', 'Maria is sick Thu & Fri', 'Maria is sick Thursday and Friday. Sort out the schedule.'],
    ['fa-piggy-bank', 'Will the pool last?', 'Will the pool cover the next 7 days? If not, ask for fair top-ups.'],
    ['fa-hand-holding-dollar', 'Pay caregivers', 'Pay the caregivers for the shifts they’ve finished.'],
    ['fa-heart', 'How is Mom?', 'How has Mom been this week?'],
  ] : [];
  $('#chips').innerHTML = chips.map(([icon, label, prompt]) => `<button class="chip" data-ask="${esc(prompt)}"><i class="fa ${icon}"></i> ${esc(label)}</button>`).join('');
  $('#chatForm').hidden = !isFamily();
  if (!isFamily() && !$('#chatLog').dataset.cg) {
    $('#chatLog').dataset.cg = '1';
    addMsg('kin', md(`Hi ${firstName(viewerId)}! Kin works for the family. To finish a shift and leave a care note, click your shift on the calendar.`));
  }
}

function markFlash(ids) {
  const until = Date.now() + 6000;
  ids.forEach((id) => flash.set(id, until));
  setTimeout(() => {
    if (calendar) calendar.eventStore.data = buildEvents();
    if (scheduler) scheduler.eventStore.data = buildEvents();
  }, 6200);
}

let chatBusy = false;
async function sendChat(text) {
  if (chatBusy || !text.trim()) return;
  if (!isFamily()) { toast('Switch “Viewing as” to a family member to talk to Kin.'); return; }
  chatBusy = true;
  $('#chat').classList.add('open');
  addMsg('user', esc(text));
  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.innerHTML = '<span class="dots"><span></span><span></span><span></span></span> Kin is working on it…';
  $('#chatLog').append(typing);
  $('#chatLog').scrollTop = 1e9;
  try {
    const r = await api('/api/agent', { sessionId, message: text, viewerId });
    sessionId = r.sessionId;
    typing.remove();
    if (r.steps?.length) {
      const counts = {};
      r.steps.forEach((s) => { const l = STEP_LABEL[s.tool] || s.tool; counts[l] = (counts[l] || 0) + 1; });
      const el = document.createElement('div');
      el.className = 'steps';
      el.innerHTML = Object.entries(counts).map(([l, n]) => `<span class="pill"><i class="fa fa-check"></i> ${esc(l)}${n > 1 ? ` ×${n}` : ''}</span>`).join('');
      $('#chatLog').append(el);
    }
    addMsg('kin', md(r.reply));
    for (const a of r.approvals || []) addMsg('kin', approvalCard(a)).classList.add('as-card');
    if (r.touched?.length) {
      markFlash(r.touched);
      const first = S.shifts.find((x) => r.touched.includes(x.id));
      if (first && calendar) calendar.date = fromFloating(first.start);
    }
    await load();
  } catch (e) {
    typing.remove();
    addMsg('kin', md(`Sorry, something went wrong: ${e.message}`));
  } finally {
    chatBusy = false;
    $('#chatLog').scrollTop = 1e9;
  }
}

async function decideApproval(id, approve, btn) {
  if (btn) btn.disabled = true;
  try {
    const a = await api(`/api/approvals/${id}/${approve ? 'approve' : 'reject'}`, { approverId: viewerId });
    $$(`[data-approval="${id}"]`).forEach((el) => { el.outerHTML = approvalCard(a); });
    toast(approve ? (a.type === 'invoice' ? 'PayPal invoice sent' : 'Caregivers paid via PayPal') : 'Declined', approve ? 'good' : '');
    await load();
  } catch (e) {
    if (btn) btn.disabled = false;
    toast(e.message, 'error');
    if (e.code === 'POOL_SHORT') sendChat('The pool is too low to pay the caregivers. Propose fair PayPal top-ups so we can pay them.');
  }
}

// ---------- Wiring ----------
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button, [data-close], .modal-backdrop');
  if (!t) return;
  if (t.dataset.ask) { closeModal(); sendChat(t.dataset.ask); return; }
  if (t.dataset.tab) { switchTab(t.dataset.tab); return; }
  if (t.dataset.view) { setView(t.dataset.view); return; }
  if (t.dataset.approve) { decideApproval(t.dataset.approve, true, t); return; }
  if (t.dataset.reject) { decideApproval(t.dataset.reject, false, t); return; }
  if (t.hasAttribute('data-close') || (t.id === 'modal' && ev.target === t)) { closeModal(); return; }
  if (t.dataset.markpaid) {
    try { await api(`/api/invoices/${t.dataset.markpaid}/mark-paid`, {}); toast('Recorded as paid', 'good'); await load(); } catch (e) { toast(e.message, 'error'); }
    return;
  }
  if (t.id === 'resetDemo') {
    if (!confirm('Reset all demo data (shifts, payments, notes) to the starting state?')) return;
    await api('/api/reset', {});
    sessionId = null;
    $('#chatLog').innerHTML = '';
    toast('Demo data reset', 'good');
    await load();
    return;
  }
  if (t.id === 'syncBtn') {
    t.disabled = true;
    try { const r = await api('/api/sync', {}); toast(r.changes.length ? r.changes.join(', ') : 'Everything is up to date'); await load(); } catch (e) { toast(e.message, 'error'); }
    t.disabled = false;
  }
});

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#chatText').value;
  $('#chatText').value = '';
  sendChat(v);
});
$('#chatText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); }
});
$('#viewer').addEventListener('change', (e) => {
  viewerId = e.target.value;
  store.set('ks.viewer', viewerId);
  delete $('#chatLog').dataset.cg;
  $('#viewerAvatar').textContent = (person(viewerId)?.name || '?')[0];
  renderPool();
  applyViewer();
});
$('#chatText').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`;
});
$('#openChat').addEventListener('click', () => $('#chat').classList.add('open'));
$('#closeChat').addEventListener('click', () => $('#chat').classList.remove('open'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

$('#sendRequest').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    await api('/api/requests', { siblingId: $('#reqSibling').value, amount: Number($('#reqAmount').value), reason: $('#reqReason').value, approverId: viewerId });
    toast('PayPal invoice sent', 'good');
    $('#reqReason').value = '';
    await load();
  } catch (e) { toast(e.message, 'error'); }
  btn.disabled = false;
});

$('#summarize').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  $('#summary').classList.add('muted');
  $('#summary').textContent = 'Reading this week’s notes…';
  try {
    const r = await api('/api/care-summary', {});
    $('#summary').classList.remove('muted');
    $('#summary').innerHTML = md(r.text);
  } catch (e) { $('#summary').textContent = e.message; }
  btn.disabled = false;
});

addMsg('kin', md('Hi! I’m **Kin**. I keep Mom’s care schedule covered and the family pool fair.\n\nTell me when plans change (“Maria is sick Friday”) and I’ll fix the calendar. When money needs to move, I’ll prepare it with PayPal and ask you to approve.'));

load().catch((e) => toast(`Could not load: ${e.message}`, 'error'));
{
  // Coming back from a PayPal payment link
  const q = new URLSearchParams(location.search);
  if (q.get('paid') && q.get('paid') !== 'unknown') toast(`${q.get('paid')} paid ${usd2(q.get('amount'))} into the care pool via PayPal`, 'good');
  if (q.get('payfailed')) toast(`PayPal payment failed: ${q.get('payfailed')}`, 'error');
  if (q.get('cancelled')) toast('PayPal payment was cancelled');
  if ([...q.keys()].length) history.replaceState(null, '', '/');
}
setInterval(() => { if (!chatBusy && $('#modal').hidden) load().catch(() => {}); }, 30_000);
