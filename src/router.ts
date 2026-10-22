import { todayIn, type Config } from './config.js';
import { decide } from './rules/decide.js';
import { mergeLead } from './rules/merge.js';
import { describeRep } from './rules/reps.js';
import type { AiExtraction, Extractor } from './ai/extract.js';
import type { Db } from './db.js';
import type { GhlClient } from './ghl.js';
import type { LeadPayload } from './payload.js';
import type { Outcome, RepRow } from './types.js';

// One flow, start to finish, for every lead:
//
//   claim event -> AI read -> merge with form -> load reference data
//   -> decide (pure) -> reserve seat (atomic) -> write to CRM -> log decision
//
// Nothing waits on another automation to finish saving a field. The webhook
// carries the submitted answers, the decision is computed in memory from them,
// and the CRM is written once at the end.

export interface RouteResult {
  status: 'processed' | 'duplicate';
  outcome?: Outcome;
  rep?: string;
  reasons?: string[];
}

const TAGS: Record<Outcome, string> = {
  assigned: 'routing:assigned',
  blocked: 'routing:blocked',
  waiting_registration: 'routing:waiting-registration',
  needs_review: 'routing:needs-review',
};

export function createRouter(deps: { db: Db; ghl: GhlClient; extractor: Extractor; config: Config }) {
  const { db, ghl, extractor, config } = deps;

  return async function routeLead(payload: LeadPayload, eventKey: string): Promise<RouteResult> {
    const contactId = payload.contact_id;

    // Idempotency: a retried or doubled webhook stops here.
    if (!(await db.claimEvent(eventKey, contactId, payload))) return { status: 'duplicate' };

    let crmWritten = false;
    try {
      // 1. AI reads the free text (optional; failure = null).
      const ai: AiExtraction | null = payload.about_you ? await extractor.extract(payload.about_you) : null;
      const merged = mergeLead(payload, ai, config.AI_MIN_CONFIDENCE);
      const { facts } = merged;

      // 2. Load everything the decision needs, once.
      const [states, zip, reps] = await Promise.all([
        db.states([facts.residenceState ?? '', facts.unitState ?? '']),
        facts.zip ? db.zip(facts.zip) : Promise.resolve(null),
        db.reps(),
      ]);
      const territory = zip?.territory_code ? await db.territory(zip.territory_code) : null;

      // 3. Decide in memory.
      const now = new Date();
      const decision = decide({
        facts,
        conflicts: merged.conflicts,
        states,
        zip,
        territory,
        reps,
        now,
        today: todayIn(config.BUSINESS_TIMEZONE, now),
      });

      let outcome = decision.outcome;
      const reasons = [...decision.reasons];
      let rep: RepRow | null = null;

      // 4. Take the seat atomically, then write to the CRM.
      if (outcome === 'assigned') {
        const userIds = await ghl.userIdsByEmail();
        const routable = decision.candidates.filter((r) => {
          if (userIds.has(r.email.toLowerCase())) return true;
          reasons.push(`${r.full_name} skipped: no CRM user with e-mail ${r.email}`);
          return false;
        });

        const chosenId = routable.length > 0 ? await db.reserveRep(routable.map((r) => r.id)) : null;

        if (!chosenId) {
          outcome = 'needs_review';
          reasons.push('Every eligible rep is at capacity, sent to the manager queue');
        } else {
          rep = routable.find((r) => r.id === chosenId)!;
          reasons.push(describeRep(rep, decision.ownerRepId, now));
          const userId = userIds.get(rep.email.toLowerCase())!;

          try {
            const { pipelineId, firstStageId } = await ghl.pipeline(config.GHL_PIPELINE_NAME);
            await ghl.assignContact(contactId, userId);
            await ghl.addTags(contactId, [TAGS.assigned, ...(decision.territoryCode ? [`territory:${decision.territoryCode}`] : [])]);
            await ghl.createOpportunity({
              contactId,
              name: opportunityName(payload, decision.territoryCode ?? facts.unitState ?? ''),
              pipelineId,
              stageId: firstStageId,
              assignedTo: userId,
            });
            crmWritten = true;
          } catch (error) {
            await db.releaseRep(chosenId); // give the seat back before failing
            throw error;
          }
        }
      }

      if (outcome !== 'assigned') {
        await ghl.addTags(contactId, [TAGS[outcome]]);
        crmWritten = true;
      }

      // 5. Explain the decision where the team will see it, and log it.
      await ghl
        .addNote(contactId, formatNote(outcome, rep, reasons, merged.filledByAi, ai))
        .catch((e) => console.error(`[route] note failed for ${contactId}:`, e.message));

      await db.saveDecision({
        event_key: eventKey,
        contact_id: contactId,
        outcome,
        rep_id: rep?.id ?? null,
        territory_code: decision.territoryCode,
        residence_state: facts.residenceState ?? null,
        unit_state: facts.unitState ?? null,
        reasons,
        ai_extraction: ai,
      });

      console.log(`[route] ${contactId} -> ${outcome}${rep ? ` (${rep.full_name})` : ''}`);
      return { status: 'processed', outcome, rep: rep?.full_name, reasons };
    } catch (error) {
      // Nothing reached the CRM: free the event so GHL's retry can process it.
      // Something did: keep the claim, so a retry can't double-assign.
      if (!crmWritten) await db.unclaimEvent(eventKey);
      throw error;
    }
  };
}

function opportunityName(p: LeadPayload, where: string): string {
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'New lead';
  return `${name} - ${where}`;
}

function formatNote(
  outcome: Outcome,
  rep: RepRow | null,
  reasons: string[],
  filledByAi: string[],
  ai: AiExtraction | null,
): string {
  const headline: Record<Outcome, string> = {
    assigned: `ASSIGNED to ${rep?.full_name}`,
    blocked: 'BLOCKED, not added to the pipeline',
    waiting_registration: 'WAITING for state registration, will re-route automatically',
    needs_review: 'NEEDS HUMAN REVIEW',
  };

  const lines = [`Lead routing decision: ${headline[outcome]}`, '', ...reasons.map((r) => `- ${r}`)];
  if (ai) {
    lines.push('', `AI read of "About you" (confidence ${ai.confidence.toFixed(2)}): ${ai.summary}`);
    if (filledByAi.length > 0) lines.push(`Filled from free text: ${filledByAi.join(', ')}`);
  }
  return lines.join('\n');
}
