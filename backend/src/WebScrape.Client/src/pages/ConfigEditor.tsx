import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import CodeMirror from '@uiw/react-codemirror';
import { json as cmJson } from '@codemirror/lang-json';
import { useScraperConfig } from '../api/queries';
import { useCreateScraperConfig, useDeleteScraperConfig, useUpdateScraperConfig } from '../api/mutations';
import Modal from '../components/Modal';
import type { CreateScraperConfigDto, DeleteConfigConflictDto } from '../api/types';
import { axiosErrorMessage } from '../utils/errorMessages';

const DEFAULT_CONFIG_JSON = JSON.stringify(
  { name: '', url: '', domain: '', schemaVersion: 3, steps: [] },
  null,
  2,
);

type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function tryParseConfig(raw: string): ParseResult {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Top-level value must be a JSON object.' };
    }
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.steps)) {
      return { ok: false, error: '"steps" must be an array.' };
    }
    return { ok: true, value: parsed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON.' };
  }
}

export default function ConfigEditor() {
  const { id } = useParams<{ id: string }>();
  const isEdit = !!id;
  const nav = useNavigate();

  const { data: existing, isPending: loadingExisting } = useScraperConfig(id);
  const create = useCreateScraperConfig();
  const update = useUpdateScraperConfig();
  const remove = useDeleteScraperConfig();

  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [schemaVersion, setSchemaVersion] = useState(3);
  const [jsonText, setJsonText] = useState(DEFAULT_CONFIG_JSON);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!isEdit || !existing || hydrated) return;
    setName(existing.name);
    setDomain(existing.domain);
    setSchemaVersion(existing.schemaVersion);
    setJsonText(JSON.stringify(existing.configJson, null, 2));
    setHydrated(true);
  }, [isEdit, existing, hydrated]);

  const parseResult = useMemo(() => tryParseConfig(jsonText), [jsonText]);
  const saving = create.isPending || update.isPending;

  const saveError = (() => {
    const e = create.error ?? update.error;
    return e ? axiosErrorMessage(e, 'Could not save this config.') : null;
  })();

  const submit = async () => {
    if (!parseResult.ok) return;
    if (!name.trim() || !domain.trim()) return;
    const body: CreateScraperConfigDto = {
      name: name.trim(),
      domain: domain.trim(),
      configJson: parseResult.value,
      schemaVersion,
    };
    if (isEdit && id) {
      await update.mutateAsync({ id, body });
    } else {
      await create.mutateAsync(body);
    }
    nav('/configs');
  };

  const doDelete = async () => {
    if (!id) return;
    setDeleteError(null);
    try {
      await remove.mutateAsync(id);
      nav('/configs');
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 409) {
        const data = e.response.data as DeleteConfigConflictDto;
        setDeleteError(data.error);
      } else {
        setDeleteError('Could not delete this config. Try again.');
      }
    }
  };

  if (isEdit && loadingExisting) return <div className="loading-state">Loading…</div>;

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <div className="flex items-center gap-sm">
          <Link to="/configs" className="back-btn" aria-label="Back to configs">←</Link>
          <h2 className="view-title">{isEdit ? 'Edit config' : 'New config'}</h2>
        </div>
        <div className="flex gap-sm">
          {isEdit && (
            <button className="btn btn-danger" onClick={() => { setConfirmDelete(true); setDeleteError(null); }}>
              Delete
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => nav('/configs')}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={saving || !parseResult.ok || !name.trim() || !domain.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {saveError && <div className="danger-banner">{saveError}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 'var(--spacing-lg)', alignItems: 'start' }}>
        <div>
          <div className="form-group">
            <label className="form-label" htmlFor="config-name">Name</label>
            <input
              id="config-name"
              className="form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Bing News"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="config-domain">Domain</label>
            <input
              id="config-domain"
              className="form-input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
            />
            <div className="form-hint">The site this config runs on. Used for matching at runtime.</div>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="config-schema">Schema version</label>
            <input
              id="config-schema"
              className="form-input"
              type="number"
              value={schemaVersion}
              onChange={(e) => setSchemaVersion(Number(e.target.value) || 3)}
            />
            <div className="form-hint">Leave at 3 unless you know what you're doing.</div>
          </div>
        </div>

        <div>
          <div className="form-group">
            <label className="form-label">Config JSON</label>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <CodeMirror
                value={jsonText}
                onChange={(v) => setJsonText(v)}
                extensions={[cmJson()]}
                height="520px"
                basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: false }}
              />
            </div>
            {!parseResult.ok && (
              <div className="danger-banner" style={{ marginTop: 'var(--spacing-sm)' }}>
                {parseResult.error}
              </div>
            )}
            {parseResult.ok && (
              <div className="form-hint">Valid JSON · top-level object · steps array present.</div>
            )}
          </div>
        </div>
      </div>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this config?">
        {deleteError && <div className="danger-banner">{deleteError}</div>}
        <div className="modal-body">
          Delete <strong>{name || 'this config'}</strong>? This can't be undone.
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button className="btn btn-danger" onClick={doDelete} disabled={remove.isPending}>
            {remove.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
