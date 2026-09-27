import { test, expect } from '@playwright/test';
import {
  OMOP_CLASS_COUNT,
  waitForGraph,
  getViewport,
  setViewport,
  tableNode,
  tableCard,
  search,
  resetLayoutDelay,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

test.afterEach(async ({ page }) => {
  await resetLayoutDelay(page);
});

// ---------------------------------------------------------------------------
// Test 1 — collapse preserves the viewport (layout mutation ≠ viewport reset)
// ---------------------------------------------------------------------------
test('collapse preserves viewport', async ({ page }) => {
  await setViewport(page, { x: 120, y: 80, zoom: 0.72 });
  const before = await getViewport(page);

  // dispatchEvent, not click(): collapsing replaces the node elements, and a
  // normal click would be retried by Playwright against a detached element.
  await tableNode(page, 'person').locator('.header').dispatchEvent('click');
  // Column children must disappear (collapse actually happened).
  await expect(page.locator('.svelte-flow__node-column[data-id^="person"]')).toHaveCount(0);
  await page.waitForTimeout(900);

  const after = await getViewport(page);
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  expect(Math.abs(after.zoom - before.zoom)).toBeLessThan(0.01);
});

// ---------------------------------------------------------------------------
// Test 2 — search recentres without changing zoom, and highlights the target
// ---------------------------------------------------------------------------
test('search preserves zoom and highlights target', async ({ page }) => {
  await setViewport(page, { x: 0, y: 0, zoom: 0.63 });

  await search(page, 'person');
  await page.waitForTimeout(900); // setCenter animation is 500ms

  const zoom = await page.evaluate(() => window.__erdFlow.getZoom());
  expect(Math.abs(zoom - 0.63)).toBeLessThan(0.01);

  await expect(tableCard(page, 'person')).toHaveClass(/highlighted/);

  // Target should be centred in the flow pane.
  const pane = await page.locator('.svelte-flow').boundingBox();
  const nodeBox = await tableNode(page, 'person').boundingBox();
  expect(pane).not.toBeNull();
  expect(nodeBox).not.toBeNull();
  if (pane && nodeBox) {
    const dx = Math.abs(nodeBox.x + nodeBox.width / 2 - (pane.x + pane.width / 2));
    const dy = Math.abs(nodeBox.y + nodeBox.height / 2 - (pane.y + pane.height / 2));
    expect(dx).toBeLessThan(40);
    expect(dy).toBeLessThan(40);
  }
});

// ---------------------------------------------------------------------------
// Test 3 — rapid search: newest target wins; both clear after the timeout.
// This is the regression test for the old stale-closure highlight bug.
// ---------------------------------------------------------------------------
test('rapid search replaces highlight cleanly', async ({ page }) => {
  await search(page, 'person');
  await search(page, 'visit_occurrence');

  await expect(tableCard(page, 'visit_occurrence')).toHaveClass(/highlighted/);
  await expect(tableCard(page, 'person')).not.toHaveClass(/highlighted/);

  await page.waitForTimeout(2200);
  await expect(tableCard(page, 'person')).not.toHaveClass(/highlighted/);
  await expect(tableCard(page, 'visit_occurrence')).not.toHaveClass(/highlighted/);
});

// ---------------------------------------------------------------------------
// Test 4 — explicit Fit is the only operation that reframes the whole graph.
//
// Note (runtime finding): the OMOP graph is a very tall strip whose height
// exceeds what fits at minZoom=0.1, so fitView saturates at the minimum zoom and
// centres the graph rather than containing every node. The contract this test
// enforces is therefore: Fit reframes + centres; when it cannot contain the
// graph, zoom is pinned at minZoom.
// ---------------------------------------------------------------------------
test('fit button reframes and centres the graph', async ({ page }) => {
  await setViewport(page, { x: 0, y: 0, zoom: 0.63 });
  const zoomBefore = (await getViewport(page)).zoom;
  expect(zoomBefore).toBeGreaterThan(0.5);

  await page.getByRole('button', { name: 'Fit view' }).click();
  await page.waitForTimeout(1200);

  const zoomAfter = (await getViewport(page)).zoom;
  expect(zoomAfter).toBeLessThan(zoomBefore); // Fit actually reframed

  const pane = await page.locator('.svelte-flow').boundingBox();
  expect(pane).not.toBeNull();
  const boxes = await page
    .locator('.svelte-flow__node-tableParent')
    .evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      })
    );
  expect(boxes.length).toBeGreaterThanOrEqual(OMOP_CLASS_COUNT);
  if (!pane) return;

  const minL = Math.min(...boxes.map((b) => b.left));
  const maxR = Math.max(...boxes.map((b) => b.right));
  const minT = Math.min(...boxes.map((b) => b.top));
  const maxB = Math.max(...boxes.map((b) => b.bottom));

  // Centring is the invariant fitView always satisfies.
  const bboxCx = (minL + maxR) / 2;
  const bboxCy = (minT + maxB) / 2;
  expect(Math.abs(bboxCx - (pane.x + pane.width / 2))).toBeLessThan(15);
  expect(Math.abs(bboxCy - (pane.y + pane.height / 2))).toBeLessThan(15);

  const contained =
    minL >= pane.x - 4 &&
    maxR <= pane.x + pane.width + 4 &&
    minT >= pane.y - 4 &&
    maxB <= pane.y + pane.height + 4;

  // If it does not contain, it must be saturated at minZoom (0.1).
  if (!contained) {
    expect(Math.abs(zoomAfter - 0.1)).toBeLessThan(0.005);
  }
});

// ---------------------------------------------------------------------------
// Test 5 — async layout race: a user viewport change made while a rebuild is in
// flight must never be overwritten by the post-layout restore.
// ---------------------------------------------------------------------------
test('user pan during async layout is preserved', async ({ page }) => {
  await setViewport(page, { x: 0, y: 0, zoom: 0.6 });

  // Widen the async window deterministically (dev seam).
  await page.evaluate(() => {
    window.__erdLayoutDelayMs = 700;
  });

  // Start a content rebuild (capture A = {0,0,0.6}).
  await tableNode(page, 'person').locator('.header').dispatchEvent('click');
  await page.waitForTimeout(150);

  // Simulate the user moving the viewport to B while the layout is running.
  await setViewport(page, { x: 321, y: 222, zoom: 0.6 });
  const during = await getViewport(page);

  // Wait for the delayed layout to complete and the conditional restore to run.
  await page.waitForTimeout(1500);

  const after = await getViewport(page);
  expect(Math.abs(after.x - during.x)).toBeLessThan(2);
  expect(Math.abs(after.y - during.y)).toBeLessThan(2);
  // The stale captured viewport (0,0) must NOT have been restored.
  expect(Math.abs(after.x - 0)).toBeGreaterThan(100);
});

// ---------------------------------------------------------------------------
// Test 6 — LOD thresholds change presentation only, never geometry/viewport
// ---------------------------------------------------------------------------
test('LOD follows zoom and does not move the viewport', async ({ page }) => {
  const readDom = async () => {
    const lod0 = await page.locator('.svelte-flow__node-column .col-row.lod0').count();
    const types = await page.locator('.svelte-flow__node-column .slot-type').count();
    return { lod0, types };
  };

  for (const zoom of [0.49, 0.5, 0.55, 0.84, 0.85, 0.9]) {
    await setViewport(page, { x: 0, y: 0, zoom });
    await page.waitForTimeout(200);

    const actual = await page.evaluate(() => window.__erdFlow.getZoom());
    const expected = actual < 0.5 ? 0 : actual < 0.85 ? 1 : 2;
    const { lod0, types } = await readDom();

    if (expected === 0) {
      expect(lod0, `zoom ${actual} should render LOD0`).toBeGreaterThan(0);
      expect(types, `zoom ${actual} should hide ranges`).toBe(0);
    } else if (expected === 1) {
      expect(lod0, `zoom ${actual} should not render LOD0`).toBe(0);
      expect(types, `zoom ${actual} should hide ranges`).toBe(0);
    } else {
      expect(types, `zoom ${actual} should show ranges`).toBeGreaterThan(0);
    }

    // Presentation-only: the viewport must be exactly where we put it.
    const vp = await getViewport(page);
    expect(Math.abs(vp.zoom - actual)).toBeLessThan(0.001);
  }
});
