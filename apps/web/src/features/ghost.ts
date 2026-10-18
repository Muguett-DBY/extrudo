/**
 * The optimistic ghost of a handle drag (issue #76): a dialog's preview is
 * the kernel's answer for an earlier draft, so while the kernel works on the
 * newest one the view moves the ghost it has by what the handles changed
 * since. A handle says how its ghost follows (`ghost` on a distance arrow or
 * an angle arc): an extrude's or a box's size stretches it from the plane the
 * arrow starts on, a move slides it, a turn turns it. The kernel's answer
 * replaces the guess as soon as it is back.
 */
import type { Vec3 } from '@extrudo/core';
import type { Manipulator } from './spec';

/** A handle's ghost rule, with the value its field had in the draft the ghost shows. */
export type GhostHint =
  | {
      kind: 'stretch' | 'move';
      field: string;
      /** The field's value in the shown draft. */
      value: number;
      origin: Vec3;
      direction: Vec3;
      /** World length per unit of the field's value (the arrow's `scale`). */
      scale: number;
    }
  | {
      kind: 'turn';
      field: string;
      value: number;
      origin: Vec3;
      axis: Vec3;
      /** Degrees per unit of the field's value (the arc's `scale`). */
      scale: number;
    };

/** The ghost rules of a draft's handles, with its fields' values. */
export function ghostHints(
  manipulators: readonly Manipulator[],
  value: (field: string) => number | undefined,
): GhostHint[] {
  const hints: GhostHint[] = [];
  for (const m of manipulators) {
    if (m.kind !== 'distance' && m.kind !== 'angle') continue;
    const v = value(m.field);
    if (!m.ghost || v === undefined) continue;
    const scale = m.scale ?? 1;
    if (m.kind === 'distance') {
      hints.push({
        kind: m.ghost,
        field: m.field,
        value: v,
        origin: m.origin,
        direction: m.direction,
        scale,
      });
    } else {
      hints.push({ kind: 'turn', field: m.field, value: v, origin: m.origin, axis: m.axis, scale });
    }
  }
  return hints;
}

/**
 * The world matrix (column-major, as three.js's `Matrix4.elements`) that
 * takes the shown ghost to the current values, or undefined when nothing
 * changed or a change can't be guessed (a stretch through zero, which the
 * kernel's answer shows).
 */
export function ghostMatrix(
  hints: readonly GhostHint[] | undefined,
  value: (field: string) => number | undefined,
): number[] | undefined {
  let total: Affine | undefined;
  for (const hint of hints ?? []) {
    const now = value(hint.field);
    if (now === undefined || now === hint.value) continue;
    const step = affineOf(hint, now);
    if (step) total = total ? compose(step, total) : step;
  }
  return total && columnMajor(total);
}

/** p ↦ m·p + t, `m` by rows. */
interface Affine {
  m: [Vec3, Vec3, Vec3];
  t: Vec3;
}

function affineOf(hint: GhostHint, now: number): Affine | undefined {
  switch (hint.kind) {
    case 'move': {
      const s = (now - hint.value) * hint.scale;
      const d = hint.direction;
      return { m: IDENTITY, t: [d[0] * s, d[1] * s, d[2] * s] };
    }
    case 'stretch': {
      // From the plane through the origin across the direction; the ghost
      // doesn't turn inside out (the kernel's answer shows the other side).
      if (hint.value === 0) return undefined;
      const k = now / hint.value;
      if (!(k > 1e-6)) return undefined;
      const d = hint.direction;
      const m = rows((i, j) => (i === j ? 1 : 0) + (k - 1) * d[i] * d[j]);
      return about(m, hint.origin);
    }
    case 'turn': {
      const angle = (((now - hint.value) * hint.scale) / 180) * Math.PI;
      const a = hint.axis;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const cross: [Vec3, Vec3, Vec3] = [
        [0, -a[2], a[1]],
        [a[2], 0, -a[0]],
        [-a[1], a[0], 0],
      ];
      // Rodrigues: c·I + s·[a]× + (1 − c)·a·aᵀ.
      const m = rows((i, j) => (i === j ? c : 0) + s * cross[i][j] + (1 - c) * a[i] * a[j]);
      return about(m, hint.origin);
    }
  }
}

const IDENTITY: [Vec3, Vec3, Vec3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function rows(entry: (i: 0 | 1 | 2, j: 0 | 1 | 2) => number): [Vec3, Vec3, Vec3] {
  const row = (i: 0 | 1 | 2): Vec3 => [entry(i, 0), entry(i, 1), entry(i, 2)];
  return [row(0), row(1), row(2)];
}

/** `m` about the point `o`: p ↦ o + m·(p − o). */
function about(m: [Vec3, Vec3, Vec3], o: Vec3): Affine {
  const mo = apply(m, o);
  return { m, t: [o[0] - mo[0], o[1] - mo[1], o[2] - mo[2]] };
}

function apply(m: [Vec3, Vec3, Vec3], p: Vec3): Vec3 {
  const dot = (r: Vec3) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2];
  return [dot(m[0]), dot(m[1]), dot(m[2])];
}

/** `second` after `first`. */
function compose(second: Affine, first: Affine): Affine {
  const m = rows(
    (i, j) =>
      second.m[i][0] * first.m[0][j] +
      second.m[i][1] * first.m[1][j] +
      second.m[i][2] * first.m[2][j],
  );
  const t = apply(second.m, first.t);
  return { m, t: [t[0] + second.t[0], t[1] + second.t[1], t[2] + second.t[2]] };
}

function columnMajor({ m, t }: Affine): number[] {
  return [
    m[0][0],
    m[1][0],
    m[2][0],
    0,
    m[0][1],
    m[1][1],
    m[2][1],
    0,
    m[0][2],
    m[1][2],
    m[2][2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}
