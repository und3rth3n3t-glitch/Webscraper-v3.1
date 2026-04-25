import { useEffect, useState } from 'react';
import { useConfigStore } from '../stores/configStore';
import { useUiStore } from '../stores/uiStore';
import { getConfigsByDomain } from '../utils/storage';

export default function DomainBadge() {
  const pageDomain = useConfigStore((s) => s.pageDomain);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const [configCount, setConfigCount] = useState(0);

  useEffect(() => {
    if (pageDomain) {
      getConfigsByDomain(pageDomain).then((configs) => setConfigCount(configs.length));
    } else {
      setConfigCount(0);
    }
  }, [pageDomain]);

  if (!pageDomain) return null;

  return (
    <div className="domain-badge-bar" onClick={() => setActiveTab('saved')} title="View configs for this domain">
      <span className="domain-badge">{pageDomain}</span>
      {configCount > 0 && (
        <span className="text-xs text-light">
          {configCount} config{configCount !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}
