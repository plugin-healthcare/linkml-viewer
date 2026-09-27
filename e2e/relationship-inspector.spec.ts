import { test, expect, type Page } from '@playwright/test';
import { waitForGraph, tableNode } from './helpers';

// ---------------------------------------------------------------------------
// R2.8.12 — relationship inspector.
//
// Presentation-only: it lists exactly the relationships the canvas consumes
// (the layout `edges` surface), never the original LinkML schema. Selected
// edges take precedence over table focus, matching the canvas.
// ---------------------------------------------------------------------------

async function openInspector(page: Page) {
  await page.getByRole('button', { name: 'Relationships' }).click();
  await expect(page.getByTestId('relationship-inspector')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

test('inspector lists a selected table relationships from the canvas edge surface', async ({ page }) => {
  await openInspector(page);
  await expect(page.getByText(/Select a table or a relationship/)).toBeVisible();

  await tableNode(page, 'person').locator('.header').click();
  // Wait for the native selection to surface before counting (the inspector is
  // driven by relationship focus, not by the click itself).
  await expect
    .poll(() => page.evaluate(() => window.__erdFocus.get().selectedTableIds))
    .toEqual(['person']);

  // Outgoing + incoming, using the inspector's own rule (an edge is outgoing
  // when its source table is focused, incoming when its target table is).
  const counts = await page.evaluate(() => {
    const table = (id: string) => id.split('\u0000')[0];
    const edges = window.__erdEdges.get();
    return {
      out: edges.filter((e) => table(e.source) === 'person').length,
      inc: edges.filter((e) => table(e.target) === 'person').length,
    };
  });
  expect(counts.out + counts.inc).toBeGreaterThan(0);
  await expect(page.locator('.ri-row')).toHaveCount(counts.out + counts.inc);
});

test('inspector row click selects that relationship natively', async ({ page }) => {
  await openInspector(page);
  await tableNode(page, 'person').locator('.header').click();
  await expect
    .poll(() => page.evaluate(() => window.__erdFocus.get().selectedTableIds))
    .toEqual(['person']);

  const firstRow = page.locator('.ri-row').first();
  await expect(firstRow).toBeVisible();
  await firstRow.click();

  // Edge precedence: the clicked relationship becomes the selected one, and the
  // canvas selection follows (no parallel selection model).
  await expect(page.locator('.ri-row-selected')).toHaveCount(1);
  const selected = await page.evaluate(() => window.__erdSelection.getSelectedEdgeIds());
  expect(selected.length).toBe(1);
});
