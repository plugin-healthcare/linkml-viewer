<script lang="ts">
  /**
   * R2.8.13 — reconciliation / provenance visibility.
   *
   * Read-only. It renders the provenance the producer already recorded in the
   * authoritative artefact (`schema`, `counts`, `reproducibility`,
   * `generator_reconciliation`), projected 1:1 by `linkml.ts`. It states what
   * established the model and what was reconciled — it never derives, mutates,
   * or writes back any semantic fact.
   */
  import type { Provenance } from '$lib/types';

  interface Props {
    provenance: Provenance;
    schemaName: string;
    schemaId: string;
    onclose: () => void;
  }

  let { provenance, schemaName, schemaId, onclose }: Props = $props();

  // Move focus into the dialog when it mounts (WAI-ARIA dialog pattern).
  function focusCard(node: HTMLElement) {
    node.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onclose();
    }
  }

  /** `sha256:abcd…` → `sha256:abcd…` with a short hex tail. */
  function shortDigest(digest: string | null): string {
    if (!digest) return '—';
    const sep = digest.indexOf(':');
    if (sep < 0) return `${digest.slice(0, 12)}…`;
    return `${digest.slice(0, sep + 1)}${digest.slice(sep + 1, sep + 13)}…`;
  }

  const c = $derived(provenance.counts);
</script>

<svelte:window onkeydown={onKeydown} />

<div class="pv-backdrop">
  <div
    class="pv-card"
    role="dialog"
    aria-modal="true"
    aria-labelledby="pv-title"
    tabindex="-1"
    {@attach focusCard}
  >
    <header class="pv-header">
      <h2 id="pv-title" class="pv-title">About this model</h2>
      <button class="pv-close" onclick={onclose} aria-label="Close" title="Close">×</button>
    </header>

    <div class="pv-body">
      <p class="pv-lede">
        The graph is a <strong>reconciled projection</strong> of an authoritative artefact.
        LinkML semantics are established once, off-client, by the producer; the viewer only
        presents them.
      </p>

      <section class="pv-section">
        <h3 class="pv-h3">Schema</h3>
        <dl class="pv-grid">
          <dt>Name</dt><dd>{schemaName}</dd>
          <dt>Id</dt><dd class="pv-mono">{schemaId || '—'}</dd>
          {#if provenance.schemaPath}
            <dt>Source</dt><dd class="pv-mono">{provenance.schemaPath}</dd>
          {/if}
        </dl>
      </section>

      <section class="pv-section">
        <h3 class="pv-h3">Producer</h3>
        <dl class="pv-grid">
          <dt>Tool</dt>
          <dd>{provenance.producerName ?? 'producer'}{provenance.producerVersion ? ` v${provenance.producerVersion}` : ''}</dd>
          <dt>LinkML</dt><dd>{provenance.linkmlVersion ?? '—'}</dd>
          <dt>Runtime</dt><dd>{provenance.linkmlRuntimeVersion ?? '—'}</dd>
          <dt>Python</dt><dd>{provenance.pythonVersion ?? '—'}</dd>
          <dt>Format</dt><dd class="pv-mono">{provenance.artifactFormat} v{provenance.artifactVersion}</dd>
        </dl>
      </section>

      <section class="pv-section">
        <h3 class="pv-h3">Reconciled content</h3>
        <div class="pv-counts">
          <div class="pv-count"><span class="pv-count-n">{c.classes}</span><span class="pv-count-l">tables</span></div>
          <div class="pv-count"><span class="pv-count-n">{c.fkCross}</span><span class="pv-count-l">cross FK</span></div>
          <div class="pv-count"><span class="pv-count-n">{c.etl}</span><span class="pv-count-l">ETL</span></div>
          <div class="pv-count"><span class="pv-count-n">{c.fkSelf}</span><span class="pv-count-l">self FK</span></div>
          <div class="pv-count"><span class="pv-count-n">{c.identifiers}</span><span class="pv-count-l">identifiers</span></div>
          <div class="pv-count"><span class="pv-count-n">{provenance.reconciliationGaps}</span><span class="pv-count-l">gaps</span></div>
        </div>

        {#if provenance.generators.length > 0}
          <ul class="pv-generators">
            {#each provenance.generators as g (g.name)}
              <li class="pv-generator">
                <span class="pv-gen-name">{g.name}</span>
                <span class="pv-gen-state" class:ok={g.ok} class:warn={!g.ok}>
                  {g.ok ? 'reconciled' : 'limited'}
                </span>
                {#if g.limitation}
                  <span class="pv-gen-note" title={g.limitation}>{g.limitation}</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="pv-section">
        <h3 class="pv-h3">Reproducibility</h3>
        <dl class="pv-grid">
          <dt>Schema</dt><dd class="pv-mono" title={provenance.schemaFingerprint ?? ''}>{shortDigest(provenance.schemaFingerprint)}</dd>
          <dt>Content</dt><dd class="pv-mono" title={provenance.contentDigest ?? ''}>{shortDigest(provenance.contentDigest)}</dd>
          <dt>Output</dt><dd class="pv-mono" title={provenance.outputDigest ?? ''}>{shortDigest(provenance.outputDigest)}</dd>
        </dl>
      </section>
    </div>
  </div>
</div>

<style>
  .pv-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(15, 23, 42, 0.35);
    font-family: ui-sans-serif, system-ui, sans-serif;
  }

  .pv-card {
    width: 460px;
    max-width: 100%;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    background: #ffffff;
    border-radius: 8px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
    overflow: hidden;
    outline: none;
  }

  .pv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid #e5e7eb;
  }

  .pv-title {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    color: #111827;
  }

  .pv-close {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: #6b7280;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .pv-close:hover {
    background: #e5e7eb;
    color: #111827;
  }

  .pv-body {
    overflow-y: auto;
    padding: 12px 14px 16px;
  }

  .pv-lede {
    margin: 0 0 12px;
    font-size: 12px;
    line-height: 1.5;
    color: #374151;
  }

  .pv-section + .pv-section {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid #f1f5f9;
  }

  .pv-h3 {
    margin: 0 0 6px;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #6b7280;
  }

  .pv-grid {
    display: grid;
    grid-template-columns: 72px 1fr;
    gap: 3px 10px;
    margin: 0;
  }

  .pv-grid dt {
    font-size: 11px;
    color: #94a3b8;
  }

  .pv-grid dd {
    margin: 0;
    font-size: 12px;
    color: #0f172a;
    word-break: break-word;
  }

  .pv-mono {
    font-family: ui-monospace, monospace;
    font-size: 11px;
  }

  .pv-counts {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }

  .pv-count {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 6px 4px;
    background: #f8fafc;
    border-radius: 5px;
  }

  .pv-count-n {
    font-size: 16px;
    font-weight: 700;
    color: #0f172a;
  }

  .pv-count-l {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
  }

  .pv-generators {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pv-generator {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 11px;
  }

  .pv-gen-name {
    font-family: ui-monospace, monospace;
    color: #0f172a;
    width: 72px;
    flex-shrink: 0;
  }

  .pv-gen-state {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 3px;
  }

  .pv-gen-state.ok {
    background: #dcfce7;
    color: #166534;
  }

  .pv-gen-state.warn {
    background: #fef3c7;
    color: #92400e;
  }

  .pv-gen-note {
    color: #94a3b8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
