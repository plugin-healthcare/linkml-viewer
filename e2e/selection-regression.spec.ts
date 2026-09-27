import { test, expect, type Page } from '@playwright/test';
import { waitForGraph, setViewport, getViewport, tableNode, screenLabelFor } from './helpers';

// ---------------------------------------------------------------------------
// R2.4.4 — Selection regression hardening / presentation-state preservation.
//
// Invariant: a presentation transform may add presentation state but must
// preserve the native Svelte Flow interaction state on the objects it receives
// — at minimum `selected`. Svelte Flow derives `selectedNodes`/`selectedEdges`
// by filtering `node.selected` / `edge.selected` on the array it is handed, so
// any rebuilt node/edge array that drops the flag resets selection (the R2.4.2
// defect class).
//
// These tests assert observable outcomes (selection/focus remains applied),
// not transform internals:
//   1. edge selection survives an LOD threshold crossing (applyEdgeLod →
//      applyEdgeFocus round-trip),
//   2. node selection survives a collapse/expand rebuild (layout rebuild),
//   3. node selection survives node presentation re-derivation (LOD),
//   4. selection clears on a schema/file switch (new graph).
// ---------------------------------------------------------------------------

/** First rendered FK edge id (path not dashed = not ETL), or ''. */
async function firstFkEdgeId(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const el of document.querySelectorAll('.svelte-flow__edge')) {
      const path = el.querySelector('.svelte-flow__edge-path') as SVGPathElement | null;
      if (!path) continue;
      if (getComputedStyle(path).strokeDasharray === 'none') {
        return el.getAttribute('data-id') ?? '';
      }
    }
    return '';
  });
}

/** First rendered column node id (carries the layout's NUL separator), or ''. */
async function firstColumnId(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector('.svelte-flow__node-column')?.getAttribute('data-id') ?? ''
  );
}

async function selectedNodeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__erdSelection.getSelectedNodeIds());
}

async function selectedEdgeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__erdSelection.getSelectedEdgeIds());
}

async function focusActive(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__erdFocus.get().active);
}

/**
 * The rendered label for one edge, matched by the label text the reconciled edge
 * already carries (`edge.label === slotName`, the middle `--` segment of the edge
 * id). Svelte Flow portals edge labels out of the edge `<g>`, so identity is by
 * text, not by ancestor. Returns null when no label is rendered.
 */
async function edgeLabelBox(
  page: Page,
  edgeId: string
): Promise<{ width: number; height: number } | null> {
  return page.evaluate((id) => {
    const slot = id.split('--')[1] ?? '';
    const labels = [...document.querySelectorAll('.svelte-flow__edge-label')] as HTMLElement[];
    const el = labels.find((l) => (l.textContent ?? '').trim() === slot);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }, edgeId);
}

function px(n: number): string {
  return `${n.toFixed(2)}px`;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

// ---------------------------------------------------------------------------
// 1 — Edge selection survives LOD threshold crossings.
// At LOD2 `applyEdgeLod` returns the source array unchanged; below LOD2 it
// rest-destructures `label` only, so the native `selected` flag is carried
// through, and `applyEdgeFocus` re-asserts it. Crossing a threshold must not
// drop the selected edge (the R2.4.2 reset loop lived exactly here).
// ---------------------------------------------------------------------------
test('edge selection survives an LOD threshold crossing', async ({ page }) => {
  await setViewport(page, { x: 0, y: 0, zoom: 1.0 }); // LOD2
  const edgeId = await firstFkEdgeId(page);
  expect(edgeId).not.toBe('');

  await page.evaluate((id) => window.__erdSelection.selectEdges([id]), edgeId);
  await expect.poll(() => selectedEdgeIds(page)).toEqual([edgeId]);
  await expect(page.locator('.svelte-flow__edge.erd-edge-selected')).toHaveCount(1);

  // Overview: labels dropped by applyEdgeLod; selection must persist.
  await setViewport(page, { x: 0, y: 0, zoom: 0.3 }); // LOD0
  await expect.poll(() => selectedEdgeIds(page)).toEqual([edgeId]);
  await expect(page.locator('.svelte-flow__edge.erd-edge-selected')).toHaveCount(1);

  // Structural, then back to semantic.
  await setViewport(page, { x: 0, y: 0, zoom: 0.6 }); // LOD1
  await expect.poll(() => selectedEdgeIds(page)).toEqual([edgeId]);
  await setViewport(page, { x: 0, y: 0, zoom: 1.0 }); // LOD2
  await expect.poll(() => selectedEdgeIds(page)).toEqual([edgeId]);
  await expect(page.locator('.svelte-flow__edge.erd-edge-selected')).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// 1b — R2.6.4.2 selected-edge identity below LOD2: the ordinary zoom-coupled
// label is suppressed for the natively selected edge and its existing
// `edge.label` is rendered at a stable screen size by EdgeLabelOverlay. This is
// a surface swap, not a semantic change. At LOD2 the overlay stands down and
// the ordinary (already legible) label is the single render. Deselect restores
// ordinary LOD behaviour.
// ---------------------------------------------------------------------------
test('selected edge renders a screen-stable label below LOD2; deselect restores ordinary LOD', async ({
  page,
}) => {
  // The default OMOP ELK-LR view is a fit (~0.161 zoom → LOD0).
  const fitZoom = (await getViewport(page)).zoom;
  const edgeId = await firstFkEdgeId(page);
  expect(edgeId).not.toBe('');

  await page.evaluate((id) => window.__erdSelection.selectEdges([id]), edgeId);
  await expect.poll(() => selectedEdgeIds(page)).toEqual([edgeId]);

  // LOD0 at the default fit zoom: the selected edge's label is screen-stable
  // and the ordinary zoom-coupled label for it no longer renders (no duplicate).
  const fitBox = await screenLabelFor(page, edgeId);
  expect(fitBox).not.toBeNull();
  expect(fitBox!.height).toBeGreaterThanOrEqual(11);
  await expect(page.locator('.erd-edge-label')).toHaveCount(1);
  await expect(page.locator('.svelte-flow__edge-label')).toHaveCount(0);

  // LOD1: below the semantic level no static labels render; the selected edge
  // keeps its readable screen-space label.
  await setViewport(page, { x: 0, y: 0, zoom: 0.6 });
  const lod1Box = await screenLabelFor(page, edgeId);
  expect(lod1Box).not.toBeNull();
  expect(lod1Box!.height).toBeGreaterThanOrEqual(11);

  // LOD2: the overlay stands down and the ordinary label is the single render.
  await setViewport(page, { x: 0, y: 0, zoom: 1.0 });
  await expect(page.locator('.erd-edge-label')).toHaveCount(0);
  const reference = await edgeLabelBox(page, edgeId);
  expect(reference).not.toBeNull();

  // LOD0 at the 0.49 threshold boundary.
  await setViewport(page, { x: 0, y: 0, zoom: 0.49 });
  const lod0Box = await screenLabelFor(page, edgeId);
  expect(lod0Box).not.toBeNull();
  await expect(page.locator('.erd-edge-label')).toHaveCount(1);

  // R2.6.4.2 measured on-screen size of the readable surface.
  const line =
    `[R2.6.4.2] selected edge label on-screen size — ` +
    `LOD0@fit(zoom ${fitZoom.toFixed(3)}): ${px(fitBox!.width)} x ${px(fitBox!.height)}; ` +
    `LOD0@0.49: ${px(lod0Box!.width)} x ${px(lod0Box!.height)}; ` +
    `LOD1@0.6: ${px(lod1Box!.width)} x ${px(lod1Box!.height)}; ` +
    `LOD2@1.0: ${px(reference!.width)} x ${px(reference!.height)}`;
  // eslint-disable-next-line no-console
  console.log(line);
  test.info().annotations.push({ type: 'r2.6.4.2-legibility', description: line });

  // Deselect → ordinary LOD behaviour is restored immediately.
  await page.evaluate(() => window.__erdSelection.clear());
  await expect.poll(() => selectedEdgeIds(page)).toEqual([]);
  await expect(page.locator('.erd-edge-label')).toHaveCount(0);
  await expect(page.locator('.svelte-flow__edge-label')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 1c — The split LOD0 contract: with no selection, LOD0 still has no labels.
// (The other half of the split asserted in 1b: selected LOD0 may retain one.)
// ---------------------------------------------------------------------------
test('unselected LOD0 retains no edge labels', async ({ page }) => {
  await setViewport(page, { x: 0, y: 0, zoom: 0.49 }); // LOD0
  expect(await page.evaluate(() => window.__erdSelection.getSelectedEdgeIds())).toEqual([]);
  await expect(page.locator('.svelte-flow__edge-label')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// 2 — Node selection survives a collapse/expand rebuild.
// The layout effect replaces the bound `nodes` array; the native `selected`
// flag must be carried across for nodes that still exist (same schema), or
// relationship focus (derived from selection) silently clears.
// ---------------------------------------------------------------------------
test('node selection survives a collapse/expand rebuild', async ({ page }) => {
  await page.evaluate(() => window.__erdSelection.selectNodes(['person']));
  await expect.poll(() => selectedNodeIds(page)).toEqual(['person']);
  await expect.poll(() => focusActive(page)).toBe(true);

  await page.getByRole('button', { name: 'Collapse all' }).click();
  await page.waitForTimeout(800);
  await expect.poll(() => selectedNodeIds(page)).toEqual(['person']);
  expect(await focusActive(page)).toBe(true);

  await page.getByRole('button', { name: 'Expand all' }).click();
  await page.waitForTimeout(800);
  await expect.poll(() => selectedNodeIds(page)).toEqual(['person']);
  expect(await focusActive(page)).toBe(true);
});

// ---------------------------------------------------------------------------
// 2b — Node selection survives collapsing an unrelated table. Only the
// selected node's object identity matters; presentation classes are derived
// from context, never written back into the node array.
// ---------------------------------------------------------------------------
test('node selection survives an unrelated collapse', async ({ page }) => {
  await page.evaluate(() => window.__erdSelection.selectNodes(['person']));
  await expect.poll(() => selectedNodeIds(page)).toEqual(['person']);

  await tableNode(page, 'visit_occurrence').locator('.collapse-toggle').dispatchEvent('click');
  await page.waitForTimeout(800);

  expect(await selectedNodeIds(page)).toEqual(['person']);
  expect(await focusActive(page)).toBe(true);
});

// ---------------------------------------------------------------------------
// 3 — Node presentation re-derivation does not drop native selection.
// Crossing LOD re-derives ColumnNode classes and the parent's related/dimmed
// class from context; the node array is never rewritten, so a selected column
// row (or table) stays selected.
// ---------------------------------------------------------------------------
test('column selection survives node presentation re-derivation', async ({ page }) => {
  const columnId = await firstColumnId(page);
  expect(columnId).not.toBe('');

  await page.evaluate((id) => window.__erdSelection.selectNodes([id]), columnId);
  await expect.poll(() => selectedNodeIds(page)).toEqual([columnId]);

  await setViewport(page, { x: 0, y: 0, zoom: 0.3 }); // LOD0
  await expect.poll(() => selectedNodeIds(page)).toEqual([columnId]);
  await setViewport(page, { x: 0, y: 0, zoom: 1.0 }); // LOD2
  await expect.poll(() => selectedNodeIds(page)).toEqual([columnId]);
});

// ---------------------------------------------------------------------------
// 4 — Selection clears on a schema/file switch. Reloading the default schema
// is a new graph with the same class ids, so a naive carry-over would keep
// `person` selected; the reset of the schema identity must clear it.
// ---------------------------------------------------------------------------
test('selection clears on a schema/file switch', async ({ page }) => {
  await page.evaluate(() => window.__erdSelection.selectNodes(['person']));
  await expect.poll(() => selectedNodeIds(page)).toEqual(['person']);

  await page.evaluate(() => window.__erdSchema.loadBundled('omop_cdm'));
  await expect.poll(() => selectedNodeIds(page)).toEqual([]);
  expect(await focusActive(page)).toBe(false);
  await expect(page.locator('.svelte-flow__edge.erd-edge-selected')).toHaveCount(0);
});
