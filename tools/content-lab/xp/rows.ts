import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import type { FightRow } from './types.js';

/**
 * One fight, little endian. Fixed part: u32 cell, u32 realMs, f32 damage, u16 encounter, u16 minHp (x 65535),
 * u8 result, u8 deaths, u8 flags, u8 group count. Then per monster: u16 index, u8 killed, u8 standing.
 */
const FIXED_BYTES = 20;
const GROUP_COUNT_AT = 19;
const GROUP_BYTES = 4;
const MAGIC = Buffer.from('XPR3');
const WRITE_BUFFER_BYTES = 1 << 20;
const READ_BUFFER_BYTES = 1 << 22;
const FLAG_PAST_HORIZON = 1;

export const ROW_FILE_PREFIX = 'rows-';
export const ROW_FILE_SUFFIX = '.bin';

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

export class RowWriter {
  private readonly fd: number;
  private readonly buffer = Buffer.allocUnsafe(WRITE_BUFFER_BYTES);
  private used = 0;
  bytes = 0;

  constructor(path: string) {
    this.fd = openSync(path, 'w');
    writeSync(this.fd, MAGIC);
    this.bytes = MAGIC.length;
  }

  write(row: FightRow): void {
    const groupCount = row.groups.length / 3;
    const size = FIXED_BYTES + groupCount * GROUP_BYTES;
    if (this.used + size > this.buffer.length) this.flush();
    const b = this.buffer;
    let at = this.used;
    b.writeUInt32LE(row.cell, at);
    b.writeUInt32LE(Math.min(0xffffffff, Math.round(row.realMs)), at + 4);
    b.writeFloatLE(row.damage, at + 8);
    b.writeUInt16LE(row.encounter, at + 12);
    b.writeUInt16LE(Math.round(Math.min(1, Math.max(0, row.minHp)) * 65535), at + 14);
    b.writeUInt8(row.result, at + 16);
    b.writeUInt8(clampByte(row.deaths), at + 17);
    b.writeUInt8(row.pastHorizon ? FLAG_PAST_HORIZON : 0, at + 18);
    b.writeUInt8(groupCount, at + GROUP_COUNT_AT);
    at += FIXED_BYTES;
    for (let i = 0; i < row.groups.length; i += 3) {
      b.writeUInt16LE(row.groups[i], at);
      b.writeUInt8(clampByte(row.groups[i + 1]), at + 2);
      b.writeUInt8(clampByte(row.groups[i + 2]), at + 3);
      at += GROUP_BYTES;
    }
    this.used = at;
    this.bytes += size;
  }

  flush(): void {
    if (this.used > 0) writeSync(this.fd, this.buffer, 0, this.used);
    this.used = 0;
  }

  close(): void {
    this.flush();
    closeSync(this.fd);
  }
}

/** Streams a row file. `visit` gets the same object every time: copy anything you keep. Returning false stops the read. */
export function forEachRow(path: string, visit: (row: FightRow) => void | false): void {
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const row: FightRow = { cell: 0, encounter: 0, result: 0, deaths: 0, realMs: 0, damage: 0, minHp: 0, pastHorizon: false, groups: [] };
  try {
    let have = readSync(fd, buffer, 0, buffer.length, null);
    if (have < MAGIC.length || buffer.compare(MAGIC, 0, MAGIC.length, 0, MAGIC.length) !== 0) throw new Error(`${path} is not a row file of this version: rebuild the atlas`);
    let at = MAGIC.length;
    for (;;) {
      const left = have - at;
      const complete = left >= FIXED_BYTES && left >= FIXED_BYTES + buffer.readUInt8(at + GROUP_COUNT_AT) * GROUP_BYTES;
      if (!complete) {
        buffer.copy(buffer, 0, at, have);
        const more = readSync(fd, buffer, left, buffer.length - left, null);
        have = left + more;
        at = 0;
        if (more === 0) {
          if (left > 0) throw new Error(`${path} ends inside a row`);
          return;
        }
        continue;
      }
      row.cell = buffer.readUInt32LE(at);
      row.realMs = buffer.readUInt32LE(at + 4);
      row.damage = buffer.readFloatLE(at + 8);
      row.encounter = buffer.readUInt16LE(at + 12);
      row.minHp = buffer.readUInt16LE(at + 14) / 65535;
      row.result = buffer.readUInt8(at + 16);
      row.deaths = buffer.readUInt8(at + 17);
      row.pastHorizon = (buffer.readUInt8(at + 18) & FLAG_PAST_HORIZON) !== 0;
      const groupCount = buffer.readUInt8(at + GROUP_COUNT_AT);
      at += FIXED_BYTES;
      row.groups.length = groupCount * 3;
      for (let g = 0; g < groupCount; g++) {
        row.groups[g * 3] = buffer.readUInt16LE(at);
        row.groups[g * 3 + 1] = buffer.readUInt8(at + 2);
        row.groups[g * 3 + 2] = buffer.readUInt8(at + 3);
        at += GROUP_BYTES;
      }
      if (visit(row) === false) return;
    }
  } finally {
    closeSync(fd);
  }
}
