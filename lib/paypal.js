// PayPal REST client (sandbox only). Covers Orders v2, Payouts v1, Invoicing v2 and webhook verification.
// If no sandbox keys are configured, every call is simulated so the app still runs end to end.
import crypto from 'node:crypto';

const BASE = 'https://api-m.sandbox.paypal.com';
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const SECRET = process.env.PAYPAL_CLIENT_SECRET || '';

export const live = Boolean(CLIENT_ID && SECRET);
export const clientId = CLIENT_ID;

let token = null;
let tokenExpires = 0;

async function getToken() {
  if (token && Date.now() < tokenExpires - 60_000) return token;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new PayPalError(`PayPal auth failed (${res.status})`, res.status, await res.text());
  const json = await res.json();
  token = json.access_token;
  tokenExpires = Date.now() + json.expires_in * 1000;
  return token;
}

export class PayPalError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function call(method, path, body, { requestId, prefer } = {}) {
  const headers = {
    Authorization: `Bearer ${await getToken()}`,
    'Content-Type': 'application/json',
  };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.message || json?.error_description || `PayPal ${method} ${path} failed`;
    const issue = json?.details?.[0]?.issue;
    throw new PayPalError(issue ? `${msg} (${issue})` : msg, res.status, json);
  }
  return json;
}

const sim = (prefix) => `SIM-${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);

// ---------- Orders: siblings add money to the shared care pool ----------
export async function createOrder({ amount, description, customId }) {
  if (!live) return { id: sim('ORDER'), status: 'CREATED', simulated: true };
  return call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: 'care-pool',
      custom_id: customId,
      description,
      amount: { currency_code: 'USD', value: money(amount) },
    }],
  }, { requestId: crypto.randomUUID() });
}

// A shareable PayPal Checkout link (used when the app isn't allowed to use Invoicing).
// The payer approves on PayPal, comes back to returnUrl?token=<orderId>, and the server captures it.
export async function createPaymentLink({ amount, description, customId, returnUrl, cancelUrl }) {
  if (!live) return { id: sim('ORDER'), payUrl: null, simulated: true };
  const json = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: 'care-pool', custom_id: customId, description, amount: { currency_code: 'USD', value: money(amount) } }],
    application_context: {
      brand_name: 'Kinshift Family Care Pool',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      return_url: returnUrl,
      cancel_url: cancelUrl,
    },
  }, { requestId: crypto.randomUUID() });
  const approve = json.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action');
  return { id: json.id, payUrl: approve?.href || null };
}

export async function captureOrder(orderId) {
  if (!live || orderId.startsWith('SIM-')) {
    return { id: orderId, status: 'COMPLETED', simulated: true, captureId: sim('CAPTURE') };
  }
  const json = await call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, { requestId: crypto.randomUUID() });
  const cap = json.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    id: json.id,
    status: json.status,
    captureId: cap?.id,
    amount: cap ? Number(cap.amount.value) : null,
    payerEmail: json.payer?.email_address,
    payerName: [json.payer?.name?.given_name, json.payer?.name?.surname].filter(Boolean).join(' '),
  };
}

// ---------- Payouts: pay caregivers from the pool once a shift is approved ----------
export async function createPayout({ items, batchKey }) {
  if (!live) {
    return { batchId: sim('PAYOUT'), status: 'SUCCESS', simulated: true };
  }
  const json = await call('POST', '/v1/payments/payouts', {
    sender_batch_header: {
      sender_batch_id: batchKey,
      email_subject: 'You have been paid for your care shift',
      email_message: 'Thank you for caring for Leela. This payment comes from the family care pool.',
    },
    items: items.map((it) => ({
      recipient_type: 'EMAIL',
      receiver: it.email,
      amount: { value: money(it.amount), currency: 'USD' },
      note: it.note,
      sender_item_id: it.itemKey,
    })),
  }, { requestId: batchKey });
  return { batchId: json.batch_header.payout_batch_id, status: json.batch_header.batch_status };
}

export async function getPayout(batchId) {
  if (!live || batchId.startsWith('SIM-') || batchId.startsWith('SEED-')) return { batchId, status: 'SUCCESS', items: [] };
  const json = await call('GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
  return {
    batchId,
    status: json.batch_header.batch_status,
    items: (json.items || []).map((i) => ({ itemId: i.payout_item_id, status: i.transaction_status, receiver: i.payout_item?.receiver })),
  };
}

// ---------- Invoicing: ask a sibling for their fair share ----------
export async function createAndSendInvoice({ recipientName, recipientEmail, amount, note, reference }) {
  if (!live) {
    return { id: sim('INV'), status: 'SENT', payUrl: null, simulated: true };
  }
  const invoice = await call('POST', '/v2/invoicing/invoices', {
    detail: {
      currency_code: 'USD',
      reference,
      note,
      memo: 'Created by Kinshift care agent after family approval',
      payment_term: { term_type: 'DUE_ON_RECEIPT' },
    },
    invoicer: { business_name: 'Kinshift Family Care Pool' },
    primary_recipients: [{
      billing_info: { name: { given_name: recipientName }, email_address: recipientEmail },
    }],
    items: [{
      name: 'Care pool contribution',
      description: note.slice(0, 1000),
      quantity: '1',
      unit_amount: { currency_code: 'USD', value: money(amount) },
      unit_of_measure: 'AMOUNT',
    }],
    configuration: { allow_tip: false, tax_calculated_after_discount: true, tax_inclusive: false },
  }, { requestId: crypto.randomUUID(), prefer: 'return=representation' });

  const sent = await call('POST', `/v2/invoicing/invoices/${invoice.id}/send`, {
    send_to_invoicer: false,
    send_to_recipient: true,
  }, { requestId: crypto.randomUUID() });
  const payUrl = sent?.href || invoice.detail?.metadata?.recipient_view_url || null;
  return { id: invoice.id, status: 'SENT', payUrl };
}

export async function getInvoice(id) {
  if (!live || id.startsWith('SIM-')) return { id, status: 'SENT' };
  const json = await call('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
  return {
    id,
    status: json.status,
    paid: json.payments?.paid_amount ? Number(json.payments.paid_amount.value) : 0,
    payUrl: json.detail?.metadata?.recipient_view_url,
  };
}

// Sandbox helper: mark an invoice as paid outside PayPal (e.g. the sibling paid by bank transfer).
export async function recordInvoicePayment(id, amount) {
  if (!live || id.startsWith('SIM-')) return { ok: true, simulated: true };
  await call('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, {
    method: 'BANK_TRANSFER',
    payment_date: new Date().toISOString().slice(0, 10),
    amount: { currency_code: 'USD', value: money(amount) },
    note: 'Recorded by family in Kinshift',
  });
  return { ok: true };
}

// ---------- Webhooks ----------
export async function verifyWebhook(headers, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!live || !webhookId) return false;
  const json = await call('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: event,
  });
  return json.verification_status === 'SUCCESS';
}
