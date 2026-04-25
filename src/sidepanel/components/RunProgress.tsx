import { useEffect, useRef, useState } from 'react';
import { Circle, Play, Check, X, Minus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import ConfirmDialog from './ConfirmDialog';
import { useRunStore } from '../stores/runStore';
import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';
import { useContentMessage } from '../utils/messageDispatcher';
import type { ScrapingResult } from '../../types/extraction';

const STATUS_ICON: Record<string, LucideIcon> = {
  pending: Circle,
  running: Play,
  success: Check,
  error:   X,
  skipped: Minus,
};

export default function RunProgress() {
  const {
    searchTerms,
    progress,
    logEntries,
    stopRun,
    updateProgress,
    appendLog,
    setResults,
    setError,
  } = useRunStore();
  const { setCloudflarePaused } = useUiStore();
  const [confirmStop, setConfirmStop] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useContentMessage('FLOW_PROGRESS', (payload) => {
    const p = payload as Record<string, unknown>;
    appendLog(String(p.message || p.stepLabel || p.status || 'Progress update'));
    if (p.termIndex !== undefined) {
      updateProgress(p.termIndex as number, {
        status: p.status as 'pending' | 'running' | 'success' | 'error' | 'skipped',
        message: (p.message as string) || null,
        stepLabel: (p.stepLabel as string) || null,
      });
    }
  });

  useContentMessage('FLOW_COMPLETE', (payload) => {
    stopRun();
    setResults((payload as { result: ScrapingResult }).result);
    useRunStore.getState().navigateRun('RESULTS');
  });

  useContentMessage('FLOW_ERROR', (payload) => {
    const p = payload as Record<string, unknown>;
    stopRun();
    setError(String(p.error || 'Unknown error'));
    useRunStore.getState().navigateRun('RUN_ERROR');
  });

  useContentMessage('FLOW_PAUSED', (payload) => {
    const p = payload as Record<string, unknown>;
    if (p.reason === 'cloudflare') {
      setCloudflarePaused(true);
    }
  });

  useContentMessage('FLOW_RESUMED', () => {
    setCloudflarePaused(false);
  });

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logEntries]);

  const doneCount = progress.filter(p =>
    p.status === 'success' || p.status === 'error' || p.status === 'skipped'
  ).length;
  const totalCount = searchTerms.length;
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
  const isSingleNoTerm = totalCount === 1 && searchTerms[0] === null;

  const handleStop = async () => {
    await sendToContent('ABORT_FLOW');
    stopRun();
    setCloudflarePaused(false);
    setConfirmStop(false);
    useRunStore.getState().goBackFromRun();
  };

  return (
    <>
      <div className="view">
        <h2 className="view-title">Running Scraper</h2>

        <div className="run-progress-bar-wrap">
          <div className="run-progress-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="run-progress-label">
          {isSingleNoTerm ? 'Running...' : `${doneCount} / ${totalCount} terms`}
        </p>

        {!isSingleNoTerm && (
          <div className="run-terms-list">
            {searchTerms.map((term, i) => {
              const p = progress[i] || {};
              const status = p.status || 'pending';
              const Icon = STATUS_ICON[status] || Circle;
              return (
                <div key={i} className={`run-term-row run-term-${status}`}>
                  <span className="run-term-icon"><Icon size={12} /></span>
                  <div className="run-term-body">
                    <span className="run-term-name">{term === null ? 'Current page' : `"${term}"`}</span>
                    {p.stepLabel && status === 'running' && (
                      <span className="run-term-step">{p.stepLabel}</span>
                    )}
                    {status === 'error' && p.message && (
                      <span className="run-term-error">{p.message}</span>
                    )}
                  </div>
                  <span className={`run-term-status run-term-status-${status}`}>
                    {status}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className="run-log-section">
          <div className="run-log-title">Live log:</div>
          <div className="run-log" ref={logRef}>
            {logEntries.map((entry, i) => (
              <div key={i} className="run-log-entry">
                <span className="run-log-time">{entry.time}</span>
                <span className="run-log-msg">{entry.message}</span>
              </div>
            ))}
            {logEntries.length === 0 && <span className="run-log-empty">Waiting for scraper to start...</span>}
          </div>
        </div>

        <div className="form-actions">
          <button className="btn btn-danger btn-full" onClick={() => setConfirmStop(true)}>
            Stop Scraper
          </button>
        </div>
      </div>

      {confirmStop && (
        <ConfirmDialog
          title="Stop Scraper?"
          message="This will stop the scraper. Any data collected so far will still be available."
          confirmLabel="Stop"
          confirmVariant="danger"
          onConfirm={handleStop}
          onCancel={() => setConfirmStop(false)}
        />
      )}
    </>
  );
}
