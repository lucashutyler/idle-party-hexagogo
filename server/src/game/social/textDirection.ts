/** Bidirectional embedding, override and isolate controls: U+202A–U+202E and U+2066–U+2069. Joiners are not among them. */
const TEXT_DIRECTION_CONTROL = /[‪-‮⁦-⁩]/;
const TEXT_DIRECTION_CONTROLS = new RegExp(TEXT_DIRECTION_CONTROL.source, 'g');

export function hasTextDirectionControls(text: string): boolean {
  return TEXT_DIRECTION_CONTROL.test(text);
}

export function stripTextDirectionControls(text: string): string {
  return text.replace(TEXT_DIRECTION_CONTROLS, '');
}
