import { CRM_INTERRUPTED, flagForAttention } from '../router.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { GhlClient } from '../ghl.js';
import type { RouteResult } from '../router.js';
import type { LeadPayload } from '../payload.js';

// Events whose run never finished or failed: the server restarted, GHL or the
// database was down, or a setting was wrong.
//
//   'failed' / stuck 'processing' -> nothing reached the CRM, so it is routed
//                          again (claim_event takes over the claim and frees its
//                          seat); after MAX_ROUTING_ATTEMPTS a person is told
//   still 'writing_crm' -> the CRM may be half written; if the decision was
//                          logged it is only marked done, otherwise a person is told

const GAVE_UP =
  'Lead routing failed several times before writing anything to the CRM, so this lead was not routed. ' +
  'Fix the cause in the error below (it is often a setting or reference data), then route it by hand.';

export async function recoverStuck(deps: {
  db: Db;
  ghl: GhlClient;
  config: Config;
  routeLead: (payload: LeadPayload, eventKey: string) => Promise<RouteResult>;
}): Promise<number> {
  const { db, config, routeLead } = deps;
  const stale = await db.staleEvents(config.STALE_EVENT_MINUTES);
  let recovered = 0;

  for (const event of stale) {
    try {
      if (event.status === 'writing_crm') {
        if (await db.hasDecision(event.event_key)) {
          await db.setEventStatus(event.event_key, 'done');
        } else {
          const why = `interrupted while writing the CRM (no decision logged after ${config.STALE_EVENT_MINUTES} min)`;
          await flagForAttention(deps, event.event_key, event.contact_id, why, CRM_INTERRUPTED);
        }
      } else if (event.attempts >= config.MAX_ROUTING_ATTEMPTS) {
        await flagForAttention(deps, event.event_key, event.contact_id, event.last_error ?? 'unknown error', GAVE_UP);
      } else {
        const result = await routeLead(event.payload, event.event_key);
        console.log(`[recover] ${event.contact_id} re-routed -> ${result.outcome ?? result.status}`);
      }
      recovered++;
    } catch (error) {
      console.error(`[recover] ${event.event_key} failed, retrying next run:`, (error as Error).message);
    }
  }

  return recovered;
}
