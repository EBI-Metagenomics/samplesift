import { LitElement, css, html, nothing, unsafeCSS } from 'lit';
import type { PropertyValues } from 'lit';
import '@golemui/gui-lit';
import type { FormElement } from '@golemui/gui-lit';
import type { GuiFormInitConfig } from '@golemui/gui-shared';
import golemCss from '@golemui/gui-components/index.css?inline';
import type { CollectionMetadata, Predicate } from '../collection/types';
import { validateCollectionState } from '../collection/cql2';
import { createCollectionFilterDefinition, formDataToPredicates, predicatesToFormData } from './collection-filter-schema';
import type { FilterFormData } from './collection-filter-schema';

/** Backend-derived filters. Drafts stay local until a validated Apply or Clear. */
export class SampleSiftCollectionFilterForm extends LitElement {
  static properties = {
    metadata: { attribute: false }, predicates: { attribute: false }, disabled: { type: Boolean },
    _error: { state: true }, _dirty: { state: true }, _unavailable: { state: true },
  };

  metadata: CollectionMetadata | undefined;
  predicates: readonly Predicate[] = [];
  disabled = false;
  private _config: GuiFormInitConfig | undefined;
  private _error = '';
  private _dirty = false;
  private _unavailable = false;
  private _pendingData: FilterFormData | undefined;
  private _draftData: unknown = {};
  private _runtimeError = false;
  private _hydrating = false;

  private get form() { return this.renderRoot.querySelector<FormElement>('gui-form'); }

  protected firstUpdated() {
    // Golem number controls stop native bubbling. Capture drafts before that handler.
    this.renderRoot.addEventListener('input', this.onNativeInput, true);
    this.renderRoot.addEventListener('change', this.onNativeInput, true);
  }

  protected willUpdate(changed: PropertyValues<this>) {
    if (!changed.has('metadata') && !changed.has('predicates')) return;
    this._error = '';
    this._dirty = false;
    this._unavailable = false;
    this._pendingData = undefined;
    if (!this.metadata) { this._config = undefined; return; }
    try {
      validateCollectionState({ predicates: this.predicates, sort: [], selection: null }, this.metadata);
      const data = predicatesToFormData(this.predicates, this.metadata.fields);
      this._draftData = structuredClone(data);
      if (changed.has('metadata') || !this._config) {
        this._runtimeError = false;
        this._config = {
          formDef: createCollectionFilterDefinition(this.metadata.fields) as GuiFormInitConfig['formDef'],
          data, validateOn: 'eager', expressionPolicy: 'strict',
        };
      } else this._pendingData = data;
    } catch (error) {
      this._unavailable = true;
      this._error = this.errorMessage(error);
    }
  }

  protected updated() {
    if (this._pendingData && this.form) {
      this.restoreFormData(this._pendingData);
      this._pendingData = undefined;
    }
  }

  private restoreFormData(data: FilterFormData) {
    this._hydrating = true;
    try {
      // Golem preserves focused numeric drafts; blur before a host restoration so
      // the displayed value immediately agrees with the newly applied state.
      this.form?.querySelector<HTMLElement>('input:focus, select:focus, textarea:focus')?.blur();
      this.form?.setData(data);
    } finally { this._hydrating = false; }
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'The filter form could not be updated.';
  }

  private emitDraft(valid: boolean) {
    this.dispatchEvent(new CustomEvent('draftchange', {
      detail: { dirty: this._dirty, valid }, bubbles: true, composed: true,
    }));
  }

  private onNativeInput = () => {
    if (this.disabled || this._unavailable || this._hydrating) return;
    this._dirty = true;
    this._error = '';
    this.emitDraft(false);
  };

  private invalidControl(): string | null {
    // Includes native numeric badInput and the form-associated segmented date control.
    for (const element of this.form?.querySelectorAll('*') ?? []) {
      const control = element as HTMLElement & { validity?: ValidityState; validationMessage?: string; disabled?: boolean };
      if (!control.disabled && control.validity && !control.validity.valid) {
        return control.validationMessage || 'Complete or correct the highlighted filter value.';
      }
    }
    return null;
  }

  private onFormEvent(event: CustomEvent<{ name: string; data: unknown }>) {
    event.stopPropagation();
    if (this.disabled || this._unavailable || this._hydrating || event.detail.name !== 'filter-draft') return;
    this._dirty = true;
    this._draftData = structuredClone(event.detail.data);
    this._error = '';
    let valid = false;
    try {
      this.validatedPredicates(this._draftData);
      valid = !this.invalidControl() && !this._runtimeError;
    } catch { /* The Apply action displays detailed cross-field errors. */ }
    this.emitDraft(valid);
  }

  private onInputError(event: CustomEvent<{ message: string }>) {
    event.stopPropagation();
    if (this.disabled || this._unavailable || this._hydrating || !event.detail.message) return;
    this._dirty = true;
    this._error = event.detail.message;
    this.emitDraft(false);
  }

  private onPartsChange(event: Event) {
    event.stopPropagation();
    this.onNativeInput();
  }

  private onFormHealth(event: CustomEvent<{ status: string; message?: string }>) {
    event.stopPropagation();
    this._runtimeError = event.detail.status === 'errored';
    if (this._runtimeError) {
      this._error = event.detail.message || 'The filter controls could not be loaded.';
      this._dirty = true;
      this.emitDraft(false);
    }
  }

  private validatedPredicates(data: unknown): Predicate[] {
    if (!this.metadata) throw new Error('Filter metadata has not loaded.');
    const predicates = formDataToPredicates(data, this.metadata.fields);
    validateCollectionState({ predicates, sort: [], selection: null }, this.metadata);
    return predicates;
  }

  private commit(predicates: Predicate[]) {
    this._error = '';
    this._dirty = false;
    this.emitDraft(true);
    this.dispatchEvent(new CustomEvent('predicateschange', {
      detail: { predicates: structuredClone(predicates) }, bubbles: true, composed: true,
    }));
  }

  private onFormSubmit(event: CustomEvent<{ data: unknown }>) {
    event.stopPropagation();
    if (this.disabled || this._unavailable || this._runtimeError) return;
    try {
      const invalid = this.invalidControl();
      if (invalid) throw new Error(invalid);
      this._draftData = structuredClone(event.detail.data);
      this.commit(this.validatedPredicates(this._draftData));
    } catch (error) {
      this._dirty = true;
      this._error = this.errorMessage(error);
      this.emitDraft(false);
    }
  }

  private clear() {
    if (this.disabled || !this.metadata) return;
    try {
      validateCollectionState({ predicates: [], sort: [], selection: null }, this.metadata);
      const data = predicatesToFormData([], this.metadata.fields);
      this._draftData = data;
      // Clear also recovers from a saved condition this compact form cannot represent.
      if (this._unavailable || !this._config) {
        this._config = {
          formDef: createCollectionFilterDefinition(this.metadata.fields) as GuiFormInitConfig['formDef'],
          data, validateOn: 'eager', expressionPolicy: 'strict',
        };
        this._unavailable = false;
        this._runtimeError = false;
      } else this.restoreFormData(data);
      this.commit([]);
    } catch (error) {
      this._error = this.errorMessage(error);
    }
  }

  protected render() {
    return html`
      <section aria-label="Collection filters">
        <div class="heading"><h3>Filters</h3><button type="button" @click=${this.clear} ?disabled=${this.disabled || !this.metadata}>Clear filters</button></div>
        ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : nothing}
        ${!this.metadata ? html`<p role="status">Loading available filters…</p>` : nothing}
        ${this._dirty ? html`<p class="draft" role="status">Unapplied changes. Apply filters to update results.</p>` : nothing}
        ${this._config && !this._unavailable ? html`
          <fieldset ?disabled=${this.disabled}>
            <gui-form .config=${this._config}
              @formEvent=${this.onFormEvent} @formSubmit=${this.onFormSubmit} @formHealth=${this.onFormHealth}
              @gui-input-error=${this.onInputError} @gui-parts-change=${this.onPartsChange}
            ></gui-form>
          </fieldset>` : nothing}
      </section>
    `;
  }

  static styles = [
    // Golem's light-DOM widgets remain in this shadow tree. Its root token selectors
    // must target our host instead of the document; no global stylesheet is inserted.
    unsafeCSS(golemCss.replaceAll(':root', ':host')),
    css`
      :host { display: block; min-width: 0; font: inherit; color: inherit; --gui-color-primary-500: #0d766e; --gui-color-primary-600: #0b655e; }
      * { box-sizing: border-box; }
      section { min-width: 0; }
      .heading { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .7rem; }
      h3 { margin: 0; font-size: 1rem; }
      fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
      .heading button { font: inherit; font-size: .8rem; color: #0b655e; background: #fff; border: 1px solid #b7cec9; border-radius: .35rem; padding: .4rem .55rem; cursor: pointer; }
      button:disabled { opacity: .55; cursor: default; }
      button:focus-visible { outline: 2px solid #0d766e; outline-offset: 2px; }
      .error, .draft { font-size: .82rem; line-height: 1.4; padding: .65rem; border-radius: .4rem; margin: 0 0 .75rem; }
      .error { color: #8b2020; background: #fff0ee; border: 1px solid #e9bcb7; }
      .draft { color: #71521f; background: #fff7df; }
      gui-form, gui-core-form { display: block; min-width: 0; }
    `,
  ];
}

if (!customElements.get('sample-sift-collection-filter-form')) {
  customElements.define('sample-sift-collection-filter-form', SampleSiftCollectionFilterForm);
}

declare global {
  interface HTMLElementTagNameMap { 'sample-sift-collection-filter-form': SampleSiftCollectionFilterForm; }
}
