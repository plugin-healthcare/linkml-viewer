import { test, expect } from '@playwright/test';
import { waitForGraph, canvas } from './helpers';

// ---------------------------------------------------------------------------
// Responsive correction (R2.7.2) — the two defects found by the R2.7.1 audit:
//
//   1. Below ~960px with both editor panels open, `.content-row`'s fixed-width
//      panels (420px + 360px, flex-shrink:0) drove the flex-grown canvas to 0
//      and clipped the GroupEditor. The panels now use viewport-aware widths
//      (`min(420px, 38vw)` / `min(360px, 32vw)`), which are pixel-identical at
//      >=1280 but shrink below so the canvas keeps positive width.
//   2. The topbar title cluster had no `overflow:hidden`, so it painted over
//      the search bar at <=834px. `.topbar-left` now clips and `.app-title`
//      truncates with an ellipsis.
//
// These are presentation-only contracts; no interaction/search state changes.
// ---------------------------------------------------------------------------

const NARROW = { width: 834, height: 1112 };

test.describe('responsive correction (R2.7.2)', () => {
  test('canvas stays non-zero with both editors open at 834x1112', async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.goto('/');
    await waitForGraph(page);

    await page.getByRole('button', { name: /Schema/ }).click();
    await page.getByRole('button', { name: /Groups/ }).click();
    await expect(page.locator('.schema-editor-panel')).toBeVisible();
    await expect(page.locator('.group-editor-panel')).toBeVisible();

    const canvasBox = await canvas(page).boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(canvasBox!.width).toBeGreaterThan(0);

    // Neither panel clips past the right edge of the viewport.
    for (const sel of ['.schema-editor-panel', '.group-editor-panel']) {
      const box = await page.locator(sel).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(NARROW.width + 1);
      expect(box!.x).toBeGreaterThanOrEqual(-1);
    }
  });

  test('topbar title does not paint over search at 834', async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.goto('/');
    await waitForGraph(page);

    const search = await page.locator('.search-wrap').boundingBox();
    const title = await page.locator('.app-title').boundingBox();
    const left = await page.locator('.topbar-left').boundingBox();
    expect(search && title && left).toBeTruthy();

    // The title cluster is clipped to its column, and the title box itself ends
    // before the search bar begins — no overpaint.
    expect(left!.x + left!.width).toBeLessThanOrEqual(search!.x + 1);
    expect(title!.x + title!.width).toBeLessThanOrEqual(search!.x + 1);

    // The title is genuinely truncated (ellipsis), not merely clipped mid-glyph.
    const truncated = await page
      .locator('.app-title')
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(truncated).toBe(true);

    // Search remains fully visible and interactive (R2.4.x preserved).
    await expect(
      page.getByRole('combobox', { name: 'Search tables and columns' })
    ).toBeEnabled();
  });
});
