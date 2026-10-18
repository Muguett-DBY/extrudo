import type { Vec3 } from '@extrudo/core';
import { describe, expect, it } from 'vitest';
import { type GhostHint, ghostHints, ghostMatrix } from './ghost';

/** A point through a column-major world matrix. */
function transform(m: readonly number[] | undefined, [x, y, z]: Vec3): number[] {
  if (!m) throw new Error('no matrix');
  return [0, 1, 2].map(
    (i) => (m[i] ?? 0) * x + (m[4 + i] ?? 0) * y + (m[8 + i] ?? 0) * z + (m[12 + i] ?? 0),
  );
}

const near = (p: number[]) => p.map((v) => expect.closeTo(v, 9));

describe('ghostHints', () => {
  it('keeps the handles that say how their ghost follows, with the shown values', () => {
    const hints = ghostHints(
      [
        { kind: 'distance', field: 'd', origin: [0, 0, 0], direction: [0, 0, 1], ghost: 'stretch' },
        { kind: 'distance', field: 'plain', origin: [0, 0, 0], direction: [1, 0, 0] },
        {
          kind: 'angle',
          field: 'a',
          origin: [1, 0, 0],
          axis: [0, 0, 1],
          zero: [1, 0, 0],
          ghost: 'turn',
          scale: 0.5,
        },
        { kind: 'distance', field: 'bad', origin: [0, 0, 0], direction: [1, 0, 0], ghost: 'move' },
      ],
      (field) => ({ d: 10, plain: 3, a: 90 })[field],
    );
    expect(hints).toEqual([
      { kind: 'stretch', field: 'd', value: 10, origin: [0, 0, 0], direction: [0, 0, 1], scale: 1 },
      { kind: 'turn', field: 'a', value: 90, origin: [1, 0, 0], axis: [0, 0, 1], scale: 0.5 },
    ]);
  });
});

describe('ghostMatrix', () => {
  const stretch: GhostHint = {
    kind: 'stretch',
    field: 'd',
    value: 10,
    origin: [0, 0, 5],
    direction: [0, 0, 1],
    scale: 1,
  };

  it('is absent while the values are the shown ones', () => {
    expect(ghostMatrix([stretch], () => 10)).toBeUndefined();
    expect(ghostMatrix(undefined, () => 10)).toBeUndefined();
    expect(ghostMatrix([stretch], () => undefined)).toBeUndefined();
  });

  it('stretches from the plane through the origin, and only along the direction', () => {
    const m = ghostMatrix([stretch], () => 25);
    expect(transform(m, [3, 4, 15])).toEqual(near([3, 4, 30]));
    expect(transform(m, [3, 4, 5])).toEqual(near([3, 4, 5]));
    // A cut going in (negative both times) stretches the same way.
    const cut = ghostMatrix([{ ...stretch, value: -10 }], () => -20);
    expect(transform(cut, [0, 0, -5])).toEqual(near([0, 0, -15]));
  });

  it("doesn't guess a stretch through zero", () => {
    expect(ghostMatrix([stretch], () => -5)).toBeUndefined();
    expect(ghostMatrix([{ ...stretch, value: 0 }], () => 5)).toBeUndefined();
  });

  it('moves along the direction by the change times the scale', () => {
    const move: GhostHint = { ...stretch, kind: 'move', direction: [1, 0, 0], scale: 0.5 };
    expect(
      transform(
        ghostMatrix([move], () => 16),
        [1, 2, 3],
      ),
    ).toEqual(near([4, 2, 3]));
  });

  it('turns right-handed about the axis through the origin', () => {
    const turn: GhostHint = {
      kind: 'turn',
      field: 'a',
      value: 30,
      origin: [1, 1, 0],
      axis: [0, 0, 1],
      scale: 1,
    };
    expect(
      transform(
        ghostMatrix([turn], () => 120),
        [2, 1, 7],
      ),
    ).toEqual(near([1, 2, 7]));
  });

  it('applies several changed handles one after the other', () => {
    const move: GhostHint = {
      ...stretch,
      kind: 'move',
      field: 'x',
      value: 0,
      direction: [1, 0, 0],
    };
    const m = ghostMatrix([stretch, move], (field) => (field === 'd' ? 20 : 3));
    expect(transform(m, [0, 0, 15])).toEqual(near([3, 0, 25]));
  });
});
