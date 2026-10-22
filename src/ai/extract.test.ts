import { describe, expect, it, vi } from 'vitest';
import { createOpenAiExtractor } from './extract.js';

const parsed = {
  residence_state: 'NJ',
  unit_state: 'FL',
  zip: '33130',
  liquid_capital_usd: 250_000,
  net_worth_usd: null,
  preferred_language: 'Spanish',
  summary: 'Lives in Newark, wants Miami.',
  confidence: 0.95,
};
const unsupported = new Error("400 Unsupported parameter: 'temperature' is not supported with this model.");

describe('OpenAI extractor', () => {
  it('drops temperature when the model rejects it, and keeps it dropped', async () => {
    const parse = vi
      .fn()
      .mockRejectedValueOnce(unsupported)
      .mockResolvedValue({ output_parsed: parsed });
    const ai = createOpenAiExtractor({ apiKey: 'k', model: 'reasoning-model', temperature: 0, client: { responses: { parse } } as never });

    expect(await ai.extract('texto')).toMatchObject({ unit_state: 'FL', zip: '33130' });
    expect(parse.mock.calls[0]![0]).toHaveProperty('temperature', 0);
    expect(parse.mock.calls[1]![0]).not.toHaveProperty('temperature');

    await ai.extract('outro texto');
    expect(parse).toHaveBeenCalledTimes(3);
    expect(parse.mock.calls[2]![0]).not.toHaveProperty('temperature');
  });

  it('returns null on any other error, without retrying', async () => {
    const parse = vi.fn().mockRejectedValue(new Error('401 Incorrect API key'));
    const ai = createOpenAiExtractor({ apiKey: 'k', model: 'm', temperature: 0, client: { responses: { parse } } as never });
    expect(await ai.extract('texto')).toBeNull();
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('rejects an answer outside the schema', async () => {
    const parse = vi.fn().mockResolvedValue({ output_parsed: { ...parsed, confidence: 7 } });
    const ai = createOpenAiExtractor({ apiKey: 'k', model: 'm', client: { responses: { parse } } as never });
    expect(await ai.extract('texto')).toBeNull();
  });
});
