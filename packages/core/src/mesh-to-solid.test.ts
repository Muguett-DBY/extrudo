import { describe, expect, it } from 'vitest';
import {
  type MeshToSolidReport,
  meshToSolidInputs,
  meshToSolidSettings,
  meshToSolidSummary,
} from './mesh-to-solid';

const report = (overrides: Partial<MeshToSolidReport>): MeshToSolidReport => ({
  method: 'prismatic',
  faces: 0,
  planes: 0,
  cylinders: 0,
  cones: 0,
  spheres: 0,
  tori: 0,
  unfit: { regions: 0, triangles: 0, fraction: 0 },
  facets: 0,
  ...overrides,
});

describe('meshToSolidSummary (ADR-0097 §4, slice D1)', () => {
  it('counts the faces of a faceted result', () => {
    expect(meshToSolidSummary(report({ method: 'faceted', faces: 6, planes: 6 }))).toBe('6 faces');
  });

  it('lists an exact result’s kinds and the unfit regions', () => {
    expect(
      meshToSolidSummary(report({ rebuild: 'exact', faces: 7, planes: 6, cylinders: 1 })),
    ).toBe('6 planes, 1 cylinder · 0 unfit');
  });

  it('says what a hybrid result kept as facets', () => {
    expect(
      meshToSolidSummary(
        report({
          rebuild: 'hybrid',
          faces: 336,
          planes: 12,
          cylinders: 4,
          tori: 2,
          unfit: { regions: 3, triangles: 900, fraction: 0.2 },
          facets: 318,
        }),
      ),
    ).toBe('12 planes, 4 cylinders, 2 tori · 3 unfit regions kept as 318 facets');
  });

  it('uses the singular forms, and names facets with no unfit region', () => {
    expect(
      meshToSolidSummary(
        report({
          rebuild: 'hybrid',
          planes: 1,
          cylinders: 1,
          unfit: { regions: 1, triangles: 2, fraction: 0.01 },
          facets: 1,
        }),
      ),
    ).toBe('1 plane, 1 cylinder · 1 unfit region kept as 1 facet');
    expect(meshToSolidSummary(report({ rebuild: 'hybrid', planes: 6, facets: 4 }))).toBe(
      '6 planes · 4 facets',
    );
  });

  // Slice D2: Auto appends the tolerance the kernel picked, no trailing zeros.
  it('names an Auto tolerance (0.02 mm, 0.1 mm)', () => {
    expect(
      meshToSolidSummary(
        report({ rebuild: 'exact', planes: 2, cylinders: 1, auto: true, tolerance: 0.02 }),
      ),
    ).toBe('2 planes, 1 cylinder · 0 unfit · auto 0.02 mm');
    expect(
      meshToSolidSummary(
        report({ rebuild: 'hybrid', planes: 6, facets: 4, auto: true, tolerance: 0.1 }),
      ),
    ).toBe('6 planes · 4 facets · auto 0.1 mm');
  });

  it('does not name the tolerance of a fixed (non-Auto) conversion', () => {
    expect(
      meshToSolidSummary(report({ rebuild: 'exact', planes: 6, cylinders: 1, tolerance: 0.01 })),
    ).toBe('6 planes, 1 cylinder · 0 unfit');
  });
});

describe('meshToSolidSettings (ADR-0097, slice D2: absent tolerance means Auto)', () => {
  it('reads Auto when the tolerance input is absent', () => {
    expect(meshToSolidSettings(meshToSolidInputs('b1'))).toMatchObject({
      method: 'prismatic',
      tolerance: 'auto',
    });
  });

  it('reads the evaluated value when the input is present', () => {
    expect(
      meshToSolidSettings(meshToSolidInputs('b1', 'prismatic', '0.05 mm'), 0.05),
    ).toMatchObject({ method: 'prismatic', tolerance: 0.05 });
  });
});
