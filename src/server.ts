import { timingSafeEqual } from 'node:crypto';
import express, { type Request } from 'express';
import { ZodError } from 'zod';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { GhlClient } from './ghl.js';
import { createOpenAiExtractor } from './ai/extract.js';
import { createRouter } from './router.js';
import { releaseWaiting } from './jobs/releaseWaiting.js';
import { eventKeyFor, parsePayload } from './payload.js';

const config = loadConfig();
const db = new Db(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY);
const ghl = new GhlClient(config.GHL_TOKEN, config.GHL_LOCATION_ID);
const extractor = createOpenAiExtractor(config.OPENAI_API_KEY, config.OPENAI_MODEL);
const routeLead = createRouter({ db, ghl, extractor, config });

// GHL workflow webhooks are not signed, so the workflow sends a shared secret.
// Header first; the customData field is a fallback for webhook actions that
// cannot set headers. Compared in constant time.
function isAuthorized(req: Request): boolean {
  const provided =
    req.header('x-webhook-secret') ?? (req.body?.customData?.webhook_secret as string | undefined) ?? '';
  const expected = Buffer.from(config.WEBHOOK_SECRET);
  const given = Buffer.from(String(provided));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const app = express();
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

app.listen(config.PORT, () => {
  console.log(`[server] listening on :${config.PORT}`);
});

// Re-route leads whose state registration became active again.
let jobRunning = false;
setInterval(async () => {
  if (jobRunning) return;
  jobRunning = true;
  try {
    const released = await releaseWaiting({ db, ghl, config, routeLead });
    if (released > 0) console.log(`[release] ${released} lead(s) released`);
  } catch (error) {
    console.error('[release] job failed:', error);
  } finally {
    jobRunning = false;
  }
}, config.RELEASE_JOB_MINUTES * 60_000);
