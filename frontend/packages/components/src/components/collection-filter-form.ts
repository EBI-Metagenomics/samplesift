import { LitElement, css, html, nothing, unsafeCSS } from 'lit';
import type { PropertyValues } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import '@golemui/gui-lit';
import type { FormElement } from '@golemui/gui-lit';
import type { GuiFormInitConfig } from '@golemui/gui-shared';
import golemCss from '@golemui/gui-components/index.css?inline';
import type { CollectionMetadata, Predicate, QueryableField } from '../collection/types';
import { validateCollectionState } from '../collection/cql2';
import { fieldLabel } from '../collection/presentation';
import {
  createCollectionFilterDefinition, defaultFilterOperator, filterOperatorLabels,
  formDataToPredicates, predicatesToFormData, predicateStateKey, retainHiddenOperator,
} from './collection-filter-schema';
import type { FilterFormData } from './collection-filter-schema';

interface FilterCard {
  id: string;
  field: QueryableField;
  data: FilterFormData;
  config?: GuiFormInitConfig;
  retained?: Predicate[];
  advanced: boolean;
  error: string;
  runtimeError: string;
}
let formSequence = 0;

/** Styling hooks forwarded by the collection explorer and its public wrapper. */
export const FILTER_PARTS = 'filter-form, filter-heading, filter-card, filter-label, filter-condition, filter-remove, filter-fields, filter-add, filter-picker, filter-search, filter-option, filter-actions, apply-button, discard-button, clear-button, filter-status, filter-error';

/** Metadata-derived cards keep drafts local until an explicit Apply (or host-opted-in auto apply). */
export class SampleSiftCollectionFilterForm extends LitElement {
  static properties = {
    metadata: { attribute: false }, predicates: { attribute: false }, disabled: { type: Boolean },
    autoApply: { attribute: false }, debounceMs: { type: Number }, busy: { type: Boolean }, restoreRevision: { type: Number },
    _active: { state: true }, _picker: { state: true }, _search: { state: true },
    _error: { state: true }, _dirty: { state: true }, _valid: { state: true }, _unavailable: { state: true },
  };
  metadata: CollectionMetadata | undefined;
  predicates: readonly Predicate[] = [];
  disabled = false;
  autoApply = false;
  debounceMs = 500;
  busy = false;
  restoreRevision = 0;
  private _active: string[] = [];
  private _cards = new Map<string, FilterCard>();
  private _picker = false;
  private _search = '';
  private _error = '';
  private _dirty = false;
  private _valid = true;
  private _unavailable = false;
  private _applied: Predicate[] = [];
  private _appliedKey = predicateStateKey([]);
  private _timer?: ReturnType<typeof setTimeout>;
  private _generation = 0;
  private _cardSequence = 0;
  private _instance = `sf-filters-${++formSequence}`;
  private _lastDraftSignal = '';
  private _focusObserver?: MutationObserver;
  private _focusTimer?: ReturnType<typeof setTimeout>;

  protected firstUpdated() {
    // Capture native drafts before Golem stops bubbling or converts bad numeric input to undefined.
    this.renderRoot.addEventListener('input', this.onNativeInput, true);
    this.renderRoot.addEventListener('change', this.onNativeInput, true);
  }

  disconnectedCallback() {
    this.cancelPending();
    this.stopFocusObserver();
    super.disconnectedCallback();
  }

  protected willUpdate(changed: PropertyValues<this>) {
    const forceRestore = changed.has('metadata') || changed.has('restoreRevision');
    if (forceRestore) {
      this.restore(this.predicates);
    } else if (changed.has('predicates')) {
      const key = predicateStateKey(this.predicates);
      // An acknowledgment must not replace text/caret or a newer draft typed after our commit.
      if (key !== this._appliedKey) this.restore(this.predicates);
    }
    if (changed.has('autoApply') || changed.has('debounceMs') || changed.has('disabled')) {
      this.cancelPending();
      if (this._dirty && !this.disabled) this.reconcileDraft(false);
    }
  }

  private cancelPending() {
    this._generation++;
    if (this._timer !== undefined) clearTimeout(this._timer);
    this._timer = undefined;
  }

  private form(card: FilterCard) {
    return this.renderRoot.querySelector<FormElement>(`gui-form[data-card-id="${card.id}"]`);
  }

  private makeCard(field: QueryableField, predicates: readonly Predicate[] = []): FilterCard {
    const id = `${this._instance}-${++this._cardSequence}`;
    let data: FilterFormData;
    try { data = predicatesToFormData(predicates, [field]); }
    catch (error) {
      if (!predicates.length) throw error;
      return { id, field, data: {}, retained: structuredClone([...predicates]), advanced: false, error: '', runtimeError: '' };
    }
    const row = data.f0;
    const preferred = defaultFilterOperator(field);
    if (!predicates.length) {
      row.operator = preferred;
      if (field.schema?.const !== undefined && field.schema.const !== null) row.value = field.schema.const;
    } else if (preferred === 'range' && (row.operator === '>=' || row.operator === '<=')) {
      data.f0 = { operator: 'range', [row.operator === '>=' ? 'minimum' : 'maximum']: row.value };
    }
    return {
      id, field, data, advanced: false, error: '', runtimeError: '',
      config: {
        formDef: createCollectionFilterDefinition([field], id) as GuiFormInitConfig['formDef'],
        data: structuredClone(data), meta: { advanced: false }, formName: id,
        validateOn: 'eager', expressionPolicy: 'strict',
      },
    };
  }

  private restore(predicates: readonly Predicate[]) {
    this.cancelPending();
    this.stopFocusObserver();
    this._picker = false;
    this._search = '';
    this._error = '';
    this._unavailable = false;
    this._dirty = false;
    this._valid = true;
    this._lastDraftSignal = '';
    this._cards = new Map();
    this._active = [];
    this._applied = structuredClone([...predicates]);
    this._appliedKey = predicateStateKey(predicates);
    if (!this.metadata) return;
    try {
      validateCollectionState({ predicates, sort: [], selection: null }, this.metadata);
      for (const name of new Set(predicates.map(predicate => predicate.field))) {
        const field = this.metadata.fields.find(item => item.name === name);
        if (!field) throw new Error(`The saved filter field ${name} is unavailable.`);
        this._cards.set(name, this.makeCard(field, predicates.filter(predicate => predicate.field === name)));
        this._active.push(name);
      }
    } catch (error) {
      this._unavailable = true;
      this._error = this.message(error);
    }
  }

  private message(error: unknown) { return error instanceof Error ? error.message : 'The filters could not be updated.'; }

  private notifyDraft(force = false) {
    const signal = `${this._dirty}:${this._valid}`;
    if (!force && signal === this._lastDraftSignal) return;
    this._lastDraftSignal = signal;
    this.dispatchEvent(new CustomEvent('draftchange', {
      detail: { dirty: this._dirty, valid: this._valid }, bubbles: true, composed: true,
    }));
  }

  private nativeError(card: FilterCard, complete = false): string | undefined {
    for (const element of this.form(card)?.querySelectorAll('*') ?? []) {
      const control = element as HTMLElement & { validity?: ValidityState; disabled?: boolean; validationMessage?: string };
      if (control.disabled || !control.validity) continue;
      if (control.validity.badInput || (complete && !control.validity.valid)) {
        return control.validationMessage || 'Complete or correct this value.';
      }
    }
    return undefined;
  }

  private validateDraft(showErrors: boolean, complete = false): Predicate[] | undefined {
    if (!this.metadata || this._unavailable) return undefined;
    const predicates: Predicate[] = [];
    let valid = true;
    for (const name of this._active) {
      const card = this._cards.get(name);
      if (!card) continue;
      try {
        if (card.retained) { predicates.push(...structuredClone(card.retained)); continue; }
        const issue = card.runtimeError || this.nativeError(card, complete);
        if (issue) throw new Error(issue);
        predicates.push(...formDataToPredicates(card.data, [card.field]));
        if (showErrors) card.error = '';
      } catch (error) {
        valid = false;
        if (showErrors) card.error = this.message(error);
      }
    }
    if (valid) {
      try { validateCollectionState({ predicates, sort: [], selection: null }, this.metadata); }
      catch (error) { valid = false; if (showErrors) this._error = this.message(error); }
    }
    this._valid = valid;
    return valid ? predicates : undefined;
  }

  private reconcileDraft(showErrors = true) {
    this.cancelPending();
    const predicates = this.validateDraft(showErrors);
    this._dirty = predicates === undefined || predicateStateKey(predicates) !== this._appliedKey
      || this._active.some(name => !this._applied.some(predicate => predicate.field === name));
    this.notifyDraft();
    this.requestUpdate();
    if (!this.autoApply || !this._dirty || !predicates || this.disabled) return;
    if (!Number.isFinite(this.debounceMs) || this.debounceMs < 0 || this.debounceMs > 2_147_483_647) {
      this._error = 'The filter update delay must be a nonnegative duration.';
      return;
    }
    const generation = this._generation;
    this._timer = setTimeout(() => {
      this._timer = undefined;
      if (generation === this._generation && this.isConnected && !this.disabled) this.applyFilters();
    }, this.debounceMs);
  }

  private onNativeInput = (event: Event) => {
    const form = event.composedPath().find(node => node instanceof HTMLElement && node.tagName === 'GUI-FORM') as HTMLElement | undefined;
    if (!form || this.disabled || this._unavailable) return;
    this.cancelPending();
    const generation = this._generation;
    // Golem's model event normally reconciles synchronously. A duplicate native blur-change
    // has no model event; reconcile that case without moving Apply between mousedown/up.
    queueMicrotask(() => {
      if (generation === this._generation && this.isConnected && !this.disabled) this.reconcileDraft(false);
    });
  };

  private onFormEvent(card: FilterCard, event: CustomEvent<{ name: string; data: unknown }>) {
    event.stopPropagation();
    if (this.disabled || this._unavailable || this._cards.get(card.field.name) !== card || event.detail.name !== 'filter-draft') return;
    this.cancelPending();
    try { card.data = retainHiddenOperator(event.detail.data, card.data); }
    catch (error) { card.error = this.message(error); this._dirty = true; this._valid = false; this.notifyDraft(); this.requestUpdate(); return; }
    this._error = '';
    this.reconcileDraft();
  }

  private onInputError(card: FilterCard, event: CustomEvent<{ message: string }>) {
    event.stopPropagation();
    if (this.disabled || this._cards.get(card.field.name) !== card || !event.detail.message) return;
    this.cancelPending();
    card.error = event.detail.message;
    this._dirty = true;
    this._valid = false;
    this.notifyDraft();
    this.requestUpdate();
  }

  private onHealth(card: FilterCard, event: CustomEvent<{ status: string; message?: string }>) {
    event.stopPropagation();
    if (this._cards.get(card.field.name) !== card) return;
    card.runtimeError = event.detail.status === 'errored' ? event.detail.message || 'These filter controls could not load.' : '';
    if (card.runtimeError) {
      this.cancelPending(); card.error = card.runtimeError; this._dirty = true; this._valid = false;
      this.notifyDraft(); this.requestUpdate();
    }
  }

  private commit(predicates: Predicate[]) {
    this.cancelPending();
    const key = predicateStateKey(predicates);
    const changed = key !== this._appliedKey;
    this._applied = structuredClone(predicates);
    this._appliedKey = key;
    this._dirty = false; this._valid = true; this._error = '';
    this.notifyDraft(true);
    this.requestUpdate();
    if (changed) this.dispatchEvent(new CustomEvent('predicateschange', {
      detail: { predicates: structuredClone(predicates) }, bubbles: true, composed: true,
    }));
  }

  /** Commit all cards together; an invalid card never broadens the active search. */
  applyFilters() {
    if (this.disabled || this._unavailable) return;
    this.cancelPending();
    const predicates = this.validateDraft(true, true);
    if (predicates) this.commit(predicates);
    else { this._dirty = true; this.notifyDraft(); this.requestUpdate(); }
  }

  private addField(name: string, restoreApplied = false) {
    if (this.disabled || this._unavailable || !this.metadata) return;
    const field = this.metadata.fields.find(item => item.name === name);
    if (!field || this._cards.has(name)) return;
    this.cancelPending();
    try {
      this._cards.set(name, this.makeCard(field, restoreApplied ? this._applied.filter(item => item.field === name) : []));
      this._active = [...this._active, name];
      this._picker = false; this._search = '';
      this.reconcileDraft(false);
      this.focusField(name);
    } catch (error) { this._error = this.message(error); }
  }

  /** Stages only this field's removal, preserving unfinished drafts in the other cards. */
  removeField(name: string) {
    if (this.disabled || !this._cards.has(name)) return;
    this.cancelPending();
    this._cards.delete(name);
    this._active = this._active.filter(item => item !== name);
    this.reconcileDraft(false);
  }

  /** Deliberate clear is an immediate commit in either mode; the host retains its region. */
  clearFilters() {
    if (this.disabled || !this.metadata) return;
    this.cancelPending();
    this.stopFocusObserver();
    this._cards = new Map(); this._active = []; this._picker = false; this._search = '';
    this._unavailable = false;
    this.commit([]);
  }

  discardChanges() {
    if (this.disabled) return;
    this.restore(this._applied);
    this.notifyDraft(true);
    this.requestUpdate();
  }

  editField(name: string) {
    if (!this._cards.has(name)) this.addField(name, true);
    else this.focusField(name);
  }

  private stopFocusObserver() {
    this._focusObserver?.disconnect(); this._focusObserver = undefined;
    if (this._focusTimer !== undefined) clearTimeout(this._focusTimer);
    this._focusTimer = undefined;
  }

  private focusField(name: string) {
    this.stopFocusObserver();
    void this.updateComplete.then(() => {
      const card = this._cards.get(name);
      if (!card || !this.isConnected) return;
      const form = this.form(card);
      if (!form) return;
      const focus = () => {
        const input = [...form.querySelectorAll<HTMLElement>('input:not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled])')]
          .find(element => !element.id.endsWith('f0-operator'));
        if (!input) return false;
        input.focus(); this.stopFocusObserver(); return true;
      };
      if (focus()) return;
      this._focusObserver = new MutationObserver(focus);
      this._focusObserver.observe(form, { childList: true, subtree: true });
      this._focusTimer = setTimeout(() => this.stopFocusObserver(), 2000);
    });
  }

  private toggleCondition(card: FilterCard) {
    card.advanced = !card.advanced;
    this.form(card)?.setMeta({ advanced: card.advanced });
    this.requestUpdate();
  }

  private openPicker() {
    this._picker = !this._picker;
    this._search = '';
    if (this._picker) void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLInputElement>('[aria-label="Search filters"]')?.focus());
  }

  private renderCard(card: FilterCard) {
    const label = fieldLabel(card.field);
    const condition = filterOperatorLabels[String(card.data.f0?.operator)] || 'Choose condition';
    return html`<section class="card" part="filter-card" role="group" aria-label=${`${label} filter`}>
      <div class="card-heading"><h4 part="filter-label">${label}</h4><button type="button" class="remove" part="filter-remove" aria-label=${`Remove ${label} filter`} title="Remove filter" ?disabled=${this.disabled} @click=${() => this.removeField(card.field.name)}>×</button></div>
      ${card.retained ? html`<p class="hint" part="filter-status">These saved conditions are preserved. Remove this filter to replace them.</p>
        <ul class="retained">${card.retained.map(predicate => html`<li>${filterOperatorLabels[predicate.operator]}${'value' in predicate ? ` ${Array.isArray(predicate.value) ? predicate.value.join(', ') : String(predicate.value)}` : ''}</li>`)}</ul>` : html`
      <button class="condition" part="filter-condition" type="button" aria-label=${`Change ${label} condition`} aria-expanded=${card.advanced} ?disabled=${this.disabled} @click=${() => this.toggleCondition(card)}>${condition}<span aria-hidden="true">⌄</span></button>
      <fieldset ?disabled=${this.disabled}>
        <gui-form part="filter-fields" data-card-id=${card.id} .config=${card.config}
          @formEvent=${(event: CustomEvent<{ name: string; data: unknown }>) => this.onFormEvent(card, event)}
          @formSubmit=${(event: Event) => { event.stopPropagation(); this.applyFilters(); }}
          @formHealth=${(event: CustomEvent<{ status: string; message?: string }>) => this.onHealth(card, event)}
          @gui-input-error=${(event: CustomEvent<{ message: string }>) => this.onInputError(card, event)}
        ></gui-form>
      </fieldset>`}
      ${card.data.f0?.operator === 'isNull' ? html`<p class="hint" part="filter-status">Matches records where this field is missing.</p>` : nothing}
      ${card.error ? html`<p class="error" part="filter-error" role="alert">${card.error}</p>` : nothing}
    </section>`;
  }

  protected render() {
    const available = (this.metadata?.fields ?? []).filter(field => !this._cards.has(field.name));
    const search = this._search.trim().toLocaleLowerCase();
    const matches = available.filter(field => `${fieldLabel(field)} ${field.name} ${field.description ?? ''}`.toLocaleLowerCase().includes(search));
    return html`<section part="filter-form" aria-label="Collection filters">
      <div class="heading" part="filter-heading"><h3>Filters${this._active.length ? html`<span class="count">${this._active.length}</span>` : nothing}</h3>
        ${this._active.length || this._applied.length || this._unavailable ? html`<button class="link" part="clear-button" type="button" @click=${this.clearFilters} ?disabled=${this.disabled}>Clear filters</button>` : nothing}</div>
      ${this._error ? html`<p class="error" part="filter-error" role="alert">${this._error}</p>` : nothing}
      ${!this.metadata ? html`<p class="hint" part="filter-status" role="status">Loading available filters…</p>` : nothing}
      ${!this._active.length && this.metadata && !this._unavailable ? html`<p class="empty" part="filter-status">Start with a field you want to narrow down.</p>` : nothing}
      ${!this._unavailable ? repeat(this._active, name => this._cards.get(name)?.id, name => {
        const card = this._cards.get(name); return card ? this.renderCard(card) : nothing;
      }) : nothing}
      ${this.metadata && !this._unavailable ? html`<button class="add" part="filter-add" type="button" @click=${this.openPicker} aria-expanded=${this._picker} ?disabled=${this.disabled || !available.length}><span aria-hidden="true">＋</span> Add filter</button>` : nothing}
      ${this._picker ? html`<div class="picker" part="filter-picker">
        <input part="filter-search" type="search" aria-label="Search filters" placeholder="Find a field…" .value=${this._search}
          @input=${(event: Event) => { this._search = (event.target as HTMLInputElement).value; }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === 'Escape') { this._picker = false; this.renderRoot.querySelector<HTMLButtonElement>('.add')?.focus(); }
            if (event.key === 'Enter' && matches.length === 1) { event.preventDefault(); this.addField(matches[0].name); }
          }}>
        <ul>${matches.map(field => html`<li><button part="filter-option" type="button" aria-label=${`Add ${fieldLabel(field)} filter`} @click=${() => this.addField(field.name)}><strong>${fieldLabel(field)}</strong>${field.description ? html`<small>${field.description}</small>` : nothing}</button></li>`)}</ul>
        ${!matches.length ? html`<p class="hint" part="filter-status">No matching fields.</p>` : nothing}
      </div>` : nothing}
      <div class="actions" part="filter-actions">
      ${this._dirty ? html`<div class="draft" part="filter-status" role="status"><span>${this._valid ? this.autoApply ? 'Updating filters shortly…' : 'Changes ready to apply.' : 'Finish or remove the incomplete filter.'}</span><button class="link" part="discard-button" type="button" @click=${this.discardChanges} ?disabled=${this.disabled}>Discard changes</button></div>` : nothing}
      ${!this.autoApply ? html`<button class="apply" part="apply-button" type="button" @click=${this.applyFilters} ?disabled=${this.disabled || !this.metadata || this._unavailable || !this._dirty}>Apply filters</button>` : nothing}
      <p class="footnote" part="filter-status" aria-live="polite">${this.busy ? 'Updating results…' : this.autoApply ? 'Valid changes update results automatically.' : 'Results update when you apply your filters.'}</p>
      </div>
    </section>`;
  }

  static styles = [unsafeCSS(golemCss.replaceAll(':root', ':host')), css`
    :host {
      display: block; min-width: 0; font: inherit; font-family: var(--samplesift-font, inherit); color: var(--samplesift-text, inherit);
      /* Keep Golem's own defaults while letting one host theme reach generated controls. */
      --gui-color-primary-500: var(--samplesift-accent, #0d766e);
      --gui-color-primary-600: var(--samplesift-accent-hover, #0b655e);
      --gui-font-family: var(--samplesift-font, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif);
      --gui-bg-default: var(--samplesift-control-background, var(--samplesift-surface, var(--gui-color-white)));
      --gui-bg-surface: var(--samplesift-control-background, var(--samplesift-surface, var(--gui-color-white)));
      --gui-bg-surface-hover: var(--samplesift-surface-muted, var(--gui-color-neutral-200));
      --gui-bg-surface-active: var(--samplesift-surface-muted, var(--gui-color-neutral-100));
      --gui-bg-disabled: var(--samplesift-surface-muted, var(--gui-color-neutral-300));
      --gui-text-default: var(--samplesift-control-text, var(--samplesift-text, var(--gui-color-neutral-900)));
      --gui-text-secondary: var(--samplesift-muted, var(--gui-color-neutral-500));
      --gui-text-muted: var(--samplesift-muted, var(--gui-color-neutral-400));
      --gui-text-disabled: var(--samplesift-muted, var(--gui-color-neutral-400));
      --gui-text-inverse: var(--samplesift-on-accent, var(--gui-color-white));
      --gui-border-default: var(--samplesift-control-border-color, var(--samplesift-border-color, var(--gui-color-neutral-300)));
      --gui-border-subtle: var(--samplesift-border-color, var(--gui-color-neutral-200));
      --gui-border-strong: var(--samplesift-control-border-color, var(--samplesift-border-color, var(--gui-color-neutral-500)));
      --gui-border-disabled: var(--samplesift-border-color, var(--gui-color-neutral-200));
      --gui-border-focus: var(--samplesift-focus-color, var(--gui-color-primary-500));
      --gui-intent-primary: var(--samplesift-accent, var(--gui-color-primary-600));
      --gui-intent-primary-hover: var(--samplesift-accent-hover, var(--gui-color-primary-700));
      --gui-intent-primary-active: var(--samplesift-accent-hover, var(--gui-color-primary-800));
      --gui-intent-primary-text: var(--samplesift-on-accent, var(--gui-color-white));
      --gui-intent-error: var(--samplesift-error-color, var(--gui-color-error-600));
      --gui-intent-error-text: var(--samplesift-error-color, var(--gui-color-error-900));
      --gui-intent-error-bg: var(--samplesift-error-background, var(--gui-color-error-50));
      --gui-intent-error-surface: var(--samplesift-error-background, var(--gui-color-error-50));
      --gui-radius-md: var(--samplesift-control-radius, .25rem);
      --gui-radius-sm: var(--samplesift-control-radius, .125rem);
      --gui-space-4: .65rem;
    }
    * { box-sizing: border-box; } section { min-width: 0; } button, input { font: inherit; }
    button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; } button:focus-visible, input:focus-visible { outline: 2px solid var(--samplesift-focus-color, var(--samplesift-accent, #0d766e)); outline-offset: 2px; }
    .heading, .card-heading { display: flex; align-items: center; justify-content: space-between; gap: .65rem; }
    .heading { margin-bottom: .85rem; } h3 { margin: 0; font-size: 1rem; display: flex; align-items: center; gap: .5rem; }
    .count { background: var(--samplesift-surface-muted, #e4eee6); color: var(--samplesift-muted, #46694f); border-radius: 1rem; padding: .1rem .45rem; font-size: .7rem; }
    .link { color: var(--samplesift-accent, #286653); background: none; border: 0; padding: .15rem 0; font-size: .75rem; text-decoration: underline; text-underline-offset: 2px; }
    .empty, .hint, .footnote { color: var(--samplesift-muted, #647b68); font-size: .78rem; line-height: 1.45; } .empty { margin: .2rem 0 1rem; } .footnote { margin: .65rem 0 0; font-size: .7rem; }
    .card { background: var(--samplesift-surface, #fff); border: 1px solid var(--samplesift-border-color, #d4e0d5); border-radius: var(--samplesift-radius, .65rem); padding: var(--samplesift-filter-card-padding, .8rem); margin-bottom: .7rem; box-shadow: var(--samplesift-shadow, 0 1px 2px #193c2410); }
    h4 { margin: 0; font-size: .85rem; font-weight: 650; } .remove { border: 0; background: none; color: var(--samplesift-muted, #7a8b7b); font-size: 1.25rem; width: 1.6rem; height: 1.6rem; line-height: 1; border-radius: var(--samplesift-control-radius, .25rem); }
    .remove:hover { background: var(--samplesift-surface-muted, #f3f5ef); color: var(--samplesift-text, #244a35); } .condition { display: flex; align-items: center; gap: .4rem; border: 0; background: none; color: var(--samplesift-muted, #57725e); padding: .35rem 0 .55rem; font-size: .73rem; }
    .condition span { color: var(--samplesift-muted, #829184); } fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
    .add { width: 100%; display: flex; align-items: center; justify-content: center; gap: .35rem; border: 1px dashed var(--samplesift-control-border-color, var(--samplesift-border-color, #a6bead)); border-radius: var(--samplesift-control-radius, .5rem); padding: .65rem; background: var(--samplesift-control-background, var(--samplesift-surface-muted, #f8fbf6)); color: var(--samplesift-control-text, var(--samplesift-accent, #2d6852)); font-size: .8rem; font-weight: 600; }
    .add:hover { background: var(--samplesift-surface-muted, #edf5eb); } .picker { border: 1px solid var(--samplesift-border-color, #c7d8cb); border-radius: var(--samplesift-radius, .5rem); margin-top: .5rem; padding: .5rem; background: var(--samplesift-surface, #fff); }
    .picker input { width: 100%; border: 1px solid var(--samplesift-control-border-color, var(--samplesift-border-color, #cbd7cc)); border-radius: var(--samplesift-control-radius, .35rem); padding: .5rem; font-size: .8rem; background: var(--samplesift-control-background, Field); color: var(--samplesift-control-text, var(--samplesift-text, FieldText)); } .picker ul { list-style: none; margin: .35rem 0 0; padding: 0; max-height: 240px; overflow-y: auto; }
    .picker li button { display: block; width: 100%; text-align: left; border: 0; background: none; padding: .55rem .45rem; color: var(--samplesift-text, #2d4b35); border-radius: var(--samplesift-control-radius, .3rem); font-size: .8rem; }
    .picker li button:hover { background: var(--samplesift-surface-muted, #edf5eb); } .picker small { display: block; margin-top: .15rem; color: var(--samplesift-muted, #738276); font-size: .7rem; line-height: 1.35; }
    .actions { position: sticky; bottom: 0; z-index: 3; margin-top: .65rem; padding: .3rem 0 .1rem; background: var(--samplesift-surface-muted, #f7faf5); border-top: 1px solid var(--samplesift-border-color, #dfe8dc); }
    .draft { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .4rem; margin-top: .7rem; font-size: .74rem; color: var(--samplesift-warning-color, #77602c); }
    .retained { margin: .4rem 0 0; padding-left: 1.1rem; color: var(--samplesift-muted, #526c59); font-size: .75rem; line-height: 1.5; }
    .error { color: var(--samplesift-error-color, #962f27); background: var(--samplesift-error-background, #fff2ef); border-radius: var(--samplesift-radius, .35rem); font-size: .75rem; line-height: 1.4; padding: .55rem; margin: .55rem 0 0; }
    .apply { margin-top: .8rem; width: 100%; border: 1px solid var(--samplesift-accent, #1a6856); border-radius: var(--samplesift-control-radius, .45rem); background: var(--samplesift-accent, #1b705c); color: var(--samplesift-on-accent, #fff); padding: .7rem; font-size: .82rem; font-weight: 650; }
    .apply:hover:not(:disabled) { background: var(--samplesift-accent-hover, #155b4a); } gui-form, gui-core-form { display: block; min-width: 0; }
    .card .gui-label { font-size: .73rem; } .card .gui-widget-input { max-width: 100%; } .card gui-number .gui-widget-input { width: 100%; }

  `];
}

if (!customElements.get('sample-sift-collection-filter-form')) customElements.define('sample-sift-collection-filter-form', SampleSiftCollectionFilterForm);
declare global { interface HTMLElementTagNameMap { 'sample-sift-collection-filter-form': SampleSiftCollectionFilterForm; } }
