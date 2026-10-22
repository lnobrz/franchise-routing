import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  // Shared secret the GHL workflow sends in the x-webhook-secret header
  WEBHOOK_SECRET: z.string().min(24, 'use at least 24 random characters'),

  GHL_TOKEN: z.string().min(10),
  GHL_LOCATION_ID: z.string().min(5),
  GHL_PIPELINE_NAME: z.string().default('Franchise Sales (Demo)'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(20),

  OPENAI_API_KEY: z.string().min(20),
  OPENAI_MODEL: z.string().min(1),
  AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),

  // Time zone used for "today" in the registration expiry check
  BUSINESS_TIMEZONE: z.string().default('America/New_York'),
  RELEASE_JOB_MINUTES: z.coerce.number().int().positive().default(15),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}

export function todayIn(timeZone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
