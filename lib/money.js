// Everything that actually moves money through PayPal. Only called after a family member approves.
import * as paypal from './paypal.js';
import { db, newId, log } from './store.js';
import { person, shiftView, pool, suggestTopUp } from './care.js';

const r2 = (n) => Math.round(n * 100) / 100;

// Public URL of this server, used for PayPal return links. Set from each incoming request.
let baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
export function setBaseUrl(url) { if (!process.env.PUBLIC_URL && url) baseUrl = url; }

export async function executeApproval(id, approverId) {
  const s = db();
  const a = s.approvals.find((x) => x.id === id);
  if (!a) throw new Error('Approval not found');
  if (a.status !== 'pending') throw new Error(`Already ${a.status}`);
  const approver = person(approverId)?.name || 'Family';
  let result;
  if (a.type === 'invoice') result = await sendContributionRequest(a.params, approver);
  else if (a.type === 'payout') result = await payCaregivers(a.params.shiftIds, approver);
  else throw new Error(`Unknown approval type ${a.type}`);
  a.status = 'approved';
  a.approvedBy = approver;
  a.approvedAt = new Date().toISOString();
  a.result = result;
  return a;
}

export function rejectApproval(id, approverId) {
  const a = db().approvals.find((x) => x.id === id);
  if (!a || a.status !== 'pending') throw new Error('Approval not pending');
  a.status = 'rejected';
  a.approvedBy = person(approverId)?.name || 'Family';
  log('approval', `${a.approvedBy} declined: ${a.summary}`);
  return a;
}

export async function sendContributionRequest({ siblingId, amount, reason }, approver) {
  const s = db();
  const sib = person(siblingId);
  if (!sib || !siblingId.startsWith('sib_')) throw new Error('Unknown sibling');
  if (!(amount >= 1 && amount <= 10000)) throw new Error('Amount must be between $1 and $10,000');
  let inv;
  try {
    inv = await paypal.createAndSendInvoice({
      recipientName: sib.name,
      recipientEmail: sib.email,
      amount,
      note: reason || `Your share of ${s.family.careRecipient}'s care`,
      reference: `kinshift-${siblingId}-${Date.now()}`,
    });
  } catch (e) {
    if (e.status !== 401 && e.status !== 403) throw e;
    // Invoicing isn't enabled for this PayPal app: fall back to a PayPal Checkout payment link
    console.warn('PayPal Invoicing not permitted for this app; sending a PayPal payment link instead');
    const link = await paypal.createPaymentLink({
      amount,
      description: `${sib.name}'s share of ${s.family.careRecipient}'s care`,
      customId: siblingId,
      returnUrl: `${baseUrl}/api/paypal/return`,
      cancelUrl: `${baseUrl}/?cancelled=1`,
    });
    const record = { id: newId('inv'), kind: 'payment_link', paypalId: link.id, siblingId, amount: r2(amount), reason, status: 'SENT', payUrl: link.payUrl, simulated: false, createdAt: new Date().toISOString(), approvedBy: approver };
    s.invoices.unshift(record);
    log('invoice', `PayPal payment request for $${amount.toFixed(2)} sent to ${sib.name} (approved by ${approver})`, { invoiceId: record.id });
    return { invoice: record };
  }
  const record = { id: newId('inv'), kind: 'invoice', paypalId: inv.id, siblingId, amount: r2(amount), reason, status: inv.status, payUrl: inv.payUrl, simulated: !!inv.simulated, createdAt: new Date().toISOString(), approvedBy: approver };
  s.invoices.unshift(record);
  log('invoice', `PayPal invoice for $${amount.toFixed(2)} sent to ${sib.name} (approved by ${approver})`, { invoiceId: record.id });
  return { invoice: record };
}

export async function payCaregivers(shiftIds, approver) {
  const s = db();
  const shifts = shiftIds.map((id) => s.shifts.find((x) => x.id === id)).filter(Boolean);
  const payable = shifts.filter((x) => x.status === 'awaiting_approval' && x.assigneeType === 'caregiver');
  if (!payable.length) throw new Error('No finished caregiver shifts waiting for payment in this request');
  const byCg = {};
  for (const sh of payable) {
    const v = shiftView(sh);
    (byCg[sh.assigneeId] ||= { amount: 0, shifts: [] });
    byCg[sh.assigneeId].amount = r2(byCg[sh.assigneeId].amount + v.cost);
    byCg[sh.assigneeId].shifts.push(sh);
  }
  const total = r2(Object.values(byCg).reduce((a, x) => a + x.amount, 0));
  const { balance } = pool();
  if (total > balance) {
    const err = new Error(`The pool has $${balance.toFixed(2)} but these payouts need $${total.toFixed(2)}. Ask siblings to top up first.`);
    err.code = 'POOL_SHORT';
    err.suggestion = suggestTopUp(r2(total - balance + 200));
    throw err;
  }
  const batchKey = `kinshift-${Date.now()}`;
  const items = Object.entries(byCg).map(([cgId, x], i) => ({
    email: person(cgId).email,
    amount: x.amount,
    note: `Care shifts for Leela: ${x.shifts.map((sh) => shiftView(sh).label).join('; ')}`.slice(0, 4000),
    itemKey: `${batchKey}-${i}`,
    cgId,
  }));
  const res = await paypal.createPayout({ items, batchKey });
  const records = [];
  for (const it of items) {
    const rec = { id: newId('po'), batchId: res.batchId, caregiverId: it.cgId, amount: it.amount, shiftIds: byCg[it.cgId].shifts.map((x) => x.id), status: res.status, simulated: !!res.simulated, createdAt: new Date().toISOString(), approvedBy: approver };
    s.payouts.unshift(rec);
    records.push(rec);
    for (const sh of byCg[it.cgId].shifts) { sh.status = 'paid'; sh.payoutId = rec.id; }
    log('payout', `Paid ${person(it.cgId).name} $${it.amount.toFixed(2)} via PayPal Payouts (approved by ${approver})`, { payoutId: rec.id });
  }
  return { batchId: res.batchId, total, payouts: records };
}

export function recordContribution({ siblingId, amount, method, paypalId, payer }) {
  const s = db();
  const c = { id: newId('ct'), siblingId, amount: r2(amount), method, paypalId, payer, status: 'COMPLETED', at: new Date().toISOString() };
  s.contributions.unshift(c);
  log('contribution', `${person(siblingId)?.name || 'Someone'} added $${c.amount.toFixed(2)} to the care pool via PayPal`, { contributionId: c.id });
  return c;
}

// Poll PayPal for invoice payments and payout status (webhooks do the same when configured).
export async function syncWithPayPal() {
  const s = db();
  const changes = [];
  for (const inv of s.invoices.filter((i) => ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(i.status) && !i.simulated && i.kind !== 'payment_link')) {
    try {
      const fresh = await paypal.getInvoice(inv.paypalId);
      if (fresh.payUrl) inv.payUrl = fresh.payUrl;
      if (fresh.status !== inv.status) {
        inv.status = fresh.status;
        changes.push(`invoice ${inv.id} → ${fresh.status}`);
        if (fresh.status === 'PAID' || fresh.status === 'MARKED_AS_PAID') markInvoicePaid(inv);
      }
    } catch (e) { inv.syncError = e.message; }
  }
  for (const po of s.payouts.filter((p) => ['PENDING', 'PROCESSING', 'NEW'].includes(p.status) && !p.simulated && !p.seeded)) {
    try {
      const fresh = await paypal.getPayout(po.batchId);
      const item = fresh.items.find((i) => i.receiver === person(po.caregiverId)?.email);
      const st = item?.status || fresh.status;
      if (st && st !== po.status) { po.status = st; changes.push(`payout ${po.id} → ${st}`); }
    } catch (e) { po.syncError = e.message; }
  }
  return changes;
}

export function markInvoicePaid(inv) {
  if (inv.contributionId) return;
  inv.status = inv.status === 'MARKED_AS_PAID' ? 'MARKED_AS_PAID' : 'PAID';
  const c = recordContribution({ siblingId: inv.siblingId, amount: inv.amount, method: inv.kind === 'payment_link' ? 'paypal_link' : 'paypal_invoice', paypalId: inv.paypalId });
  inv.contributionId = c.id;
}
