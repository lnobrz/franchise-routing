// Turns whatever a lead typed into clean values the rules can trust.
// Forms are messy: "florida", "Fl.", "07102" saved as 7102, "$250k", "español".

const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

const STATE_CODES = new Set(Object.values(STATES));

export function normalizeState(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const cleaned = input.trim().replace(/\./g, '');
  if (!cleaned) return undefined;

  const upper = cleaned.toUpperCase();
  if (upper.length === 2 && STATE_CODES.has(upper)) return upper;

  return STATES[cleaned.toLowerCase().replace(/\s+/g, ' ')];
}

export function normalizeZip(input: string | number | null | undefined): string | undefined {
  if (input === null || input === undefined) return undefined;
  const digits = String(input).split('-')[0]!.replace(/\D/g, '');
  if (digits.length === 0 || digits.length > 5) return undefined;
  // A ZIP stored as a number loses its leading zero (07102 -> 7102).
  return digits.padStart(5, '0');
}

export function parseMoney(input: string | number | null | undefined): number | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : undefined;

  const text = input.trim().toLowerCase().replace(/[$,\s]/g, '').replace(/usd$/, '');
  const match = text.match(/^(\d+(?:\.\d+)?)(k|m|mm)?$/);
  if (!match) return undefined;

  const value = Number(match[1]);
  const multiplier = match[2] === 'k' ? 1_000 : match[2] ? 1_000_000 : 1;
  return Math.round(value * multiplier);
}

export type Language = 'English' | 'Spanish' | 'Portuguese';

export function normalizeLanguage(input: string | null | undefined): Language | undefined {
  if (!input) return undefined;
  const value = input.trim().toLowerCase();
  if (['english', 'en', 'inglés', 'ingles', 'inglês'].includes(value)) return 'English';
  if (['spanish', 'es', 'español', 'espanol', 'espanhol'].includes(value)) return 'Spanish';
  if (['portuguese', 'pt', 'português', 'portugues', 'portugués'].includes(value)) return 'Portuguese';
  return undefined;
}
