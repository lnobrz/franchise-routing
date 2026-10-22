import { checkLegal } from './legal.js';
import { rankCandidates } from './reps.js';
import type { LeadFacts, Outcome, RepRow, StateRow, TerritoryRow, ZipRow } from '../types.js';

// The whole routing decision as one pure function: same input, same output,
// no network, no clock of its own. Everything it needs is loaded first, then it
// decides in memory. That is what removes the timing problem: nothing here
// reads a value that another step might still be writing.

export interface DecideInput {
  facts: LeadFacts;
  conflicts: string[];
  states: Map<string, StateRow>;
  zip: ZipRow | null;
  territory: TerritoryRow | null;
  reps: RepRow[];
  now: Date;
  today: string; // YYYY-MM-DD, in the franchisor's time zone
}

export interface Decision {
  outcome: Outcome;
  reasons: string[];
  candidates: RepRow[]; // ranked; only filled when outcome is 'assigned'
  territoryCode: string | null;
  ownerRepId: string | null;
}

const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

export function decide(input: DecideInput): Decision {
  const { facts, conflicts, states, zip, territory, reps, now, today } = input;
  const reasons: string[] = [];
  const result = (outcome: Outcome, extra: Partial<Decision> = {}): Decision => ({
    outcome,
    reasons,
    candidates: [],
    territoryCode: territory?.code ?? null,
    ownerRepId: territory?.owner_rep_id ?? null,
    ...extra,
  });

  // 1. Don't guess when the data disagrees with itself.
  if (conflicts.length > 0) {
    reasons.push(...conflicts.map((c) => `Conflict: ${c}`));
    return result('needs_review');
  }

  // 2. Both states are required for the legal check.
  if (!facts.residenceState) reasons.push('Missing residence state');
  if (!facts.unitState) reasons.push('Missing unit state');
  if (!facts.residenceState || !facts.unitState) return result('needs_review');

  const residence = states.get(facts.residenceState);
  const unit = states.get(facts.unitState);
  if (!residence) reasons.push(`No legal data for residence state ${facts.residenceState}`);
  if (!unit) reasons.push(`No legal data for unit state ${facts.unitState}`);
  if (!residence || !unit) return result('needs_review');

  // 3. Legal check on both states.
  const legal = checkLegal(residence, unit, today);
  reasons.push(...legal.reasons);
  if (legal.verdict === 'blocked') return result('blocked');
  if (legal.verdict === 'waiting') return result('waiting_registration');

  // 4. Territory from the ZIP.
  if (facts.zip) {
    if (!zip) {
      reasons.push(`ZIP ${facts.zip} is not in the territory map, routing by state`);
    } else if (zip.state_code !== unit.code) {
      reasons.push(`Conflict: ZIP ${zip.zip} is in ${zip.state_code} but unit state is ${unit.code}`);
      return result('needs_review');
    } else if (!territory) {
      reasons.push(`ZIP ${zip.zip} (${zip.city}) has no territory yet, routing by state`);
    } else if (territory.status !== 'available') {
      reasons.push(`ZIP ${zip.zip} -> territory ${territory.code} (${territory.name}) is ${territory.status}`);
      return result('blocked');
    } else {
      reasons.push(`ZIP ${zip.zip} -> territory ${territory.code} (${territory.name}), available`);
    }
  } else {
    reasons.push('No ZIP given, routing by state');
  }

  // 5. Financial qualification against the territory minimums.
  if (territory && territory.status === 'available') {
    // Both minimums apply, so both numbers are needed; a missing one is never assumed to pass.
    const { liquidCapital, netWorth } = facts;
    if (liquidCapital === undefined || netWorth === undefined) {
      const missing = [liquidCapital === undefined && 'liquid capital', netWorth === undefined && 'net worth'];
      reasons.push(
        `Financials incomplete (${missing.filter(Boolean).join(' and ')} not provided or unreadable), cannot qualify for this territory`,
      );
      return result('needs_review');
    }
    const short: string[] = [];
    if (liquidCapital < territory.min_liquid_capital) {
      short.push(`liquid capital ${usd(liquidCapital)} below ${usd(territory.min_liquid_capital)} minimum`);
    }
    if (netWorth < territory.min_net_worth) {
      short.push(`net worth ${usd(netWorth)} below ${usd(territory.min_net_worth)} minimum`);
    }
    if (short.length > 0) {
      reasons.push(`Not qualified for ${territory.code}: ${short.join('; ')}`);
      return result('blocked');
    }
    reasons.push(`Financials meet ${territory.code} minimums`);
  }

  // 6. Rank the reps. The seat itself is reserved later, atomically.
  const ranked = rankCandidates({
    reps,
    unitState: unit.code,
    ownerRepId: territory?.owner_rep_id ?? null,
    language: facts.language,
    now,
  });
  reasons.push(...ranked.notes);
  if (ranked.candidates.length === 0) return result('needs_review');

  return result('assigned', { candidates: ranked.candidates });
}
