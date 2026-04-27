import { useState } from 'react';
import { toNunjucks } from '../../utils/dotPath';

type Props = {
  path: string | null;
  value: unknown;
};

export default function SelectedNodePanel({ path, value }: Props) {
  const [copied, setCopied] = useState<'path' | 'template' | null>(null);

  const copy = (text: string, which: 'path' | 'template') => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(null), 1200);
    });
  };

  if (!path) {
    return (
      <div className="card" style={{ marginBottom: 'var(--spacing-sm)' }}>
        <div className="empty-state" style={{ minHeight: 60 }}>
          <div className="empty-state-desc">Click any value to see its path and copy a reference.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 'var(--spacing-sm)' }}>
      <div className="flex flex-col gap-sm">
        <div>
          <div className="form-label" style={{ marginBottom: 2 }}>Path</div>
          <pre className="json-preview" style={{ maxHeight: 60, padding: 'var(--spacing-xs) var(--spacing-sm)' }}>
            {path}
          </pre>
        </div>
        <div>
          <div className="form-label" style={{ marginBottom: 2 }}>Value</div>
          <pre className="json-preview" style={{ maxHeight: 80, padding: 'var(--spacing-xs) var(--spacing-sm)' }}>
            {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '')}
          </pre>
        </div>
        <div className="flex gap-sm">
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => copy(path, 'path')}
          >
            {copied === 'path' ? 'Copied' : 'Copy path'}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            title="Copies a Nunjucks template expression you can paste into the wider platform."
            onClick={() => copy(toNunjucks(path), 'template')}
          >
            {copied === 'template' ? 'Copied' : 'Copy as template'}
          </button>
        </div>
      </div>
    </div>
  );
}
