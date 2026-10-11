/**
 * How a toolbar tile's label fits (ADR-0079 round 3, 2026-10-11). A tile is a
 * fixed 64 px wide, so its label has at most two 62 px lines; `tileLabel` picks
 * the full name when it fits, else the tool's short name, else the short name
 * cut with an ellipsis. Pure, so the rule is tested without a font: the caller
 * supplies `measure`, the text's width in px at the tile font.
 */

/** A tile's fixed width in px. */
export const TILE_WIDTH = 64;

/** A label line's width in px: the tile less 2 × 1 px padding. */
export const TILE_TEXT_WIDTH = 62;

/** The tile font: 11 px Instrument Sans (`--x-font-ui`), one line 13 px tall. */
export const TILE_FONT = '11px "Instrument Sans"';

export interface TileLabel {
  /** The lines shown, at most two. A one-line result has `lines.length === 1`. */
  lines: string[];
  /** Whether the short text was cut to fit. */
  cut: boolean;
}

/** A trailing ellipsis is dropped: "Open File…" shows as "Open File". */
function stripEllipsis(text: string): string {
  return text.endsWith('…') ? text.slice(0, -1).trimEnd() : text;
}

/** Greedy wrap at spaces only; a word is never broken inside. */
function wrap(text: string, max: number, measure: (t: string) => number): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const line = lines[lines.length - 1];
    if (line !== undefined && measure(`${line} ${word}`) <= max) {
      lines[lines.length - 1] = `${line} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines;
}

/** The text fits when it wraps to at most two lines, each within `max`. */
function fits(lines: string[], max: number, measure: (t: string) => number): boolean {
  return lines.length <= 2 && lines.every((line) => measure(line) <= max);
}

/** Shorten a line from its end until `trimEnd(line) + '…'` measures within `max`. */
function clip(line: string, max: number, measure: (t: string) => number): string {
  let text = line;
  while (text.length > 0 && measure(`${text.trimEnd()}…`) > max) text = text.slice(0, -1);
  return `${text.trimEnd()}…`;
}

/**
 * The lines a tile shows. `full` fits as it is (up to two lines), else `short`
 * fits, else `short` is cut: line 1 is its first wrapped line, line 2 the rest.
 * A line wider than `max` (a single long word) is clipped with an ellipsis.
 */
export function tileLabel(
  full: string,
  short: string,
  max: number,
  measure: (t: string) => number,
): TileLabel {
  for (const text of [stripEllipsis(full), stripEllipsis(short)]) {
    const lines = wrap(text, max, measure);
    if (fits(lines, max, measure)) return { lines, cut: false };
  }
  const lines = wrap(stripEllipsis(short), max, measure);
  const first = lines[0] ?? '';
  const rest = lines.slice(1).join(' ');
  const out = [measure(first) > max ? clip(first, max, measure) : first];
  if (rest.length > 0) out.push(measure(rest) > max ? clip(rest, max, measure) : rest);
  return { lines: out, cut: true };
}

/** A module-level 2D context measuring at the tile font (11 px Instrument Sans). */
let measureContext: CanvasRenderingContext2D | null | undefined;

/**
 * The text's width in px at the tile font. One module-level canvas context; the
 * toolbar measures again once `document.fonts.ready` resolves so a fallback-font
 * width never sticks. Without a DOM (unit tests) it falls back to 6 px a character.
 */
export function measureTileText(text: string): number {
  if (measureContext === undefined) {
    measureContext =
      typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  }
  if (!measureContext) return text.length * 6;
  measureContext.font = TILE_FONT;
  return measureContext.measureText(text).width;
}
