// P4-13 slice D4: the browser's Mesh to Solid time against node's (ADR-0097's
// slice D4 amendment). A measurement script, not a CI test: skipped unless
// MESH_TIMING is set. It imports each STL with "As solid" off, then runs
// Convert to Solid… (Prismatic, Auto) and times from the dialog's OK to the
// body row losing its mesh flag (the conversion done). Fixtures come from
// fixtures/imports/mesh-to-solid/; the larger own/ files from the folder
// MESH_TIMING_DIR names (default /tmp/extrudo-mesh-timing; they are not
// repository fixtures). Run through spikes/stl-to-solid/browser-timing.sh.
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { ok } from './benchmark-helpers';
import { kernelReady, openProject, selectTab } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 1_800_000 });
test.skip(!process.env.MESH_TIMING, 'a measurement script: set MESH_TIMING to run it');

const viewport = (page: Page) => page.getByRole('region', { name: 'Viewport' });
const bodyRow = (page: Page) => page.locator('[data-body]').first();

const FIXTURES = 'fixtures/imports/mesh-to-solid/';
const FIXTURE_FILES = [
  'peg-perego-button.stl',
  'trashcan-spacer.stl',
  'drill-block.stl',
  'hole-filler-35mm.stl',
  'puzzle-base-circle.stl',
  'remove-before-flight-cover.stl',
  'track-straight-100mm.stl',
  'trashcan-repair-foot.stl',
];
const OWN_DIR = process.env.MESH_TIMING_DIR ?? '/tmp/extrudo-mesh-timing';
const OWN_FILES = ['battery-holder.stl', 'phone-stand-foldable.stl', 'spool-screw-v4.1.stl'];

/** Home › Import Model with a buffer, OK, "As solid" off, and the one mesh body. */
async function importMesh(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser');
  await selectTab(page, 'Home');
  await page.getByRole('button', { name: 'Import Model', exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: 'model/stl', buffer });
  const panel = page.getByRole('region', { name: 'Import dialog' });
  await expect(panel).toHaveAttribute('data-preview-status', 'ok', { timeout: 180_000 });
  await panel.getByRole('button', { name: /^OK/ }).click();
  await expect(bodyRow(page)).toHaveAttribute('data-body-mesh', 'true', { timeout: 120_000 });
}

/** The body row's "Convert to Solid…", Prismatic/Auto, and the time from OK to done. */
async function convertTimed(page: Page): Promise<number> {
  await bodyRow(page).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Convert to Solid…' }).click();
  const dialog = page.getByRole('region', { name: 'Mesh to Solid dialog' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Method' })).toHaveValue('prismatic');
  await expect(dialog.getByRole('combobox', { name: 'Tolerance' })).toHaveValue('auto');
  // The dialog's own region preview first (not part of the measured span).
  await expect(dialog).toHaveAttribute('data-preview-status', 'ok', { timeout: 180_000 });
  const start = Date.now();
  await ok(page, dialog);
  await expect(bodyRow(page)).not.toHaveAttribute('data-body-mesh', { timeout: 300_000 });
  const ms = Date.now() - start;
  // The result is a plain solid and the chip exists.
  await expect(viewport(page)).toHaveAttribute('data-bodies', /./, { timeout: 60_000 });
  return ms;
}

test('browser Mesh to Solid timings', async ({ page }) => {
  await openProject(page);
  await kernelReady(page);
  const jobs: [string, Buffer][] = FIXTURE_FILES.map((name) => [
    name,
    readFileSync(`${FIXTURES}${name}`),
  ]);
  for (const name of OWN_FILES) jobs.push([name, readFileSync(`${OWN_DIR}/${name}`)]);

  const results: { file: string; run: number; ms: number }[] = [];
  for (const [name, buffer] of jobs) {
    for (const run of [1, 2]) {
      // A fresh blank design each time: each import adds a body and one undo
      // would only take the conversion away.
      await openProject(page);
      await kernelReady(page);
      await importMesh(page, name, buffer);
      const ms = await convertTimed(page);
      results.push({ file: name, run, ms });
      console.log(`TIMING ${JSON.stringify({ file: name, run, ms })}`);
    }
  }
  console.log(`TIMINGS ${JSON.stringify(results)}`);
});
