import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ICON_MARKUP, ICON_NAMES, ToolIcon } from './index';

const sources = import.meta.glob<string>('./svg/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const files = Object.keys(sources).map((path) => path.replace('./svg/', ''));
const ALLOWED_ELEMENTS = new Set([
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'g',
]);
const ALLOWED_ATTRIBUTES = new Set([
  'd',
  'x',
  'y',
  'width',
  'height',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'class',
  'stroke-dasharray',
  'transform',
]);

describe('tool icon sources (docs/05-brand.md §6)', () => {
  it('every file is registered and every registered name has a file', () => {
    expect(files.map((f) => f.replace('.svg', '')).sort()).toEqual([...ICON_NAMES].sort());
    for (const name of ICON_NAMES) expect(ICON_MARKUP[name]).toBeTruthy();
  });

  it.each(files)('%s follows the icon rules', (file) => {
    const svg = sources[`./svg/${file}`] ?? '';
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24">/);
    const tags = [...svg.matchAll(/<([a-z]+)\s*([^>]*?)\/?>/g)].filter(([, tag]) => tag !== 'svg');
    expect(tags.length).toBeGreaterThan(0);
    for (const [, tag, attributes] of tags) {
      expect(ALLOWED_ELEMENTS, `<${tag}> in ${file}`).toContain(tag);
      for (const [, attribute] of (attributes ?? '').matchAll(/([a-z-]+)="/g)) {
        // Colours, stroke widths and styles come from CSS, so every icon stays two-tone.
        expect(ALLOWED_ATTRIBUTES, `${attribute} on <${tag}> in ${file}`).toContain(attribute);
      }
    }
    // At least one filled "subject" surface (class f) and one outline.
    expect(svg).toMatch(/class="f"/);
    expect(tags.some(([, , a]) => !a?.includes('class="f"'))).toBe(true);
  });
});

describe('ToolIcon stroke weight (ADR-0079 round 3)', () => {
  it('scales the stroke back above 24 px so the line weight stays at 1.75 px', () => {
    const html = renderToStaticMarkup(<ToolIcon name="box" category="create" size={32} />);
    expect(html).toContain('stroke-width:1.3125');
  });

  it('leaves the stroke to the stylesheet at 24 px and below', () => {
    for (const size of [14, 16, 18, 24] as const) {
      const html = renderToStaticMarkup(<ToolIcon name="box" category="create" size={size} />);
      expect(html).not.toContain('stroke-width');
    }
  });
});
