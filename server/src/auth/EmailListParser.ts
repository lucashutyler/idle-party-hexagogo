/** Parses a comma-separated email list from an environment variable into a lowercase set. */
export function parseEmailListEnv(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(e => e.length > 0)
  );
}
