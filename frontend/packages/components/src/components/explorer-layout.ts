import { css, type LitElement } from 'lit';

export type ExplorerPanel = 'filters' | 'results';

function visibleElement(element: HTMLElement | null | undefined): element is HTMLElement {
  return Boolean(element && !element.closest('[hidden]') && element.getClientRects().length);
}

/** Panels stay mounted; only their visibility and focus change. */
export function focusPanel(host: LitElement, panel: ExplorerPanel): void {
  void host.updateComplete.then(() => {
    const section = host.renderRoot.querySelector<HTMLElement>(`[data-panel="${panel}"]`);
    const heading = section?.querySelector<HTMLElement>('[data-panel-heading]');
    const target = visibleElement(heading) ? heading : visibleElement(section) ? section : undefined;
    target?.focus({ preventScroll: true });
  });
}

export function restorePanelFocus(host: LitElement, panel: ExplorerPanel): void {
  void host.updateComplete.then(() => {
    const selectors = [`[data-panel-toggle="${panel}"]`, '[data-panel-toggle="filters"]',
      `[data-panel="${panel}"]`, '[data-panel="filters"]'];
    const target = selectors.map(selector => host.renderRoot.querySelector<HTMLElement>(selector)).find(visibleElement);
    target?.focus({ preventScroll: true });
  });
}

/** Keep keyboard focus visible when the host changes layout or removes the table. */
export function reconcilePanelFocus(host: LitElement, panel: ExplorerPanel | null, layout: 'compact' | 'full', showTable: boolean): ExplorerPanel | null {
  const active = host.shadowRoot?.activeElement;
  const section = active?.closest<HTMLElement>('[data-panel]');
  const toggle = active?.closest<HTMLElement>('[data-panel-toggle]');
  const focusedPanel = section?.dataset.panel ?? toggle?.dataset.panelToggle;
  if (!showTable && focusedPanel === 'results') {
    restorePanelFocus(host, 'filters');
    return layout === 'full' || panel === 'results' ? null : panel;
  }
  if (layout === 'full') {
    if ((focusedPanel === 'filters' || focusedPanel === 'results') && active?.closest('.compact-toolbar, .panel-heading')) {
      focusPanel(host, focusedPanel);
    } else if (active?.closest('.compact-summary')) {
      focusPanel(host, showTable ? 'results' : 'filters');
    }
    return null;
  }
  if (section && (focusedPanel === 'filters' || focusedPanel === 'results')) return focusedPanel;
  return panel === 'results' && !showTable ? null : panel;
}

/** Shared shell for collection mode and the legacy sample explorer. */
export const compactLayoutStyles = css`
  :host { container-type: inline-size; min-width: 0; }
  [hidden] { display: none !important; }
  .compact-toolbar, .compact-summary, .panel-heading { min-width: 0; }
  .filter-content { display: contents; }
  .filter-intro, .explorer:not(.compact) > .compact-summary { grid-column: 1 / -1; }
  .compact-toolbar button, .compact-summary button, .panel-heading button {
    font: inherit; cursor: pointer; color: var(--samplesift-control-text, var(--samplesift-accent, #295d49));
    background: var(--samplesift-control-background, var(--samplesift-surface, white));
    border: 1px solid var(--samplesift-control-border-color, var(--samplesift-border-color, #d8e1d4));
    border-radius: var(--samplesift-control-radius, 6px); padding: 6px 10px; min-height: 32px;
  }
  .compact-toolbar button[aria-expanded="true"] {
    color: var(--samplesift-on-accent, white); background: var(--samplesift-accent, #176d5c);
    border-color: var(--samplesift-accent, #176d5c);
  }
  .compact-toolbar button:focus-visible, .compact-summary button:focus-visible, .panel-heading button:focus-visible {
    outline: 2px solid var(--samplesift-focus-color, var(--samplesift-accent, #16674f)); outline-offset: 2px;
  }
  .compact-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--samplesift-border-color, #dbe2da); background: var(--samplesift-surface, white); }
  .compact-toolbar .count { font-size: 12px; color: var(--samplesift-muted, #63795f); margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .compact-toolbar .badge { font: inherit; font-size: 11px; margin-left: 5px; }
  .compact-toolbar .draft-indicator { font-size: 11px; color: var(--samplesift-warning-color, #806235); white-space: nowrap; }
  .panel-heading { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 12px; }
  .panel-heading h2 { font-size: 16px; margin: 0; letter-spacing: 0; }
  .panel-heading h2:focus { outline: none; }
  .panel-heading button { flex: 0 0 auto; }
  .compact-summary { display: flex; align-items: center; gap: 8px; padding: 6px 12px; min-width: 0; background: var(--samplesift-surface-muted, #f8faf6); border-top: 1px solid var(--samplesift-border-color, #dbe2da); font-size: 11px; }
  .compact-summary .summary-message { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .compact-summary .summary-error { color: var(--samplesift-error-color, #963f28); }
  .compact-summary button { flex: 0 0 auto; font-size: 11px; }
  .explorer.compact { display: block; position: relative; isolation: isolate; height: var(--samplesift-compact-height, 480px); min-height: 360px; min-width: 0; }
  .compact > .compact-toolbar { position: absolute; top: 0; left: 0; right: 0; height: 52px; z-index: 5; }
  .compact > main { position: absolute; inset: 52px 0 44px; min-width: 0; min-height: 0; }
  .compact .map-section, .compact sample-sift-map { height: 100%; min-height: 0; }
  .compact .map-caption, .compact .caption { display: none; }
  .compact > .compact-summary { position: absolute; bottom: 0; left: 0; right: 0; height: 44px; z-index: 5; }
  .compact > .filters { display: block; position: absolute; z-index: 6; top: 52px; bottom: 84px; left: 0; width: min(360px, 100%); overflow: auto; overscroll-behavior: contain; scroll-padding: 60px 0 140px; padding: 0; border-bottom: 0; box-shadow: 4px 0 14px #102b2918; }
  .compact .filter-content { display: block; padding: var(--samplesift-panel-padding, 16px); }
  .compact .filter-intro { display: none; }
  .compact sample-sift-collection-filter-form::part(filter-title) { display: none; }
  .compact sample-sift-collection-filter-form::part(filter-heading) { margin-bottom: 0; }
  .compact sample-sift-collection-filter-form::part(clear-button) { margin-bottom: 12px; }
  .compact .filters > .panel-heading { position: sticky; top: 0; z-index: 4; margin: 0; padding: 12px 16px; background: var(--samplesift-surface-muted, #f8faf6); border-bottom: 1px solid var(--samplesift-border-color, #dbe2da); }
  .compact .region, .compact .region-card { margin: 0 0 14px; padding: 10px; }
  .compact .filter-footer { margin-top: 18px; padding-top: 12px; }
  /* Leave the map attribution accessible beneath the panels. */
  .compact > main > .results { position: absolute; bottom: 40px; left: 0; right: 0; z-index: 6; max-height: 70%; overflow: auto; overscroll-behavior: contain; background: var(--samplesift-surface, white); border-top: 1px solid var(--samplesift-border-color, #dbe2da); box-shadow: 0 -4px 14px #102b2918; }
  .compact .results > .panel-heading { position: sticky; top: 0; z-index: 3; margin: 0; padding: 10px 14px; background: var(--samplesift-surface, white); border-bottom: 1px solid var(--samplesift-border-color, #dbe2da); }
  .compact .results .heading, .compact .results .results-heading { padding: 10px 14px; }
  .compact .results .heading h3, .compact .results .results-heading h3 { font-size: 18px; }
  .compact .results .applied { padding: 0 14px 10px; }
  .compact .results .draft-note { margin: 0 14px 10px; }
  .compact .results .pagination { padding: 10px 14px; flex-wrap: wrap; }
  .compact .feature { position: absolute; z-index: 2; bottom: 40px; right: 12px; width: min(300px, calc(100% - 24px)); max-height: 50%; overflow: auto; border: 1px solid var(--samplesift-border-color, #dbe2da); border-radius: var(--samplesift-radius, 8px); box-shadow: 0 3px 14px #102b2915; }
  @container (max-width: 520px) {
    .compact > .filters { width: 100%; }
    .compact > .compact-toolbar { gap: 6px; padding-inline: 8px; }
    .compact-toolbar button { padding-inline: 8px; }
    .compact-toolbar .draft-indicator { display: none; }
    .compact > main > .results { max-height: 85%; }
    .compact .results .heading, .compact .results .results-heading { flex-wrap: wrap; }
    .compact .compact-summary { padding-inline: 8px; }
  }
`;
