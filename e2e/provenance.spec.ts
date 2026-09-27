import { test, expect } from '@playwright/test';
import { waitForGraph } from './helpers';

// ---------------------------------------------------------------------------
// R2.8.13 — reconciliation / provenance visibility.
//
// The viewer states what established the model (the single producer and its
// pinned toolchain) and what was reconciled (counts + per-generator status),
// read from the artefact. Presentation-only; no semantic field is recomputed.
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

test('About opens a provenance dialog surfacing the producer and reconciliation', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'About this model' }).click();

  const dialog = page.getByRole('dialog', { name: 'About this model' });
  await expect(dialog).toBeVisible();

  // It states the reconciled nature and the producer/predecessor toolchain.
  await expect(dialog).toContainText('reconciled projection');
  await expect(dialog).toContainText('produce.py');
  await expect(dialog).toContainText('LinkML');

  // Per-generator reconciliation status is listed, including at least one
  // recorded upstream limitation (the `sql`/`lifecycle` recursion the producer
  // reconciled).
  await expect(dialog.locator('.pv-generator').first()).toBeVisible();
  await expect(dialog.locator('.pv-gen-state.warn').first()).toBeVisible();

  // Reconciliation counts are shown.
  await expect(dialog.locator('.pv-count')).toHaveCount(6);
});

test('the provenance dialog closes on Escape', async ({ page }) => {
  await page.getByRole('button', { name: 'About this model' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
