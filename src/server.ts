import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { GhlClient } from './ghl.js';
import { createOpenAiExtractor } from './ai/extract.js';
import { createRouter } from './router.js';
import { releaseWaiting } from './jobs/releaseWaiting.js';
import { recoverStuck } from './jobs/recoverStuck.js';
import { eventKeyFor, parseOpportunityPayload, parsePayload } from './payload.js';

const config = loadConfig();
const db = new Db(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY);
const ghl = new GhlClient(config.GHL_TOKEN, config.GHL_LOCATION_ID);
const extractor = createOpenAiExtractor({
  apiKey: config.OPENAI_API_KEY,
  model: config.OPENAI_MODEL,
  temperature: config.AI_TEMPERATURE,
});
const routeLead = createRouter({ db, ghl, extractor, config });

// GHL workflow webhooks are not signed, so the workflow sends a shared secret.
// Header first; the customData field is a fallback for webhook actions that
// cannot set headers. Compared in constant time.
function isAuthorized(req: Request): boolean {
  const fromBody: unknown = req.body?.customData?.webhook_secret;
  const provided = req.header('x-webhook-secret') ?? (typeof fromBody === 'string' ? fromBody : '');
  const expected = Buffer.from(config.WEBHOOK_SECRET);
  const given = Buffer.from(provided);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/webhooks/lead', async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const payload = parsePayload(req.body);
    const result = await routeLead(payload, eventKeyFor(payload));
    res.json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({ error: 'invalid payload', issues: error.issues });
      return;
    }
    // 500 makes GHL retry; the event was un-claimed, so the retry is processed.
    console.error('[webhook] routing failed:', error);
    res.status(500).json({ error: 'routing failed' });
  }
});

// A second GHL workflow (opportunity status changed / opportunity changed)
// reports closed or reassigned opportunities, so the rep's seat is given back.
app.post('/webhooks/opportunity', async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const change = parseOpportunityPayload(req.body);
    const assignedEmail =
      change.assigned_to_email ??
      (change.assigned_to_user_id ? await ghl.emailForUserId(change.assigned_to_user_id) : null) ??
      // An id that isn't a CRM user (deleted, or a manager outside routing) frees the seat.
      (change.assigned_to_user_id ? `unknown-user:${change.assigned_to_user_id}` : null);
    const seat = await db.opportunityChanged(
      change.opportunity_id,
      change.status,
      assignedEmail,
      change.contact_id ?? null,
    );
    if (seat !== 'ignored' && seat !== 'unchanged') console.log(`[seat] ${change.opportunity_id} ${change.status} -> ${seat}`);
    res.json({ seat });
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({ error: 'invalid payload', issues: error.issues });
      return;
    }
    console.error('[webhook] opportunity update failed:', error);
    res.status(500).json({ error: 'update failed' });
  }
});

// Malformed JSON and anything unexpected: a short JSON answer, never a stack trace.
app.use((error: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (error.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid json' });
    return;
  }
  if (error.type === 'entity.too.large') {
    res.status(413).json({ error: 'payload too large' });
    return;
  }
  console.error('[server] unhandled error:', error);
  res.status(500).json({ error: 'internal error' });
});

app.listen(config.PORT, config.HOST, () => {
  console.log(`[server] listening on ${config.HOST}:${config.PORT}`);
});

// Recover interrupted events, then re-route leads whose state registration
// became active again.
let jobRunning = false;
setInterval(async () => {
  if (jobRunning) return;
  jobRunning = true;
  try {
    const recovered = await recoverStuck({ db, ghl, config, routeLead });
    if (recovered > 0) console.log(`[recover] ${recovered} stuck event(s) handled`);
    const released = await releaseWaiting({ db, ghl, config, routeLead });
    if (released > 0) console.log(`[release] ${released} lead(s) released`);
    const purged = await db.purgeOldPayloads(config.PII_RETENTION_DAYS);
    if (purged > 0) console.log(`[purge] personal data cleared from ${purged} old event(s)`);
  } catch (error) {
    console.error('[jobs] run failed:', error);
  } finally {
    jobRunning = false;
  }
}, config.RELEASE_JOB_MINUTES * 60_000);
