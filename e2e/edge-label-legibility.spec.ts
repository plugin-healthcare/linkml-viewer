import { test, expect, type Page } from '@playwright/test';
import {
  waitForGraph,
  getViewport,
  setViewport,
  setLayout,
  resetLayoutDelay,
  firstFkEdgeId,
  firstEtlEdgeId,
  screenLabelFor,
  screenLabels,
  edgePathMidScreen,
  flowLabelAtPoint,
  type ScreenLabel,
} from './helpers';

// ---------------------------------------------------------------------------
// R2.6.5 — counter-scaled selected-edge identity presentation freeze.
//
// Contract: when a relationship is selected below LOD2, its existing
// `edge.label` is rendered at a stable, readable screen size by
// `EdgeLabelOverlay` (counter-scaled viewport label), anchored to the same
// flow-space midpoint, while the ordinary zoom-coupled label for that edge is
// suppressed (no duplicate). Geometry, viewport, FK/ETL identity and selection
// semantics are unchanged. At LOD2 the overlay stands down.
// ---------------------------------------------------------------------------

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

async function selectEdge(page: Page, edgeId: string) {
  await page.evaluate((id) => window.__erdSelection.selectEdges([id]), edgeId);
  await expect.poll(() => page.evaluate(() => window.__erdSelection.getSelectedEdgeIds())).toEqual([
    edgeId,
  ]);
}

/** Wait until the screen-space label for an edge exists, then return it. */
async function waitScreenLabel(page: Page, edgeId: string): Promise<ScreenLabel> {
  await expect.poll(async () => (await screenLabelFor(page, edgeId))?.width ?? 0).toBeGreaterThan(0);
  const label = await screenLabelFor(page, edgeId);
  expect(label).not.toBeNull();
  return label!;
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const nodes = Object.fromEntries(
      [...document.querySelectorAll('.svelte-flow__node-tableParent')].map((e) => [
        e.getAttribute('data-id'),
        (e as HTMLElement).style.transform,
      ])
    );
    const edges = Object.fromEntries(
      [...document.querySelectorAll('.svelte-flow__edge')].map((e) => [
        e.getAttribute('data-id'),
        e.querySelector('.svelte-flow__edge-path')?.getAttribute('d') ?? null,
      ])
    );
    const vpEl = document.querySelector('.svelte-flow__viewport') as HTMLElement;
    const m = new DOMMatrixReadOnly(getComputedStyle(vpEl).transform);
    return { nodes, edges, viewport: { x: m.e, y: m.f, zoom: m.a } };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

test.afterEach(async ({ page }) => {
  await resetLayoutDelay(page);
});

// 1 — default OMOP fit (LOD0): the selected label is readable.
test('default fit: selected relationship label is screen-readable', async ({ page }) => {
  const fitZoom = (await getViewport(page)).zoom;
  const edgeId = await firstFkEdgeId(page);
  expect(edgeId).not.toBe('');

  await selectEdge(page, edgeId);
  const label = await waitScreenLabel(page, edgeId);
  expect(label.height).toBeGreaterThanOrEqual(11);

  // Exactly one readable surface; the tiny zoom-coupled one is suppressed.
  await expect(page.locator('.erd-edge-label')).toHaveCount(1);
  await expect(page.locator('.svelte-flow__edge-label')).toHaveCount(0);

  // Anchored to the relationship's own flow midpoint.
  const mid = await edgePathMidScreen(page, edgeId);
  expect(mid).not.toBeNull();
  expect(distance({ x: label.x, y: label.y }, mid!)).toBeLessThan(4);

  // eslint-disable-next-line no-console
  console.log(
    `[R2.6.5] default fit (zoom ${fitZoom.toFixed(3)}): ` +
      `selected label ${label.width.toFixed(2)}x${label.height.toFixed(2)}px`
  );
});

// 2 — LOD0 → LOD1: stable readable label.
test('LOD0 → LOD1 keeps a stable readable selected label', async ({ page }) => {
  const edgeId = await firstFkEdgeId(page);
  await selectEdge(page, edgeId);

  const heights: number[] = [];
  for (const zoom of [0.49, 0.6]) {
    await setViewport(page, { x: 0, y: 0, zoom });
    const label = await waitScreenLabel(page, edgeId);
    expect(label.height).toBeGreaterThanOrEqual(11);
    heights.push(label.height);
    await expect(page.locator('.erd-edge-label')).toHaveCount(1);
  }

  expect(Math.abs(heights[1] - heights[0])).toBeLessThan(1.5);
});

// 3 — LOD1 → LOD2: no duplicate selected label.
test('LOD1 → LOD2 produces no duplicate selected label', async ({ page }) => {
  const edgeId = await firstFkEdgeId(page);
  await selectEdge(page, edgeId);

  await setViewport(page, { x: 0, y: 0, zoom: 0.6 }); // LOD1
  const label = await waitScreenLabel(page, edgeId);
  // No ordinary label coincides with the screen-space surface.
  expect(await flowLabelAtPoint(page, label.x, label.y)).toBeNull();

  await setViewport(page, { x: 0, y: 0, zoom: 1.0 }); // LOD2
  await expect(page.locator('.erd-edge-label')).toHaveCount(0);
  await expect(page.locator('.svelte-flow__edge-label').first()).toBeVisible();
});

// 4 — deselect restores ordinary LOD behaviour.
test('deselect restores ordinary LOD label behaviour', async ({ page }) => {
  const edgeId = await firstFkEdgeId(page);
  await selectEdge(page, edgeId);

  await setViewport(page, { x: 0, y: 0, zoom: 0.49 }); // LOD0
  await expect(page.locator('.erd-edge-label')).toHaveCount(1);

  await page.evaluate(() => window.__erdSelection.clear());
  await expect
    .poll(() => page.evaluate(() => window.__erdSelection.getSelectedEdgeIds()))
    .toEqual([]);
  await expect(page.locator('.erd-edge-label')).toHaveCount(0);
  // Unselected LOD0 stays label-free.
  await expect(page.locator('.svelte-flow__edge-label')).toHaveCount(0);

  // At LOD2 the ordinary labels return after deselection.
  await setViewport(page, { x: 0, y: 0, zoom: 1.0 });
  expect(await page.locator('.svelte-flow__edge-label').count()).toBeGreaterThan(0);
});

// 5 — pan: label remains anchored.
test('pan keeps the selected label anchored to its relationship', async ({ page }) => {
  const edgeId = await firstFkEdgeId(page);
  await selectEdge(page, edgeId);
  await setViewport(page, { x: 0, y: 0, zoom: 0.3 });

  const before = await waitScreenLabel(page, edgeId);
  const midBefore = await edgePathMidScreen(page, edgeId);
  expect(midBefore).not.toBeNull();
  expect(distance({ x: before.x, y: before.y }, midBefore!)).toBeLessThan(4);

  await setViewport(page, { x: 420, y: 260, zoom: 0.3 });

  const after = await waitScreenLabel(page, edgeId);
  const midAfter = await edgePathMidScreen(page, edgeId);
  expect(midAfter).not.toBeNull();
  expect(distance({ x: after.x, y: after.y }, midAfter!)).toBeLessThan(4);
  // The relationship really moved on screen (the pan had an effect).
  expect(distance(midBefore!, midAfter!)).toBeGreaterThan(10);
});

// 6 — zoom: label remains screen-readable.
test('zoom keeps the selected label screen-readable', async ({ page }) => {
  const edgeId = await firstFkEdgeId(page);
  await selectEdge(page, edgeId);

  const heights: number[] = [];
  for (const zoom of [0.2, 0.3, 0.49, 0.6, 0.84]) {
    await setViewport(page, { x: 0, y: 0, zoom });
    const label = await waitScreenLabel(page, edgeId);
    expect(label.height).toBeGreaterThanOrEqual(11);
    heights.push(label.height);
  }
  // Stable across a ~4x zoom range.
  expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1.5);

  // At LOD2 the screen-space overlay stands down.
  await setViewport(page, { x: 0, y: 0, zoom: 0.85 });
  await expect(page.locator('.erd-edge-label')).toHaveCount(0);
});

// 7 — layout switch: label follows the relationship.
test('layout switch keeps the selected label on its relationship', async ({ page }) => {
  const edgeId = await firstFkEdgeId(page);
  await selectEdge(page, edgeId);

  await setLayout(page, { engine: 'dagre', direction: 'TB' });
  await page.waitForTimeout(1200); // fit intent settles

  // Selection survives the same-schema rebuild; the overlay re-anchors.
  await expect
    .poll(() => page.evaluate(() => window.__erdFocus.get().strongEdgeIds))
    .toEqual([edgeId]);

  const label = await waitScreenLabel(page, edgeId);
  const mid = await edgePathMidScreen(page, edgeId);
  expect(mid).not.toBeNull();
  expect(distance({ x: label.x, y: label.y }, mid!)).toBeLessThan(4);
});

// 8 — FK / ETL identity unchanged.
test('FK and ETL selected labels keep their kind identity', async ({ page }) => {
  const fk = await firstFkEdgeId(page);
  await selectEdge(page, fk);
  await setViewport(page, { x: 0, y: 0, zoom: 0.3 });
  const fkLabel = await waitScreenLabel(page, fk);
  expect(fkLabel.color).toBe('rgb(107, 114, 128)'); // --erd-edge-label-fk #6b7280

  await page.evaluate(() => window.__erdSchema.loadBundled('sein'));
  await expect.poll(async () => firstEtlEdgeId(page), { timeout: 30_000 }).not.toBe('');
  await page.waitForTimeout(1500);

  const etl = await firstEtlEdgeId(page);
  await selectEdge(page, etl);
  await setViewport(page, { x: 0, y: 0, zoom: 0.3 });
  const etlLabel = await waitScreenLabel(page, etl);
  expect(etlLabel.color).toBe('rgb(79, 70, 229)'); // --erd-edge-label-etl #4f46e5
});

// 9 — presentation changes no geometry or viewport.
test('selection changes no geometry or viewport', async ({ page }) => {
  await setViewport(page, { x: 120, y: 80, zoom: 0.6 });
  const before = await geometry(page);
  expect(Object.keys(before.nodes).length).toBeGreaterThan(0);
  expect(Object.keys(before.edges).length).toBeGreaterThan(0);

  const edgeId = await firstFkEdgeId(page);
  await selectEdge(page, edgeId);
  await expect.poll(async () => (await screenLabels(page)).length).toBeGreaterThan(0);

  const after = await geometry(page);
  expect(after).toEqual(before);
});

// 10 — R2.8.8 hover inspection: below LOD2 there are no static labels, but the
// relationship under the pointer renders its label at a readable screen size.
test('hovering a relationship reveals its label below LOD2, leaving hides it', async ({
  page,
}) => {
  await setViewport(page, { x: 0, y: 0, zoom: 0.6 }); // LOD1
  await expect(page.locator('.svelte-flow__edge-label')).toHaveCount(0);
  await expect(page.locator('.erd-edge-label')).toHaveCount(0);

  const edgeId = await firstFkEdgeId(page);
  expect(edgeId).not.toBe('');

  const pointer = (type: string, id: string) =>
    page.evaluate(
      ([t, i]) => {
        const groups = [...document.querySelectorAll('.svelte-flow__edge')];
        const el = groups.find((g) => g.getAttribute('data-id') === i);
        el?.dispatchEvent(new PointerEvent(t, { bubbles: true }));
      },
      [type, id] as const
    );

  await pointer('pointerenter', edgeId);
  const label = await waitScreenLabel(page, edgeId);
  expect(label.height).toBeGreaterThanOrEqual(11);

  await pointer('pointerleave', edgeId);
  await expect(page.locator('.erd-edge-label')).toHaveCount(0);
});
