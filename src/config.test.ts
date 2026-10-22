import { describe, expect, it } from 'vitest';
import { isTimeZone } from './config.js';

describe('config', () => {
  it('only accepts real IANA time zones', () => {
    expect(isTimeZone('America/New_York')).toBe(true);
    expect(isTimeZone('America/NewYork')).toBe(false);
    expect(isTimeZone('EST5')).toBe(false);
  });
});
