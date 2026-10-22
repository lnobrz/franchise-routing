import { flagForAttention } from '../router.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { GhlClient } from '../ghl.js';
import type { RouteResult } from '../router.js';
import type { LeadPayload } from '../payload.js';

// Events whose run never finished: the server restarted, or the database was
// unreachable when a failed run tried to give its claim back.
//
//   still 'processing'  -> nothing reached the CRM, so it is simply routed again
//                          (claim_event takes over the stale claim and its seat)
//   still 'writing_crm' -> the CRM may be half written; if the decision was
//                          logged it is only marked done, otherwise a person is told

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
      if (event.status === 'processing') {
        const result = await routeLead(event.payload, event.event_key);
        console.log(`[recover] ${event.contact_id} re-routed -> ${result.outcome ?? result.status}`);
      } else if (await db.hasDecision(event.event_key)) {
        await db.setEventStatus(event.event_key, 'done');
      } else {
        await flagForAttention(
          deps,
          event.event_key,
          event.contact_id,
          new Error(`interrupted while writing the CRM (no decision logged after ${config.STALE_EVENT_MINUTES} min)`),
        );
      }
      recovered++;
    } catch (error) {
      console.error(`[recover] ${event.event_key} failed, retrying next run:`, (error as Error).message);
    }
  }

  return recovered;
}
