import { createHash } from 'crypto';
import { PARTIAL_STATE_PARAM } from '@idle-party-rpg/shared';
import type { ServerStateMessage } from '@idle-party-rpg/shared';

/** A field this small always goes out: naming it in `unchangedFields` would save nothing. */
const MIN_ELIDED_JSON_LENGTH = 64;

/** A service worker can still serve a bundle that predates partial pushes, and it never asks for them. */
export function clientAcceptsPartialState(requestUrl: string | undefined): boolean {
  // Not new URL(): it throws on some targets a client can send, and this runs outside any try.
  return new URLSearchParams(requestUrl?.split('?')[1] ?? '').has(PARTIAL_STATE_PARAM);
}

export interface PreparedStateField {
  name: string;
  json: string;
  fingerprint: string | null;
}

/** Field name → fingerprint of what one socket last received. */
export type SentStateFields = Map<string, string>;

/** Serialises a state once, however many of the player's sockets it goes to. */
export function prepareStatePush(state: ServerStateMessage): PreparedStateField[] {
  const fields: PreparedStateField[] = [];
  for (const [name, value] of Object.entries(state)) {
    const json = JSON.stringify(value);
    if (json === undefined) continue;
    const fingerprint = json.length > MIN_ELIDED_JSON_LENGTH ? createHash('sha1').update(json).digest('base64') : null;
    fields.push({ name, json, fingerprint });
  }
  return fields;
}

/**
 * The state message for one socket, leaving out what it already holds, and records what it now holds.
 * Must only be called for a message that is really sent: the client's copy is what `sent` describes.
 */
export function encodeStatePush(fields: readonly PreparedStateField[], sent: SentStateFields): string {
  const parts: string[] = [];
  const unchanged: string[] = [];
  const present = new Set<string>();
  for (const { name, json, fingerprint } of fields) {
    present.add(name);
    if (fingerprint !== null && sent.get(name) === fingerprint) {
      unchanged.push(name);
      continue;
    }
    if (fingerprint !== null) sent.set(name, fingerprint);
    else sent.delete(name);
    parts.push(`${JSON.stringify(name)}:${json}`);
  }
  // A field that left the state is gone from the client's copy too, so its return must be sent in full.
  for (const name of sent.keys()) {
    if (!present.has(name)) sent.delete(name);
  }
  if (unchanged.length > 0) parts.push(`"unchangedFields":${JSON.stringify(unchanged)}`);
  return `{${parts.join(',')}}`;
}
