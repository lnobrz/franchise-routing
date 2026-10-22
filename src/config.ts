import { existsSync } from 'node:fs';
import { z } from 'zod';

// Node reads .env natively (no dotenv). Variables already set in the
// environment, e.g. by pm2 or the host, take precedence.
if (existsSync('.env')) process.loadEnvFile('.env');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  // Shared secret the GHL workflow sends in the x-webhook-secret header
  WEBHOOK_SECRET: z.string().min(24, 'use at least 24 random characters'),

  GHL_TOKEN: z.string().min(10),
  GHL_LOCATION_ID: z.string().min(5),
  GHL_PIPELINE_NAME: z.string().default('Franchise Sales (Demo)'),

  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(20),

  OPENAI_API_KEY: z.string().min(20),
  OPENAI_MODEL: z.string().min(1),
  // Empty for reasoning models, which don't accept a temperature
  AI_TEMPERATURE: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().min(0).max(2).optional()),
  AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),

  // Time zone used for "today" in the registration expiry check
  BUSINESS_TIMEZONE: z.string().default('America/New_York'),
  RELEASE_JOB_MINUTES: z.coerce.number().int().positive().default(15),
});

export type Config = z.infer<typeof EnvSchema>;

export const loadConfig = (): Config => {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
};

// en-CA formats dates as YYYY-MM-DD
export const todayIn = (timeZone: string, now = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
