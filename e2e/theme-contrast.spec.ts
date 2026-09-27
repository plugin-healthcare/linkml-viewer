import { test, expect } from '@playwright/test';
import { waitForGraph, setViewport } from './helpers';

// ---------------------------------------------------------------------------
// R2.7.4 — theme contrast corrections.
//
// Regression guard for the R2.7.3 audit fixes (D1/D3/D4): the corrected
// secondary-text surfaces must clear WCAG AA (>= 4.5:1), and FK / ETL must stay
// visually distinct (colour + dash pattern). Every ratio is computed from the
// live `getComputedStyle` values — no hardcoded ratio expectations.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

function parseColor(value: string): RGB {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`Unparseable colour: ${value}`);
  const [r, g, b] = m[1].split(',').map((p) => parseFloat(p.trim()));
  return [r, g, b];
}

function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: RGB, b: RGB): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

const MIN_RATIO = 4.5;

/** Load the SEIN schema (has groups + ETL) and wait for its legend to appear. */
async function loadSein(page: import('@playwright/test').Page) {
  await page.evaluate(() => window.__erdSchema.loadBundled('sein'));
  await expect(page.locator('.sidebar .section-title').first()).toBeVisible({ timeout: 30_000 });
  // Let the schema-switch fit intent settle before the test moves the viewport.
  await page.waitForTimeout(2000);
}

test.describe('theme contrast corrections (R2.7.4)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForGraph(page);
    await loadSein(page);
  });

  test('corrected secondary text surfaces meet WCAG AA 4.5:1', async ({ page }) => {
    // LOD2 renders range/type + ETL mapping rows.
    await setViewport(page, { x: 0, y: 0, zoom: 1.0 });
    await expect(page.locator('.slot-type').first()).toBeVisible({ timeout: 30_000 });
    // Group editor surfaces (.col-label) require the panel to be open.
    await page.locator('button[title="Edit group colors"]').click();
    await page.locator('.col-label').first().waitFor();

    const samples = await page.evaluate(() => {
      const el = (sel: string) => document.querySelector(sel) as HTMLElement | null;
      const color = (node: HTMLElement | null, pseudo?: string) =>
        node ? getComputedStyle(node, pseudo).color : null;
      const bg = (node: HTMLElement | null) =>
        node ? getComputedStyle(node).backgroundColor : null;

      const slotType = el('.slot-type');
      const input = el('input[type="search"]');
      const fileCount = el('.file-count');
      const kbd = el('.kbd-hint');
      const colLabel = el('.col-label');
      const sidebar = el('.sidebar');

      return {
        columnType: { color: color(slotType), bg: bg(slotType?.closest('.col-row') as HTMLElement | null) },
        groupSectionTitle: { color: color(el('.sidebar .section-title')), bg: bg(sidebar) },
        fileSectionTitle: { color: color(el('.file-list .section-title')), bg: bg(el('.sidebar-col')) },
        fileCount: { color: color(fileCount), bg: bg(fileCount) },
        placeholder: { color: color(input, '::placeholder'), bg: bg(el('.search-input-row')) },
        kbdHint: { color: color(kbd), bg: bg(kbd) },
        groupColLabel: { color: color(colLabel), bg: bg(el('.group-editor-panel')) },
      };
    });

    const failures: string[] = [];
    for (const [name, s] of Object.entries(samples)) {
      expect(s.color, `${name} colour missing`).not.toBeNull();
      expect(s.bg, `${name} background missing`).not.toBeNull();
      const ratio = contrast(parseColor(s.color!), parseColor(s.bg!));
      // eslint-disable-next-line no-console
      console.log(`[R2.7.4] ${name}: ${ratio.toFixed(2)}:1 (${s.color} on ${s.bg})`);
      if (ratio < MIN_RATIO) failures.push(`${name} = ${ratio.toFixed(2)}:1`);
    }
    expect(failures, `surfaces below ${MIN_RATIO}:1`).toEqual([]);
  });

  test('FK and ETL stay distinct (colour + dash)', async ({ page }) => {
    const facts = await page.evaluate(() => {
      const el = (sel: string) => document.querySelector(sel) as HTMLElement | null;
      const fkBadge = getComputedStyle(el('.badge-fk')!).color;
      const swatch = el('.edge-etl')!;
      const etlLabel = getComputedStyle(el('.legend-mapping')!).color;
      const flow = el('.svelte-flow')!;
      const rootStyle = getComputedStyle(flow);
      return {
        fkBadge,
        etlSwatchColor: getComputedStyle(swatch).borderTopColor,
        etlSwatchStyle: getComputedStyle(swatch).borderTopStyle,
        etlLabel,
        fkStroke: rootStyle.getPropertyValue('--erd-edge-fk').trim(),
        etlStroke: rootStyle.getPropertyValue('--erd-edge-etl').trim(),
        etlLabelToken: rootStyle.getPropertyValue('--erd-edge-label-etl').trim(),
      };
    });

    // Edge kinds remain distinguishable by dash + colour.
    expect(facts.etlSwatchStyle).toBe('dashed');
    expect(facts.etlSwatchColor).not.toBe(facts.fkBadge);
    // ETL label text is a distinct indigo from both FK surfaces.
    expect(facts.etlLabel).not.toBe(facts.fkBadge);
    expect(facts.etlLabel).toBe('rgb(79, 70, 229)'); // --erd-edge-label-etl #4f46e5
    expect(facts.fkStroke).not.toBe(facts.etlStroke);
    expect(facts.etlLabelToken).not.toBe(facts.etlStroke);
  });
});
