import type { Language } from './normalize.js';
import type { RepRow } from '../types.js';

// Orders the reps who could take a lead. This function only ranks; the actual
// seat is taken atomically in the database (reserve_rep), which walks this list
// and gives the lead to the first rep that still has capacity at that instant.

export interface LocalTime {
  isoWeekday: number; // 1 = Monday
  hhmm: string;       // "14:05"
}

export function localTime(now: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return { isoWeekday: weekdays.indexOf(get('weekday')) + 1, hhmm: `${get('hour')}:${get('minute')}` };
}

export function isOnShift(rep: RepRow, now: Date): boolean {
  const { isoWeekday, hhmm } = localTime(now, rep.timezone);
  return (
    rep.work_days.includes(isoWeekday) &&
    hhmm >= rep.work_start.slice(0, 5) &&
    hhmm < rep.work_end.slice(0, 5)
  );
}

export interface RankInput {
  reps: RepRow[];
  unitState: string;
  ownerRepId: string | null;
  language: Language;
  now: Date;
}

export interface RankResult {
  candidates: RepRow[];
  notes: string[];
}

export function rankCandidates({ reps, unitState, ownerRepId, language, now }: RankInput): RankResult {
  const notes: string[] = [];

  let pool = reps.filter(
    (r) => r.is_active && (r.covered_states.includes(unitState) || r.id === ownerRepId),
  );
  if (pool.length === 0) {
    notes.push(`No active rep covers ${unitState}`);
    return { candidates: [], notes };
  }

  if (language !== 'English') {
    const speakers = pool.filter((r) => r.languages.includes(language));
    if (speakers.length > 0) {
      pool = speakers;
      notes.push(`Language ${language}: limited to reps who speak it (${speakers.map((r) => r.full_name).join(', ')})`);
    } else {
      notes.push(`Language ${language}: no rep for ${unitState} speaks it, routed in English`);
    }
  }

  const tier = (r: RepRow) => {
    if (r.id === ownerRepId) return 0;     // territory owner keeps the relationship
    return isOnShift(r, now) ? 1 : 2;      // then whoever is working right now
  };
  const load = (r: RepRow) => r.open_leads / r.max_open_leads;

  const candidates = [...pool].sort(
    (a, b) => tier(a) - tier(b) || load(a) - load(b) || a.full_name.localeCompare(b.full_name),
  );

  return { candidates, notes };
}

export function describeRep(rep: RepRow, ownerRepId: string | null, now: Date): string {
  const parts: string[] = [];
  if (rep.id === ownerRepId) parts.push('territory owner');
  const shift = isOnShift(rep, now);
  const { hhmm } = localTime(now, rep.timezone);
  parts.push(shift ? 'on shift' : `off shift (${hhmm} local), first contact next business morning`);
  parts.push(`${rep.open_leads} of ${rep.max_open_leads} open leads before this one`);
  return `${rep.full_name}: ${parts.join(', ')}`;
}
