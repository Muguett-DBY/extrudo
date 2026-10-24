/**
 * The Mesh to Solid feature (P4-13, FR-IO-10, ADR-0097 §1): turns an
 * imported mesh body into a B-rep solid with real faces, so it fillets,
 * shells and takes sketches like any body. `body` is the mesh body (a solid
 * is refused); `method` says how: `prismatic` recognises planes, cylinders,
 * cones, spheres and tori within `tolerance` and rebuilds exact faces (what
 * fits nothing stays as facets), `faceted` keeps every flat facet as a face. `tolerance` is a length in mm and only matters
 * to `prismatic`.
 *
 * The result **replaces the mesh body under its own body ID** (as Combine
 * replaces its target), so the body keeps its name, colour and place in the
 * browser; suppressing the feature gives the mesh back. The kernel adds its
 * evaluator and the web app its dialog, each in its own registry keyed by
 * `MESH_TO_SOLID_TYPE` (ADR-0003).
 */
import { enumInput, exprOf, refsOf } from './feature-inputs';
import type { FeatureDefinition } from './features';
import type { GeomRef } from './schema';
import { z } from './zod';

export const MESH_TO_SOLID_TYPE = 'meshToSolid';

/** How a mesh is turned into a solid (ADR-0097 §3). */
export const MESH_TO_SOLID_METHODS = ['prismatic', 'faceted'] as const;
export type MeshToSolidMethod = (typeof MESH_TO_SOLID_METHODS)[number];

export const MeshToSolidInputsSchema = z.strictObject({
  /** The mesh body to convert. Empty: the feature fails until one is picked. */
  body: refsOf(['body'], 1).describe('The mesh body to convert. Required.'),
  /** Default `prismatic`. */
  method: enumInput(MESH_TO_SOLID_METHODS)
    .optional()
    .describe(
      'prismatic recognises planes, cylinders, cones, spheres and tori within the tolerance and rebuilds exact faces; what fits nothing stays as facets. faceted keeps every flat facet as a face. Default prismatic.',
    ),
  /** Prismatic only: how far a facet may sit from a fitted surface. Absent: Auto. */
  tolerance: exprOf('length')
    .optional()
    .describe(
      'How far a facet may sit from a fitted surface, in mm (prismatic only). Absent: Auto, the kernel picks 0.01-0.1 mm from the mesh.',
    ),
});
export type MeshToSolidInputs = z.infer<typeof MeshToSolidInputsSchema>;

export const meshToSolidFeature: FeatureDefinition<MeshToSolidInputs> = {
  type: MESH_TO_SOLID_TYPE,
  label: 'Mesh to Solid',
  category: 'modify',
  icon: 'mesh-to-solid',
  inputsSchema: MeshToSolidInputsSchema,
  // ADR-0097 §2: every face of the result, by position (there is no history
  // into the mesh to name them from).
  faceRoles: [
    {
      pattern: 'face:<n>',
      description: "Face n of the converted body, in the result's own order (1-based).",
    },
  ],
};

/**
 * What a conversion made, or what its segmentation found before a refusal
 * (ADR-0097 §4): the result's faces counted by surface kind, the regions that
 * fit nothing, and the tolerance that would have fitted the largest of them.
 * Derived, never stored: the kernel's report, `FeatureStatus.meshToSolid`
 * and the dialog's preview carry it.
 */
export interface MeshToSolidReport {
  method: MeshToSolidMethod;
  /** The result's faces (0 before a solid is built). */
  faces: number;
  planes: number;
  cylinders: number;
  cones: number;
  spheres: number;
  tori: number;
  /** The regions that fit no surface, their triangles, and their share of the surface area (0–1). */
  unfit: { regions: number; triangles: number; fraction: number };
  /** The tolerance that would have fitted the largest unfit region, when there is one. */
  suggestedTolerance?: number;
  /** The fitting tolerance the kernel used in mm (ADR-0097, slice D2): always for prismatic, Auto or not; absent for faceted. */
  tolerance?: number;
  /** The tolerance was Auto: the kernel picked it from the mesh (slice D2). */
  auto?: boolean;
  /**
   * How prismatic built the solid (ADR-0097, slice D1): `exact` from its
   * surfaces alone, `hybrid` from the mesh with an exact face per recognised
   * region and facets for the rest. Absent for faceted and before a solid.
   */
  rebuild?: 'exact' | 'hybrid';
  /** The result's facet faces (a hybrid rebuild's; 0 for faceted and exact). */
  facets: number;
}

/** The surface counts of a report or of a region preview. */
export type MeshSurfaceCounts = Pick<
  MeshToSolidReport,
  'planes' | 'cylinders' | 'cones' | 'spheres' | 'tori' | 'unfit' | 'tolerance' | 'auto'
>;

const SURFACE_KINDS = [
  ['planes', 'plane', 'planes'],
  ['cylinders', 'cylinder', 'cylinders'],
  ['cones', 'cone', 'cones'],
  ['spheres', 'sphere', 'spheres'],
  ['tori', 'torus', 'tori'],
] as const;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "0.02", "0.1": a tolerance's millimetres with no trailing zeros. */
export function formatTolerance(tolerance: number): string {
  return String(Number(tolerance.toFixed(4)));
}

/** " · auto 0.02 mm" when the kernel picked the tolerance (ADR-0097, slice D2). */
function autoSuffix(counts: Pick<MeshSurfaceCounts, 'auto' | 'tolerance'>): string {
  return counts.auto && counts.tolerance !== undefined
    ? ` · auto ${formatTolerance(counts.tolerance)} mm`
    : '';
}

/**
 * "6 planes, 1 cylinder · 0 unfit" (ADR-0097 §4): every kind found, and the
 * unfit regions always; " · auto 0.05 mm" appended when the kernel picked the
 * tolerance (slice D2).
 */
export function meshSurfaceSummary(counts: MeshSurfaceCounts): string {
  const found = SURFACE_KINDS.filter(([key]) => counts[key] > 0).map(([key, one, many]) =>
    count(counts[key], one, many),
  );
  const text = [found.join(', '), `${counts.unfit.regions} unfit`].filter(Boolean).join(' · ');
  return text + autoSuffix(counts);
}

/**
 * A conversion's report in one line: "6 faces" (faceted), "6 planes,
 * 1 cylinder · 0 unfit" (prismatic, exact), "12 planes, 4 cylinders · 3 unfit
 * regions kept as 318 facets" (prismatic, hybrid: ADR-0097 slice D1); with
 * " · auto 0.05 mm" when the kernel picked the tolerance (slice D2).
 */
export function meshToSolidSummary(report: MeshToSolidReport): string {
  if (report.method === 'faceted') return count(report.faces, 'face', 'faces');
  if (report.rebuild !== 'hybrid') return meshSurfaceSummary(report);
  const found = SURFACE_KINDS.filter(([key]) => report[key] > 0).map(([key, one, many]) =>
    count(report[key], one, many),
  );
  const facets = count(report.facets, 'facet', 'facets');
  const rest =
    report.unfit.regions > 0
      ? `${count(report.unfit.regions, 'unfit region', 'unfit regions')} kept as ${facets}`
      : facets;
  return [found.join(', '), rest].filter(Boolean).join(' · ') + autoSuffix(report);
}

/**
 * A surface kind of Mesh to Solid's region preview (ADR-0097 §5), as the
 * kernel's `meshRegions` reports it per surface.
 */
export const MESH_REGION_KIND = {
  unfit: -1,
  plane: 0,
  cylinder: 1,
  cone: 2,
  sphere: 3,
  torus: 4,
} as const;

/** A conversion's inputs with every default filled in: what the kernel builds. */
export interface MeshToSolidSettings {
  /** The mesh body to convert, or `undefined` until one is picked. */
  body: GeomRef | undefined;
  method: MeshToSolidMethod;
  /** The evaluated tolerance in mm, or `'auto'` when the input is absent (ADR-0097, slice D2). */
  tolerance: number | 'auto';
}

/**
 * Reads a conversion's (valid) inputs with their defaults. `value` is the
 * evaluated `tolerance` expression (the caller evaluates it; absent means
 * Auto, as the input itself is absent).
 */
export function meshToSolidSettings(
  inputs: MeshToSolidInputs,
  value?: number,
): MeshToSolidSettings {
  return {
    body: inputs.body.refs[0],
    method: inputs.method?.value ?? 'prismatic',
    tolerance: inputs.tolerance && value !== undefined ? value : 'auto',
  };
}

/** A conversion's inputs from a body ID, a method and a tolerance (tests, scripts; the dialog builds the same shape). */
export function meshToSolidInputs(
  body: string,
  method?: MeshToSolidMethod,
  tolerance?: string,
): MeshToSolidInputs {
  const inputs: MeshToSolidInputs = {
    body: { kind: 'ref', refs: [{ kind: 'body', id: body } satisfies GeomRef] },
  };
  if (method) inputs.method = { kind: 'enum', value: method };
  if (tolerance !== undefined) {
    inputs.tolerance = { kind: 'expr', expr: tolerance, unit: 'length' };
  }
  return inputs;
}
