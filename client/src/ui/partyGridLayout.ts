export type PartyColumnLabel = 'Front' | 'Mid' | 'Back';

export interface PartyGridCell {
  row: number;
  col: number;
  columnLabel: PartyColumnLabel;
  /** Portrait placement (combat party-block mapping): front column on top. */
  portraitRow: number;
  portraitCol: number;
}

const COLUMN_LABELS: readonly PartyColumnLabel[] = ['Back', 'Mid', 'Front'];

export function partyGridCell(pos: number): PartyGridCell {
  const row = Math.floor(pos / 3);
  const col = pos % 3;
  return {
    row,
    col,
    columnLabel: COLUMN_LABELS[col],
    portraitRow: 2 - col,
    portraitCol: row,
  };
}
