// Demo data: three siblings caring for their mother, four paid caregivers,
// ten days of history and two weeks ahead. Dates are relative to "today" so the demo never goes stale.
import { today, addDays, dayOfWeek, at, hoursBetween } from './time.js';

// Each person's PayPal email: a specific env var, else one shared sandbox Personal account, else a placeholder.
// Payouts to an email with no sandbox account show as UNCLAIMED, so set SANDBOX_PERSONAL_EMAIL for the demo.
const env = (k, d) => process.env[k] || process.env.SANDBOX_PERSONAL_EMAIL || d;

export function buildSeed() {
  const t = today();

  const siblings = [
    { id: 'sib_anika', name: 'Anika', email: env('SIB_ANIKA_EMAIL', 'anika@kinshift.example'), weight: 0.3, color: 'violet',
      about: 'Lives 15 minutes from Mom. Covers Saturdays herself.',
      canCover: [{ days: [6], from: '08:00', to: '20:00' }] },
    { id: 'sib_rohan', name: 'Rohan', email: env('SIB_ROHAN_EMAIL', 'rohan@kinshift.example'), weight: 0.4, color: 'indigo',
      about: 'Lives in London. Cannot cover shifts in person, so pays a larger share.',
      canCover: [] },
    { id: 'sib_meera', name: 'Meera', email: env('SIB_MEERA_EMAIL', 'meera@kinshift.example'), weight: 0.3, color: 'purple',
      about: 'Lives an hour away. Free on Wednesday afternoons.',
      canCover: [{ days: [3], from: '14:00', to: '20:00' }] },
  ];

  const caregivers = [
    { id: 'cg_maria', name: 'Maria Lopez', email: env('CG_MARIA_EMAIL', 'maria@kinshift.example'), rate: 22, maxHoursPerWeek: 40, color: 'blue',
      about: 'Home health aide, 8 years. Mom’s main weekday caregiver.',
      availability: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '20:00' }] },
    { id: 'cg_grace', name: 'Grace Kim', email: env('CG_GRACE_EMAIL', 'grace@kinshift.example'), rate: 24, maxHoursPerWeek: 30, color: 'teal',
      about: 'Certified nursing assistant. Handles medication days.',
      availability: [{ days: [2, 4, 6, 0], from: '08:00', to: '20:00' }] },
    { id: 'cg_james', name: 'James Okafor', email: env('CG_JAMES_EMAIL', 'james@kinshift.example'), rate: 20, maxHoursPerWeek: 20, color: 'cyan',
      about: 'Nursing student. Afternoons only.',
      availability: [{ days: [1, 3, 5, 6], from: '14:00', to: '20:00' }] },
    { id: 'cg_daniel', name: 'Daniel Reyes', email: env('CG_DANIEL_EMAIL', 'daniel@kinshift.example'), rate: 26, maxHoursPerWeek: 12, color: 'lime',
      about: 'Backup caregiver from a local agency. Mornings, any day, at a higher rate.',
      availability: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '14:00' }] },
  ];

  // Weekly pattern: [AM 08–14, PM 14–20] per weekday (0 = Sunday)
  const pattern = {
    1: ['cg_maria', 'cg_james'],
    2: ['cg_maria', 'cg_grace'],
    3: ['cg_maria', 'sib_meera'],
    4: ['cg_maria', 'cg_grace'],
    5: ['cg_maria', 'cg_james'],
    6: ['sib_anika', 'sib_anika'],
    0: ['cg_grace', 'cg_grace'],
  };

  const timeOff = [];
  const nextDow = (dow) => { for (let i = 0; i < 7; i++) if (dayOfWeek(addDays(t, i)) === dow) return addDays(t, i); };
  const firstSat = nextDow(6);
  const firstTue = nextDow(2) === t ? addDays(t, 7) : nextDow(2);
  timeOff.push({ id: 'off_anika', personType: 'sibling', personId: 'sib_anika', from: at(firstSat, '00:00'), to: at(addDays(firstSat, 1), '00:00'), reason: 'At a wedding out of town' });
  timeOff.push({ id: 'off_grace', personType: 'caregiver', personId: 'cg_grace', from: at(firstTue, '14:00'), to: at(firstTue, '20:00'), reason: 'Her own doctor appointment' });

  const shifts = [];
  const payouts = [];
  const careNotes = [];
  const people = Object.fromEntries([...siblings, ...caregivers].map((p) => [p.id, p]));
  let n = 0;

  const notes = [
    { mood: 'Cheerful', meals: 'Ate breakfast and lunch', meds: 'All morning meds taken', text: 'Leela was in good spirits. We did her stretching exercises and she called Rohan on video.' },
    { mood: 'Tired', meals: 'Skipped lunch, said she wasn’t hungry', meds: 'Taken', text: 'Napped most of the afternoon. Mild complaint about knee pain when walking to the garden.' },
    { mood: 'Calm', meals: 'Good dinner, small lunch', meds: 'Evening meds taken', text: 'Watched her favourite show and folded laundry together. Knee still a bit sore.' },
    { mood: 'A bit low', meals: 'Skipped lunch again', meds: 'Taken', text: 'Quiet day. She asked when Anika is visiting next. Encouraged water — drank 4 glasses.' },
  ];

  for (let d = -10; d <= 13; d++) {
    const date = addDays(t, d);
    const dow = dayOfWeek(date);
    [['08:00', '14:00'], ['14:00', '20:00']].forEach(([from, to], i) => {
      const start = at(date, from);
      const end = at(date, to);
      let assignee = pattern[dow][i];
      // Week after next isn't planned yet (only siblings have committed)
      if (d >= 7 && assignee.startsWith('cg_')) assignee = null;
      // Respect seeded time off → those shifts start open
      if (assignee && timeOff.some((o) => o.personId === assignee && start < o.to && o.from < end)) assignee = null;

      const p = assignee ? people[assignee] : null;
      const shift = {
        id: `sh_${String(++n).padStart(3, '0')}`,
        start, end,
        assigneeType: p ? (assignee.startsWith('cg_') ? 'caregiver' : 'sibling') : null,
        assigneeId: assignee,
        status: p ? 'scheduled' : 'open',
        rate: p && p.rate ? p.rate : null,
        note: '',
      };

      const isPast = d < 0;
      if (isPast && shift.assigneeType === 'sibling') shift.status = 'done';
      if (isPast && shift.assigneeType === 'caregiver') {
        const amount = +(hoursBetween(start, end) * p.rate).toFixed(2);
        if (d <= -4) {
          shift.status = 'paid';
          const payout = { id: `po_seed_${n}`, shiftIds: [shift.id], caregiverId: p.id, amount, batchId: `SEED-HISTORY-${n}`, status: 'SUCCESS', createdAt: at(addDays(date, 1), '09:00'), seeded: true };
          payouts.push(payout);
          shift.payoutId = payout.id;
        } else {
          shift.status = 'awaiting_approval';
        }
      }
      if (isPast && d >= -5 && shift.assigneeType === 'caregiver') {
        const nt = notes[careNotes.length % notes.length];
        careNotes.push({ id: `note_${n}`, shiftId: shift.id, authorId: p.id, at: end, ...nt });
      }
      shifts.push(shift);
    });
  }

  const contributions = [
    { id: 'ct_seed_1', siblingId: 'sib_rohan', amount: 1100, method: 'paypal_order', paypalId: 'SEED-ORDER-1', status: 'COMPLETED', at: at(addDays(t, -20), '10:12'), seeded: true },
    { id: 'ct_seed_2', siblingId: 'sib_meera', amount: 800, method: 'paypal_order', paypalId: 'SEED-ORDER-2', status: 'COMPLETED', at: at(addDays(t, -18), '19:40'), seeded: true },
    { id: 'ct_seed_3', siblingId: 'sib_anika', amount: 700, method: 'paypal_order', paypalId: 'SEED-ORDER-3', status: 'COMPLETED', at: at(addDays(t, -15), '08:05'), seeded: true },
  ];

  return {
    version: 1,
    seededOn: t,
    family: { name: 'The Rao family', careRecipient: 'Leela (Mom)', inKindRate: 22, coverage: { from: '08:00', to: '20:00' }, lowBalanceDays: 7 },
    siblings, caregivers, timeOff, shifts, payouts, careNotes, contributions,
    invoices: [],
    approvals: [],
    activity: [{ id: 'act_seed', at: at(t, '07:00'), kind: 'info', text: 'Care pool set up for Leela. Three siblings, four caregivers.' }],
  };
}
