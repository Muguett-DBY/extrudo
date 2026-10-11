import { describe, expect, it } from 'vitest';
import { measureTileText, TILE_TEXT_WIDTH, TILE_WIDTH, tileLabel } from './tileLabel';

// A fake measure of 6 px per character: `max = 62` holds 10 characters (ADR-0079 round 3).
const m = (text: string) => text.length * 6;
const max = TILE_TEXT_WIDTH;

describe('tileLabel (ADR-0079 round 3)', () => {
  it('keeps the full text on one line when it fits', () => {
    expect(tileLabel('Short', 'S', max, m)).toEqual({ lines: ['Short'], cut: false });
  });

  it('wraps the full text onto two lines', () => {
    expect(tileLabel('Alpha Beta Gamma', 'ABG', max, m)).toEqual({
      lines: ['Alpha Beta', 'Gamma'],
      cut: false,
    });
  });

  it('falls back to the short text when the full one needs three lines', () => {
    expect(tileLabel('Alpha Beta Gamma Delta', 'Short', max, m)).toEqual({
      lines: ['Short'],
      cut: false,
    });
  });

  it('cuts the short text when even it does not fit, one ellipsis per wide line', () => {
    const label = tileLabel('Alpha Beta Gamma Delta', 'Alpha Beta Gamma Delta', max, m);
    expect(label.cut).toBe(true);
    expect(label.lines).toHaveLength(2);
    expect(label.lines[0]).toBe('Alpha Beta');
    expect(label.lines[1]?.endsWith('…')).toBe(true);
    for (const line of label.lines) expect(m(line)).toBeLessThanOrEqual(max);
  });

  it('clips a single word wider than max', () => {
    const label = tileLabel('Supercalifragilistic', 'Supercalifragilistic', max, m);
    expect(label.cut).toBe(true);
    expect(label.lines).toHaveLength(1);
    expect(label.lines[0]?.endsWith('…')).toBe(true);
    expect(m(label.lines[0] ?? '')).toBeLessThanOrEqual(max);
  });

  it('strips a trailing ellipsis from both texts', () => {
    expect(tileLabel('Open File…', 'Open File', max, m)).toEqual({
      lines: ['Open File'],
      cut: false,
    });
    expect(tileLabel('A Long Name…', 'A Long Nam…', max, m).lines.join('')).not.toContain('…');
  });

  it('handles full equal to short', () => {
    expect(tileLabel('Same', 'Same', max, m)).toEqual({ lines: ['Same'], cut: false });
  });

  it('returns no lines for an empty string', () => {
    expect(tileLabel('', '', max, m)).toEqual({ lines: [], cut: false });
  });
});

describe('measureTileText', () => {
  it('falls back to a rough width without a DOM canvas', () => {
    // Vitest's web environment has no 2D canvas here; the fallback is 6 px a character.
    expect(measureTileText('abcdef')).toBe(36);
  });
});

it('exports the tile geometry', () => {
  expect(TILE_WIDTH).toBe(64);
  expect(TILE_TEXT_WIDTH).toBe(62);
});
