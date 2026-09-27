import { test, expect } from '@playwright/test';
import { waitForGraph, resetLayoutDelay } from './helpers';

// ---------------------------------------------------------------------------
// R2.8.11 — primary controls (M7).
//
// The layout is exposed as two orthogonal, intent-labelled axes:
//   direction (primary): "Left → Right" / "Top → Bottom"
//   engine   (secondary): "ELK" / "Dagre"
// instead of the engine-initials glyphs (D→ D↓ E→ E↓). Selecting either axis
// switches the layout through the same `onlayoutselect` path and preserves the
// other axis. No new layout semantics.
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

test.afterEach(async ({ page }) => {
  await resetLayoutDelay(page);
});

test('layout controls are labelled by direction and engine, not glyphs', async ({ page }) => {
  await expect(
    page.getByRole('button', { name: 'Layout direction: Left → Right' })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Layout direction: Top → Bottom' })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Layout engine: ELK' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Layout engine: Dagre' })).toBeVisible();

  // The cryptic engine-initials glyphs are gone.
  for (const glyph of ['D→', 'D↓', 'E→', 'E↓']) {
    await expect(page.locator('.controls-panel button', { hasText: glyph })).toHaveCount(0);
  }
});

test('clicking each axis switches layout, preserving the other axis', async ({ page }) => {
  // Product default: ELK + left-to-right.
  await expect
    .poll(() => page.evaluate(() => window.__erdLayout.getLayoutOptions()))
    .toEqual({ engine: 'elk', direction: 'LR' });

  await page.getByRole('button', { name: 'Layout direction: Top → Bottom' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__erdLayout.getLayoutOptions()))
    .toEqual({ engine: 'elk', direction: 'TB' });

  // Wait for the first layout to settle so the next control is enabled.
  await expect(page.getByRole('button', { name: 'Layout engine: Dagre' })).toBeEnabled();
  await page.getByRole('button', { name: 'Layout engine: Dagre' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__erdLayout.getLayoutOptions()))
    .toEqual({ engine: 'dagre', direction: 'TB' });

  await expect(
    page.getByRole('button', { name: 'Layout direction: Top → Bottom' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Layout engine: Dagre' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});
