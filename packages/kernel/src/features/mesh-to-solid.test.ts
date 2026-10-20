// The Mesh to Solid feature (P4-13, ADR-0095, slices 2 and 3) through the recompute
// engine: an imported mesh body becomes a solid under its own ID, fillets
// like a native solid, refuses a solid body and a bad tolerance, and gives
// the mesh back when suppressed. Real OCCT, a real manifold module and
// `strictLeaks`: a leaked mesh or shape fails the `afterEach`.
import {
  type AttachmentId,
  type BodyId,
  type ExtrudoDocument,
  type Feature,
  type FeatureId,
  filletInputs,
  importInputs,
  meshToSolidInputs,
  primitiveInputs,
} from '@extrudo/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import cubeStl from '../../../../fixtures/imports/cube.stl?url&inline';
import { kernelFeatures } from '../features';
import { Kernel, type ShapeHandle } from '../kernel';
import { loadManifold } from '../manifold';
import { loadOcct } from '../occt/load';
import { RecomputeEngine } from '../recompute/engine';
import { testDocument, testFeature } from '../recompute/testing';
import type { ImportedFile, RecomputeResult } from '../recompute/types';

type Done = Extract<RecomputeResult, { status: 'done' }>;

let kernel: Kernel;
let engine: RecomputeEngine | undefined;
const held = new Map<AttachmentId, ImportedFile>();

beforeAll(async () => {
  kernel = new Kernel(await loadOcct());
  kernel.enableMeshes(await loadManifold());
});

afterEach(() => {
  engine?.clear();
  engine = undefined;
  held.clear();
  expect(kernel.stats().liveShapes).toBe(0);
});

/** The bytes of a `data:` URL (Vite's `?url&inline` import of a fixture). */
function bytesOf(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** `fixtures/imports/cube.stl`: a 20 mm cube from (0, 0, 0) to (20, 20, 20). */
const CUBE = bytesOf(cubeStl);
const CUBE_BODY = 'Import1:0';

const files = (id: AttachmentId) => held.get(id);
const FILE = 'file-1' as AttachmentId;

/** One `import` of the cube fixture. */
function importMesh(id: string, file: AttachmentId = FILE): Feature {
  held.set(file, { bytes: CUBE, mediaType: 'model/stl', fileName: 'cube.stl' });
  return { ...testFeature(id, 'import'), inputs: importInputs({ file }) };
}

/** The document's attachment record for the fixture. */
function attachments(): ExtrudoDocument['attachments'] {
  return {
    [FILE]: {
      name: 'cube',
      fileName: 'cube.stl',
      mediaType: 'model/stl',
      sha256: 'c'.repeat(64),
      size: CUBE.length,
    },
  };
}

/** One `meshToSolid` of `body`, under the name given. */
function meshToSolid(id: string, body: string, tolerance?: string): Feature {
  return {
    ...testFeature(id, 'meshToSolid'),
    inputs: meshToSolidInputs(body, 'faceted', tolerance),
  };
}

async function recompute(features: Feature[]): Promise<Done> {
  engine ??= new RecomputeEngine(kernel, kernelFeatures(), { strictLeaks: true, files });
  const result = await engine.recompute({
    doc: { ...testDocument(features), attachments: attachments() },
  });
  if (result.status !== 'done') throw new Error('cancelled');
  return result;
}

/** Fails with the feature's message, so a broken test says why. */
function ok(result: Done): Done {
  for (const [id, s] of Object.entries(result.features)) {
    if (s.status === 'error') throw new Error(`${id}: ${s.message}`);
  }
  return result;
}

const status = (result: Done, id: string) => result.features[id as FeatureId];

/** The shape of the body `id` the engine holds. */
function bodyShape(id: string): ShapeHandle {
  const shape = (engine as RecomputeEngine).latestBody(id as BodyId);
  if (shape === undefined) throw new Error(`no body ${id}`);
  return shape;
}

const faceIds = (result: Done, id: string): string[] => [
  ...(result.bodies.find((b) => b.id === id)?.mesh?.faceIds ?? []),
];

describe('the Mesh to Solid feature (P4-13, ADR-0095)', { timeout: 300_000 }, () => {
  it('converts an imported mesh into a six-plane solid under the same body ID', async () => {
    const result = ok(
      await recompute([importMesh('Import1'), meshToSolid('MeshToSolid1', CUBE_BODY)]),
    );
    expect(status(result, 'MeshToSolid1')?.status).toBe('ok');
    // The same body, now a solid with six named faces.
    expect(result.bodies.map((b) => b.id)).toEqual([CUBE_BODY]);
    expect(kernel.isMesh(bodyShape(CUBE_BODY))).toBe(false);
    expect(faceIds(result, CUBE_BODY)).toEqual(
      Array.from({ length: 6 }, (_, i) => `toSolid:MeshToSolid1:face:${i + 1}`),
    );
    expect(kernel.properties(bodyShape(CUBE_BODY)).volume).toBeCloseTo(8000, 6);
    // The report (ADR-0095 §4).
    expect(result.reports['MeshToSolid1' as FeatureId]).toEqual({
      kind: 'meshToSolid',
      method: 'faceted',
      faces: 6,
      planes: 6,
      cylinders: 0,
      cones: 0,
      spheres: 0,
      tori: 0,
      unfit: { regions: 0, triangles: 0, fraction: 0 },
    });
  });

  it('gives a body that takes a Fillet', async () => {
    await recompute([importMesh('Import1'), meshToSolid('MeshToSolid1', CUBE_BODY)]);
    const edge = (engine as RecomputeEngine).reference(CUBE_BODY as BodyId, 'edge', 0);
    if (!edge) throw new Error('no edge on the converted body');
    const fillet: Feature = {
      ...testFeature('Fillet1', 'fillet'),
      inputs: filletInputs([{ edges: [edge], radius: '1 mm' }]),
    };
    const result = ok(
      await recompute([importMesh('Import1'), meshToSolid('MeshToSolid1', CUBE_BODY), fillet]),
    );
    expect(status(result, 'Fillet1')?.status).toBe('ok');
    expect(kernel.count(bodyShape(CUBE_BODY), 'face')).toBe(7);
  });

  it('refuses a body that is already a solid', async () => {
    const box: Feature = {
      ...testFeature('Box1', 'box'),
      inputs: primitiveInputs('box', {
        numbers: { length: '10 mm', width: '10 mm', height: '10 mm' },
      }),
    };
    const result = await recompute([box, meshToSolid('MeshToSolid1', 'Box1:0')]);
    expect(status(result, 'MeshToSolid1')?.status).toBe('error');
    expect(status(result, 'MeshToSolid1')?.message).toBe(
      'Mesh to Solid needs a mesh body: this body is already a solid.',
    );
  });

  it('refuses a tolerance of 0 mm', async () => {
    const result = await recompute([
      importMesh('Import1'),
      meshToSolid('MeshToSolid1', CUBE_BODY, '0 mm'),
    ]);
    expect(status(result, 'MeshToSolid1')?.status).toBe('error');
    expect(status(result, 'MeshToSolid1')?.message).toBe(
      'The tolerance must be greater than 0 mm.',
    );
  });

  it('converts with prismatic, the default method, into six exact planes', async () => {
    const feature: Feature = {
      ...testFeature('MeshToSolid1', 'meshToSolid'),
      inputs: meshToSolidInputs(CUBE_BODY, 'prismatic'),
    };
    const result = ok(await recompute([importMesh('Import1'), feature]));
    expect(kernel.isMesh(bodyShape(CUBE_BODY))).toBe(false);
    expect(kernel.properties(bodyShape(CUBE_BODY)).volume).toBeCloseTo(8000, 6);
    expect(result.reports['MeshToSolid1' as FeatureId]).toMatchObject({
      kind: 'meshToSolid',
      method: 'prismatic',
      faces: 6,
      planes: 6,
      cylinders: 0,
      unfit: { regions: 0, triangles: 0, fraction: 0 },
    });
  });

  it('gives the mesh body back when it is suppressed', async () => {
    const result = ok(
      await recompute([
        importMesh('Import1'),
        { ...meshToSolid('MeshToSolid1', CUBE_BODY), suppressed: true },
      ]),
    );
    expect(result.bodies.map((b) => b.id)).toEqual([CUBE_BODY]);
    expect(kernel.isMesh(bodyShape(CUBE_BODY))).toBe(true);
    expect(faceIds(result, CUBE_BODY)).toEqual(['mesh:Import1']);
  });
});
