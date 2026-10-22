import { describe, expect, it } from 'vitest';
import { checkLegal } from './legal.js';
import { decide, type DecideInput } from './decide.js';
import { mergeLead } from './merge.js';
import { normalizeLanguage, normalizeState, normalizeZip, parseMoney } from './normalize.js';
import { isOnShift, rankCandidates } from './reps.js';
import type { AiExtraction } from '../ai/extract.js';
import type { RepRow, StateRow, TerritoryRow, ZipRow } from '../types.js';

// Thursday 2026-10-22 15:00 UTC = 11:00 New York, 10:00 Chicago, 08:00 Los Angeles
const NOW = new Date('2026-10-22T15:00:00Z');
const TODAY = '2026-10-22';

const state = (code: string, over: Partial<StateRow> = {}): StateRow => ({
  code,
  name: code,
  registration_status: 'not_required',
  registration_expires_at: null,
  total_slots: 5,
  sold_slots: 0,
  ...over,
});

const rep = (id: string, over: Partial<RepRow> = {}): RepRow => ({
  id,
  full_name: id,
  email: `${id}@example.com`,
  covered_states: ['FL'],
  languages: ['English'],
  timezone: 'America/New_York',
  work_start: '09:00:00',
  work_end: '18:00:00',
  work_days: [1, 2, 3, 4, 5],
  max_open_leads: 8,
  open_leads: 0,
  is_active: true,
  ...over,
});

describe('normalize', () => {
  it('reads states written in different ways', () => {
    expect(normalizeState('florida')).toBe('FL');
    expect(normalizeState(' Fl. ')).toBe('FL');
    expect(normalizeState('New  York')).toBe('NY');
    expect(normalizeState('XX')).toBeUndefined();
  });

  it('restores the leading zero of New Jersey ZIPs', () => {
    expect(normalizeZip('7102')).toBe('07102');
    expect(normalizeZip(7102)).toBe('07102');
    expect(normalizeZip('33130-1234')).toBe('33130');
    expect(normalizeZip('331301234')).toBe('33130');
    expect(normalizeZip('123456')).toBeUndefined();
  });

  it('never turns a typo into a different ZIP', () => {
    for (const typo of ['3313O', '33l30', '0', '1', '00000', '123', '33130-', '-33130', 'ZIP 33130', '7102-1234', '']) {
      expect(normalizeZip(typo), typo).toBeUndefined();
    }
    expect(normalizeZip(0)).toBeUndefined();
    expect(normalizeZip(1e10)).toBeUndefined();
  });

  it('parses money shorthand', () => {
    expect(parseMoney('$250k')).toBe(250_000);
    expect(parseMoney('1.2M')).toBe(1_200_000);
    expect(parseMoney('150,000')).toBe(150_000);
    expect(parseMoney('a lot')).toBeUndefined();
    expect(parseMoney('1.2 million')).toBe(1_200_000);
  });

  it('uses the lower bound of ranges and open-ended dropdown answers', () => {
    expect(parseMoney('$100,000 - $250,000')).toBe(100_000);
    expect(parseMoney('$250K to $500K')).toBe(250_000);
    expect(parseMoney('100-250k')).toBe(100_000);
    expect(parseMoney('$1M+')).toBe(1_000_000);
    expect(parseMoney('Over $1M')).toBe(1_000_000);
    expect(parseMoney('500000 or more')).toBe(500_000);
  });

  it('reads European separators, and leaves ambiguous ones to a person', () => {
    expect(parseMoney('1,5M')).toBe(1_500_000);
    expect(parseMoney('2,75 million')).toBe(2_750_000);
    expect(parseMoney('$1.000.000')).toBe(1_000_000);
    expect(parseMoney('250.000,50')).toBe(250_000);
    expect(parseMoney('250,000.00')).toBe(250_000);
    expect(parseMoney('1,234,567')).toBe(1_234_567);
    expect(parseMoney('250.000')).toBeUndefined(); // 250 or 250,000?
    expect(parseMoney('1,5-2,5m')).toBe(1_500_000);
    expect(parseMoney('0.3m')).toBe(300_000);
    expect(parseMoney('2.3k')).toBe(2_300);
    expect(parseMoney('8.2m')).toBe(8_200_000); // 8.2 * 1e6 = 8199999.999… in floating point
  });

  it('rejects negative, non-finite and absurd amounts', () => {
    for (const junk of ['-5000', '1e9', 'NaN', 'Infinity', '9'.repeat(30)]) expect(parseMoney(junk), junk).toBeUndefined();
    for (const junk of [-1, NaN, Infinity, 1e20]) expect(parseMoney(junk)).toBeUndefined();
  });

  it('leaves answers without a safe lower bound to a person', () => {
    expect(parseMoney('Under $50k')).toBeUndefined();
    expect(parseMoney('Less than $100,000')).toBeUndefined();
    expect(parseMoney('500-1m')).toBeUndefined();
    expect(parseMoney('$500,000 - $100,000')).toBeUndefined();
  });

  it('maps language names in three languages', () => {
    expect(normalizeLanguage('español')).toBe('Spanish');
    expect(normalizeLanguage('Português')).toBe('Portuguese');
  });
});

describe('legal check across two states', () => {
  it('passes when both states allow the offer', () => {
    const r = checkLegal(state('NJ'), state('FL'), TODAY);
    expect(r.verdict).toBe('ok');
  });

  it('parks the lead when the UNIT state renewal is pending, even if residence is fine', () => {
    const r = checkLegal(state('NJ'), state('NY', { registration_status: 'renewal_pending' }), TODAY);
    expect(r.verdict).toBe('waiting');
  });

  it('parks the lead when the RESIDENCE state is the problem', () => {
    const r = checkLegal(state('IL', { registration_status: 'expired' }), state('FL'), TODAY);
    expect(r.verdict).toBe('waiting');
  });

  it('treats an active registration past its date as expired', () => {
    const ca = state('CA', { registration_status: 'active', registration_expires_at: '2026-10-21' });
    expect(checkLegal(ca, ca, TODAY).verdict).toBe('waiting');
  });

  it('blocks a state where the franchise was never registered', () => {
    const r = checkLegal(state('WA', { registration_status: 'not_registered' }), state('FL'), TODAY);
    expect(r.verdict).toBe('blocked');
  });

  it('blocks when the unit state has no units left, whatever the registration says', () => {
    const r = checkLegal(state('NJ'), state('AZ', { total_slots: 3, sold_slots: 3 }), TODAY);
    expect(r.verdict).toBe('blocked');
  });
});

describe('rep ranking', () => {
  it('survives a rep with a mistyped time zone: off shift, with a note', () => {
    const reps = [rep('typo', { timezone: 'America/NewYork', open_leads: 0 }), rep('ok', { open_leads: 5 })];
    const { candidates, notes } = rankCandidates({ reps, unitState: 'FL', ownerRepId: null, language: 'English', now: NOW });
    expect(candidates.map((r) => r.id)).toEqual(['ok', 'typo']);
    expect(notes[0]).toMatch(/typo: unknown time zone "America\/NewYork"/);
    expect(isOnShift(reps[0]!, NOW)).toBe(false);
  });

  it('puts the territory owner first, then reps on shift by lowest load', () => {
    const reps = [
      rep('busy', { open_leads: 6 }),
      rep('light', { open_leads: 1 }),
      rep('owner', { open_leads: 7 }),
    ];
    const { candidates } = rankCandidates({ reps, unitState: 'FL', ownerRepId: 'owner', language: 'English', now: NOW });
    expect(candidates.map((r) => r.id)).toEqual(['owner', 'light', 'busy']);
  });

  it('prefers reps who are working right now', () => {
    const reps = [
      rep('west', { timezone: 'America/Los_Angeles', open_leads: 0 }), // 08:00, not started
      rep('east', { open_leads: 5 }),                                  // 11:00, on shift
    ];
    expect(isOnShift(reps[0]!, NOW)).toBe(false);
    const { candidates } = rankCandidates({ reps, unitState: 'FL', ownerRepId: null, language: 'English', now: NOW });
    expect(candidates.map((r) => r.id)).toEqual(['east', 'west']);
  });

  it('limits to reps who speak the lead language, falls back to English if nobody does', () => {
    const reps = [rep('en'), rep('es', { languages: ['English', 'Spanish'], open_leads: 5 })];
    const spanish = rankCandidates({ reps, unitState: 'FL', ownerRepId: null, language: 'Spanish', now: NOW });
    expect(spanish.candidates.map((r) => r.id)).toEqual(['es']);

    const portuguese = rankCandidates({ reps, unitState: 'FL', ownerRepId: null, language: 'Portuguese', now: NOW });
    expect(portuguese.candidates).toHaveLength(2);
    expect(portuguese.notes[0]).toMatch(/no rep .* speaks it/);
  });

  it('ignores inactive reps and reps who do not cover the state', () => {
    const reps = [rep('off', { is_active: false }), rep('tx', { covered_states: ['TX'] })];
    const { candidates } = rankCandidates({ reps, unitState: 'FL', ownerRepId: null, language: 'English', now: NOW });
    expect(candidates).toHaveLength(0);
  });
});

describe('merging the form with the AI read', () => {
  const ai = (over: Partial<AiExtraction> = {}): AiExtraction => ({
    residence_state: null,
    unit_state: null,
    zip: null,
    liquid_capital_usd: null,
    net_worth_usd: null,
    preferred_language: null,
    summary: 'test',
    confidence: 0.95,
    ...over,
  });

  it('lets the AI fill blank fields', () => {
    const r = mergeLead({ contact_id: 'c', residence_state: 'NJ' }, ai({ unit_state: 'FL', zip: '33130' }), 0.7);
    expect(r.facts).toMatchObject({ residenceState: 'NJ', unitState: 'FL', zip: '33130' });
    expect(r.conflicts).toEqual([]);
  });

  it('ignores the AI when its confidence is below the bar', () => {
    const r = mergeLead({ contact_id: 'c' }, ai({ unit_state: 'FL', confidence: 0.4 }), 0.7);
    expect(r.facts.unitState).toBeUndefined();
  });

  it('puts AI amounts through the same checks as the form', () => {
    const r = mergeLead({ contact_id: 'c' }, ai({ liquid_capital_usd: -50, net_worth_usd: 1e20, zip: '123' }), 0.7);
    expect(r.facts.liquidCapital).toBeUndefined();
    expect(r.facts.netWorth).toBeUndefined();
    expect(r.facts.zip).toBeUndefined();
  });

  it('sends a typed but unreadable ZIP to a person instead of routing by state', () => {
    const r = mergeLead({ contact_id: 'c', residence_state: 'FL', unit_state: 'FL', desired_territory_zip: '3313O' }, null, 0.7);
    expect(r.facts.zip).toBeUndefined();
    expect(r.conflicts[0]).toMatch(/"3313O", which is not a valid ZIP/);
    expect(mergeLead({ contact_id: 'c', unit_state: 'FL' }, null, 0.7).conflicts).toEqual([]); // no ZIP at all is fine
  });

  it('flags a conflict instead of choosing when form and text disagree', () => {
    const r = mergeLead({ contact_id: 'c', unit_state: 'TX' }, ai({ unit_state: 'FL' }), 0.7);
    expect(r.facts.unitState).toBe('TX');
    expect(r.conflicts[0]).toMatch(/form says TX, free text says FL/);
  });
});

describe('full decision', () => {
  const miami: TerritoryRow = {
    code: 'MIA-01',
    name: 'Miami',
    state_code: 'FL',
    status: 'available',
    owner_rep_id: 'ana',
    min_liquid_capital: 150_000,
    min_net_worth: 500_000,
  };
  const zip: ZipRow = { zip: '33130', city: 'Miami', state_code: 'FL', territory_code: 'MIA-01' };

  const base = (over: Partial<DecideInput> = {}): DecideInput => ({
    facts: { residenceState: 'NJ', unitState: 'FL', zip: '33130', liquidCapital: 200_000, netWorth: 600_000, language: 'English' },
    conflicts: [],
    states: new Map([['NJ', state('NJ')], ['FL', state('FL')]]),
    zip,
    territory: miami,
    reps: [rep('ana'), rep('bob')],
    now: NOW,
    today: TODAY,
    ...over,
  });

  it('assigns a qualified lead with the territory owner first', () => {
    const d = decide(base());
    expect(d.outcome).toBe('assigned');
    expect(d.candidates[0]?.id).toBe('ana');
  });

  it('sends conflicts to review before anything else', () => {
    expect(decide(base({ conflicts: ['Unit state: x'] })).outcome).toBe('needs_review');
  });

  it('blocks a lead below the territory minimums', () => {
    const d = decide(base({ facts: { ...base().facts, liquidCapital: 80_000 } }));
    expect(d.outcome).toBe('blocked');
    expect(d.reasons.at(-1)).toMatch(/below \$150,000 minimum/);
  });

  it('blocks a sold territory', () => {
    expect(decide(base({ territory: { ...miami, status: 'sold' } })).outcome).toBe('blocked');
  });

  it('sends a ZIP from another state to review', () => {
    const d = decide(base({ zip: { ...zip, state_code: 'GA' } }));
    expect(d.outcome).toBe('needs_review');
  });

  it('asks a human when only one of the two financials is known', () => {
    const { netWorth: _, ...withoutNetWorth } = base().facts;
    const d = decide(base({ facts: withoutNetWorth }));
    expect(d.outcome).toBe('needs_review');
    expect(d.reasons.at(-1)).toMatch(/net worth not provided/);

    const { liquidCapital: __, ...withoutLiquid } = base().facts;
    expect(decide(base({ facts: withoutLiquid })).outcome).toBe('needs_review');
  });

  it('asks a human when a required state is missing', () => {
    expect(decide(base({ facts: { language: 'English', unitState: 'FL' } })).outcome).toBe('needs_review');
  });
});
