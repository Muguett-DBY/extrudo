// STEP part names as body names (ADR-0034's second amendment): the fixture
// `fixtures/imports/named-parts.step` holds an assembly whose two parts share
// a name and whose third part is named only by its instance, so the reader,
// the `import` feature's `ImportReport.names` and the generic-name filter are
// all exercised. Real OCCT, `strictLeaks` on.
import {
  type AttachmentId,
  type ExtrudoDocument,
  type FeatureId,
  type ImportReport,
  importInputs,
  isImportReport,
} from '@extrudo/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import namedParts from '../../../../fixtures/imports/named-parts.step?url&inline';
import { Kernel, type ShapeHandle } from '../kernel';
import { loadOcct } from '../occt/load';
import { RecomputeEngine } from '../recompute/engine';
import { testDocument, testFeature } from '../recompute/testing';
import type { ImportedFile } from '../recompute/types';
import { kernelFeatures } from '.';

let kernel: Kernel;

beforeAll(async () => {
  kernel = new Kernel(await loadOcct());
});

afterEach(() => {
  expect(kernel.stats().liveShapes).toBe(0);
});

/** The bytes of a `data:` URL (Vite's `?url&inline` import of a binary file). */
function bytesOf(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

describe('STEP part names in the kernel (ADR-0034)', () => {
  it('reads each solid its own, its part\u2019s or its assembly instance\u2019s name', () => {
    const names = kernel.readStepNames(new TextDecoder().decode(bytesOf(namedParts)));
    // The two named parts come through by name; the third has no part name and
    // takes its instance's.
    expect([...names].sort()).toEqual(['Base plate', 'Lid', 'Lid']);
  });
});

describe("the import feature's names (ADR-0034)", () => {
  const IMPORT_ID = 'Import1' as FeatureId;
  const file = 'file-1' as AttachmentId;
  let engine: RecomputeEngine | undefined;
  const held = new Map<AttachmentId, ImportedFile>();

  afterEach(() => {
    engine?.clear();
    engine = undefined;
    held.clear();
  });

  function design(text: string): ExtrudoDocument {
    const bytes = new TextEncoder().encode(text);
    held.set(file, { bytes, mediaType: 'model/step' });
    return {
      ...testDocument([
        {
          ...testFeature('Import1', 'import'),
          inputs: importInputs({ file }),
        },
      ]),
      attachments: {
        [file]: {
          name: 'parts',
          fileName: 'parts.step',
          mediaType: 'model/step',
          sha256: 'c'.repeat(64),
          size: bytes.length,
        },
      },
    };
  }

  async function report(doc: ExtrudoDocument) {
    engine ??= new RecomputeEngine(kernel, kernelFeatures(), {
      strictLeaks: true,
      files: (id) => held.get(id),
    });
    const result = await engine.recompute({ doc });
    if (result.status !== 'done') throw new Error('cancelled');
    expect(result.features[IMPORT_ID]?.status).toBe('ok');
    const own = result.reports[IMPORT_ID];
    return isImportReport(own) ? (own as ImportReport) : undefined;
  }

  it('names each body after its solid, numbering a repeated name', {
    timeout: 60_000,
  }, async () => {
    const got = await report(design(new TextDecoder().decode(bytesOf(namedParts))));
    if (!got) throw new Error('no import report');
    expect(Object.values(got.names).sort()).toEqual(['Base plate', 'Lid', 'Lid (2)']);
  });

  it('drops empty and generic names (SOLID, PART, an all-digits name)', {
    timeout: 60_000,
  }, async () => {
    const boxes = [
      kernel.box([10, 10, 10], [0, 0, 0]),
      kernel.box([10, 10, 10], [20, 0, 0]),
      kernel.box([10, 10, 10], [40, 0, 0]),
      kernel.box([10, 10, 10], [60, 0, 0]),
    ];
    let text: string;
    try {
      text = kernel.writeStep([
        { shape: boxes[0] as ShapeHandle, name: 'PART' },
        { shape: boxes[1] as ShapeHandle, name: 'SOLID' },
        { shape: boxes[2] as ShapeHandle, name: '123' },
        { shape: boxes[3] as ShapeHandle, name: 'Body' },
      ]);
    } finally {
      kernel.release(...boxes);
    }
    const got = await report(design(text));
    if (!got) throw new Error('no import report');
    expect(got.names).toEqual({});
  });

  it('a file whose product names are all empty has no report, as before', {
    timeout: 60_000,
  }, async () => {
    // The bare `PRODUCT('')` an un-named writer makes: the feature never reads
    // names for it, so a file without names computes exactly as it did.
    const nameless = new TextDecoder()
      .decode(bytesOf(namedParts))
      .replace(/PRODUCT\('[^']*'/g, "PRODUCT(''");
    const got = await report(design(nameless));
    expect(got).toBeUndefined();
  });
});
