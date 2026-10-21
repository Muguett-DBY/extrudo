import { expect, type Locator, type Page, test } from '@playwright/test';
import { writeStl } from '../packages/io/src/index';
import { ok } from './benchmark-helpers';
import { kernelReady, openProject, selectTab } from './helpers';

// P4-13, slice 4: Mesh to Solid's region preview and report (ADR-0095 §4,
// §5). While the dialog is open with Prismatic, the view colours the mesh by
// what the segmentation found and the dialog says it in one line; the report
// of the conversion stays on the feature's status (its chip's tooltip).

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 240_000 });

let errors: string[] = [];

test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const CUBE_STL = 'fixtures/imports/cube.stl';

const viewport = (page: Page) => page.getByRole('region', { name: 'Viewport' });
const chip = (page: Page, name: string) =>
  page
    .getByRole('list', { name: 'Features' })
    .getByRole('button', { name: new RegExp(`^${name}`) });
const bodyRow = (page: Page) => page.locator('[data-body]').first();

/** A UV sphere of radius 10, 12 rings of 22 segments (484 triangles, facing out); `scaleZ` squashes it into an ellipsoid. */
function sphereStl(scaleZ = 1): Buffer {
  const rings = 12;
  const segments = 22;
  const r = 10;
  const positions: number[] = [0, 0, -r];
  for (let j = 1; j < rings; j++) {
    const phi = -Math.PI / 2 + (Math.PI * j) / rings;
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      positions.push(
        r * Math.cos(phi) * Math.cos(a),
        r * Math.cos(phi) * Math.sin(a),
        r * Math.sin(phi),
      );
    }
  }
  positions.push(0, 0, r);
  for (let i = 2; i < positions.length; i += 3) positions[i] = (positions[i] ?? 0) * scaleZ;
  const top = positions.length / 3 - 1;
  const at = (j: number, i: number) => 1 + (j - 1) * segments + (i % segments);
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) indices.push(0, at(1, i + 1), at(1, i));
  for (let j = 1; j + 1 < rings; j++) {
    for (let i = 0; i < segments; i++) {
      indices.push(at(j, i), at(j, i + 1), at(j + 1, i + 1));
      indices.push(at(j, i), at(j + 1, i + 1), at(j + 1, i));
    }
  }
  for (let i = 0; i < segments; i++) indices.push(at(rings - 1, i), at(rings - 1, i + 1), top);
  return Buffer.from(
    writeStl({ positions: new Float64Array(positions), indices: new Uint32Array(indices) }),
  );
}

/** Home › Import Model with a file, OK, and the one mesh body it makes. */
async function importMesh(page: Page, file: string | { name: string; buffer: Buffer }) {
  const chooser = page.waitForEvent('filechooser');
  await selectTab(page, 'Home');
  await page.getByRole('button', { name: 'Import Model', exact: true }).click();
  await (await chooser).setFiles(
    typeof file === 'string' ? file : { ...file, mimeType: 'model/stl' },
  );
  const panel = page.getByRole('region', { name: 'Import dialog' });
  await expect(panel).toHaveAttribute('data-preview-status', 'ok', { timeout: 90_000 });
  await panel.getByRole('button', { name: /^OK/ }).click();
  await expect(bodyRow(page)).toHaveAttribute('data-body-mesh', 'true', { timeout: 60_000 });
}

/** The body row's "Convert to Solid…", and the dialog it opens. */
async function convertDialog(page: Page): Promise<Locator> {
  await bodyRow(page).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Convert to Solid…' }).click();
  const dialog = page.getByRole('region', { name: 'Mesh to Solid dialog' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the cube shows six planes before it converts; Faceted says six faces', async ({ page }) => {
  await openProject(page);
  await kernelReady(page);
  await importMesh(page, CUBE_STL);

  const dialog = await convertDialog(page);
  await expect(dialog).toHaveAttribute('data-regions', '6 planes, 0 cylinders, 0 unfit', {
    timeout: 60_000,
  });
  await expect(dialog.locator('[data-info="summary"]')).toHaveText('6 planes · 0 unfit');
  await expect(dialog.locator('[data-legend="summary"]')).toHaveText(
    /Planes.*Curved.*Fits nothing/,
  );
  // The view colours the mesh body in place of the drawing.
  await expect(viewport(page)).toHaveAttribute('data-preview-regions', /.+/);
  await expect(dialog).toHaveAttribute('data-preview-status', 'ok', { timeout: 90_000 });

  await dialog.getByRole('combobox', { name: 'Method' }).selectOption('faceted');
  await expect(dialog).not.toHaveAttribute('data-regions');
  await expect(viewport(page)).not.toHaveAttribute('data-preview-regions');
  await expect(dialog.locator('[data-info="summary"]')).toHaveText('6 faces', { timeout: 90_000 });
  await expect(dialog.locator('[data-legend="summary"]')).toHaveCount(0);
  await ok(page, dialog);
  await expect(viewport(page)).toHaveAttribute('data-bodies', 'Body1:6:20,20,20', {
    timeout: 60_000,
  });
});

test('an ellipsoid fits nothing: all red, refused, and Cancel leaves the mesh', async ({
  page,
}) => {
  await openProject(page);
  await kernelReady(page);
  await importMesh(page, { name: 'ellipsoid.stl', buffer: sphereStl(0.6) });

  const dialog = await convertDialog(page);
  await expect(dialog).toHaveAttribute('data-regions', '0 planes, 0 cylinders, 1 unfit', {
    timeout: 60_000,
  });
  await expect(dialog.locator('[data-info="summary"]')).toHaveText('1 unfit');
  await expect(dialog).toHaveAttribute('data-preview-status', 'error', { timeout: 90_000 });
  await expect(dialog.getByRole('status', { name: 'Feature status' })).toContainText(
    "Mesh to Solid couldn't close the body: 1 region (100 % of the surface)",
  );
  await expect(dialog.getByRole('button', { name: /^OK/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  // The regions stay drawn while the draft is refused.
  await expect(viewport(page)).toHaveAttribute('data-preview-regions', /.+/);
  await viewport(page).screenshot({ path: test.info().outputPath('ellipsoid-regions.png') });

  await dialog.getByRole('button', { name: 'Cancel' }).first().click();
  await expect(dialog).toBeHidden();
  await expect(viewport(page)).not.toHaveAttribute('data-preview-regions');
  await expect(bodyRow(page)).toHaveAttribute('data-body-mesh', 'true');
  await expect(chip(page, 'Mesh to Solid1')).toHaveCount(0);
});

test("the converted cube's chip says what it made", async ({ page }) => {
  await openProject(page);
  await kernelReady(page);
  await importMesh(page, CUBE_STL);

  const dialog = await convertDialog(page);
  await expect(dialog).toHaveAttribute('data-preview-status', 'ok', { timeout: 90_000 });
  await viewport(page).screenshot({ path: test.info().outputPath('cube-regions.png') });
  await ok(page, dialog);
  await expect(viewport(page)).toHaveAttribute('data-bodies', 'Body1:6:20,20,20', {
    timeout: 60_000,
  });
  await chip(page, 'Mesh to Solid1').hover();
  await expect(page.getByRole('tooltip')).toContainText('6 planes · 0 unfit');
});
