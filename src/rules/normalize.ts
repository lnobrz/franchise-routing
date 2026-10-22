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

// Lowest real ZIP is 00501; anything below is a typo or a blank number field.
const MIN_ZIP = 501;

export function normalizeZip(input: string | number | null | undefined): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === 'number') {
    // A ZIP stored as a number loses its leading zero (07102 -> 7102).
    return Number.isInteger(input) && input >= MIN_ZIP && input <= 99_999 ? String(input).padStart(5, '0') : undefined;
  }
  // "33130", "33130-1234", "331301234", or a number field that lost its zero: "7102".
  // Letters or stray characters are a typo ("3313O"), never stripped into another ZIP.
  const text = input.trim();
  const match = text.match(/^(\d{5})(?:-?\d{4})?$/) ?? text.match(/^(\d{3,4})$/);
  if (!match) return undefined;
  const digits = match[1]!;
  return Number(digits) >= MIN_ZIP ? digits.padStart(5, '0') : undefined;
}

// Amounts above this are not a real answer (a typo or junk), so a person decides.
const MAX_AMOUNT = 1_000_000_000_000;

/** A money value from a form or the AI that can be trusted: finite, not negative, not absurd. */
export const validAmount = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT ? value : undefined;

// A number written with US or European separators:
//   "250000", "250,000", "250,000.50", "1.5"          (US)
//   "1.000.000", "250.000,50", "1,5"                  (European: dots group, comma is decimal)
// "250.000" alone is ambiguous (250 or 250,000?), so it is not read.
function parseNumber(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) return Number(text.replace(/,/g, ''));
  if (/^\d{1,3}(\.\d{3}){2,}(,\d+)?$/.test(text) || /^\d{1,3}\.\d{3},\d+$/.test(text)) {
    return Number(text.replace(/\./g, '').replace(',', '.'));
  }
  if (/^\d{1,3}\.\d{3}$/.test(text)) return undefined;
  if (/^\d+\.\d+$/.test(text)) return Number(text);
  if (/^\d+,\d{1,2}$/.test(text)) return Number(text.replace(',', '.'));
  return undefined;
}

// One amount: "250000", "$250k", "1.2M", "1,5M", "1.2 million", "250 thousand".
function parseAmount(text: string): number | undefined {
  const match = text.match(/^([\d.,]+)(k|thousand|m|mm|million)?$/);
  if (!match) return undefined;
  const value = parseNumber(match[1]!);
  if (value === undefined) return undefined;
  const unit = match[2];
  const multiplier = unit === 'k' || unit === 'thousand' ? 1_000 : unit ? 1_000_000 : 1;
  // Down, so a lead is never rounded up past a minimum (the epsilon absorbs float error)
  return validAmount(Math.floor(value * multiplier + 1e-6));
}

// Dropdown answers are often ranges or open ends. The lowest amount the lead
// certainly has is used, so nobody qualifies on the top of a range:
//   "$100,000 - $250,000" -> 100000     "$1M+" / "over $1M" -> 1000000
//   "under $50k" -> undefined (no lower bound, a person decides)
export function parseMoney(input: string | number | null | undefined): number | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === 'number') return validAmount(input);

  const text = input.trim().toLowerCase().replace(/[$\s]/g, '').replace(/usd/g, '');
  if (/^(under|lessthan|below|upto|<)/.test(text)) return undefined;

  const openEnded = text.replace(/^(over|morethan|above|atleast|>=?)/, '').replace(/(\+|ormore|andup|andabove)$/, '');
  const [low, high, ...rest] = openEnded.split(/-|–|—|to/);
  if (rest.length > 0 || low === undefined) return undefined;

  const lowValue = parseAmount(low);
  if (high === undefined) return lowValue;
  const highValue = parseAmount(high);
  if (lowValue === undefined || highValue === undefined || highValue < lowValue) return undefined;
  // "100-250k": the unit written on the upper bound applies to both.
  // "500-1m" is ambiguous (500k? 500m?), so a person decides.
  const unitOf = (t: string) => t.match(/[a-z]+$/)?.[0];
  const highUnit = unitOf(high);
  if (!unitOf(low) && highUnit) {
    const lowNumber = parseNumber(low);
    const highNumber = parseNumber(high.slice(0, -highUnit.length));
    if (lowNumber === undefined || highNumber === undefined || lowNumber > highNumber) return undefined;
    return parseAmount(low + highUnit);
  }
  return lowValue;
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
