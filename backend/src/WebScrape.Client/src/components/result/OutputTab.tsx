import { useState } from 'react';
import { JsonViewer } from '@textea/json-viewer';
import type { WireIteration, WireTable } from '../../types/wire';
import TableGridView from './TableGridView';
import SelectedNodePanel from './SelectedNodePanel';
import { toNunjucks } from '../../utils/dotPath';

type Props = {
  iter: WireIteration;
};

export default function OutputTab({ iter }: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedValue, setSelectedValue] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);

  const handleSelect = (path: (string | number)[], value: unknown) => {
    setSelectedPath(path.join('.'));
    setSelectedValue(value);
  };

  const handleCopy = (path: string) => {
    navigator.clipboard.writeText(toNunjucks(path)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  if (!iter.outputs || Object.keys(iter.outputs).length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No data yet</div>
        <div className="empty-state-desc">Run something — your data will appear here.</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-sm">
      <SelectedNodePanel path={selectedPath} value={selectedValue} />

      <div className="card">
        <div className="flex items-center gap-sm" style={{ marginBottom: 'var(--spacing-sm)' }}>
          {copied && <span className="meta-badge">Copied</span>}
        </div>

        {Object.entries(iter.outputs).map(([outputKey, output]) => (
          <div key={outputKey} style={{ marginBottom: 'var(--spacing-md)' }}>
            <div className="run-log-title" style={{ marginBottom: 'var(--spacing-sm)' }}>
              {outputKey}
              <span className="meta-badge" style={{ marginLeft: 6 }}>{output.kind}</span>
            </div>

            {output.kind === 'table' ? (
              <TableGridView
                table={output as WireTable}
                basePath={`outputs.${outputKey}`}
                onCopy={handleCopy}
              />
            ) : (
              <JsonViewer
                value={output}
                displayDataTypes={false}
                quotesOnKeys={false}
                onSelect={handleSelect}
                style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-xs)' }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
