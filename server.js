import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { db, save, reset, log } from './lib/store.js';
import * as care from './lib/care.js';
import * as money from './lib/money.js';
import * as paypal from './lib/paypal.js';
import { chat, summarizeCare, aiEnabled, provider, modelName } from './lib/agent.js';
import { nowLocal, TZ } from './lib/time.js';

const app = express();
app.set('trust proxy', true); // so req.protocol is https behind Render's proxy
app.use(express.json({ limit: '200kb' }));
app.use('/api', (req, _res, next) => { money.setBaseUrl(`${req.protocol}://${req.get('host')}`); next(); });
app.use('/bryntum', express.static(path.resolve('node_modules/@bryntum/calendar'), { maxAge: '1h' }));
app.use(express.static(path.resolve('public')));

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    save();
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    console.error(e.message, e.details ? JSON.stringify(e.details).slice(0, 500) : '');
    save();
    res.status(e.status && e.status < 500 ? 400 : 500).json({ error: e.message, code: e.code, suggestion: e.suggestion });
  }
};
const must = (r) => { if (!r.ok) { const e = new Error(r.reason); e.status = 400; throw e; } return r; };

app.get('/api/state', wrap(() => {
  care.refreshStatuses();
  const s = db();
  return {
    now: nowLocal(),
    timeZone: TZ,
    family: s.family,
    siblings: s.siblings,
    caregivers: s.caregivers,
    timeOff: s.timeOff,
    shifts: s.shifts.map(care.shiftView),
    pool: care.pool(),
    fairShare: care.fairShare(),
    approvals: s.approvals.slice(0, 30),
    invoices: s.invoices.slice(0, 30),
    payouts: s.payouts.filter((p) => !p.seeded).slice(0, 30),
    contributions: s.contributions.slice(0, 30),
    careNotes: [...s.careNotes].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20),
    activity: s.activity.slice(0, 40),
    config: { paypalLive: paypal.live, paypalClientId: paypal.clientId, aiEnabled, provider, model: modelName },
  };
}));

// ---------- Shifts ----------
app.post('/api/shifts', wrap((req) => must(care.createShift(req.body))));

app.patch('/api/shifts/:id', wrap((req) => {
  const { start, end, assigneeType, assigneeId, unassign } = req.body;
  if (unassign) return must(care.unassignShift(req.params.id, 'Changed by family'));
  if (assigneeId) return must(care.assignShift(req.params.id, assigneeType, assigneeId));
  if (start && end) return must(care.moveShift(req.params.id, start, end));
  throw Object.assign(new Error('Nothing to change'), { status: 400 });
}));

app.post('/api/shifts/:id/checkout', wrap((req) => {
  const s = db();
  const sh = s.shifts.find((x) => x.id === req.params.id);
  if (!sh || sh.assigneeType !== 'caregiver') throw Object.assign(new Error('No caregiver shift'), { status: 400 });
  if (!['scheduled', 'awaiting_approval'].includes(sh.status)) throw Object.assign(new Error(`Shift is ${sh.status}`), { status: 400 });
  if (sh.start.slice(0, 10) > nowLocal().slice(0, 10)) throw Object.assign(new Error('You can only finish today’s or earlier shifts'), { status: 400 });
  const { mood, meals, meds, text } = req.body;
  s.careNotes.push({ id: `note_${Date.now()}`, shiftId: sh.id, authorId: sh.assigneeId, at: nowLocal(), mood, meals, meds, text });
  sh.status = 'awaiting_approval';
  log('note', `${care.person(sh.assigneeId).name} finished ${care.shiftView(sh).label} and left a care note`, { shiftId: sh.id });
  return { ok: true };
}));

app.post('/api/shifts/:id/pay', wrap((req) => money.payCaregivers([req.params.id], care.person(req.body.approverId)?.name || 'Family')));

app.post('/api/people/:id', wrap((req) => {
  const p = care.person(req.params.id);
  if (!p) throw Object.assign(new Error('Unknown person'), { status: 400 });
  if (req.body.email) p.email = String(req.body.email).trim();
  return { ok: true };
}));

// ---------- Approvals ----------
app.post('/api/approvals/:id/approve', wrap((req) => money.executeApproval(req.params.id, req.body.approverId)));
app.post('/api/approvals/:id/reject', wrap((req) => money.rejectApproval(req.params.id, req.body.approverId)));
app.post('/api/requests', wrap((req) => {
  // Family member asks a sibling directly (no agent involved): still goes through PayPal Invoicing
  const { siblingId, amount, reason, approverId } = req.body;
  return money.sendContributionRequest({ siblingId, amount: Number(amount), reason }, care.person(approverId)?.name || 'Family');
}));

// ---------- PayPal: contributions via Orders v2 + JS SDK buttons ----------
const pendingOrders = new Map();
app.post('/api/paypal/orders', wrap(async (req) => {
  const { siblingId } = req.body;
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  const sib = care.person(siblingId);
  if (!sib || !siblingId.startsWith('sib_')) throw Object.assign(new Error('Choose who is paying'), { status: 400 });
  if (!(amount >= 1 && amount <= 10000)) throw Object.assign(new Error('Amount must be between $1 and $10,000'), { status: 400 });
  const order = await paypal.createOrder({ amount, description: `${sib.name}'s contribution to ${db().family.careRecipient}'s care pool`, customId: siblingId });
  pendingOrders.set(order.id, { siblingId, amount });
  return { id: order.id, simulated: !!order.simulated };
}));

app.post('/api/paypal/orders/:id/capture', wrap(async (req) => {
  const pending = pendingOrders.get(req.params.id);
  if (!pending) throw Object.assign(new Error('Unknown or already captured order'), { status: 400 });
  const cap = await paypal.captureOrder(req.params.id);
  if (cap.status !== 'COMPLETED') throw Object.assign(new Error(`Payment not completed (${cap.status})`), { status: 400 });
  pendingOrders.delete(req.params.id);
  const c = money.recordContribution({ siblingId: pending.siblingId, amount: cap.amount ?? pending.amount, method: 'paypal_order', paypalId: cap.captureId || cap.id, payer: cap.payerEmail });
  return { ok: true, contribution: c, simulated: !!cap.simulated };
}));

app.post('/api/invoices/:id/mark-paid', wrap(async (req) => {
  const inv = db().invoices.find((i) => i.id === req.params.id);
  if (!inv) throw Object.assign(new Error('Unknown invoice'), { status: 400 });
  if (inv.kind !== 'payment_link') await paypal.recordInvoicePayment(inv.paypalId, inv.amount);
  inv.status = 'MARKED_AS_PAID';
  money.markInvoicePaid(inv);
  return { ok: true };
}));

// PayPal sends the payer back here after approving a payment link; capture it and record the contribution.
app.get('/api/paypal/return', async (req, res) => {
  const orderId = String(req.query.token || '');
  const inv = db().invoices.find((i) => i.kind === 'payment_link' && i.paypalId === orderId);
  if (!inv) return res.redirect('/?paid=unknown');
  try {
    if (!['PAID', 'MARKED_AS_PAID'].includes(inv.status)) {
      const cap = await paypal.captureOrder(orderId);
      if (cap.status !== 'COMPLETED') throw new Error(`Payment not completed (${cap.status})`);
      money.markInvoicePaid(inv);
      save();
    }
    res.redirect(`/?paid=${encodeURIComponent(care.person(inv.siblingId)?.name || 'Someone')}&amount=${inv.amount}`);
  } catch (e) {
    console.error('return capture', e.message);
    res.redirect(`/?payfailed=${encodeURIComponent(e.message)}`);
  }
});

app.post('/api/sync', wrap(async () => ({ changes: await money.syncWithPayPal() })));

app.post('/api/paypal/webhook', async (req, res) => {
  try {
    const ok = await paypal.verifyWebhook(req.headers, req.body);
    if (!ok) return res.status(400).json({ error: 'signature not verified' });
    const ev = req.body;
    const s = db();
    if (ev.event_type?.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
      const r = ev.resource;
      const po = s.payouts.find((p) => p.batchId === r.payout_batch_id && care.person(p.caregiverId)?.email === r.payout_item?.receiver);
      if (po) po.status = r.transaction_status;
    } else if (ev.event_type === 'INVOICING.INVOICE.PAID') {
      const invId = ev.resource?.invoice?.id || ev.resource?.id;
      const inv = s.invoices.find((i) => i.paypalId === invId);
      if (inv) money.markInvoicePaid(inv);
    }
    log('webhook', `PayPal webhook: ${ev.event_type}`);
    save();
    res.json({ ok: true });
  } catch (e) {
    console.error('webhook', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---------- AI ----------
app.post('/api/agent', wrap((req) => chat(req.body)));
app.post('/api/care-summary', wrap(() => summarizeCare(7)));

app.post('/api/reset', wrap(() => { reset(); return { ok: true }; }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  db();
  console.log(`Kinshift running on http://localhost:${PORT}`);
  console.log(`PayPal: ${paypal.live ? 'sandbox (live API calls)' : 'SIMULATED — add PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET'}`);
  console.log(`AI agent (Kin): ${aiEnabled ? `${provider} · ${modelName}` : 'off — add GEMINI_API_KEY'}`);
});

if (paypal.live) {
  setInterval(() => { money.syncWithPayPal().then((c) => c.length && save()).catch(() => {}); }, 60_000);
}
