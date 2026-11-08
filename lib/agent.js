// "Kin" — the family's care coordinator agent, built on Google Gemini with function calling.
// It can read and change the schedule directly, but anything that moves money only creates an
// approval card that a family member has to click.
import { db, save, newId } from './store.js';
import * as care from './care.js';
import { today, addDays, nowLocal } from './time.js';

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

export const aiEnabled = Boolean(GEMINI_KEY);
export const provider = aiEnabled ? 'gemini' : 'none';
export const modelName = aiEnabled ? GEMINI_MODEL : null;

const sessions = new Map(); // sessionId -> Gemini `contents` history (append-only)

// ---------- Tools (Gemini function declarations) ----------
const str = (description) => (description ? { type: 'string', description } : { type: 'string' });
const date = str('Date as YYYY-MM-DD');
const params = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });

const functionDeclarations = [
  { name: 'get_overview', description: 'Current date/time, pool balance and 7-day forecast, open shifts in the next 14 days, pending approvals and unpaid invoices. Call this first in most conversations.' },
  { name: 'list_people', description: 'All siblings (with fair-share weight and when they can cover care themselves) and caregivers (hourly rate, availability windows, weekly hour cap), plus recorded time off.' },
  { name: 'list_shifts', description: 'Shifts between two dates (inclusive) with who is assigned, status (open, scheduled, awaiting_approval, paid, done, missed) and cost.', parameters: params({ from_date: date, to_date: date }) },
  { name: 'find_coverage_gaps', description: 'Open (uncovered) future shifts in a date range. For each, every caregiver and sibling is listed with cost, hours already worked that week, and whether they can take it (with the reason if not).', parameters: params({ from_date: date, to_date: date }) },
  {
    name: 'assign_shifts',
    description: 'Assign one or more shifts. Each assignment is validated against availability, time off, overlaps and weekly hour caps; failures are reported per shift and do not block the others.',
    parameters: params({
      assignments: { type: 'array', items: params({ shift_id: str(), assignee_type: { type: 'string', enum: ['caregiver', 'sibling'] }, assignee_id: str() }) },
    }),
  },
  { name: 'unassign_shift', description: 'Remove the assigned person from a future scheduled shift, making it open.', parameters: params({ shift_id: str(), reason: str() }) },
  { name: 'mark_unavailable', description: 'Record that a caregiver or sibling is unavailable for whole days (sick, travel, etc.). Their scheduled shifts in that range become open and are returned so you can refill them.', parameters: params({ person_id: str(), from_date: date, to_date: date, reason: str() }) },
  { name: 'create_shift', description: 'Add an extra care shift (e.g. an evening for a hospital visit). Times are HH:MM, 24h.', parameters: params({ date, start_time: str(), end_time: str(), note: str() }) },
  { name: 'get_fair_share', description: 'How much each sibling has contributed (money and in-kind care hours) versus their agreed share of care so far. If top_up_target is a number, also returns a suggested split of that top-up that moves everyone toward their fair share.', parameters: { type: 'object', properties: { top_up_target: { type: 'number', nullable: true } } } },
  { name: 'request_contribution', description: 'Propose asking a sibling to pay into the pool through PayPal. This does NOT send anything: it creates an approval card for the family. Use one call per sibling.', parameters: params({ sibling_id: str(), amount: { type: 'number' }, reason: str('One friendly sentence shown to the sibling') }) },
  { name: 'queue_caregiver_payouts', description: 'Propose paying caregivers (PayPal Payouts) for finished shifts that are awaiting approval. Creates an approval card; nothing is paid until a family member approves.', parameters: params({ shift_ids: { type: 'array', items: str() } }) },
  { name: 'get_care_notes', description: 'Caregiver notes (mood, meals, medication, free text) written at the end of shifts in a date range.', parameters: params({ from_date: date, to_date: date }) },
];
const tools = [{ functionDeclarations }];

function runTool(name, input, touched) {
  const s = db();
  switch (name) {
    case 'get_overview': return care.overview();
    case 'list_people': return {
      siblings: s.siblings.map(({ id, name, weight, about, canCover }) => ({ id, name, fairShareWeight: weight, about, canCoverThemselves: canCover })),
      caregivers: s.caregivers.map(({ id, name, rate, maxHoursPerWeek, availability, about }) => ({ id, name, hourlyRate: rate, maxHoursPerWeek, availability, about })),
      dayNumbers: '0=Sunday … 6=Saturday',
      timeOff: s.timeOff.filter((o) => o.to > nowLocal()).map((o) => ({ personId: o.personId, from: o.from, to: o.to, reason: o.reason })),
    };
    case 'list_shifts': return care.listShifts(input.from_date, input.to_date).map(({ id, label, status, assigneeName, assigneeId, cost, note }) => ({ id, when: label, status, assignee: assigneeName, assigneeId, cost, note: note || undefined }));
    case 'find_coverage_gaps': return care.coverageGaps(input.from_date, input.to_date);
    case 'assign_shifts': return (input.assignments || []).map((a) => {
      const r = care.assignShift(a.shift_id, a.assignee_type, a.assignee_id, 'agent');
      if (r.ok) touched.add(a.shift_id);
      return { shiftId: a.shift_id, ok: r.ok, reason: r.reason, when: r.shift?.label, assignee: r.shift?.assigneeName, cost: r.shift?.cost };
    });
    case 'unassign_shift': {
      const r = care.unassignShift(input.shift_id, input.reason, 'agent');
      if (r.ok) touched.add(input.shift_id);
      return { ok: r.ok, reason: r.reason };
    }
    case 'mark_unavailable': {
      const r = care.markUnavailable({ personId: input.person_id, fromDate: input.from_date, toDate: input.to_date, reason: input.reason }, 'agent');
      r.nowOpen?.forEach((x) => touched.add(x.id));
      return r.ok ? { ok: true, person: r.person, nowOpen: r.nowOpen.map((x) => ({ shiftId: x.id, when: x.label })) } : r;
    }
    case 'create_shift': {
      const r = care.createShift({ date: input.date, from: input.start_time, to: input.end_time, note: input.note }, 'agent');
      if (r.ok) touched.add(r.shift.id);
      return r.ok ? { ok: true, shiftId: r.shift.id, when: r.shift.label } : r;
    }
    case 'get_fair_share': {
      const fs = care.fairShare();
      return input.top_up_target ? { ...fs, suggestedSplit: care.suggestTopUp(input.top_up_target) } : fs;
    }
    case 'request_contribution': {
      const sib = care.person(input.sibling_id);
      if (!sib || !input.sibling_id.startsWith('sib_')) return { ok: false, reason: 'Unknown sibling' };
      const amount = Math.round(input.amount * 100) / 100;
      if (!(amount >= 1 && amount <= 10000)) return { ok: false, reason: 'Amount must be $1–$10,000' };
      const a = care.queueApproval('invoice', { siblingId: sib.id, amount, reason: input.reason }, `Ask ${sib.name} to pay $${amount.toFixed(2)} via PayPal`);
      return { ok: true, approvalId: a.id, status: 'waiting for a family member to approve' };
    }
    case 'queue_caregiver_payouts': {
      const shifts = (input.shift_ids || []).map((id) => s.shifts.find((x) => x.id === id)).filter((x) => x && x.status === 'awaiting_approval');
      if (!shifts.length) return { ok: false, reason: 'None of those shifts are finished and awaiting payment' };
      const views = shifts.map(care.shiftView);
      const total = views.reduce((a, x) => a + x.cost, 0);
      const names = [...new Set(views.map((x) => x.assigneeName))].join(', ');
      const a = care.queueApproval('payout', { shiftIds: shifts.map((x) => x.id) }, `Pay ${names} $${total.toFixed(2)} for ${shifts.length} finished shift${shifts.length > 1 ? 's' : ''}`);
      return { ok: true, approvalId: a.id, total, poolBalance: care.pool().balance };
    }
    case 'get_care_notes': {
      const from = `${input.from_date}T00:00:00`;
      const to = `${addDays(input.to_date, 1)}T00:00:00`;
      return s.careNotes.filter((n) => n.at >= from && n.at < to).map((n) => ({ when: n.at, by: care.person(n.authorId)?.name, mood: n.mood, meals: n.meals, meds: n.meds, text: n.text }));
    }
    default: return { ok: false, reason: `Unknown tool ${name}` };
  }
}

function systemPrompt() {
  const s = db();
  return `You are Kin, the care coordinator for ${s.family.name}: siblings who share the cost and the hands-on care of ${s.family.careRecipient}. You manage the care calendar and the family's shared PayPal care pool. Coverage is needed every day ${s.family.coverage.from}–${s.family.coverage.to}.

How you work:
- Look things up with tools before answering. Never invent people, shift ids or amounts.
- When someone becomes unavailable, record it with mark_unavailable, then refill the shifts that opened up. Choose people who can actually take the shift; prefer lower cost, but keep the same caregiver on back-to-back shifts when that is cheap to do. A free sibling can cover at no cost; it counts as their in-kind contribution.
- If nobody can cover a shift, say so plainly and suggest realistic options.
- You never move money yourself. request_contribution and queue_caregiver_payouts only create approval cards that a family member clicks. Before adding paid shifts, check the pool; if the next 7 days would leave it short, propose top-ups split by fair share.
- Write for a busy, worried family member: short, warm, plain words. Lead with what changed, then anything waiting for their decision. Use names and days, never internal ids. A short bullet list is fine for changes.`;
}

// ---------- Gemini REST client ----------
class AIError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Free-tier model availability varies by account, so fall back through other free models on 404.
const models = [...new Set([GEMINI_MODEL, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'])];
let modelIdx = 0;

async function generate(body) {
  for (let attempt = 0; attempt < 3 + models.length; attempt++) {
    let res;
    try {
      res = await fetch(`${GEMINI_BASE}/v1beta/models/${encodeURIComponent(models[modelIdx])}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      if (attempt < 2) continue; // network hiccup or timeout: try again
      throw new AIError('Kin could not reach Gemini. Check your internet connection and try again.', 503);
    }
    const json = await res.json().catch(() => ({}));
    if (res.ok) return json;
    if (res.status === 404 && modelIdx < models.length - 1) {
      console.warn(`Gemini model ${models[modelIdx]} not available for this key; trying ${models[modelIdx + 1]}`);
      modelIdx++;
      continue;
    }
    // Free tier: brief rate limits and overloads are common, so retry a couple of times
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
      continue;
    }
    if (res.status === 429) throw new AIError('Kin hit the free Gemini rate limit. Wait a minute and try again.', 429);
    throw new AIError(json?.error?.message || `Gemini request failed (${res.status})`, res.status);
  }
  throw new AIError('Gemini is busy right now. Please try again in a minute.', 503);
}

const textOf = (parts = []) => parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n').trim();

async function runAgent(contents, touched, steps) {
  for (let i = 0; i < 16; i++) {
    const json = await generate({
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents,
      tools,
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    });
    const cand = json.candidates?.[0];
    if (!cand?.content?.parts?.length) {
      return json.promptFeedback?.blockReason || cand?.finishReason === 'SAFETY'
        ? 'Sorry, I can’t help with that one. I can help with the care schedule, the pool and payments.'
        : 'I didn’t get an answer back. Please try again.';
    }
    // Keep the model's turn exactly as received: it can carry thought signatures that must be sent back
    contents.push(cand.content);
    const calls = cand.content.parts.filter((p) => p.functionCall);
    if (!calls.length) return textOf(cand.content.parts);

    const responses = calls.map(({ functionCall: fc }) => {
      let out;
      try { out = runTool(fc.name, fc.args || {}, touched); } catch (e) { out = { ok: false, reason: e.message }; }
      steps.push({ tool: fc.name, input: fc.args || {}, ok: out?.ok !== false });
      return { functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: { result: out } } };
    });
    contents.push({ role: 'user', parts: responses });
    save();
  }
  return '';
}

export async function chat({ sessionId, message, viewerId }) {
  if (!aiEnabled) {
    return { sessionId, reply: 'Kin is offline: add a free GEMINI_API_KEY (from aistudio.google.com) to the .env file and restart the server to turn on the AI care agent.', touched: [], approvals: [] };
  }
  const id = sessionId && sessions.has(sessionId) ? sessionId : newId('chat');
  const contents = sessions.get(id) || [];
  sessions.set(id, contents);
  const viewer = care.person(viewerId)?.name || 'a family member';
  contents.push({ role: 'user', parts: [{ text: `[${viewer} is writing. Now: ${nowLocal()} (${today()})]\n\n${message}` }] });

  const touched = new Set();
  const approvalsBefore = new Set(db().approvals.map((a) => a.id));
  const steps = [];
  const reply = (await runAgent(contents, touched, steps))
    || 'I made the changes above but ran out of steps before writing a summary. Check the calendar for details.';
  save();
  const approvals = db().approvals.filter((a) => !approvalsBefore.has(a.id));
  return { sessionId: id, reply, touched: [...touched], approvals, steps };
}

export async function summarizeCare(days = 7) {
  const s = db();
  const from = `${addDays(today(), -days)}T00:00:00`;
  const notes = s.careNotes.filter((n) => n.at >= from).map((n) => ({ when: n.at, by: care.person(n.authorId)?.name, mood: n.mood, meals: n.meals, meds: n.meds, text: n.text }));
  if (!notes.length) return { text: 'No caregiver notes in the last week yet.' };
  if (!aiEnabled) return { text: 'Add a free GEMINI_API_KEY to get an AI summary of the care notes.', notes };
  const json = await generate({
    systemInstruction: { parts: [{ text: `You write a short weekly update for siblings who share care of their mother, ${s.family.careRecipient}, based on caregiver shift notes. Warm, factual, under 120 words. Start with one sentence on how she has been overall, then "Worth watching:" with at most 3 bullets (lines starting with "- ") for patterns that may need attention (meals, mood, pain, meds). Do not diagnose; suggest a gentle next step where useful. Plain text, no headings.` }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(notes) }] }],
  });
  return { text: textOf(json.candidates?.[0]?.content?.parts) || 'No summary came back. Please try again.' };
}
