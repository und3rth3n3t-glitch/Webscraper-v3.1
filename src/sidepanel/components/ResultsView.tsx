import { useState, type ReactNode } from 'react';
import { Check, X, Minus, AlertTriangle, ChevronUp, ChevronDown } from 'lucide-react';
import { useRunStore } from '../stores/runStore';
import { useConfigStore } from '../stores/configStore';
import BackButton from './BackButton';
import type { IterationResult } from '../../types/extraction';

const STATUS_ICON: Record<string, ReactNode> = {
  success: <Check size={14} />,
  error:   <X size={14} />,
  partial: <AlertTriangle size={14} />,
  skipped: <Minus size={14} />,
};

export default function ResultsView() {
  const { results, error } = useRunStore();
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const iterations: IterationResult[] = results?.iterations || [];
  const successCount = iterations.filter(i => i.status === 'success').length;
  const errorCount = iterations.filter(i => i.status === 'error').length;
  const skippedCount = iterations.filter(i => i.status === 'skipped').length;
  const totalCount = iterations.length;
  const isSingleNoTerm = totalCount === 1 && iterations[0]?.searchTerm === null;

  const toggleExpand = (i: number) => {
    setExpanded(prev => ({ ...prev, [i]: !prev[i] }));
  };

  const handleDownload = () => {
    if (!results) return;
    const json = JSON.stringify(results, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(results.configName || 'scrape').replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRunAgain = () => {
    const { runContext } = useRunStore.getState();
    useRunStore.getState().launchRun(runContext);
  };

  const handleBack = () => {
    useRunStore.getState().goBackFromRun();
  };

  if (error && !results) {
    return (
      <div className="view">
        <div className="view-header">
          <BackButton onClick={handleBack} />
          <h2 className="view-title">Scrape Failed</h2>
        </div>
        <div className="run-banner run-banner-error">
          Scraper failed: {error}
        </div>
      </div>
    );
  }

  const partialCount = iterations.filter(i => i.status === 'partial' as string).length;

  const bannerClass = errorCount === 0 && partialCount === 0 && skippedCount === 0
    ? 'run-banner-success'
    : errorCount > 0 && successCount === 0 && partialCount === 0
    ? 'run-banner-error'
    : 'run-banner-warning';

  const tail = [
    errorCount > 0 ? `${errorCount} failed` : null,
    skippedCount > 0 ? `${skippedCount} skipped` : null,
  ].filter(Boolean).join(', ');

  const bannerMsg = isSingleNoTerm
    ? (errorCount === 0 && partialCount === 0
        ? 'Scrape completed successfully!'
        : errorCount > 0
        ? 'Scrape failed. Check your config steps and try again.'
        : 'Scrape completed with some data. One or more charts could only be partially read — see details below.')
    : errorCount === 0 && partialCount === 0 && skippedCount === 0
    ? `All ${totalCount} search terms scraped successfully!`
    : successCount === 0 && partialCount === 0
    ? `No terms scraped successfully${tail ? ` (${tail})` : ''}. Check your config steps and try again.`
    : `${successCount + partialCount} of ${totalCount} terms completed${tail ? ` — ${tail}` : ''}.`;

  return (
    <div className="view">
      <div className="view-header">
        <BackButton onClick={handleBack} />
        <h2 className="view-title">Scrape Complete</h2>
      </div>

      <div className={`run-banner ${bannerClass}`}>{bannerMsg}</div>

      {!isSingleNoTerm && (
        <div className="results-summary">
          <span>{totalCount} terms</span>
          <span className="results-success">{successCount} success</span>
          {errorCount > 0 && <span className="results-error">{errorCount} failed</span>}
          {skippedCount > 0 && <span className="results-skipped">{skippedCount} skipped</span>}
        </div>
      )}

      <div className="results-list">
        {iterations.map((iter, i) => {
          const iterAny = iter as IterationResult & { warning?: string };
          return (
            <div key={i} className={`result-item result-item-${iter.status}`}>
              <div className="result-item-header" onClick={() => toggleExpand(i)}>
                <span className="result-item-status-icon">
                  {STATUS_ICON[iter.status] || <Minus size={14} />}
                </span>
                <span className="result-item-term">
                  {iter.searchTerm === null ? 'Current page' : `"${iter.searchTerm}"`}
                </span>
                <span className="result-item-toggle">
                  {expanded[i] ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </span>
              </div>

              {iter.status === 'error' && iter.error && (
                <div className="result-item-error">{iter.error}</div>
              )}

              {iter.status === 'skipped' && iter.error && (
                <div className="result-item-skipped-msg">{iter.error}</div>
              )}

              {(iter.status as string) === 'partial' && iterAny.warning && (
                <div className="result-item-warning-msg">{iterAny.warning}</div>
              )}

              {expanded[i] && iter.status === 'success' && (
                <div className="result-item-body">
                  {Object.entries(iter.data || {}).map(([key, val]) => (
                    <div key={key} className="result-field">
                      <div className="result-field-name">{key}</div>
                      <div className="result-field-value">
                        {Array.isArray(val)
                          ? `${val.length} rows`
                          : typeof val === 'object'
                          ? JSON.stringify(val, null, 2).substring(0, 200)
                          : String(val)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="form-actions">
        {results && (
          <button className="btn btn-primary" onClick={handleDownload}>
            Download JSON
          </button>
        )}
        {results && (
          <button className="btn btn-secondary" onClick={() => useConfigStore.getState().pushView('DATA_MAPPING')}>
            Map Output
          </button>
        )}
        <button className="btn btn-secondary" onClick={handleRunAgain}>
          Run Again
        </button>
      </div>
    </div>
  );
}
