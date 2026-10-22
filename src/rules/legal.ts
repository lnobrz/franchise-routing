import type { StateRow } from '../types.js';

// Franchise sales law check.
//
// In registration states the franchisor must hold an active registration
// before it can even *offer* a franchise. The law applies when the buyer lives
// in the state OR the unit will be opened there, so a lead can touch two
// different states and both have to pass.
//
// Verdicts:
//   ok       - can be offered
//   waiting  - temporarily not allowed (renewal pending, expired); the lead is
//              parked and re-routed automatically once the state is active again
//   blocked  - cannot be offered (never registered, or no units left)

export type LegalVerdict = 'ok' | 'waiting' | 'blocked';

export interface LegalResult {
  verdict: LegalVerdict;
  reasons: string[];
}

function checkRegistration(state: StateRow, role: string, today: string): { verdict: LegalVerdict; reason: string } {
  const label = `${role} state ${state.code}`;

  switch (state.registration_status) {
    case 'not_required':
      return { verdict: 'ok', reason: `${label}: no franchise registration required` };

    case 'active': {
      const expires = state.registration_expires_at;
      if (expires && expires < today) {
        return { verdict: 'waiting', reason: `${label}: registration expired on ${expires}, renewal needed before offering` };
      }
      return { verdict: 'ok', reason: `${label}: registration active until ${expires}` };
    }

    case 'renewal_pending':
      return { verdict: 'waiting', reason: `${label}: registration renewal pending, cannot offer until approved` };

    case 'expired':
      return { verdict: 'waiting', reason: `${label}: registration expired, cannot offer until renewed` };

    case 'not_registered':
      return { verdict: 'blocked', reason: `${label}: franchise not registered here, cannot offer` };
  }
}

const SEVERITY: Record<LegalVerdict, number> = { ok: 0, waiting: 1, blocked: 2 };

export function checkLegal(residence: StateRow, unit: StateRow, today: string): LegalResult {
  const checks = [checkRegistration(residence, 'Residence', today)];
  if (unit.code !== residence.code) checks.push(checkRegistration(unit, 'Unit', today));

  const reasons = checks.map((c) => c.reason);
  let verdict = checks.reduce<LegalVerdict>(
    (worst, c) => (SEVERITY[c.verdict] > SEVERITY[worst] ? c.verdict : worst),
    'ok',
  );

  // Units are opened in the unit state, so that is where the slots are counted.
  const left = unit.total_slots - unit.sold_slots;
  if (left <= 0) {
    reasons.push(`Unit state ${unit.code}: no franchise units left (${unit.sold_slots} of ${unit.total_slots} sold)`);
    verdict = 'blocked';
  } else {
    reasons.push(`Unit state ${unit.code}: ${left} of ${unit.total_slots} units still available`);
  }

  return { verdict, reasons };
}

// Used by the release job: is anything still keeping this lead in the waiting queue?
export function isStillWaiting(residence: StateRow, unit: StateRow, today: string): boolean {
  return checkLegal(residence, unit, today).verdict === 'waiting';
}
