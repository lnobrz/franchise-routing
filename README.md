# Franchise Lead Routing

A rebuild of a lead routing system I originally built for a US franchise company,
rewritten from scratch with fake data because the client work is under NDA.

When a prospect submits the franchise inquiry form in GoHighLevel, this service
decides, in one flow, whether the franchise can legally be offered to them, which
territory they belong to, whether they qualify financially, and which sales rep
gets the lead. Then it writes the result back to the CRM and explains the decision
in a note on the contact.

GoHighLevel workflows can't do this on their own: the rules need external data
(state registrations, territory map, rep capacity), date math, live counts across
the team, and several rules with priorities between them.

## The flow

```
GHL form submitted
  -> GHL workflow: webhook (with shared secret)
    -> claim event (idempotent: retries and double submits stop here)
    -> AI reads the free-text answer (optional, validated)
    -> merge with the form fields (form wins, conflicts go to a human)
    -> load states, ZIP, territory, reps from Supabase
    -> decide()  pure function, no I/O
    -> reserve_rep()  atomic seat reservation in Postgres
    -> write to GHL: opportunity first, then assign contact, tags, decision note
    -> log the decision in Supabase

GHL opportunity won / lost / abandoned / reassigned
  -> GHL workflow: webhook -> opportunity_changed()  the rep's seat is given back or moved
```

## Why it doesn't depend on timing

The original version was a chain of separate automations. One step chose the rep
while another step was still saving the data it needed, so a few leads went to
the wrong rep. The quick fix at the time was a wait step between automations.

This version removes the problem instead of waiting it out:

- **One flow.** The webhook carries the submitted answers, so nothing reads a field
  another automation might still be writing.
- **Decide in memory.** `decide()` in `src/rules/decide.ts` is a pure function.
  Same input, same output, fully unit tested.
- **Atomic capacity.** `reserve_rep()` in `supabase/schema.sql` locks the candidate
  reps in Postgres and takes the seat in a single transaction. Two leads arriving
  at the same instant can't both see "7 of 8" and both take the last seat.
- **Idempotent.** Each submission gets a key (contact id + hash of the answers).
  A GHL retry or a double click is recognized and ignored.
- **Safe failure.** Each event has a status (`processing`, `writing_crm`, `done`,
  `needs_attention`) and a claim id. If something fails before the CRM is touched,
  the claim and the seat are given back and GHL's retry starts clean. Once the
  opportunity exists, a failure is never retried automatically (that could assign
  the lead twice): the contact gets the `routing:needs-attention` tag and a note.
- **Nothing lost on a restart.** Every `RELEASE_JOB_MINUTES` a recovery job looks
  for events unfinished after `STALE_EVENT_MINUTES`. One that never reached the CRM
  is routed again (its old claim and seat are taken over atomically); one that
  stopped while writing the CRM is flagged for a person the same way.
- **Seats come back.** Each seat is recorded in `rep_seats` with its opportunity.
  When the opportunity is won, lost or abandoned the seat is freed; when it is
  reassigned the seat moves to the new rep. Without this, every rep would end up
  "full" and all leads would go to review.

## The rules

**Legal check (`src/rules/legal.ts`).** In franchise registration states the
franchisor needs an active registration before it can even offer a franchise. The
law applies if the buyer lives in the state *or* the unit will be opened there, so
both states are checked:

| State status | Result |
|---|---|
| no registration required | ok |
| active, not expired | ok |
| renewal pending, expired, or active past its date | **waiting**: lead is parked, not added to the pipeline, and re-routed automatically when ops marks the state active again |
| never registered | **blocked** |
| unit state has no franchise units left | **blocked** |

**Territory (`decide.ts`).** The ZIP maps to a territory. Sold or reserved
territories are blocked. A ZIP in a different state than the unit state goes to
human review.

**Financials.** Liquid capital and net worth are both checked against the territory's
minimums; if either is missing or unreadable, the lead goes to a human. Dropdown
answers are read conservatively: a range like "$100,000 - $250,000" counts as its
lower bound, "$1M+" as $1M, and "Under $50k" (no lower bound) as unreadable.

**Rep ranking (`src/rules/reps.ts`).** Active reps covering the unit state, then:
language match (falls back to English if nobody speaks it), territory owner first,
then reps on shift right now in their own time zone, then lowest load.

## Where the AI is used, and where it isn't

The AI never makes a routing or legal decision. Those stay deterministic.

It reads the free-text "About you" answer, where people write things like *"I live
in Newark but want to open in Miami, around 33130, I have about $250k"*, and turns
it into structured data (`src/ai/extract.ts`). To keep it reliable:

- Structured outputs (Responses API) with a fixed JSON schema, temperature 0 on models that accept it
- The prompt asks for `null` instead of guessing
- The result is validated again with zod on our side
- A confidence score: below the threshold, its answers are ignored
- Form fields always win; if the text contradicts the form, the lead goes to a human
- If the API fails, routing continues with the form fields only

## Data and maintenance

Reference data lives in Supabase so a non-technical ops team can maintain it in
the table editor without touching code:

| Table | What ops edit there |
|---|---|
| `states` | registration status and expiry date, total and sold units |
| `territories` | status, owner rep, financial minimums |
| `zip_codes` | which territory each ZIP belongs to |
| `reps` | covered states, languages, time zone, hours, capacity, active flag |

Database constraints reject invalid edits (sold units above the total, an active
registration without an expiry date, unknown languages). Reps are linked to GHL
users by e-mail, so there are no ids to copy around.

`routing_decisions` keeps every decision with its reasons, so "why did this lead
go to Carlos last week?" is one query.

## Setup

1. **Supabase:** run `supabase/schema.sql`, then `supabase/seed.sql` in the SQL editor.
   A database created with an earlier version only needs
   `supabase/migrations/001_seats_and_event_status.sql`; afterwards set each rep's
   `open_leads` to their real number of open leads, since seats taken before the
   migration aren't linked to an opportunity.
2. **GoHighLevel:** custom fields, the inquiry form, a pipeline, and users whose
   e-mails match the `reps` table. Create a Private Integration token with
   contacts, opportunities, users and custom fields scopes.
3. **Environment:** `cp .env.example .env` and fill it in. Node loads it natively.
4. **Run:** Node 22+ (24 LTS recommended), then `npm install && npm run build && npm start` (or `npm run dev`).

Stack: TypeScript 7 (strict), Node ESM, Express 5, Zod 4, OpenAI SDK 7, Supabase, Vitest.

### GHL workflow

Trigger: *Form Submitted* (the inquiry form). Action: *Webhook*, `POST` to
`https://<your-domain>/webhooks/lead`, header `x-webhook-secret: <WEBHOOK_SECRET>`,
body:

```json
{
  "contact_id": "{{contact.id}}",
  "first_name": "{{contact.first_name}}",
  "last_name": "{{contact.last_name}}",
  "residence_state": "{{contact.residence_state}}",
  "unit_state": "{{contact.unit_state}}",
  "desired_territory_zip": "{{contact.desired_territory_zip}}",
  "liquid_capital": "{{contact.liquid_capital}}",
  "net_worth": "{{contact.net_worth}}",
  "preferred_language": "{{contact.preferred_language}}",
  "about_you": "{{contact.about_you}}"
}
```

If the webhook action can't set headers, the fields and a `webhook_secret` can go
in its *Custom Data*; the server reads both shapes.

A second workflow gives seats back. Triggers, all filtered to the routing
pipeline: *Opportunity Status Changed* moved to Won, to Lost and to Abandoned
(one trigger each, GHL takes one status per trigger), and *Opportunity Changed*
with *Assigned to* has changed. Action: *Webhook*, `POST` to
`https://<your-domain>/webhooks/opportunity`, header `x-webhook-secret`, and
this custom data:

| Key | Value |
|---|---|
| `opportunity_id` | `{{opportunity.id}}` |
| `status` | `{{opportunity.status}}` |
| `assigned_to_user_id` | Opportunity > Assigned To (ID) |

GHL's opportunity fields give the assigned user's id, not their e-mail; the server
looks the id up in the CRM's user list (`assigned_to_email` is accepted too).
Keep *Allow re-entry* and *Allow multiple opportunities* on in the workflow settings.

`status` is one of `open`, `won`, `lost`, `abandoned`. The call is idempotent, so
repeated or overlapping triggers are harmless. Contacts tagged
`routing:needs-attention` are worth a smart list or a notification in GHL.

### Deploying on a VPS

```bash
npm ci && npm run build
pm2 start deploy/ecosystem.config.cjs
# HTTPS: point a subdomain at the server and use deploy/Caddyfile
```

The app listens on `127.0.0.1` by default (`HOST`), so only Caddy on the same
machine can reach it.

## Testing

```bash
npm test              # rules and orchestration (no network)
npm run simulate      # creates test contacts in GHL and fires real webhooks
npm run simulate -- race
```

The simulator covers: the AI filling gaps from a Spanish free-text answer, a lead
touching two states where one has a pending renewal, a sold-out state, a
form/text contradiction, and two leads racing for a rep's last seat.

## Layout

```
src/
  server.ts              webhook endpoints, auth, job timer
  router.ts              the single flow, start to finish
  rules/decide.ts        the routing decision (pure)
  rules/legal.ts         two-state franchise law check
  rules/reps.ts          rep ranking, shifts, languages
  rules/merge.ts         form + AI merge, conflict detection
  rules/normalize.ts     messy input -> clean values
  ai/extract.ts          OpenAI structured extraction
  jobs/releaseWaiting.ts re-routes parked leads
  jobs/recoverStuck.ts   re-runs or flags events a restart interrupted
  ghl.ts                 GoHighLevel API client with retries
  db.ts                  Supabase access
supabase/
  schema.sql             tables, constraints, claims, seats, RLS
  migrations/            upgrades for databases created earlier
  seed.sql               demo data
scripts/simulate.ts      end-to-end scenarios against a running server
```
