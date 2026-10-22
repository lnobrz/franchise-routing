import { todayIn, type Config } from './config.js';
import { decide, type Decision } from './rules/decide.js';
import { mergeLead, type MergeResult } from './rules/merge.js';
import { describeRep } from './rules/reps.js';
import type { AiExtraction, Extractor } from './ai/extract.js';
import type { Db } from './db.js';
import type { GhlClient } from './ghl.js';
import type { LeadPayload } from './payload.js';
import type { LeadFacts, Outcome, RepRow } from './types.js';

// One flow, start to finish, for every lead:
//
//   claim event -> read lead (AI + form) -> load context -> decide (pure)
//   -> apply (reserve seat atomically, write CRM) -> explain and log
//
// Failure handling depends on whether the CRM was touched:
//   - not yet: the claim and the seat are given back, GHL's retry starts clean
//     (and if even that fails, the recovery job re-runs the stale claim)
//   - already: never re-run automatically, which could assign the lead twice;
//     the event and the contact are flagged for a person instead
//
// Nothing waits on another automation to finish saving a field. The webhook
// carries the submitted answers, the decision is computed in memory from them,
// and the CRM is written once at the end.

export type RouterDeps = { db: Db; ghl: GhlClient; extractor: Extractor; config: Config };

export type RouteResult = {
  status: 'processed' | 'duplicate';
  outcome?: Outcome;
  rep?: string;
  reasons?: string[];
};

type ReadLead = MergeResult & { ai: AiExtraction | null };
type Applied = { outcome: Outcome; rep: RepRow | null; reasons: string[] };
type Progress = { crmWritten: boolean };
type Run = { eventKey: string; claimId: string; progress: Progress };

/** The event was claimed again by another run (it looked stuck). Stop without writing. */
export class ClaimLostError extends Error {}

const TAGS: Record<Outcome, string> = {
  assigned: 'routing:assigned',
  blocked: 'routing:blocked',
  waiting_registration: 'routing:waiting-registration',
  needs_review: 'routing:needs-review',
};
export const NEEDS_ATTENTION_TAG = 'routing:needs-attention';

export const createRouter = (deps: RouterDeps) =>
  async function routeLead(payload: LeadPayload, eventKey: string): Promise<RouteResult> {
    // Idempotency: a retried or doubled webhook stops here.
    const claimId = await deps.db.claimEvent(eventKey, payload.contact_id, payload, deps.config.STALE_EVENT_MINUTES);
    if (!claimId) return { status: 'duplicate' };

    const run: Run = { eventKey, claimId, progress: { crmWritten: false } };
    try {
      const lead = await readLead(deps, payload);
      const now = new Date();

      const decision = decide({
        ...(await loadContext(deps.db, lead.facts)),
        facts: lead.facts,
        conflicts: lead.conflicts,
        now,
        today: todayIn(deps.config.BUSINESS_TIMEZONE, now),
      });

      const where = decision.territoryCode ?? lead.facts.unitState ?? '';
      const applied =
        decision.outcome === 'assigned'
          ? await assignToRep(deps, payload, decision, { now, where }, run)
          : await markUnassigned(deps, payload.contact_id, { ...decision, rep: null }, run);

      await explainAndLog(deps, { payload, eventKey, lead, decision, applied });
      await setStatus(deps.db, run, 'done');

      console.log(`[route] ${payload.contact_id} -> ${applied.outcome}${applied.rep ? ` (${applied.rep.full_name})` : ''}`);
      return { status: 'processed', outcome: applied.outcome, rep: applied.rep?.full_name, reasons: applied.reasons };
    } catch (error) {
      if (!run.progress.crmWritten) {
        // Nothing reached the CRM: free the event and its seat so GHL's retry
        // can process it. If this fails too, the claim goes stale and the
        // recovery job re-runs it.
        await deps.db
          .unclaimEvent(eventKey, claimId)
          .catch((e: Error) => console.error(`[route] unclaim failed for ${eventKey}:`, e.message));
      } else if (!(error instanceof ClaimLostError)) {
        // Something did: keep the claim so a retry can't double-assign, and tell a person.
        await flagForAttention(deps, eventKey, payload.contact_id, error as Error, claimId);
      }
      throw error;
    }
  };

/** Marks the event and the contact so a person checks what was written. Never throws. */
export async function flagForAttention(
  { db, ghl }: Pick<RouterDeps, 'db' | 'ghl'>,
  eventKey: string,
  contactId: string,
  error: Error,
  claimId?: string,
): Promise<void> {
  console.error(`[route] ${eventKey} needs attention:`, error.message);
  await db
    .setEventStatus(eventKey, 'needs_attention', claimId)
    .catch((e: Error) => console.error(`[route] could not flag ${eventKey}:`, e.message));
  await ghl
    .addTags(contactId, [NEEDS_ATTENTION_TAG])
    .catch((e: Error) => console.error(`[route] could not tag ${contactId}:`, e.message));
  await ghl
    .addNote(
      contactId,
      'Lead routing was interrupted after it started writing to the CRM, so it was not retried automatically. ' +
        `Check this contact's owner, tags and opportunity by hand.\n\nEvent: ${eventKey}\nError: ${error.message}`,
    )
    .catch(() => undefined);
}

// --- Steps -----------------------------------------------------------------

/** The AI reads the free text (failure = null), then it's merged with the form. */
async function readLead({ extractor, config }: RouterDeps, payload: LeadPayload): Promise<ReadLead> {
  const ai = payload.about_you ? await extractor.extract(payload.about_you) : null;
  return { ...mergeLead(payload, ai, config.AI_MIN_CONFIDENCE), ai };
}

/** Everything the decision needs, loaded once, up front. */
async function loadContext(db: Db, facts: LeadFacts) {
  const [states, zip, reps] = await Promise.all([
    db.states([facts.residenceState ?? '', facts.unitState ?? '']),
    facts.zip ? db.zip(facts.zip) : null,
    db.reps(),
  ]);
  const territory = zip?.territory_code ? await db.territory(zip.territory_code) : null;
  return { states, zip, territory, reps };
}

/** Moves the event to a new status, or stops if another run took it over. */
async function setStatus(db: Db, run: Run, status: 'writing_crm' | 'done'): Promise<void> {
  if (!(await db.setEventStatus(run.eventKey, status, run.claimId))) {
    throw new ClaimLostError(`event ${run.eventKey} was claimed by another run`);
  }
}

/** Takes a seat atomically, then writes the assignment to the CRM. */
async function assignToRep(
  deps: RouterDeps,
  payload: LeadPayload,
  decision: Decision,
  { now, where }: { now: Date; where: string },
  run: Run,
): Promise<Applied> {
  const { db, ghl, config } = deps;
  const reasons = [...decision.reasons];

  // Reps are linked to CRM users by e-mail; skip anyone without a user.
  const userIds = await ghl.userIdsByEmail();
  const routable = decision.candidates.filter((rep) => {
    const linked = userIds.has(rep.email.toLowerCase());
    if (!linked) reasons.push(`${rep.full_name} skipped: no CRM user with e-mail ${rep.email}`);
    return linked;
  });
  const { pipelineId, firstStageId } = await ghl.pipeline(config.GHL_PIPELINE_NAME);

  const chosenId = routable.length > 0 ? await db.reserveRep(routable.map((rep) => rep.id), run.eventKey) : null;
  const rep = routable.find((r) => r.id === chosenId);

  if (!rep) {
    reasons.push('Every eligible rep is at capacity, sent to the manager queue');
    return markUnassigned(deps, payload.contact_id, { outcome: 'needs_review', rep: null, reasons }, run);
  }

  reasons.push(describeRep(rep, decision.ownerRepId, now));
  const userId = userIds.get(rep.email.toLowerCase())!;

  // The opportunity goes first: if it fails, nothing is in the CRM and the
  // whole run can be retried. After it exists, the remaining writes only
  // complete it, and a failure is flagged instead of retried with another rep.
  await setStatus(db, run, 'writing_crm');
  const opportunityId = await ghl.createOpportunity({
    contactId: payload.contact_id,
    name: opportunityName(payload, where),
    pipelineId,
    stageId: firstStageId,
    assignedTo: userId,
  });
  run.progress.crmWritten = true;

  await db.attachOpportunity(run.eventKey, opportunityId);
  await ghl.assignContact(payload.contact_id, userId);
  await ghl.addTags(payload.contact_id, [
    TAGS.assigned,
    ...(decision.territoryCode ? [`territory:${decision.territoryCode}`] : []),
  ]);

  return { outcome: 'assigned', rep, reasons };
}

/** Blocked, waiting or needs review: tag the contact, no opportunity. */
async function markUnassigned(
  { db, ghl }: RouterDeps,
  contactId: string,
  applied: Applied,
  run: Run,
): Promise<Applied> {
  await setStatus(db, run, 'writing_crm');
  await ghl.addTags(contactId, [TAGS[applied.outcome]]);
  run.progress.crmWritten = true;
  return applied;
}

/** Writes the decision note on the contact and the row in the decision log. */
async function explainAndLog(
  { db, ghl }: RouterDeps,
  ctx: { payload: LeadPayload; eventKey: string; lead: ReadLead; decision: Decision; applied: Applied },
): Promise<void> {
  const { payload, eventKey, lead, decision, applied } = ctx;

  // A missing note shouldn't undo a correct assignment, so it only logs.
  await ghl
    .addNote(payload.contact_id, formatNote(applied, lead))
    .catch((error: Error) => console.error(`[route] note failed for ${payload.contact_id}:`, error.message));

  await db.saveDecision({
    event_key: eventKey,
    contact_id: payload.contact_id,
    outcome: applied.outcome,
    rep_id: applied.rep?.id ?? null,
    territory_code: decision.territoryCode,
    residence_state: lead.facts.residenceState ?? null,
    unit_state: lead.facts.unitState ?? null,
    reasons: applied.reasons,
    ai_extraction: lead.ai,
  });
}

// --- Formatting ------------------------------------------------------------

const opportunityName = (p: LeadPayload, where: string): string =>
  `${[p.first_name, p.last_name].filter(Boolean).join(' ') || 'New lead'} - ${where}`;

const HEADLINES: Record<Outcome, (rep: RepRow | null) => string> = {
  assigned: (rep) => `ASSIGNED to ${rep?.full_name}`,
  blocked: () => 'BLOCKED, not added to the pipeline',
  waiting_registration: () => 'WAITING for state registration, will re-route automatically',
  needs_review: () => 'NEEDS HUMAN REVIEW',
};

function formatNote({ outcome, rep, reasons }: Applied, { ai, filledByAi }: ReadLead): string {
  const lines = [`Lead routing decision: ${HEADLINES[outcome](rep)}`, '', ...reasons.map((r) => `- ${r}`)];
  if (ai) {
    lines.push('', `AI read of "About you" (confidence ${ai.confidence.toFixed(2)}): ${ai.summary}`);
    if (filledByAi.length > 0) lines.push(`Filled from free text: ${filledByAi.join(', ')}`);
  }
  return lines.join('\n');
}
