import { todayIn, type Config } from '../config.js';
import { isStillWaiting } from '../rules/legal.js';
import type { Db } from '../db.js';
import type { GhlClient } from '../ghl.js';
import type { RouteResult } from '../router.js';
import type { LeadPayload } from '../payload.js';

// Leads parked because a state registration was pending or expired.
// When ops marks the state active again in Supabase, this job picks those
// leads up and routes them normally. Nobody has to remember to do it.

export async function releaseWaiting(deps: {
  db: Db;
  ghl: GhlClient;
  config: Config;
  routeLead: (payload: LeadPayload, eventKey: string) => Promise<RouteResult>;
}): Promise<number> {
  const { db, ghl, config, routeLead } = deps;

  const waiting = await db.waitingDecisions();
  if (waiting.length === 0) return 0;

  const states = await db.states(waiting.flatMap((w) => [w.residence_state, w.unit_state]));
  const today = todayIn(config.BUSINESS_TIMEZONE);
  let released = 0;

  for (const lead of waiting) {
    const residence = states.get(lead.residence_state);
    const unit = states.get(lead.unit_state);
    if (!residence || !unit || isStillWaiting(residence, unit, today)) continue;

    const payload = await db.eventPayload(lead.event_key);
    if (!payload) continue;

    // Route first, then close the old decision: if routing fails, the lead stays
    // in the waiting queue and is retried on the next run instead of being lost.
    const result = await routeLead(payload, `${lead.event_key}:released:${Date.now()}`);
    await db.resolveDecision(lead.id);
    await ghl.removeTags(lead.contact_id, ['routing:waiting-registration']).catch(() => undefined);
    console.log(`[release] ${lead.contact_id} re-routed -> ${result.outcome}`);
    released++;
  }

  return released;
}
