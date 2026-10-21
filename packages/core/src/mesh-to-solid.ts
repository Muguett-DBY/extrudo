/**
 * The Mesh to Solid feature (P4-13, FR-IO-10, ADR-0097 §1): turns an
 * imported mesh body into a B-rep solid with real faces, so it fillets,
 * shells and takes sketches like any body. `body` is the mesh body (a solid
 * is refused); `method` says how: `prismatic` recognises planes and
 * cylinders within `tolerance` and rebuilds exact faces, `faceted` keeps
 * every flat facet as a face. `tolerance` is a length in mm and only matters
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

/** How far a facet may sit from a fitted surface, in mm (ADR-0097 §1). */
export const MESH_TO_SOLID_DEFAULT_TOLERANCE = 0.01;

export const MeshToSolidInputsSchema = z.strictObject({
  /** The mesh body to convert. Empty: the feature fails until one is picked. */
  body: refsOf(['body'], 1).describe('The mesh body to convert. Required.'),
  /** Default `prismatic`. */
  method: enumInput(MESH_TO_SOLID_METHODS)
    .optional()
    .describe(
      'prismatic recognises planes and cylinders within the tolerance and rebuilds exact faces; faceted keeps every flat facet as a face. Default prismatic.',
    ),
  /** Prismatic only: how far a facet may sit from a fitted surface. Default 0.01 mm. */
  tolerance: exprOf('length')
    .optional()
    .describe(
      'How far a facet may sit from a fitted surface, in mm (prismatic only). Default 0.01.',
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
}

/** The surface counts of a report or of a region preview. */
export type MeshSurfaceCounts = Pick<
  MeshToSolidReport,
  'planes' | 'cylinders' | 'cones' | 'spheres' | 'tori' | 'unfit'
>;

const SURFACE_KINDS = [
  ['planes', 'plane', 'planes'],
  ['cylinders', 'cylinder', 'cylinders'],
  ['cones', 'cone', 'cones'],
  ['spheres', 'sphere', 'spheres'],
  ['tori', 'torus', 'tori'],
] as const;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "6 planes, 1 cylinder · 0 unfit" (ADR-0097 §4): every kind found, and the
 * unfit regions always.
 */
export function meshSurfaceSummary(counts: MeshSurfaceCounts): string {
  const found = SURFACE_KINDS.filter(([key]) => counts[key] > 0).map(([key, one, many]) =>
    count(counts[key], one, many),
  );
  return [found.join(', '), `${counts.unfit.regions} unfit`].filter(Boolean).join(' · ');
}

/** A conversion's report in one line: "6 faces" (faceted), "6 planes, 1 cylinder · 0 unfit" (prismatic). */
export function meshToSolidSummary(report: MeshToSolidReport): string {
  return report.method === 'faceted'
    ? count(report.faces, 'face', 'faces')
    : meshSurfaceSummary(report);
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
}

/** Reads a conversion's (valid) inputs with their defaults. */
export function meshToSolidSettings(inputs: MeshToSolidInputs): MeshToSolidSettings {
  return {
    body: inputs.body.refs[0],
    method: inputs.method?.value ?? 'prismatic',
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
