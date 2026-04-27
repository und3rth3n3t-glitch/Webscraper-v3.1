import { useEffect, useState } from 'react';
import BackButton from './BackButton';
import {
  getDetectionMemory,
  removeIgnoredTrigger,
  clearDomainMemory,
  type DetectionMemory,
} from '../utils/detectionMemory';
import type { DetectionTrigger } from '../../types/messages';

const TRIGGER_LABEL: Record<string, string> = {
  cookieBanner: 'Cookie banners',
  captcha: 'Captchas',
  loginWall: 'Sign-in prompts',
  customSelector: 'Custom selectors',
  cloudflare: 'Cloudflare',
  unconditional: 'Unconditional',
};

export default function LearnedDetectionView() {
  const [memory, setMemory] = useState<DetectionMemory>({});
  const [loaded, setLoaded] = useState(false);

  const refresh = async () => {
    const m = await getDetectionMemory();
    setMemory(m);
    setLoaded(true);
  };

  useEffect(() => { refresh(); }, []);

  const domains = Object.keys(memory).sort();

  const handleRemove = async (domain: string, trigger: DetectionTrigger) => {
    await removeIgnoredTrigger(domain, trigger);
    await refresh();
  };

  const handleClearDomain = async (domain: string) => {
    await clearDomainMemory(domain);
    await refresh();
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Learned ignores</h2>
      </div>

      <p className="view-subtitle">
        Sites where you told the scraper to stop pausing for a particular thing. Remove an entry and the scraper will pause for it again next time.
      </p>

      {loaded && domains.length === 0 && (
        <p className="form-hint">Nothing learned yet. When the scraper pauses on a false alarm, click "Skip on this site" to add an entry here.</p>
      )}

      {domains.map((domain) => (
        <div key={domain} className="learned-detection-domain">
          <div className="learned-detection-header">
            <strong>{domain}</strong>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => handleClearDomain(domain)}
            >
              Clear all
            </button>
          </div>
          <ul className="learned-detection-list">
            {memory[domain].ignoredTriggers.map((t) => (
              <li key={t} className="learned-detection-item">
                <span>{TRIGGER_LABEL[t] ?? t}</span>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleRemove(domain, t)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
