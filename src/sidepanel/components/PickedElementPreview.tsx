import { useRef, useEffect } from 'react';
import { X, RefreshCw, Table2, BarChart3, Box, Navigation } from 'lucide-react';
import { getFriendlyLabel } from '../utils/friendlyLabel';
import { sendToContent } from '../utils/messaging';
import type { SelectorDescriptor } from '../../types/config';

interface BaseProps {
  onRepick?: () => void;
  onRemove?: () => void;
}

interface PickedElementPreviewProps {
  selector: SelectorDescriptor | null;
  elementType?: string | null;
  label?: string | null;
  extra?: Record<string, unknown> | null;
  onRepick?: () => void;
}

export default function PickedElementPreview({ selector, elementType, label, extra, onRepick }: PickedElementPreviewProps) {
  if (!selector) {
    return (
      <div className="pick-element-empty">
        <span className="pick-element-hint">No element selected</span>
      </div>
    );
  }

  if (elementType === 'table') {
    return <TableDetectionBanner extra={extra} onRepick={onRepick} />;
  }

  if (elementType === 'chart') {
    return <ChartDetectionBanner extra={extra} onRepick={onRepick} />;
  }

  return (
    <ElementBanner
      elementType={elementType ?? null}
      descriptor={selector}
      label={label ?? null}
      extra={extra ?? null}
      onRepick={onRepick}
    />
  );
}

interface ElementBannerProps extends BaseProps {
  elementType: string | null;
  descriptor: SelectorDescriptor | null;
  label?: string | null;
  extra?: Record<string, unknown> | null;
}

export function ElementBanner({ elementType, descriptor, onRepick, onRemove }: ElementBannerProps) {
  const { label: friendlyName, icon: Icon } = getFriendlyLabel(elementType, descriptor);

  return (
    <div className="element-banner">
      <div className="element-banner-title">
        <Icon size={16} />
        <span>{friendlyName}</span>
      </div>
      <div className="element-banner-actions">
        {onRepick && (
          <button className="btn btn-ghost btn-sm" onClick={onRepick}>
            <RefreshCw size={12} /> Re-pick
          </button>
        )}
        {onRemove && (
          <button className="btn btn-icon btn-icon-delete" onClick={onRemove} aria-label="Remove">
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

interface DetectionBannerProps extends BaseProps {
  extra?: Record<string, unknown> | null;
}

export function ChartDetectionBanner({ onRepick, onRemove }: DetectionBannerProps) {
  return (
    <div className="chart-banner">
      <div className="chart-banner-title">
        <BarChart3 size={16} />
        <span>Chart Detected</span>
      </div>
      <div className="element-banner-actions">
        {onRepick && (
          <button className="btn btn-ghost btn-sm" onClick={onRepick}>
            <RefreshCw size={12} /> Re-pick
          </button>
        )}
        {onRemove && (
          <button className="btn btn-icon btn-icon-delete" onClick={onRemove} aria-label="Remove">
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export function TableDetectionBanner({ onRepick, onRemove }: DetectionBannerProps) {
  return (
    <div className="table-banner">
      <div className="table-banner-title">
        <Table2 size={16} />
        <span>Table Detected</span>
      </div>
      <div className="element-banner-actions">
        {onRepick && (
          <button className="btn btn-ghost btn-sm" onClick={onRepick}>
            <RefreshCw size={12} /> Re-pick
          </button>
        )}
        {onRemove && (
          <button className="btn btn-icon btn-icon-delete" onClick={onRemove} aria-label="Remove">
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export function ContainerBanner({ onRepick, onRemove }: BaseProps) {
  return (
    <div className="container-banner">
      <div className="container-banner-title">
        <Box size={16} />
        <span>Container</span>
      </div>
      <div className="element-banner-actions">
        {onRepick && (
          <button className="btn btn-ghost btn-sm" onClick={onRepick}>
            <RefreshCw size={12} /> Re-pick
          </button>
        )}
        {onRemove && (
          <button className="btn btn-icon btn-icon-delete" onClick={onRemove} aria-label="Remove">
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

interface PaginationControlBannerProps {
  descriptor: SelectorDescriptor | null;
  onPick: () => void;
}

export function PaginationControlBanner({ descriptor, onPick }: PaginationControlBannerProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detected = !!descriptor;

  const handleMouseEnter = () => {
    if (!descriptor) return;
    sendToContent('HIGHLIGHT_ELEMENT', { selector: descriptor }).catch(() => {});
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      sendToContent('UNHIGHLIGHT_ELEMENT', {}).catch(() => {});
      timerRef.current = null;
    }, 2000);
  };

  const handleMouseLeave = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (descriptor) {
      sendToContent('UNHIGHLIGHT_ELEMENT', {}).catch(() => {});
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      sendToContent('UNHIGHLIGHT_ELEMENT', {}).catch(() => {});
    };
  }, []);

  if (detected) {
    return (
      <div
        className="pagination-detected-banner"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="pagination-detected-banner-title">
          <Navigation size={16} />
          <span>Pagination Detected</span>
        </div>
        <div className="element-banner-actions">
          <button className="btn btn-ghost btn-sm" onClick={onPick}>
            <RefreshCw size={12} /> Re-pick
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pagination-none-banner">
      <div className="pagination-none-banner-title">
        <Navigation size={16} />
        <span>No Pagination Detected</span>
      </div>
      <div className="element-banner-actions">
        <button className="btn btn-ghost btn-sm" onClick={onPick}>
          Pick
        </button>
      </div>
    </div>
  );
}

interface JsonPreviewProps {
  data: unknown;
}

export function JsonPreview({ data }: JsonPreviewProps) {
  if (!data || (Array.isArray(data) && data.length === 0)) return null;
  return (
    <pre className="json-preview">
      {JSON.stringify(Array.isArray(data) ? data.slice(0, 2) : data, null, 2)}
    </pre>
  );
}

interface TableMiniPreviewProps {
  preview: Record<string, unknown>[];
  columnNames?: string[];
}

export function TableMiniPreview({ preview, columnNames }: TableMiniPreviewProps) {
  if (!preview || preview.length === 0) return null;
  const cols = columnNames || Object.keys(preview[0] || {});
  const displayCols = cols.slice(0, 4);

  return (
    <div className="table-preview">
      <table className="table-preview-table">
        <thead>
          <tr>{displayCols.map(c => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {preview.slice(0, 3).map((row, i) => (
            <tr key={i}>{displayCols.map(c => <td key={c}>{String(row[c] ?? '')}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {cols.length > 4 && <div className="table-preview-more">+{cols.length - 4} more columns</div>}
    </div>
  );
}
