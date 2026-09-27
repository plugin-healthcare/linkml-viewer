import { test, expect } from '@playwright/test';
import {
  waitForGraph,
  getViewport,
  setViewport,
  waitForViewportStable,
  resetLayoutDelay,
  setLayout,
  tableGeometry,
  edgeLabelCount,
  tableNode,
  tableCard,
  search,
  canvas,
} from './helpers';

// ---------------------------------------------------------------------------
// Viewport contract — one test per layout candidate (Dagre/ELK x LR/TB).
//
// The contract (from `src/routes/+page.svelte` layout effect +
// `FlowController.svelte`):
//   * layout mutation is NOT viewport mutation for content-only changes
//     (collapse/expand preserve the viewport when the user has not moved);
//   * a layout/topology change IS a deliberate fit intent;
//   * search recentres at the current zoom (never fitView);
//   * keyboard navigation recentres at the current zoom (never fitView);
//   * LOD changes presentation only (never geometry).
//
// Topology/geometry is driven through `globalThis.__erdLayout`; viewport and
// node-centre through `globalThis.__erdFlow`; cursor through `globalThis.__erdNav`.
// These seams are dev-only (registered under `import.meta.env.DEV`).
//
// The four-direction handle-orientation regression contract lives in the
// benchmark (`bench-layout.ts`), not here — it is a pure layout-output assertion.
// ---------------------------------------------------------------------------

interface Candidate {
  engine: 'dagre' | 'elk';
  direction: 'LR' | 'TB';
}

const CANDIDATES: Candidate[] = [
  { engine: 'dagre', direction: 'LR' },
  { engine: 'dagre', direction: 'TB' },
  { engine: 'elk', direction: 'LR' },
  { engine: 'elk', direction: 'TB' },
];

// The product default is read from the running app (`__erdLayout.getLayoutOptions`
// before any switch) so this contract does not encode the default as truth.
async function readDefaultLayout(page: import('@playwright/test').Page): Promise<Candidate> {
  const opts = await page.evaluate(() => window.__erdLayout.getLayoutOptions());
  return opts as Candidate;
}

function layoutName(c: Candidate) {
  return `${c.engine === 'dagre' ? 'D' : 'E'}${c.direction}`;
}

// A layout that is guaranteed to differ from the default geometry.
const PROBE: Candidate = { engine: 'elk', direction: 'TB' };

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForGraph(page);
});

test.afterEach(async ({ page }) => {
  await resetLayoutDelay(page);
});

for (const c of CANDIDATES) {
  test(`${layoutName(c)}: viewport contract`, async ({ page }) => {
    // --- Step 1: initial load (the product default) — capture initial viewport ---
    const DEFAULT = await readDefaultLayout(page);
    // A probe layout guaranteed to differ from the *current* default, so the
    // "geometry changes" assertion is meaningful regardless of which candidate
    // the product default happens to be.
    const probeLayout =
      CANDIDATES.find((x) => layoutName(x) !== layoutName(DEFAULT)) ?? PROBE;
    const initialViewport = await getViewport(page);
    expect(initialViewport.zoom).toBeGreaterThan(0);
    expect(Number.isFinite(initialViewport.x)).toBe(true);
    expect(Number.isFinite(initialViewport.y)).toBe(true);
    const defaultGeometry = await tableGeometry(page);
    expect(Object.keys(defaultGeometry).length).toBeGreaterThan(0);

    // --- Step 2: layout switch changes topology/geometry ---------------------
    // For the default candidate, probe with a different layout first so the
    // "geometry changes" assertion is meaningful, then switch to the candidate.
    const probe = layoutName(c) === layoutName(DEFAULT) ? probeLayout : c;
    // setLayout now waits for the geometry rebuild *and* its fit to settle.
    await setLayout(page, probe);
    const probeGeometry = await tableGeometry(page);
    expect(probeGeometry).not.toEqual(defaultGeometry);

    if (probe !== c) {
      await setLayout(page, c);
    }

    // --- Step 3: after the layout switch the viewport is valid (a fit intent),
    // and a content-only mutation preserves it when the user has not moved ----
    await waitForViewportStable(page);
    const vpBeforeCollapse = await getViewport(page);
    expect(vpBeforeCollapse.zoom).toBeGreaterThan(0);

    await tableNode(page, 'person').locator('.collapse-toggle').dispatchEvent('click');
    await expect(page.locator('.svelte-flow__node-column[data-id^="person"]')).toHaveCount(0);
    await waitForViewportStable(page);

    const vpAfterCollapse = await getViewport(page);
    expect(Math.abs(vpAfterCollapse.x - vpBeforeCollapse.x)).toBeLessThan(2);
    expect(Math.abs(vpAfterCollapse.y - vpBeforeCollapse.y)).toBeLessThan(2);
    expect(Math.abs(vpAfterCollapse.zoom - vpBeforeCollapse.zoom)).toBeLessThan(0.01);

    // Re-expand to restore the full graph for the remaining steps.
    await tableNode(page, 'person').locator('.collapse-toggle').dispatchEvent('click');
    await expect
      .poll(() => page.locator('.svelte-flow__node-column[data-id^="person"]').count())
      .toBeGreaterThan(0);
    await waitForViewportStable(page);

    // --- Step 4: search recentres, zoom unchanged ---------------------------
    // Settle first so no pending animation can clobber the manual viewport.
    await waitForViewportStable(page);
    await setViewport(page, { x: 100, y: 80, zoom: 0.63 });
    await waitForViewportStable(page);
    const zoomBeforeSearch = (await getViewport(page)).zoom;
    await search(page, 'person');
    await expect(tableCard(page, 'person')).toHaveClass(/highlighted/);
    await waitForViewportStable(page); // setCenter animation is 500ms

    const vpAfterSearch = await getViewport(page);
    expect(Math.abs(vpAfterSearch.zoom - zoomBeforeSearch)).toBeLessThan(0.01);

    // Recentring: the target must sit near the centre of the flow pane.
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

    // --- Step 5: keyboard navigation recentres at the current zoom ----------
    await waitForViewportStable(page);
    await setViewport(page, { x: 0, y: 0, zoom: 0.63 });
    await waitForViewportStable(page);
    await page.evaluate(() => window.__erdNav.setCursor('person'));
    await canvas(page).focus();
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(() => page.evaluate(() => window.__erdNav.getCursor()))
      .not.toBe('person');

    // centerNode animates for 300ms; wait for it to settle before reading.
    await expect
      .poll(() => page.evaluate(() => window.__erdFlow.getZoom()))
      .toBeCloseTo(0.63, 1);
    await waitForViewportStable(page);
    const vpAfterNav = await getViewport(page);
    expect(Math.abs(vpAfterNav.zoom - 0.63)).toBeLessThan(0.01);

    // --- Step 6: LOD changes presentation only ------------------------------
    await waitForViewportStable(page);
    await setViewport(page, { x: 0, y: 0, zoom: 1.0 });
    await waitForViewportStable(page);
    const geometryLod2 = await tableGeometry(page);
    const labelsLod2 = await edgeLabelCount(page);

    await setViewport(page, { x: 0, y: 0, zoom: 0.6 });
    await waitForViewportStable(page);
    const geometryLod1 = await tableGeometry(page);
    const labelsLod1 = await edgeLabelCount(page);

    await setViewport(page, { x: 0, y: 0, zoom: 0.49 });
    await waitForViewportStable(page);
    const geometryLod0 = await tableGeometry(page);
    // Nothing is selected in this contract, so this is the *unselected* LOD0
    // label set. The `labelsLod0 === 0` assertion is split by R2.6.2: unselected
    // LOD0 edges stay label-free, while a natively selected edge may retain its
    // existing label (asserted in selection-regression.spec.ts). The LOD
    // contract is preserved, not weakened.
    const unselectedLabelsLod0 = await edgeLabelCount(page);

    // Geometry is identical across LOD levels.
    expect(geometryLod1).toEqual(geometryLod2);
    expect(geometryLod0).toEqual(geometryLod2);

    // Edge-label set changes by LOD: LOD0 none, LOD1 subset, LOD2 superset.
    expect(labelsLod2).toBeGreaterThan(0);
    expect(labelsLod1).toBeLessThanOrEqual(labelsLod2);
    expect(unselectedLabelsLod0).toBe(0);
  });
}
