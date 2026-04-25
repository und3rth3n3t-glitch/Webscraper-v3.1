import { useEffect, useState } from 'react';
import { getStorageUsage } from '../utils/storage';

interface UsageInfo {
  used: number;
  quota: number;
  pct: number;
}

export default function StorageFooter() {
  const [usage, setUsage] = useState<UsageInfo | null>(null);

  useEffect(() => {
    getStorageUsage().then((u) => setUsage(u as UsageInfo));
    const interval = setInterval(() => getStorageUsage().then((u) => setUsage(u as UsageInfo)), 30000);
    return () => clearInterval(interval);
  }, []);

  if (!usage) return null;

  const fillClass = usage.pct > 85 ? 'danger' : usage.pct > 65 ? 'warning' : '';
  const usedMB = (usage.used / 1048576).toFixed(1);
  const quotaMB = (usage.quota / 1048576).toFixed(0);

  return (
    <div className="storage-footer">
      <div className="footer-branding">
        <span className="footer-accent-line" />
        <span className="footer-branding-text">Web Scraper</span>
        <span className="footer-accent-line" />
      </div>
      <div className="storage-bar">
        <div className={`storage-bar-fill ${fillClass}`} style={{ width: `${Math.min(usage.pct, 100)}%` }} />
      </div>
      <span className="storage-text">Storage: {usedMB} MB / {quotaMB} MB</span>
    </div>
  );
}
