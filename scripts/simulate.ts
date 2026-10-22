// Creates test contacts in GHL and fires the webhook for each scenario,
// exactly like the workflow would.
//
//   npm run simulate            all scenarios
//   npm run simulate -- race    only the race condition test
//
// SIMULATE_URL overrides the target (default: http://localhost:PORT/webhooks/lead).

import { loadConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { GhlClient } from '../src/ghl.js';

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

const SCENARIOS: Record<string, { expect: string; lead: TestLead }> = {
  'ai-fills-gaps': {
    expect: 'AI reads unit state, ZIP and language from the Spanish text -> assigned to Ana (speaks Spanish, owns MIA-01)',
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
    expect: 'Lives in NJ (fine) but unit in NY (renewal pending) -> waiting_registration, no opportunity',
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
    lead: {
      first_name: 'Emily',
      last_name: 'Davis',
      residence_state: 'AZ',
      unit_state: 'AZ',
      desired_territory_zip: '85004',
      liquid_capital: '200000',
      net_worth: '700000',
    },
  },
  conflict: {
    expect: 'Form says Texas, free text says Miami -> needs_review, nobody guesses',
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

async function fire(contactId: string, lead: TestLead) {
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': config.WEBHOOK_SECRET },
    body: JSON.stringify({ contact_id: contactId, ...lead }),
  });
  return res.json() as Promise<{ status: string; outcome?: string; rep?: string; reasons?: string[] }>;
}

function print(name: string, expect: string, result: Awaited<ReturnType<typeof fire>>) {
  console.log(`\n=== ${name}`);
  console.log(`expected: ${expect}`);
  console.log(`got:      ${result.outcome ?? result.status}${result.rep ? ` -> ${result.rep}` : ''}`);
  for (const reason of result.reasons ?? []) console.log(`  - ${reason}`);
}

async function race(fieldIds: Map<string, string>) {
  // Ana has 1 seat left. Two Miami leads arrive at the same instant.
  const ana = await db.repByEmail('ana.rodriguez@example.com');
  if (!ana) throw new Error('Ana not found in reps');
  const original = ana.open_leads;
  await db.setOpenLeads(ana.email, ana.max_open_leads - 1);

  const lead = (first: string, last: string): TestLead => ({
    first_name: first,
    last_name: last,
    residence_state: 'FL',
    unit_state: 'FL',
    desired_territory_zip: '33131',
    liquid_capital: '200000',
    net_worth: '600000',
  });

  // Seats the race really takes stay taken (they're in rep_seats), so the
  // counter is restored to its old value plus those seats.
  let takenInRace = 0;
  try {
    const a = lead('Laura', 'Perez');
    const b = lead('Daniel', 'Cruz');
    const [idA, idB] = await Promise.all([createContact(a, fieldIds), createContact(b, fieldIds)]);

    console.log(`\n=== race: Ana has ${ana.max_open_leads - 1} of ${ana.max_open_leads} leads, two Miami leads fire at once`);
    const [ra, rb] = await Promise.all([fire(idA, a), fire(idB, b)]);
    takenInRace = [ra, rb].filter((r) => r.rep === ana.full_name).length;
    for (const [name, r] of [['Laura', ra], ['Daniel', rb]] as const) {
      console.log(`${name}: ${r.outcome}${r.rep ? ` -> ${r.rep}` : ''}`);
      if (r.outcome !== 'assigned') console.log(`  - ${r.reasons?.at(-1)}`);
    }

    const after = await db.repByEmail(ana.email);
    console.log(`Ana now: ${after?.open_leads} of ${after?.max_open_leads} (never above the limit)`);
  } finally {
    await db.setOpenLeads(ana.email, original + takenInRace);
  }
}

async function main() {
  const only = process.argv[2];
  const fieldIds = await ghl.customFieldIdsByKey();
  console.log(`target: ${target}`);

  for (const [name, { expect, lead }] of Object.entries(SCENARIOS)) {
    if (only && only !== name) continue;
    const contactId = await createContact(lead, fieldIds);
    print(name, expect, await fire(contactId, lead));
  }

  if (!only || only === 'race') await race(fieldIds);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
