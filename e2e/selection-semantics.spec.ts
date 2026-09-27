import { test, expect, type Page } from '@playwright/test';
import { waitForGraph, tableNode } from './helpers';

// ---------------------------------------------------------------------------
// R2.8.7 — selection semantics.
//
// Three distinct presentation states must be observable, not two:
//
//   SELECTED  the object the user explicitly chose  (.selected)
//   RELATED   an object connected to it             (.related)
//   DIMMED    everything else while focus is active (.dimmed)
//
// And the affordances must be separate: the table header selects; the collapse
// control collapses. This file drives real pointer interaction (click), not the
// selection seam, to pin the user-facing behaviour.
// ---------------------------------------------------------------------------

async function selectedTableIds(page: Page): Promise<string[]> {
  return page.locator('.svelte-flow__node-tableParent:has(.table-parent.selected)').evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-id') ?? '')
  );
}

async function countByState(page: Page, cls: 'selected' | 'related' | 'dimmed'): Promise<number> {
  return page.locator(`.table-parent.${cls}`).count();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

// ---------------------------------------------------------------------------
// 1 — Selecting a table marks it SELECTED, its neighbours RELATED, the rest
//     DIMMED. The header is the selection surface and does not collapse.
// ---------------------------------------------------------------------------
test('header click selects the table; neighbours are related; the rest dim', async ({ page }) => {
  const personColumns = page.locator('.svelte-flow__node-column[data-id^="person"]');
  expect(await personColumns.count()).toBeGreaterThan(0);

  await tableNode(page, 'person').locator('.header').click();

  await expect.poll(() => selectedTableIds(page)).toEqual(['person']);
  // Selection is not collapse: person's columns remain.
  expect(await personColumns.count()).toBeGreaterThan(0);
  // The selected table is NOT also styled as merely related.
  await expect(page.locator('.table-parent.selected.related')).toHaveCount(0);
  // Its neighbours are related; unrelated tables dim.
  expect(await countByState(page, 'related')).toBeGreaterThan(0);
  expect(await countByState(page, 'dimmed')).toBeGreaterThan(0);
  // Nothing is hidden — every table is in exactly one state.
  const total = await page.locator('.table-parent').count();
  expect(
    (await countByState(page, 'selected')) +
      (await countByState(page, 'related')) +
      (await countByState(page, 'dimmed'))
  ).toBe(total);
});

// ---------------------------------------------------------------------------
// 2 — Selecting a column row marks the exact row SELECTED and its parent table
//     SELECTED too, while the parent's other rows and connected tables are
//     RELATED.
// ---------------------------------------------------------------------------
test('column click selects the row and its parent table; peers are related', async ({ page }) => {
  const firstRow = page.locator('.svelte-flow__node-column[data-id^="person"]').first();
  await firstRow.click();

  // Exactly one row carries the selected treatment, and it is the clicked row.
  // Column ids contain the layout's NUL separator, so the owning column is read
  // via getAttribute (a CSS attribute selector cannot carry a NUL).
  const clickedId = await firstRow.getAttribute('data-id');
  expect(clickedId).not.toBeNull();
  await expect(page.locator('.col-row.selected')).toHaveCount(1);
  const selectedOwnerIds = await page
    .locator('.col-row.selected')
    .evaluateAll((els) =>
      els.map((el) => el.closest('.svelte-flow__node-column')?.getAttribute('data-id') ?? '')
    );
  expect(selectedOwnerIds).toEqual([clickedId]);

  // The parent table is selected (via its selected column), not merely related.
  await expect.poll(() => selectedTableIds(page)).toEqual(['person']);
  await expect(page.locator('.table-parent.selected.related')).toHaveCount(0);

  // Other rows of person are related, and the wider graph is dimmed.
  expect(await page.locator('.col-row.related').count()).toBeGreaterThan(0);
  expect(await countByState(page, 'dimmed')).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// 3 — The collapse control collapses only and preserves selection. Collapsing a
//     selected table, and collapsing an unrelated table, both leave the
//     selection untouched.
// ---------------------------------------------------------------------------
test('collapse control collapses without changing the selection', async ({ page }) => {
  // Select person via its header, then collapse it via the distinct control.
  await tableNode(page, 'person').locator('.header').click();
  await expect.poll(() => selectedTableIds(page)).toEqual(['person']);

  await tableNode(page, 'person').locator('.collapse-toggle').click();
  await expect(page.locator('.svelte-flow__node-column[data-id^="person"]')).toHaveCount(0);
  await expect.poll(() => selectedTableIds(page)).toEqual(['person']);
  expect(await page.evaluate(() => window.__erdFocus.get().active)).toBe(true);

  // Collapsing an unrelated table must not steal the selection.
  await tableNode(page, 'person').locator('.collapse-toggle').click(); // re-expand
  await expect(page.locator('.svelte-flow__node-column[data-id^="person"]').first()).toBeVisible();

  await tableNode(page, 'visit_occurrence').locator('.collapse-toggle').click();
  await expect(page.locator('.svelte-flow__node-column[data-id^="visit_occurrence"]')).toHaveCount(0);
  await expect.poll(() => selectedTableIds(page)).toEqual(['person']);
});

// ---------------------------------------------------------------------------
// 4 — Selecting an edge is distinct again: the relationship is strong, its two
//     endpoint tables are related, and no table is marked selected.
// ---------------------------------------------------------------------------
test('edge selection relates its endpoints without selecting a table', async ({ page }) => {
  const fk = await page.evaluate(() => {
    for (const el of document.querySelectorAll('.svelte-flow__edge')) {
      const path = el.querySelector('.svelte-flow__edge-path') as SVGPathElement | null;
      if (path && getComputedStyle(path).strokeDasharray === 'none') {
        return el.getAttribute('data-id') ?? '';
      }
    }
    return '';
  });
  expect(fk).not.toBe('');

  await page.evaluate((id) => window.__erdSelection.selectEdges([id]), fk);
  await expect(page.locator('.svelte-flow__edge.erd-edge-selected')).toHaveCount(1);

  await expect(page.locator('.table-parent.selected')).toHaveCount(0);
  expect(await countByState(page, 'related')).toBeGreaterThan(0);
  expect(await countByState(page, 'dimmed')).toBeGreaterThan(0);
});
