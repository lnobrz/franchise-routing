import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';

// Reads the free-text "About you" answer and pulls out structured facts.
//
// The model never decides anything. It only fills in data; the routing rules
// stay deterministic. Reliability comes from:
//   - a fixed JSON schema the API is forced to follow (structured outputs)
//   - temperature 0 on models that accept it
//   - the prompt telling it to return null instead of guessing
//   - zod validating the result again on our side
//   - a confidence score: below the bar, its answers are ignored
//   - conflicts with the form fields sending the lead to a human (see merge.ts)

export const AiExtractionSchema = z.object({
  residence_state: z.string().nullable().describe('US state where the person lives, 2-letter code'),
  unit_state: z.string().nullable().describe('US state where they want to open the franchise, 2-letter code'),
  zip: z.string().nullable().describe('ZIP code where they want to open, 5 digits'),
  liquid_capital_usd: z.number().nullable().describe('Liquid capital available to invest, in USD'),
  net_worth_usd: z.number().nullable().describe('Total net worth, in USD'),
  preferred_language: z.enum(['English', 'Spanish', 'Portuguese']).nullable(),
  summary: z.string().describe('One sentence about the lead for the sales rep, in English'),
  confidence: z.number().min(0).max(1).describe('How sure you are about the extracted values overall'),
});

export type AiExtraction = z.infer<typeof AiExtractionSchema>;

const INSTRUCTIONS = `You extract facts from a franchise inquiry written by a prospect.

Rules:
- Only extract what the text explicitly states. If something is not stated, return null. Never guess.
- States must be 2-letter US codes (e.g. "Miami" means FL only if the text says Miami, Florida or Miami clearly in the US).
- residence_state is where they live now. unit_state is where they want to open. Do not mix them up.
- Money in USD as a plain number: "$250k" -> 250000, "about 1.2 million" -> 1200000.
- preferred_language: only if they say which language they prefer, or the text itself is written in Spanish or Portuguese.
- confidence: 0.9+ when the text is explicit, 0.5-0.8 when it is vague, below 0.5 when you are unsure.`;

export interface Extractor {
  extract(text: string): Promise<AiExtraction | null>;
}

type ResponsesClient = Pick<OpenAI, 'responses'>;

// "400 Unsupported parameter: 'temperature' is not supported with this model."
const rejectsTemperature = (error: unknown): boolean =>
  /temperature/i.test((error as Error)?.message ?? '') && /unsupported|not supported/i.test((error as Error)?.message ?? '');

export const createOpenAiExtractor = (options: {
  apiKey: string;
  model: string;
  temperature?: number; // leave undefined for reasoning models, which reject it
  client?: ResponsesClient; // tests
}): Extractor => {
  const client: ResponsesClient = options.client ?? new OpenAI({ apiKey: options.apiKey, timeout: 20_000, maxRetries: 2 });
  // A model that rejects temperature (a setting left at 0 for a reasoning
  // model) would turn the AI off for every lead; it is dropped instead.
  let temperature = options.temperature;

  const call = (text: string) =>
    client.responses.parse({
      model: options.model,
      instructions: INSTRUCTIONS,
      input: text.slice(0, 4_000),
      text: { format: zodTextFormat(AiExtractionSchema, 'lead_extraction') },
      ...(temperature !== undefined && { temperature }),
    });

  return {
    async extract(text) {
      try {
        let response;
        try {
          response = await call(text);
        } catch (error) {
          if (temperature === undefined || !rejectsTemperature(error)) throw error;
          console.warn(`[ai] ${options.model} does not accept temperature; set AI_TEMPERATURE empty. Retrying without it.`);
          temperature = undefined;
          response = await call(text);
        }

        if (!response.output_parsed) return null;                // refusal or empty
        return AiExtractionSchema.parse(response.output_parsed); // validate again, never trust blindly
      } catch (error) {
        // The AI is an enhancement, not a dependency: if it fails, routing
        // continues with the form fields only.
        console.error('[ai] extraction failed:', (error as Error).message);
        return null;
      }
    },
  };
};
