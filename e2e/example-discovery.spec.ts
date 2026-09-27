import { test, expect } from '@playwright/test';
import { waitForGraph } from './helpers';

// ---------------------------------------------------------------------------
// R2.8.9 — example discovery + LinkML/ERD vocabulary.
//
// The Examples menu loads a bundled example through the same path as the
// default (no new semantic path) and explains the LinkML → ERD mapping. It does
// not change the default schema, and it never manufactures ETL: SEIN shows the
// 60 ETL relationships the reconciled artefact actually contains.
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

test('Examples menu explains the vocabulary and loads SEIN', async ({ page }) => {
  // The default schema is OMOP: no ETL.
  await expect(page.locator('.node-count')).not.toContainText('ETL');

  await page.getByRole('button', { name: 'Examples' }).click();
  await expect(page.getByRole('menu', { name: 'Example schemas' })).toBeVisible();
  // The LinkML → ERD vocabulary is stated up front.
  await expect(page.getByText(/Class → Table/)).toBeVisible();

  await page.getByRole('menuitem', { name: /SEIN/ }).click();

  // SEIN loads through the bundled-artefact path: 29 tables, with ETL present.
  await expect
    .poll(() => page.locator('.svelte-flow__node-tableParent').count(), { timeout: 30_000 })
    .toBe(29);
  await expect(page.locator('.node-count')).toContainText('60 ETL');

  // Re-opening marks SEIN as the current example.
  await page.getByRole('button', { name: 'Examples' }).click();
  await expect(page.locator('.example-item.current')).toContainText('SEIN');
});
