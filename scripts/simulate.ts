// Creates test contacts in GHL and fires the webhook for each scenario,
// exactly like the workflow would, then checks the outcome. Exits with 1 if
// any scenario routes differently than expected. Seats taken by the run are
// given back at the end, so running it doesn't fill the reps.
//
//   npm run simulate            all scenarios
//   npm run simulate -- race    one scenario by name
//
// SIMULATE_URL overrides the target (default: http://localhost:PORT/webhooks/lead).
// The expectations match supabase/seed.sql.

import { loadConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { GhlClient } from '../src/ghl.js';
import type { Outcome } from '../src/types.js';

const config = loadConfig();
const ghl = new GhlClient(config.GHL_TOKEN, config.GHL_LOCATION_ID);
const db = new Db(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY);
const target = process.env.SIMULATE_URL ?? `http://localhost:${config.PORT}/webhooks/lead`;

interface TestLead {
  first_name: string;
  last_name: string;
  residence_state?: string;
  unit_state?: string;
  desired_territory_zip?: string;
  liquid_capital?: string;
  net_worth?: string;
  preferred_language?: string;
  about_you?: string;
}

type Result = { status: string; outcome?: Outcome; rep?: string; reasons?: string[] };

interface Scenario {
  expect: string;
  outcome: Outcome;
  rep?: string;
  reason?: RegExp; // must appear in the decision reasons
  lead: TestLead;
}

// A qualified Miami lead; scenarios change one thing at a time.
const MIAMI: Omit<TestLead, 'first_name' | 'last_name'> = {
  residence_state: 'FL',
  unit_state: 'FL',
  desired_territory_zip: '33130',
  liquid_capital: '200000',
  net_worth: '600000',
};

const SCENARIOS: Record<string, Scenario> = {
  'ai-fills-gaps': {
    expect: 'AI reads unit state, ZIP and language from the Spanish text -> Ana (speaks Spanish, owns MIA-01)',
    outcome: 'assigned',
    rep: 'Ana Rodriguez',
    reason: /Language Spanish/,
    lead: {
      first_name: 'Maria',
      last_name: 'Gonzalez',
      residence_state: 'NJ',
      liquid_capital: '250000',
      net_worth: '900000',
      about_you:
        'Vivo en Newark, New Jersey, pero quiero abrir la franquicia en Miami, Florida, cerca del código postal 33130. ' +
        'Tengo unos 250 mil dólares disponibles. Prefiero hablar en español.',
    },
  },
  'two-states-waiting': {
    expect: 'Lives in NJ (fine) but unit in NY (renewal pending) -> waiting, no opportunity',
    outcome: 'waiting_registration',
    reason: /NY: registration renewal pending/,
    lead: {
      first_name: 'John',
      last_name: 'Miller',
      residence_state: 'New Jersey',
      unit_state: 'NY',
      desired_territory_zip: '10001',
      liquid_capital: '$300k',
      net_worth: '1.2M',
    },
  },
  'sold-out': {
    expect: 'Arizona has no units left -> blocked',
    outcome: 'blocked',
    reason: /no franchise units left/,
    lead: { first_name: 'Emily', last_name: 'Davis', residence_state: 'AZ', unit_state: 'AZ', desired_territory_zip: '85004', liquid_capital: '200000', net_worth: '700000' },
  },
  'not-registered': {
    expect: 'Lives in Washington (never registered) -> blocked, even with the unit in Florida',
    outcome: 'blocked',
    reason: /WA: franchise not registered/,
    lead: { first_name: 'Sim', last_name: 'NotRegistered', ...MIAMI, residence_state: 'WA' },
  },
  'below-minimum': {
    expect: '$50k liquid capital, MIA-01 asks $150k -> blocked',
    outcome: 'blocked',
    reason: /below \$150,000 minimum/,
    lead: { first_name: 'Sim', last_name: 'BelowMinimum', ...MIAMI, liquid_capital: '50000' },
  },
  'sold-territory': {
    expect: 'Orlando ZIP, territory ORL-01 is sold -> blocked',
    outcome: 'blocked',
    reason: /ORL-01 .* is sold/,
    lead: { first_name: 'Sim', last_name: 'SoldTerritory', ...MIAMI, desired_territory_zip: '32801' },
  },
  conflict: {
    expect: 'Form says Texas, free text says Miami -> needs_review, nobody guesses',
    outcome: 'needs_review',
    reason: /form says TX, free text says FL/,
    lead: {
      first_name: 'Kevin',
      last_name: 'Brown',
      residence_state: 'TX',
      unit_state: 'TX',
      desired_territory_zip: '77002',
      liquid_capital: '180000',
      net_worth: '500000',
      about_you: 'I live in Houston but I really want to open my location in Miami, Florida.',
    },
  },
  'missing-unit-state': {
    expect: 'No unit state, nothing in the text either -> needs_review',
    outcome: 'needs_review',
    reason: /Missing unit state/,
    lead: { first_name: 'Sim', last_name: 'MissingUnit', residence_state: 'FL', liquid_capital: '200000', net_worth: '600000' },
  },
  'zip-other-state': {
    expect: 'Unit in Florida, ZIP in Houston -> needs_review',
    outcome: 'needs_review',
    reason: /ZIP 77002 is in TX but unit state is FL/,
    lead: { first_name: 'Sim', last_name: 'ZipOtherState', ...MIAMI, desired_territory_zip: '77002' },
  },
  'zip-typo': {
    expect: 'ZIP "3313O" (letter O) -> needs_review, never routed by state without the minimums',
    outcome: 'needs_review',
    reason: /not a valid ZIP/,
    lead: { first_name: 'Sim', last_name: 'ZipTypo', ...MIAMI, desired_territory_zip: '3313O' },
  },
  'no-financials': {
    expect: 'No liquid capital or net worth for a territory with minimums -> needs_review',
    outcome: 'needs_review',
    reason: /Financials incomplete/,
    lead: { first_name: 'Sim', last_name: 'NoFinancials', residence_state: 'FL', unit_state: 'FL', desired_territory_zip: '33130' },
  },
  'messy-input': {
    expect: '"florida", "Fl.", ZIP+4 and "$200k" are all read -> Ana',
    outcome: 'assigned',
    rep: 'Ana Rodriguez',
    lead: { first_name: 'Sim', last_name: 'MessyInput', residence_state: 'florida', unit_state: 'Fl.', desired_territory_zip: '33131-1234', liquid_capital: '$200k', net_worth: '600,000' },
  },
  'language-fallback': {
    expect: 'Portuguese, but nobody in Florida speaks it -> Ana in English, with a note',
    outcome: 'assigned',
    rep: 'Ana Rodriguez',
    reason: /no rep for FL speaks it/,
    lead: { first_name: 'Sim', last_name: 'Portuguese', ...MIAMI, preferred_language: 'Portuguese' },
  },
};

async function createContact(lead: TestLead, fieldIds: Map<string, string>): Promise<string> {
  const slug = `${lead.first_name}.${lead.last_name}`.toLowerCase();
  const customFields = Object.entries(lead)
    .filter(([key, value]) => !['first_name', 'last_name'].includes(key) && value)
    .map(([key, value]) => ({ id: fieldIds.get(`contact.${key}`) ?? '', field_value: String(value) }))
    .filter((f) => f.id);

  return ghl.upsertContact({
    firstName: lead.first_name,
    lastName: lead.last_name,
    email: `${slug}+${Date.now()}@example.com`,
    customFields,
  });
}

async function fire(contactId: string, lead: TestLead): Promise<Result> {
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': config.WEBHOOK_SECRET },
    body: JSON.stringify({ contact_id: contactId, ...lead }),
  });
  return res.json() as Promise<Result>;
}

let failures = 0;
const taken: string[] = []; // contacts that got a seat, given back at the end

function check(name: string, scenario: Pick<Scenario, 'expect' | 'outcome' | 'rep' | 'reason'>, result: Result) {
  const problems = [
    result.outcome !== scenario.outcome && `outcome ${result.outcome ?? result.status}, expected ${scenario.outcome}`,
    scenario.rep && result.rep !== scenario.rep && `rep ${result.rep ?? 'none'}, expected ${scenario.rep}`,
    scenario.reason && !result.reasons?.some((r) => scenario.reason!.test(r)) && `no reason matching ${scenario.reason}`,
  ].filter(Boolean);
  if (problems.length) failures++;

  console.log(`\n${problems.length ? 'FAIL' : 'PASS'}  ${name}`);
  console.log(`  expected: ${scenario.expect}`);
  console.log(`  got:      ${result.outcome ?? result.status}${result.rep ? ` -> ${result.rep}` : ''}`);
  for (const p of problems) console.log(`  !! ${p}`);
  if (problems.length) for (const reason of result.reasons ?? []) console.log(`     - ${reason}`);
}

// The same contact submits again with one answer changed: never a second seat.
async function resubmit(fieldIds: Map<string, string>) {
  const lead: TestLead = { first_name: 'Sim', last_name: 'Resubmit', ...MIAMI };
  const contactId = await createContact(lead, fieldIds);
  const first = await fire(contactId, lead);
  if (first.rep) taken.push(contactId);
  check('resubmit (first)', { expect: 'qualified Miami lead -> Ana', outcome: 'assigned', rep: 'Ana Rodriguez' }, first);
  const second = await fire(contactId, { ...lead, net_worth: '650000' });
  check(
    'resubmit (again, one answer changed)',
    { expect: 'already holds a seat -> needs_review, not assigned twice', outcome: 'needs_review', reason: /already has an open assignment/ },
    second,
  );
}

async function race(fieldIds: Map<string, string>) {
  // Ana has 1 seat left. Two Miami leads arrive at the same instant.
  const ana = await db.repByEmail('ana.rodriguez@example.com');
  if (!ana) throw new Error('Ana not found in reps');
  const original = ana.open_leads;
  await db.setOpenLeads(ana.email, ana.max_open_leads - 1);

  const ids: string[] = [];
  try {
    const a: TestLead = { first_name: 'Laura', last_name: 'Perez', ...MIAMI, desired_territory_zip: '33131' };
    const b: TestLead = { first_name: 'Daniel', last_name: 'Cruz', ...MIAMI, desired_territory_zip: '33131' };
    ids.push(...(await Promise.all([createContact(a, fieldIds), createContact(b, fieldIds)])));

    const results = await Promise.all([fire(ids[0]!, a), fire(ids[1]!, b)]);
    const assigned = results.filter((r) => r.rep === ana.full_name).length;
    const after = await db.repByEmail(ana.email);
    const ok = assigned === 1 && results.some((r) => r.outcome === 'needs_review') && after?.open_leads === ana.max_open_leads;
    if (!ok) failures++;
    console.log(`\n${ok ? 'PASS' : 'FAIL'}  race`);
    console.log(`  expected: Ana has ${ana.max_open_leads - 1} of ${ana.max_open_leads}, two leads at once -> exactly one gets the seat`);
    console.log(`  got:      ${results.map((r) => r.outcome + (r.rep ? ` -> ${r.rep}` : '')).join(' | ')}; Ana ${after?.open_leads} of ${after?.max_open_leads}`);
  } finally {
    for (const id of ids) await db.releaseSeatOfContact(id);
    await db.setOpenLeads(ana.email, original);
  }
}

async function main() {
  const only = process.argv[2];
  const fieldIds = await ghl.customFieldIdsByKey();
  console.log(`target: ${target}`);

  try {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      if (only && only !== name) continue;
      const contactId = await createContact(scenario.lead, fieldIds);
      const result = await fire(contactId, scenario.lead);
      if (result.rep) taken.push(contactId);
      check(name, scenario, result);
    }
    if (!only || only === 'resubmit') await resubmit(fieldIds);
    if (!only || only === 'race') await race(fieldIds);
  } finally {
    for (const id of taken) await db.releaseSeatOfContact(id);
  }

  console.log(`\n${failures === 0 ? 'All scenarios passed.' : `${failures} scenario(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
