import { useState } from 'react';
import { Play } from 'lucide-react';
import BackButton from './BackButton';
import { useRunStore } from '../stores/runStore';
import { useUiStore } from '../stores/uiStore';

export default function SearchVarInput() {
  const { showToast } = useUiStore();
  const [termsText, setTermsText] = useState('');
  const [starting, setStarting] = useState(false);

  const terms = termsText.split('\n').map(t => t.trim()).filter(Boolean);

  const handleStart = async () => {
    if (terms.length === 0) {
      showToast('Enter at least one search term.', 'error');
      return;
    }
    setStarting(true);
    try {
      await useRunStore.getState().executeRun(terms);
    } catch {
      setStarting(false);
    }
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Search Terms</h2>
      </div>

      <p className="view-subtitle">
        Enter one search term per line. The scraper will run once for each term.
      </p>

      <div className="form-group">
        <label className="form-label">Search terms</label>
        <textarea
          className="form-textarea"
          value={termsText}
          onChange={e => setTermsText(e.target.value)}
          placeholder={"Blueberry Consultants\nAcme Corp\nTechStart Ltd"}
          rows={8}
          autoFocus
        />
        {terms.length > 0 && (
          <p className="form-hint">{terms.length} term{terms.length !== 1 ? 's' : ''} entered</p>
        )}
      </div>

      <div className="form-actions">
        <button
          className="btn btn-primary btn-full btn-lg"
          onClick={handleStart}
          disabled={starting || terms.length === 0}
        >
          {starting
            ? 'Starting...'
            : <><Play size={12} /> Run Scraper ({terms.length} term{terms.length !== 1 ? 's' : ''})</>
          }
        </button>
      </div>
    </div>
  );
}
