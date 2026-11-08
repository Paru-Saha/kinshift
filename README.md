# Kinshift: family care, shared fairly

**Kinshift is an AI care coordinator plus a shared PayPal care pool for siblings looking after an aging parent.**

When parents need daily care, adult children end up running a small business with no tools for it. They juggle caregiver shifts in group chats, someone always pays more than their share, and when a caregiver calls in sick, one sibling spends the evening on the phone. Kinshift gives the family:

- **One schedule** (Bryntum Calendar and Scheduler) showing every care shift: who covers it, what it costs, and which hours nobody is covering.
- **A shared care pool on PayPal.** Siblings add money with PayPal Checkout, caregivers are paid with PayPal Payouts after each finished shift, and anyone behind on their share gets a PayPal invoice.
- **Kin, an AI agent (Google Gemini)** that actually runs the logistics. Tell it "Maria is sick Thursday and Friday" and it records the absence, finds who can cover each shift (availability, weekly hour limits, cost), reassigns the shifts, checks whether the pool can afford the next 7 days, and drafts fair top-up invoices.
- **Fairness that counts care, not just money.** Hours a sibling covers in person are valued at an agreed hourly rate, so the sibling who lives nearby and the one who lives abroad both contribute fairly.
- **A human in the loop for every payment.** Kin can change the schedule, but it can't move money. Every payout and invoice becomes an approval card that a family member has to click.

> Built for the PayPal AI Hackathon 2026.

---

## How it works

| Step | What happens | Tech |
|---|---|---|
| 1. Siblings fund the pool | "Add money" uses PayPal Smart Buttons. The server creates and captures the order. | PayPal **Orders v2** + **JavaScript SDK** |
| 2. Shifts are planned | Calendar (week/month/list) and Team timeline (one row per person). Drag a shift to move or reassign it; every change is validated on the server. | **Bryntum Calendar** + **Bryntum Scheduler** |
| 3. Plans change | Ask Kin in plain English. It calls tools to read the schedule, find candidates, assign shifts, and check the money. | **Gemini API** function calling (`gemini-3.5-flash-lite`, free tier) |
| 4. A caregiver finishes a shift | They tap their shift, leave a care note (mood, meals, meds), and the shift moves to "awaiting pay". | |
| 5. Family approves | One click sends a PayPal payout from the pool to the caregiver. If the pool is short, the payment is blocked and Kin proposes top-ups. | PayPal **Payouts** |
| 6. Someone falls behind | Kin computes each sibling's fair share (money plus in-kind hours), splits the shortfall, and drafts invoices for approval. | PayPal **Invoicing v2** |
| 7. Status comes back | Invoice payments and payout status are read from PayPal by webhook, or by polling when no webhook is set. | PayPal **Webhooks** (verified) |
| 8. Weekly update | Kin reads the week's caregiver notes and writes a short family update that flags patterns (e.g. skipped lunches). | Gemini API |

### AI tools used
- **Google Gemini API, model `gemini-3.5-flash-lite` (free tier).** Kin is a function-calling agent with 12 tools: `get_overview`, `list_people`, `list_shifts`, `find_coverage_gaps`, `assign_shifts`, `unassign_shift`, `mark_unavailable`, `create_shift`, `get_fair_share`, `request_contribution`, `queue_caregiver_payouts`, `get_care_notes`. The agent loop lives in [`lib/agent.js`](lib/agent.js). It calls the Gemini REST API directly, sends the model's turns back unchanged (including thought signatures), and falls back to another free model if one isn't available.
- Scheduling rules (availability, time off, weekly hour caps, overlaps) are enforced in code ([`lib/care.js`](lib/care.js)), not left to the model. Kin chooses; the server validates.
- Money tools only create approval records. Real PayPal calls happen in [`lib/money.js`](lib/money.js), and only after a family member clicks Approve.
- The weekly care summary is a separate single Gemini call.

### Sponsor tools used
- **Bryntum Calendar.** Week, day, month and list views of all care shifts, colored by person and status, with drag-to-move.
- **Bryntum Scheduler** (Team timeline). One row per caregiver and sibling plus a "Needs cover" row, so gaps and workloads are obvious. Dragging a shift onto another person reassigns it, and the server validates the move.

---

## Run it locally

Requires Node.js 20+.

```bash
git clone <this repo>
cd kinshift
npm install
cp .env.example .env    # then fill in the keys below
npm start               # http://localhost:3000
```

The app runs **with no keys at all**: PayPal calls are simulated (IDs start with `SIM-`) and Kin shows as offline. Add keys to turn on the real integrations:

| Variable | Where to get it |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials → **Sandbox** → create a Merchant app. Under the app's **Features**, make sure **Payouts** and **Invoicing** are ticked. |
| `GEMINI_API_KEY` | Free: [aistudio.google.com](https://aistudio.google.com) → Get API key |
| `SANDBOX_PERSONAL_EMAIL` (recommended) | developer.paypal.com → Testing Tools → Sandbox Accounts → your **Personal** account email. Payouts and invoices go here, so they show as SUCCESS instead of UNCLAIMED. (`CG_*_EMAIL` and `SIB_*_EMAIL` set people individually.) |
| `PAYPAL_WEBHOOK_ID` (optional) | Add a webhook on your sandbox app pointing to `https://<host>/api/paypal/webhook` for `PAYMENT.PAYOUTS-ITEM.*` and `INVOICING.INVOICE.PAID` |

Demo data (one family, four caregivers, 10 days of history, 2 weeks ahead) is generated relative to today, so it never goes stale. **Updates → Everything that happened → Reset demo data** restores it.

### Paying in the PayPal sandbox
On the **Money** tab, click the PayPal button and log in with any sandbox **Personal** account (developer.paypal.com → Sandbox Accounts → View/Edit for the email and password). The money is captured into your sandbox business account and shows up in the pool.

---

## Try it as a judge (5 minutes)

1. **Viewing as: Anika.** The dashboard shows the pool will run short and there are open shifts.
2. Ask Kin: **"Maria is sick Thursday and Friday. Sort out the schedule."** Watch the shifts update on the calendar. Grace takes Thursday; Daniel, the higher-cost backup, takes Friday morning.
3. Ask Kin: **"Will the pool cover the next 7 days? If not, ask for fair top-ups."** Approve the cards it creates (Money tab → Waiting for your OK).
4. Click a finished orange shift → **Approve & pay with PayPal**, which sends a Payouts call.
5. Switch **Viewing as** to a caregiver, click today's shift → **Finish shift & send note**.
6. **Updates → Write this week's update.**
7. **Money → Fair share** shows how hands-on care and money are counted together.

---

## Project structure

```
server.js          Express API + static hosting
lib/paypal.js      PayPal REST client: Orders v2, Payouts, Invoicing v2, webhook verification (sandbox)
lib/money.js       Approved money movements: payouts, invoices, contributions, status sync
lib/care.js        Scheduling rules, coverage gaps, pool forecast, fair-share maths, approval queue
lib/agent.js       Kin: Gemini function-calling agent + weekly care summary
lib/seed.js        Demo family
public/            Front end: vanilla JS + Bryntum Calendar/Scheduler + PayPal JS SDK
```

## Limitations and next steps
- Single family, file-based storage, no login. The "Viewing as" switcher stands in for accounts.
- Payouts in the sandbox go to sandbox emails; production would need PayPal Payouts approval and caregiver onboarding.
- Next: recurring contributions with PayPal Subscriptions, SMS/WhatsApp access to Kin for caregivers, and shift-level evidence (check-in location) before payouts.

## License
[MIT](LICENSE). The Bryntum components are installed from npm under Bryntum's trial license and are not included in this repository.
