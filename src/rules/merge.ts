import { normalizeLanguage, normalizeState, normalizeZip, parseMoney, validAmount } from './normalize.js';
import type { AiExtraction } from '../ai/extract.js';
import type { LeadFacts } from '../types.js';
import type { LeadPayload } from '../payload.js';

// Combines the structured form fields with what the AI read from the free text.
//
// Rules, in order:
//   1. A form field the lead filled in always wins.
//   2. A blank form field can be filled by the AI, but only above the confidence bar.
//   3. If the AI and the form disagree on a state or ZIP, nobody guesses: the
//      lead goes to human review.

export interface MergeResult {
  facts: LeadFacts;
  conflicts: string[];
  filledByAi: string[];
}

export function mergeLead(form: LeadPayload, ai: AiExtraction | null, minConfidence: number): MergeResult {
  const conflicts: string[] = [];
  const filledByAi: string[] = [];
  const trusted = ai !== null && ai.confidence >= minConfidence;

  function pick<T>(label: string, formValue: T | undefined, aiValue: T | undefined, compare: boolean): T | undefined {
    if (formValue !== undefined) {
      if (compare && ai && aiValue !== undefined && aiValue !== formValue) {
        conflicts.push(`${label}: form says ${formValue}, free text says ${aiValue}`);
      }
      return formValue;
    }
    if (trusted && aiValue !== undefined) {
      filledByAi.push(`${label} = ${aiValue}`);
      return aiValue;
    }
    return undefined;
  }

  const facts: LeadFacts = {
    residenceState: pick(
      'Residence state',
      normalizeState(form.residence_state),
      normalizeState(ai?.residence_state),
      true,
    ),
    unitState: pick('Unit state', normalizeState(form.unit_state), normalizeState(ai?.unit_state), true),
    zip: pick('ZIP', normalizeZip(form.desired_territory_zip), normalizeZip(ai?.zip), true),
    // AI amounts go through the same checks as the form (not negative, not absurd)
    liquidCapital: pick('Liquid capital', parseMoney(form.liquid_capital), validAmount(ai?.liquid_capital_usd), false),
    netWorth: pick('Net worth', parseMoney(form.net_worth), validAmount(ai?.net_worth_usd), false),
    language:
      pick(
        'Language',
        normalizeLanguage(form.preferred_language),
        normalizeLanguage(ai?.preferred_language),
        false,
      ) ?? 'English',
  };

  // A ZIP the lead typed but that can't be read ("3313O") is not "no ZIP":
  // routing by state would skip the territory's financial minimums.
  if (form.desired_territory_zip !== undefined && facts.zip === undefined) {
    conflicts.push(`ZIP: form says "${form.desired_territory_zip}", which is not a valid ZIP code`);
  }

  return { facts, conflicts, filledByAi };
}
