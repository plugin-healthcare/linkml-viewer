<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { EditorState } from '@codemirror/state';
  import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { yaml } from '@codemirror/lang-yaml';
  import { oneDark } from '@codemirror/theme-one-dark';
  import { load as yamlLoad } from 'js-yaml';

  interface Props {
    yamlText: string;
    // The editor validates YAML syntax (js-yaml) only; LinkML semantics are
    // resolved downstream by the Vite /reconcile producer when the text lands.
    onchange: (text: string) => void;
    onclose: () => void;
  }

  let { yamlText, onchange, onclose }: Props = $props();

  let editorContainer: HTMLDivElement;
  let view: EditorView | undefined;
  let parseError = $state('');
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function applyText(text: string) {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        yamlLoad(text);
        parseError = '';
        onchange(text);
      } catch (e) {
        parseError = (e as Error).message;
      }
    }, 500);
  }

  onMount(() => {
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        applyText(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: yamlText,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        yaml(),
        oneDark,
        EditorView.lineWrapping,
        updateListener,
      ],
    });

    view = new EditorView({ state, parent: editorContainer });
  });

  onDestroy(() => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    view?.destroy();
  });

  // When yamlText changes externally (e.g. new schema loaded), sync the editor
  $effect(() => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== yamlText) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: yamlText },
      });
    }
  });
</script>

<aside class="schema-editor-panel">
  <div class="panel-header">
    <span class="panel-title">Schema YAML</span>
    {#if parseError}
      <span class="parse-error" title={parseError}>⚠ Parse error</span>
    {/if}
    <button class="close-btn" onclick={onclose} aria-label="Close schema editor">×</button>
  </div>

  {#if parseError}
    <div class="error-bar">{parseError}</div>
  {/if}

  <div class="editor-wrap" bind:this={editorContainer}></div>
</aside>

<style>
  .schema-editor-panel {
    /* Viewport-aware width (R2.7.2): pixel-identical to 420px at >=1106px
       (38vw >= 420) but shrinks below so the panel never drives the canvas to
       0. At 1280/1600 this resolves to exactly 420px — unchanged. */
    width: min(420px, 38vw);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: #282c34;
    border-left: 1px solid #1a1d23;
    overflow: hidden;
    z-index: 15;
  }

  .panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #21252b;
    border-bottom: 1px solid #1a1d23;
    flex-shrink: 0;
  }

  .panel-title {
    font-size: 12px;
    font-weight: 600;
    color: #abb2bf;
    flex: 1;
    font-family: ui-monospace, monospace;
  }

  .parse-error {
    font-size: 10px;
    color: #e06c75;
    white-space: nowrap;
  }

  .close-btn {
    background: none;
    border: none;
    color: #636d83;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
    flex-shrink: 0;
  }

  .close-btn:hover {
    color: #abb2bf;
  }

  .error-bar {
    background: #3b1a1a;
    border-bottom: 1px solid #e06c75;
    color: #e06c75;
    font-size: 11px;
    font-family: ui-monospace, monospace;
    padding: 6px 12px;
    white-space: pre-wrap;
    word-break: break-all;
    flex-shrink: 0;
    max-height: 80px;
    overflow-y: auto;
  }

  .editor-wrap {
    flex: 1;
    overflow: hidden;
  }

  /* Make the CodeMirror editor fill the wrapper */
  .editor-wrap :global(.cm-editor) {
    height: 100%;
  }

  .editor-wrap :global(.cm-scroller) {
    overflow: auto;
    font-size: 12px;
  }
</style>
