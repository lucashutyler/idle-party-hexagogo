import { describe, expect, it } from 'vitest';
import { headerOpensLog } from '../src/screens/CombatScreen';

describe('headerOpensLog', () => {
  it('opens the log from the header only on short screens with the chat sheet closed', () => {
    expect(headerOpensLog(true, false)).toBe(true);
    expect(headerOpensLog(true, true)).toBe(false);
    expect(headerOpensLog(false, false)).toBe(false);
    expect(headerOpensLog(false, true)).toBe(false);
  });
});
