import { describe, expect, it } from 'vitest';
import { type MeshToSolidReport, meshToSolidSummary } from './mesh-to-solid';

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
});
