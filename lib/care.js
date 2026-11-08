// Domain logic: shifts, coverage, the shared pool and each sibling's fair share.
import { db, newId, log } from './store.js';
import { nowLocal, today, addDays, dayOfWeek, mondayOf, hoursBetween, overlaps, describe, DAY_NAMES } from './time.js';

const r2 = (n) => Math.round(n * 100) / 100;

export function person(id) {
  const s = db();
  return s.siblings.find((p) => p.id === id) || s.caregivers.find((p) => p.id === id) || null;
}

export function shiftView(sh) {
  const p = sh.assigneeId ? person(sh.assigneeId) : null;
  const hours = hoursBetween(sh.start, sh.end);
  return {
    ...sh,
    hours,
    assigneeName: p ? p.name : null,
    cost: sh.assigneeType === 'caregiver' ? r2(hours * (sh.rate ?? p?.rate ?? 0)) : 0,
    label: describe(sh.start, sh.end),
  };
}

// Move shifts along as time passes: finished caregiver shifts wait for family approval,
// finished sibling shifts count as in-kind care, and uncovered past shifts are marked missed.
export function refreshStatuses() {
  const s = db();
  const now = nowLocal();
  let changed = false;
  for (const sh of s.shifts) {
    if (sh.end > now) continue;
    if (sh.status === 'scheduled') {
      sh.status = sh.assigneeType === 'caregiver' ? 'awaiting_approval' : 'done';
      changed = true;
    } else if (sh.status === 'open') {
      sh.status = 'missed';
      changed = true;
    }
  }
  return changed;
}

function windowsFor(p) {
  return p.availability || p.canCover || [];
}

function withinWindows(p, start, end) {
  const dow = dayOfWeek(start);
  const from = start.slice(11, 16);
  const to = end.slice(11, 16);
  if (start.slice(0, 10) !== end.slice(0, 10) && to !== '00:00') return false;
  return windowsFor(p).some((w) => w.days.includes(dow) && w.from <= from && (to <= w.to || (to === '00:00' && w.to === '24:00')));
}

function onTimeOff(personId, start, end) {
  return db().timeOff.find((o) => o.personId === personId && overlaps(start, end, o.from, o.to)) || null;
}

function busy(personId, start, end, excludeId) {
  return db().shifts.find((x) => x.id !== excludeId && x.assigneeId === personId && x.status !== 'open' && overlaps(start, end, x.start, x.end)) || null;
}

export function caregiverWeekHours(cgId, dateStr, excludeId) {
  const mon = mondayOf(dateStr);
  const sun = addDays(mon, 7);
  return db().shifts
    .filter((x) => x.id !== excludeId && x.assigneeId === cgId && x.start >= mon && x.start < sun)
    .reduce((sum, x) => sum + hoursBetween(x.start, x.end), 0);
}

export function checkAssign(sh, assigneeType, assigneeId) {
  const p = person(assigneeId);
  if (!p) return { ok: false, reason: `Unknown person ${assigneeId}` };
  const isCg = assigneeId.startsWith('cg_');
  if ((assigneeType === 'caregiver') !== isCg) return { ok: false, reason: `${p.name} is not a ${assigneeType}` };
  if (['paid', 'awaiting_approval', 'done', 'missed'].includes(sh.status)) return { ok: false, reason: `Shift ${sh.id} is already ${sh.status}` };
  if (sh.end <= nowLocal()) return { ok: false, reason: 'Shift is in the past' };
  if (!withinWindows(p, sh.start, sh.end)) {
    return { ok: false, reason: `${p.name} is not available ${DAY_NAMES[dayOfWeek(sh.start)]}s ${sh.start.slice(11, 16)}–${sh.end.slice(11, 16)}` };
  }
  const off = onTimeOff(assigneeId, sh.start, sh.end);
  if (off) return { ok: false, reason: `${p.name} is unavailable then (${off.reason})` };
  const clash = busy(assigneeId, sh.start, sh.end, sh.id);
  if (clash) return { ok: false, reason: `${p.name} already has shift ${clash.id} at that time` };
  if (isCg) {
    const hrs = caregiverWeekHours(assigneeId, sh.start, sh.id) + hoursBetween(sh.start, sh.end);
    if (hrs > p.maxHoursPerWeek) return { ok: false, reason: `${p.name} would work ${hrs}h that week (max ${p.maxHoursPerWeek}h)` };
  }
  return { ok: true };
}

export function assignShift(shiftId, assigneeType, assigneeId, actor = 'family') {
  const s = db();
  const sh = s.shifts.find((x) => x.id === shiftId);
  if (!sh) return { ok: false, reason: `No shift ${shiftId}` };
  const check = checkAssign(sh, assigneeType, assigneeId);
  if (!check.ok) return check;
  const p = person(assigneeId);
  const prev = sh.assigneeId ? person(sh.assigneeId)?.name : null;
  sh.assigneeType = assigneeType;
  sh.assigneeId = assigneeId;
  sh.rate = p.rate ?? null;
  sh.status = 'scheduled';
  sh.updatedBy = actor;
  sh.updatedAt = new Date().toISOString();
  log('shift', `${actor === 'agent' ? 'Kin' : 'Family'} assigned ${p.name} to ${describe(sh.start, sh.end)}${prev && prev !== p.name ? ` (was ${prev})` : ''}`, { shiftId });
  return { ok: true, shift: shiftView(sh) };
}

export function unassignShift(shiftId, reason, actor = 'family') {
  const s = db();
  const sh = s.shifts.find((x) => x.id === shiftId);
  if (!sh) return { ok: false, reason: `No shift ${shiftId}` };
  if (sh.status !== 'scheduled') return { ok: false, reason: `Shift is ${sh.status}, cannot unassign` };
  const prev = person(sh.assigneeId)?.name;
  Object.assign(sh, { assigneeType: null, assigneeId: null, rate: null, status: 'open', updatedBy: actor, updatedAt: new Date().toISOString() });
  log('shift', `${prev} removed from ${describe(sh.start, sh.end)}${reason ? ` — ${reason}` : ''}`, { shiftId });
  return { ok: true, shift: shiftView(sh) };
}

export function moveShift(shiftId, start, end, actor = 'family') {
  const s = db();
  const sh = s.shifts.find((x) => x.id === shiftId);
  if (!sh) return { ok: false, reason: `No shift ${shiftId}` };
  if (!['open', 'scheduled'].includes(sh.status)) return { ok: false, reason: `Shift is ${sh.status}` };
  const old = { start: sh.start, end: sh.end };
  sh.start = start;
  sh.end = end;
  if (sh.assigneeId) {
    const check = checkAssign(sh, sh.assigneeType, sh.assigneeId);
    if (!check.ok) { Object.assign(sh, old); return check; }
  }
  log('shift', `Shift moved to ${describe(start, end)}`, { shiftId });
  return { ok: true, shift: shiftView(sh) };
}

export function createShift({ date, from, to, note }, actor = 'family') {
  const s = db();
  const start = `${date}T${from}:00`;
  const end = to === '24:00' ? `${addDays(date, 1)}T00:00:00` : `${date}T${to}:00`;
  if (end <= start) return { ok: false, reason: 'End must be after start' };
  const sh = { id: newId('sh'), start, end, assigneeType: null, assigneeId: null, status: 'open', rate: null, note: note || '', createdBy: actor };
  s.shifts.push(sh);
  log('shift', `${actor === 'agent' ? 'Kin' : 'Family'} added a shift: ${describe(start, end)}${note ? ` (${note})` : ''}`, { shiftId: sh.id });
  return { ok: true, shift: shiftView(sh) };
}

export function markUnavailable({ personId, fromDate, toDate, reason }, actor = 'family') {
  const s = db();
  const p = person(personId);
  if (!p) return { ok: false, reason: `Unknown person ${personId}` };
  const from = `${fromDate}T00:00:00`;
  const to = `${addDays(toDate, 1)}T00:00:00`;
  s.timeOff.push({ id: newId('off'), personType: personId.startsWith('cg_') ? 'caregiver' : 'sibling', personId, from, to, reason: reason || 'Unavailable' });
  const affected = [];
  for (const sh of s.shifts) {
    if (sh.assigneeId === personId && sh.status === 'scheduled' && overlaps(sh.start, sh.end, from, to)) {
      unassignShift(sh.id, `${p.name}: ${reason || 'unavailable'}`, actor);
      affected.push(shiftView(sh));
    }
  }
  log('timeoff', `${p.name} unavailable ${fromDate}${toDate !== fromDate ? ` to ${toDate}` : ''} (${reason || 'no reason given'})`);
  return { ok: true, person: p.name, nowOpen: affected };
}

export function listShifts(fromDate, toDate) {
  const from = `${fromDate}T00:00:00`;
  const to = `${addDays(toDate, 1)}T00:00:00`;
  return db().shifts.filter((x) => x.start < to && x.end > from).sort((a, b) => a.start.localeCompare(b.start)).map(shiftView);
}

export function coverageGaps(fromDate, toDate) {
  const s = db();
  const now = nowLocal();
  return listShifts(fromDate, toDate)
    .filter((x) => x.status === 'open' && x.end > now)
    .map((sh) => {
      const candidates = [];
      for (const cg of s.caregivers) {
        const c = checkAssign(sh, 'caregiver', cg.id);
        const weekHrs = caregiverWeekHours(cg.id, sh.start, sh.id);
        candidates.push({ type: 'caregiver', id: cg.id, name: cg.name, rate: cg.rate, cost: r2(sh.hours * cg.rate), hoursThatWeek: weekHrs, maxHoursPerWeek: cg.maxHoursPerWeek, available: c.ok, why: c.ok ? undefined : c.reason });
      }
      for (const sib of s.siblings) {
        const c = checkAssign(sh, 'sibling', sib.id);
        candidates.push({ type: 'sibling', id: sib.id, name: sib.name, cost: 0, available: c.ok, why: c.ok ? undefined : c.reason });
      }
      candidates.sort((a, b) => (b.available - a.available) || (a.cost - b.cost));
      return { shiftId: sh.id, when: sh.label, start: sh.start, end: sh.end, hours: sh.hours, note: sh.note, candidates };
    });
}

// ---------- Money ----------
const SPENT = new Set(['SUCCESS', 'PENDING', 'PROCESSING', 'UNCLAIMED', 'ONHOLD', 'NEW']);

export function pool() {
  const s = db();
  const now = nowLocal();
  const contributed = s.contributions.filter((c) => c.status === 'COMPLETED').reduce((a, c) => a + c.amount, 0);
  const paidOut = s.payouts.filter((p) => SPENT.has(p.status)).reduce((a, p) => a + p.amount, 0);
  const balance = r2(contributed - paidOut);
  const views = s.shifts.map(shiftView);
  const awaiting = views.filter((x) => x.status === 'awaiting_approval');
  const awaitingCost = r2(awaiting.reduce((a, x) => a + x.cost, 0));
  const horizon = `${addDays(today(), s.family.lowBalanceDays)}T23:59:59`;
  const upcoming = views.filter((x) => x.status === 'scheduled' && x.assigneeType === 'caregiver' && x.end > now && x.start <= horizon);
  const upcomingCost = r2(upcoming.reduce((a, x) => a + x.cost, 0));
  const openCount = views.filter((x) => x.status === 'open' && x.end > now && x.start <= horizon).length;
  const projected = r2(balance - awaitingCost - upcomingCost);
  return {
    contributed: r2(contributed), paidOut: r2(paidOut), balance,
    awaitingApproval: { count: awaiting.length, cost: awaitingCost },
    next7Days: { scheduledCost: upcomingCost, openShifts: openCount },
    projectedAfter7Days: projected,
    shortfall: projected < 0 ? r2(-projected) : 0,
  };
}

export function fairShare() {
  const s = db();
  const views = s.shifts.map(shiftView);
  const paidCare = views.filter((x) => x.status === 'paid' || x.status === 'awaiting_approval').reduce((a, x) => a + x.cost, 0);
  const inKind = {};
  for (const x of views.filter((v) => v.status === 'done' && v.assigneeType === 'sibling')) {
    inKind[x.assigneeId] = (inKind[x.assigneeId] || 0) + x.hours;
  }
  const totalInKindValue = Object.values(inKind).reduce((a, h) => a + h * s.family.inKindRate, 0);
  const totalCareValue = paidCare + totalInKindValue;
  const rows = s.siblings.map((sib) => {
    const contributed = s.contributions.filter((c) => c.siblingId === sib.id && c.status === 'COMPLETED').reduce((a, c) => a + c.amount, 0);
    const hours = inKind[sib.id] || 0;
    const inKindValue = hours * s.family.inKindRate;
    const fair = totalCareValue * sib.weight;
    const given = contributed + inKindValue;
    return {
      siblingId: sib.id, name: sib.name, weight: sib.weight,
      contributed: r2(contributed), inKindHours: hours, inKindValue: r2(inKindValue),
      given: r2(given), fairShareOfCareSoFar: r2(fair), net: r2(given - fair),
    };
  });
  return { inKindRate: s.family.inKindRate, paidCare: r2(paidCare), inKindValue: r2(totalInKindValue), totalCareValue: r2(totalCareValue), siblings: rows };
}

// Split a top-up so that whoever is furthest behind their fair share pays more.
export function suggestTopUp(target) {
  const fs = fairShare();
  const projected = fs.totalCareValue + target;
  const owe = fs.siblings.map((r) => ({ ...r, gap: Math.max(0, projected * r.weight - r.given) }));
  const totalGap = owe.reduce((a, r) => a + r.gap, 0) || 1;
  let split = owe.map((r) => ({ siblingId: r.siblingId, name: r.name, amount: Math.round((target * r.gap) / totalGap) }));
  if (split.every((x) => x.amount === 0)) split = owe.map((r) => ({ siblingId: r.siblingId, name: r.name, amount: Math.round(target * r.weight) }));
  return split;
}

// ---------- Approvals: money never moves without a family member's click ----------
export function queueApproval(type, params, summary, requestedBy = 'agent') {
  const s = db();
  const dup = s.approvals.find((a) => a.status === 'pending' && a.type === type && JSON.stringify(a.params) === JSON.stringify(params));
  if (dup) return dup;
  const a = { id: newId('apr'), type, params, summary, requestedBy, status: 'pending', createdAt: new Date().toISOString() };
  s.approvals.unshift(a);
  log('approval', `${requestedBy === 'agent' ? 'Kin' : 'Family'} asked for approval: ${summary}`, { approvalId: a.id });
  return a;
}

export function overview() {
  const s = db();
  const t = today();
  const gaps = coverageGaps(t, addDays(t, 13));
  return {
    now: nowLocal(),
    today: `${DAY_NAMES[dayOfWeek(t)]} ${t}`,
    family: s.family,
    pool: pool(),
    openShiftsNext14Days: gaps.map((g) => ({ shiftId: g.shiftId, when: g.when })),
    pendingApprovals: s.approvals.filter((a) => a.status === 'pending').map((a) => ({ id: a.id, type: a.type, summary: a.summary })),
    openInvoices: s.invoices.filter((i) => i.status !== 'PAID' && i.status !== 'CANCELLED').map((i) => ({ siblingId: i.siblingId, amount: i.amount, status: i.status })),
  };
}
