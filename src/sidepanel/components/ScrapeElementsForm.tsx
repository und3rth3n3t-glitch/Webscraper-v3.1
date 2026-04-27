import { useState, useEffect, type ChangeEvent } from 'react';
import BackButton from './BackButton';
import {
  ElementBanner,
  ChartDetectionBanner,
  TableDetectionBanner,
  JsonPreview,
  ContainerBanner,
  PaginationControlBanner,
} from './PickedElementPreview';
import StepConditionEditor from './StepConditionEditor';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { sendToContent, collectFrameResponses, onContentMessage } from '../utils/messaging';
import { generateId } from '../utils/uuid';
import type { ScrapeOptions, ScrapeElementConfig, SelectorDescriptor } from '../../types/config';

// Extends ScrapeElementConfig with V2 form-only fields
type ElementConfig = Omit<ScrapeElementConfig, 'selectMode'> & {
  selectMode: 'single' | 'all' | 'container';
  scanned?: boolean;
  treatAsTable?: boolean;
};

interface Props {
  editingStepId?: string;
}

export default function ScrapeElementsForm({ editingStepId }: Props) {
  const { steps, draftStep, updateStep, updateStepOptions, commitDraft, setView } = useConfigStore();

  const [showModeSelect, setShowModeSelect] = useState(false);
  const [scanMode, setScanMode] = useState<'table' | 'chart' | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<string>('');
  const [expandHidden, setExpandHidden] = useState(false);
  const [dynamicHeadersDefault, setDynamicHeadersDefault] = useState(false);
  const [applyAllDecision, setApplyAllDecision] = useState<'yes' | 'no' | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!scanning) return;
    const stop = onContentMessage((msg) => {
      if (msg.type === 'SCAN_PROGRESS') {
        const m = (msg.payload as { message?: string })?.message;
        if (m) setScanProgress(m);
      }
    });
    return stop;
  }, [scanning]);

  const step = editingStepId ? steps.find(s => s.id === editingStepId) : draftStep;
  const opts = (step?.options || {}) as Partial<ScrapeOptions>;
  const elements = (opts.elements || []) as unknown as ElementConfig[];

  if (!step) return null;

  const updateElements = (newElements: ElementConfig[]) =>
    updateStepOptions(step.id, { elements: newElements as unknown as ScrapeElementConfig[] } as Partial<ScrapeOptions>);

  const updateOpt = (key: keyof ScrapeOptions, value: unknown) =>
    updateStepOptions(step.id, { [key]: value } as Partial<ScrapeOptions>);

  const addElement = async (mode = 'single') => {
    try {
      await sendToContent('START_PICKER', { mode });
      useUiStore.getState().setPickerActive(true);
      useUiStore.getState().setPendingPickerStepId(step.id);
      useUiStore.getState().setPendingPickerField('newElement');
      setShowModeSelect(false);
    } catch {
      useUiStore.getState().showToast("Could not start picker. Make sure you're on a webpage.", 'error');
    }
  };

  const removeElement = (id: string) => updateElements(elements.filter(e => e.id !== id));

  const updateElement = (id: string, changes: Partial<ElementConfig>) =>
    updateElements(elements.map(e => e.id === id ? { ...e, ...changes } : e));

  const updateAllTableElements = (changeFn: (e: ElementConfig) => Partial<ElementConfig>) =>
    updateElements(elements.map(e =>
      e.detectedType === 'table' && e.treatAsTable !== false ? { ...e, ...changeFn(e) } : e
    ));

  const toggleCollapse = (id: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allCollapsed = elements.length > 0 && elements.every(e => collapsedIds.has(e.id));
  const toggleAll = () => {
    if (allCollapsed) setCollapsedIds(new Set());
    else setCollapsedIds(new Set(elements.map(e => e.id)));
  };

  const repickElement = async (elementId: string) => {
    try {
      const el = elements.find(e => e.id === elementId);
      await sendToContent('START_PICKER', { mode: el?.selectMode || 'single' });
      useUiStore.getState().setPickerActive(true);
      useUiStore.getState().setPendingPickerStepId(step.id);
      useUiStore.getState().setPendingPickerField(`repick:${elementId}`);
    } catch {
      useUiStore.getState().showToast("Could not start picker. Make sure you're on a webpage.", 'error');
    }
  };

  const pickPaginationElement = async (elementId: string) => {
    try {
      await sendToContent('START_PICKER', { mode: 'single' });
      useUiStore.getState().setPickerActive(true);
      useUiStore.getState().setPendingPickerStepId(step.id);
      useUiStore.getState().setPendingPickerField(`pagination:${elementId}`);
    } catch {
      useUiStore.getState().showToast("Could not start picker. Make sure you're on a webpage.", 'error');
    }
  };

  const startScan = async () => {
    try {
      setScanning(true);
      setScanProgress('Starting scan...');
      // Subscribe to SCAN_COMPLETE before kicking off the scan, otherwise a fast scan
      // (or a slow sendToContent round-trip) can deliver SCAN_COMPLETE before the
      // collector subscribes, and we lose the result.
      const framesPromise = collectFrameResponses('SCAN_COMPLETE', { errorType: 'SCAN_ERROR' }) as Promise<Array<{ elements?: unknown[]; scanType?: string; aborted?: boolean }>>;
      await sendToContent('SCAN_ELEMENTS', { scanType: scanMode, expand: expandHidden });
      const frames = await framesPromise;
      const foundElements = frames.flatMap(f => f.elements || []) as Array<Record<string, unknown>>;
      const resolvedScanType = frames[0]?.scanType || scanMode;
      const wasAborted = frames.some(f => f.aborted);
      const count = foundElements.length;

      setScanning(false);
      setScanProgress('');

      if (wasAborted) {
        useUiStore.getState().showToast('Scan stopped.', 'warning');
        return;
      }

      if (count === 0) {
        useUiStore.getState().showToast(`No ${resolvedScanType}s found on this page.`, 'warning');
        setScanMode(null);
        setShowModeSelect(false);
        addElement('single');
        return;
      }

      const currentElements = (useConfigStore.getState().steps.find(s => s.id === step.id)?.options as unknown as Partial<ScrapeOptions>)?.elements as unknown as ElementConfig[] || [];
      const usedNames = new Set(currentElements.map(e => e.name));
      const newElements: ElementConfig[] = foundElements.map((pickData, i) => {
        const baseName = (pickData.label as string) || `${resolvedScanType}${currentElements.length + i + 1}`;
        let name = baseName;
        let suffix = 2;
        while (usedNames.has(name)) name = `${baseName}_${suffix++}`;
        usedNames.add(name);
        const extra = pickData.extra as Record<string, unknown> || {};
        return {
          id: generateId(),
          name,
          selector: pickData.descriptor as SelectorDescriptor,
          detectedType: pickData.elementType as string,
          selectMode: 'single',
          scanned: true,
          extra,
          treatAsTable: pickData.elementType === 'table' ? true : undefined,
          tableFields: (extra.columnNames as string[]) || [],
          excludedColumns: [],
          dynamicHeaders: scanMode === 'table' && dynamicHeadersDefault,
          excludedColumnIndices: [],
          paginate: !!(extra.paginationDetected),
          paginationSelector: (extra.paginationDetected as SelectorDescriptor | null) || null,
          paginationCount: 0,
        };
      });

      updateElements([...currentElements, ...newElements]);
      useUiStore.getState().showToast(`Found ${count} ${resolvedScanType === 'table' ? 'table' : 'chart'}${count !== 1 ? 's' : ''}.`, 'success');
      setScanMode(null);
      setShowModeSelect(false);
    } catch {
      useUiStore.getState().showToast("Could not start scan. Make sure you're on a webpage.", 'error');
      setScanning(false);
      setScanProgress('');
    }
  };

  const abortScan = async () => {
    try {
      await sendToContent('SCAN_ABORT');
    } catch { /* expected */ }
  };

  const handleSave = () => {
    if (elements.length === 0) {
      useUiStore.getState().showToast('Pick at least one element to scrape.', 'error');
      return;
    }
    if (!step.label) {
      updateStep(step.id, { label: `Scrape: ${elements.map(e => e.name).join(', ')}` });
    }
    if (!editingStepId) commitDraft();
    setView('STEP_LIST');
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Grab Elements</h2>
      </div>

      <div className="form-group">
        <label className="form-label">Label</label>
        <input
          className="form-input"
          value={step.label || ''}
          onChange={e => updateStep(step.id, { label: e.target.value })}
          placeholder="e.g. Scrape: Price Table + Result Count"
        />
      </div>

      <div className="scrape-elements-list">
        {elements.length === 0 && (
          <p className="empty-hint">No elements picked yet. Click below to add one.</p>
        )}

        {elements.length > 1 && (
          <div className="elements-list-toolbar">
            <button className="btn btn-ghost btn-sm" onClick={toggleAll}>
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          </div>
        )}

        {elements.map((el) => {
          const otherTables = elements.filter(e =>
            e.id !== el.id && e.detectedType === 'table' && e.treatAsTable !== false
          );
          return (
            <ElementConfigCard
              key={el.id}
              config={el}
              onChange={(changes) => updateElement(el.id, changes)}
              onRemove={() => removeElement(el.id)}
              onRepick={() => repickElement(el.id)}
              onPickPagination={() => pickPaginationElement(el.id)}
              collapsed={collapsedIds.has(el.id)}
              onToggleCollapse={() => toggleCollapse(el.id)}
              applyAllDecision={applyAllDecision}
              hasOtherTables={otherTables.length > 0}
              onDynamicHeadersChange={(checked, applyAll) => {
                if (applyAll) {
                  updateAllTableElements((e) => ({
                    dynamicHeaders: checked,
                    excludedColumns: [],
                    tableFields: (e.extra?.columnNames as string[]) || [],
                    excludedColumnIndices: [],
                  }));
                } else {
                  updateElement(el.id, {
                    dynamicHeaders: checked,
                    excludedColumns: [],
                    tableFields: (el.extra?.columnNames as string[]) || [],
                    excludedColumnIndices: [],
                  });
                }
              }}
              onApplyAllResponse={(response) => setApplyAllDecision(response)}
            />
          );
        })}
      </div>

      {!showModeSelect ? (
        <button className="btn btn-secondary btn-full mt-8" onClick={() => setShowModeSelect(true)}>
          + Pick Element
        </button>
      ) : scanMode ? (
        <div className="scan-panel mt-8">
          <div className="scan-panel-header">
            <h3 className="scan-panel-title">
              {scanMode === 'table' ? 'Find All Tables' : 'Find All Charts'}
            </h3>
            <button className="btn btn-ghost btn-sm" onClick={() => setScanMode(null)} disabled={scanning}>
              Back
            </button>
          </div>
          <label className="form-check">
            <input type="checkbox" checked={expandHidden}
              onChange={e => setExpandHidden(e.target.checked)} disabled={scanning} />
            Expand hidden sections before scanning
          </label>
          {scanMode === 'table' && (
            <label className="form-check">
              <input type="checkbox" checked={dynamicHeadersDefault}
                onChange={e => setDynamicHeadersDefault(e.target.checked)} disabled={scanning} />
              Dynamic headers
              <span className="form-hint">Column names change between pages</span>
            </label>
          )}
          {scanning ? (
            <button className="btn btn-secondary btn-full" onClick={abortScan}>
              <span className="picker-pulse" /> Stop Scanning
            </button>
          ) : (
            <button className="btn btn-primary btn-full" onClick={startScan}>
              Scan Page
            </button>
          )}
          {scanning && scanProgress && (
            <p className="form-hint" style={{ marginTop: 8, textAlign: 'center' }}>{scanProgress}</p>
          )}
        </div>
      ) : (
        <div className="step-type-menu mt-8">
          <button className="step-type-option" onClick={() => addElement('single')}>
            <div className="step-type-option-title">Individual Element</div>
            <div className="step-type-option-desc">Pick one specific element from the page</div>
          </button>
          <button className="step-type-option" onClick={() => setScanMode('table')}>
            <div className="step-type-option-title">Find All Tables</div>
            <div className="step-type-option-desc">Auto-detect and add every table on the page</div>
          </button>
          <button className="step-type-option" onClick={() => setScanMode('chart')}>
            <div className="step-type-option-title">Find All Charts</div>
            <div className="step-type-option-desc">Auto-detect and add every chart on the page</div>
          </button>
          <button className="step-type-option" onClick={() => addElement('container')}>
            <div className="step-type-option-title">Container</div>
            <div className="step-type-option-desc">Pick a section and grab all data inside — tables, text, charts, links</div>
          </button>
        </div>
      )}

      <details className="form-group">
        <summary className="form-label" style={{ cursor: 'pointer' }}>Human pacing (advanced)</summary>
        <p className="form-hint">All values in milliseconds (or fraction of viewport for scroll step). Leave blank for sensible defaults.</p>

        <label className="form-label mt-8">Scroll step size (× viewport)</label>
        <input
          type="number"
          step="0.05"
          min="0.1"
          max="1.0"
          className="form-input"
          value={opts.scrollIncrementVh ?? ''}
          placeholder="0.4"
          onChange={(e) => updateOpt('scrollIncrementVh', e.target.value === '' ? undefined : Number(e.target.value))}
        />

        <label className="form-label mt-8">Pause between scroll steps (ms)</label>
        <input
          type="number"
          min="0"
          className="form-input"
          value={opts.scrollDelayMs ?? ''}
          placeholder="700"
          onChange={(e) => updateOpt('scrollDelayMs', e.target.value === '' ? undefined : Number(e.target.value))}
        />

        <label className="form-label mt-8">Pause between pagination clicks (ms)</label>
        <input
          type="number"
          min="0"
          className="form-input"
          value={opts.paginationDelayMs ?? ''}
          placeholder="1500"
          onChange={(e) => updateOpt('paginationDelayMs', e.target.value === '' ? undefined : Number(e.target.value))}
        />

        <label className="form-label mt-8">Pause between expand-button clicks (ms)</label>
        <input
          type="number"
          min="0"
          className="form-input"
          value={opts.expandDelayMs ?? ''}
          placeholder="350"
          onChange={(e) => updateOpt('expandDelayMs', e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </details>

      <StepConditionEditor stepId={step.id} />

      <div className="form-actions">
        <button className="btn btn-primary btn-full" onClick={handleSave}>
          Save Scrape Step
        </button>
      </div>
    </div>
  );
}

interface ChartMethodInfoProps {
  extra: Record<string, unknown> | null;
}

function ChartMethodInfo({ extra }: ChartMethodInfoProps) {
  const method = extra?.chartMethod as { method: string; library?: string } | undefined;
  if (!method) return null;
  const methodMap: Record<string, { label: string; variant: string }> = {
    accessible_table: { label: 'Data table found', variant: 'success' },
    js_library:       { label: `${method.library || 'JS'} library detected`, variant: 'success' },
    aria:             { label: 'ARIA accessibility data found', variant: 'success' },
    svg_structure:    { label: 'Chart structure detected (no data values)', variant: 'warning' },
    metadata_only:    { label: 'Chart detected — metadata only', variant: 'warning' },
    canvas:           { label: 'Canvas chart — limited extraction', variant: 'warning' },
  };
  const info = methodMap[method.method] || { label: 'Chart detected', variant: 'success' };
  return (
    <>
      <div className={`detection-info detection-info-${info.variant}`}>
        <div className="detection-info-title">{info.label}</div>
      </div>
      {method.method === 'canvas' && (
        <p className="form-hint">Consider using a &ldquo;Select Each&rdquo; step to capture data from chart controls.</p>
      )}
      {method.method === 'metadata_only' && (
        <p className="form-hint">Chart data values are not accessible. Structure and labels may still be captured.</p>
      )}
    </>
  );
}

interface DynamicHeadersToggleProps {
  checked: boolean;
  applyAllDecision: 'yes' | 'no' | null;
  hasOtherTables: boolean;
  onToggle: (checked: boolean, applyAll: boolean) => void;
  onApplyAllResponse: (response: 'yes' | 'no') => void;
}

function DynamicHeadersToggle({ checked, applyAllDecision, hasOtherTables, onToggle, onApplyAllResponse }: DynamicHeadersToggleProps) {
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);
  const showPrompt = pendingValue !== null;

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.checked;
    if (applyAllDecision !== null || !hasOtherTables) {
      onToggle(newValue, applyAllDecision === 'yes');
      return;
    }
    setPendingValue(newValue);
  };

  const handleResponse = (response: 'yes' | 'no') => {
    onApplyAllResponse(response);
    onToggle(pendingValue!, response === 'yes');
    setPendingValue(null);
  };

  return (
    <>
      <label className="form-check">
        <input
          type="checkbox"
          checked={checked}
          onChange={handleChange}
          disabled={showPrompt}
        />
        Dynamic headers
        <span className="form-hint">Column names change between pages</span>
      </label>
      {showPrompt && (
        <div className="form-hint" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
          Apply to all tables?
          <button className="btn btn-ghost btn-sm" onClick={() => handleResponse('yes')}>Yes</button>
          <button className="btn btn-ghost btn-sm" onClick={() => handleResponse('no')}>No</button>
        </div>
      )}
    </>
  );
}

interface ElementConfigCardProps {
  config: ElementConfig;
  onChange: (changes: Partial<ElementConfig>) => void;
  onRemove: () => void;
  onRepick: () => void;
  onPickPagination: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  applyAllDecision: 'yes' | 'no' | null;
  hasOtherTables: boolean;
  onDynamicHeadersChange: (checked: boolean, applyAll: boolean) => void;
  onApplyAllResponse: (response: 'yes' | 'no') => void;
}

function ElementConfigCard({
  config,
  onChange,
  onRemove,
  onRepick,
  onPickPagination,
  collapsed,
  onToggleCollapse,
  applyAllDecision,
  hasOtherTables,
  onDynamicHeadersChange,
  onApplyAllResponse,
}: ElementConfigCardProps) {
  const isContainer = config.selectMode === 'container' || config.detectedType === 'container';
  const isTable = !isContainer && config.detectedType === 'table';
  const isChart = !isContainer && config.detectedType === 'chart';
  const treatAsTable = isTable && config.treatAsTable !== false;
  const columnNames = config.extra?.columnNames as string[] | undefined;

  return (
    <div className="element-config-card">
      {isContainer && <ContainerBanner onRepick={onRepick} onRemove={onRemove} />}
      {isTable && <TableDetectionBanner extra={config.extra} onRemove={onRemove} />}
      {isChart && <ChartDetectionBanner extra={config.extra} onRemove={onRemove} />}
      {!isContainer && !isTable && !isChart && (
        <ElementBanner
          elementType={config.detectedType}
          descriptor={config.selector}
          label={config.name}
          extra={config.extra}
          onRepick={onRepick}
          onRemove={onRemove}
        />
      )}

      <button
        className={`element-collapse-toggle${collapsed ? ' element-collapse-toggle-collapsed' : ''}`}
        onClick={onToggleCollapse}
        aria-label={collapsed ? 'Expand' : 'Collapse'}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 4.5L6 8L10 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {!collapsed && (
        <div className="element-config-body">
          {isContainer && (
            <>
              <div className="form-group">
                <label className="form-label">Field name</label>
                <input
                  className="form-input"
                  value={config.name || ''}
                  onChange={e => onChange({ name: e.target.value })}
                  placeholder="e.g. product_details"
                />
              </div>
              <div className="detection-info">
                <div className="detection-info-title">Grabs all structured content</div>
                <div className="detection-info-body">
                  Tables, charts, text, lists, links, and images inside this container will be extracted automatically.
                </div>
              </div>
            </>
          )}

          {!isContainer && (
            <>
              {isTable && !config.scanned && (
                <div className="form-group">
                  <label className="form-label">Extract as</label>
                  <div className="radio-pill-group">
                    <label className={`radio-pill${treatAsTable ? ' radio-pill-active' : ''}`}>
                      <input type="radio" name={`extract-${config.id}`} checked={treatAsTable}
                        onChange={() => onChange({ treatAsTable: true })} />
                      Table
                    </label>
                    <label className={`radio-pill${!treatAsTable ? ' radio-pill-active' : ''}`}>
                      <input type="radio" name={`extract-${config.id}`} checked={!treatAsTable}
                        onChange={() => onChange({ treatAsTable: false })} />
                      Individual
                    </label>
                  </div>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Field name</label>
                <input
                  className="form-input"
                  value={config.name || ''}
                  onChange={e => onChange({ name: e.target.value })}
                  placeholder="e.g. results_table"
                />
              </div>

              {isTable && treatAsTable && (
                <DynamicHeadersToggle
                  checked={!!config.dynamicHeaders}
                  applyAllDecision={applyAllDecision}
                  hasOtherTables={hasOtherTables}
                  onToggle={onDynamicHeadersChange}
                  onApplyAllResponse={onApplyAllResponse}
                />
              )}

              {isTable && treatAsTable && columnNames && (
                <div className="form-group">
                  <div className="form-label-row">
                    <label className="form-label">Columns to include</label>
                    <span className="meta-badge">{columnNames.length}</span>
                  </div>
                  {config.dynamicHeaders && (
                    <p className="form-hint">Columns matched by position — names shown are from when you picked the table</p>
                  )}
                  <div className="column-checklist">
                    {config.dynamicHeaders
                      ? columnNames.map((col, idx) => (
                          <label key={idx} className="form-check">
                            <input
                              type="checkbox"
                              checked={!(config.excludedColumnIndices || []).includes(idx)}
                              onChange={e => {
                                const excluded = config.excludedColumnIndices || [];
                                onChange({
                                  excludedColumnIndices: e.target.checked
                                    ? excluded.filter(i => i !== idx)
                                    : [...excluded, idx],
                                });
                              }}
                            />
                            {col}
                          </label>
                        ))
                      : columnNames.map(col => (
                          <label key={col} className="form-check">
                            <input
                              type="checkbox"
                              checked={!(config.excludedColumns || []).includes(col)}
                              onChange={e => {
                                const excluded = config.excludedColumns || [];
                                onChange({
                                  excludedColumns: e.target.checked
                                    ? excluded.filter(c => c !== col)
                                    : [...excluded, col],
                                  tableFields: columnNames.filter(c =>
                                    c !== col
                                      ? !(config.excludedColumns || []).includes(c)
                                      : e.target.checked
                                  ),
                                });
                              }}
                            />
                            {col}
                          </label>
                        ))
                    }
                  </div>
                </div>
              )}

              {isTable && treatAsTable && config.extra?.preview && (
                <div className="form-group">
                  <label className="form-label">Data preview</label>
                  <JsonPreview data={config.extra.preview} />
                </div>
              )}

              {isChart && <ChartMethodInfo extra={config.extra} />}

              {isTable && treatAsTable && (
                <div className="form-group">
                  <label className="form-check">
                    <input type="checkbox" checked={!!config.paginate}
                      onChange={e => onChange({ paginate: e.target.checked })} />
                    Paginate
                  </label>
                  {config.paginate && (
                    <div className="form-group-indented">
                      <PaginationControlBanner
                        descriptor={config.paginationSelector}
                        onPick={onPickPagination}
                      />
                      <label className="form-label mt-8">Max pages</label>
                      <input
                        type="text"
                        className="form-input"
                        value={config.paginationCount || ''}
                        onChange={e => {
                          const val = e.target.value.replace(/[^0-9]/g, '');
                          onChange({ paginationCount: val === '' ? 0 : Number(val) });
                        }}
                        placeholder="All"
                      />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
