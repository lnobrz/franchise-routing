import { createHash } from 'node:crypto';
import { z } from 'zod';

// The body GHL sends when the form is submitted. The workflow's webhook action
// can send these as top-level JSON or inside "customData", so both are accepted.
// GHL renders blank merge fields as empty strings; those become undefined here.

const optionalText = z
  .union([z.string(), z.number()])
  .optional()
  .nullable()
  .transform((v) => {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim();
    return s === '' ? undefined : s;
  });

export const LeadPayloadSchema = z.object({
  contact_id: z.string().min(1),
  first_name: optionalText,
  last_name: optionalText,
  residence_state: optionalText,
  unit_state: optionalText,
  desired_territory_zip: optionalText,
  liquid_capital: optionalText,
  net_worth: optionalText,
  preferred_language: optionalText,
  about_you: optionalText,
});

export type LeadPayload = z.infer<typeof LeadPayloadSchema>;

export function parsePayload(body: unknown): LeadPayload {
  const raw = (body ?? {}) as Record<string, unknown>;
  const custom = (raw.customData ?? {}) as Record<string, unknown>;
  return LeadPayloadSchema.parse({ ...raw, ...custom });
}

// Same contact + same answers = same event. GHL retries and double submits are
// recognized; a lead who comes back later with different answers is a new event.
export function eventKeyFor(payload: LeadPayload): string {
  const { contact_id, ...answers } = payload;
  const canonical = JSON.stringify(answers, Object.keys(answers).sort());
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return `${contact_id}:${hash}`;
}
