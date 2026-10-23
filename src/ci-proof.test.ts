import { expect, it } from 'vitest';

// Deliberately failing: proves CI blocks the merge. This PR is closed, never merged.
it('fails on purpose', () => {
  expect(1 + 1).toBe(3);
});
