import { describe, it, expect } from 'vitest';
import { parseEmailListEnv } from '../src/auth/EmailListParser.js';

describe('parseEmailListEnv', () => {
  it('splits, trims, and lowercases comma-separated emails', () => {
    const result = parseEmailListEnv('Alice@Test.com, bob@test.com ,  carol@test.com');
    expect(result).toEqual(new Set(['alice@test.com', 'bob@test.com', 'carol@test.com']));
  });

  it('filters out empty entries from stray commas', () => {
    const result = parseEmailListEnv('alice@test.com,,  ,bob@test.com,');
    expect(result).toEqual(new Set(['alice@test.com', 'bob@test.com']));
  });

  it('returns an empty set for undefined or blank input', () => {
    expect(parseEmailListEnv(undefined)).toEqual(new Set());
    expect(parseEmailListEnv('')).toEqual(new Set());
    expect(parseEmailListEnv('   ')).toEqual(new Set());
  });
});
