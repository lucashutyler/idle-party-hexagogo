import { describe, it, expect } from 'vitest';
import { formatPublishRefusal } from '../src/game/ContentValidation.js';

describe('formatPublishRefusal', () => {
  it('lists every problem when there are only a few', () => {
    expect(formatPublishRefusal(['A is broken.', 'B is broken.'])).toBe(
      "Can't publish: the draft has 2 problem(s). A is broken. B is broken.",
    );
  });

  it('shows the first five problems and counts the rest', () => {
    const problems = Array.from({ length: 8 }, (_, i) => `P${i}.`);
    expect(formatPublishRefusal(problems)).toBe(
      "Can't publish: the draft has 8 problem(s). P0. P1. P2. P3. P4. (+3 more)",
    );
  });
});
