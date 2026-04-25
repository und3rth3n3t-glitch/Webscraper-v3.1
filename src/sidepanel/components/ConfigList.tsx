import { useCallback, useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import ConfigListItem from './ConfigListItem';
import EmptyState from './EmptyState';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { getAllConfigs, saveConfig } from '../utils/storage';
import { generateId } from '../utils/uuid';
import { useRunStore } from '../stores/runStore';
import type { ScraperConfig } from '../../types/config';

export default function ConfigList() {
  const { loadConfig, pageDomain } = useConfigStore();
  const { showToast, setActiveTab } = useUiStore();
  const [configs, setConfigs] = useState<ScraperConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const loadConfigs = useCallback(async () => {
    try {
      const all = await getAllConfigs();
      setConfigs(all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    } catch {
      showToast('Failed to load configs.', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  const handleEdit = (config: ScraperConfig) => {
    loadConfig(config);
    setActiveTab('config');
  };

  const handleRun = (config: ScraperConfig) => {
    loadConfig(config);
    useRunStore.getState().launchRun('saved');
  };

  const handleDuplicate = async (config: ScraperConfig) => {
    const now = Date.now();
    const copy: ScraperConfig = {
      ...config,
      id: generateId(),
      name: `${config.name} (copy)`,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await saveConfig(copy);
      await loadConfigs();
      showToast('Config duplicated.', 'success');
    } catch {
      showToast('Failed to duplicate config.', 'error');
    }
  };

  const handleDeleted = (id: string) => {
    setConfigs(prev => prev.filter(c => c.id !== id));
    const { currentConfig, newConfig } = useConfigStore.getState();
    if (currentConfig?.id === id) {
      newConfig();
    }
  };

  if (loading) {
    return <div className="loading-state">Loading configs...</div>;
  }

  if (configs.length === 0) {
    return (
      <EmptyState
        icon={<FolderOpen size={48} />}
        title="No Saved Configs Yet"
        description="Build a scraping flow in the Config tab and save it to see it here."
        action={
          <button className="btn btn-primary" onClick={() => setActiveTab('config')}>
            Go to Config Tab
          </button>
        }
      />
    );
  }

  const visibleConfigs = configs.filter(c => !c.domainLocked || c.domain === pageDomain);
  const filtered = showAll
    ? visibleConfigs.filter(c => !c.domainLocked)
    : visibleConfigs.filter(c => c.domainLocked && c.domain === pageDomain);

  return (
    <div className="view">
      <div className="view-header-row">
        <h2 className="view-title">Saved Configs</h2>
      </div>
      <div className="radio-pill-group">
        <label className={`radio-pill ${!showAll ? 'radio-pill-active' : ''}`}>
          <input
            type="radio"
            name="domain-filter"
            checked={!showAll}
            onChange={() => setShowAll(false)}
          />
          This domain
        </label>
        <label className={`radio-pill ${showAll ? 'radio-pill-active' : ''}`}>
          <input
            type="radio"
            name="domain-filter"
            checked={showAll}
            onChange={() => setShowAll(true)}
          />
          All domains
        </label>
      </div>
      <div className="config-list">
        {filtered.length === 0 ? (
          <p className="text-sm text-light">No configs match this domain.</p>
        ) : (
          filtered.map(config => (
            <ConfigListItem
              key={config.id}
              config={config}
              onEdit={() => handleEdit(config)}
              onRun={() => handleRun(config)}
              onDuplicate={() => handleDuplicate(config)}
              onDeleted={handleDeleted}
            />
          ))
        )}
      </div>
    </div>
  );
}
