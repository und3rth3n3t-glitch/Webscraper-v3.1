import { useState } from 'react';
import BackButton from './BackButton';
import { useConfigStore } from '../stores/configStore';
import { parseExtraSelectors, formatExtraSelectors } from '../utils/parseExtraSelectors';
import type { AutoDetectConfig } from '../../types/config';

type ToggleKey = 'cloudflare' | 'loginWall' | 'captcha' | 'cookieBanner';

interface ToggleSpec {
  key: ToggleKey;
  label: string;
  hint: string;
}

const TOGGLES: ToggleSpec[] = [
  { key: 'cloudflare',   label: 'Cloudflare challenges', hint: "Pause when Cloudflare 'verify you're human' shows up." },
  { key: 'loginWall',    label: 'Login walls',           hint: 'Pause when a sign-in form appears.' },
  { key: 'captcha',      label: 'Captchas',              hint: 'Pause when reCAPTCHA, hCaptcha, or similar shows up.' },
  { key: 'cookieBanner', label: 'Cookie banners',        hint: 'Pause when a cookie/consent prompt appears.' },
];

export default function DetectionSettings() {
  const { autoDetect, setAutoDetect, setView } = useConfigStore();
  const [extraText, setExtraText] = useState(() => formatExtraSelectors(autoDetect?.extraSelectors));

  // Lazy-init: a missing field reads as default-on (true).
  const isChecked = (key: ToggleKey): boolean => autoDetect?.[key] !== false;

  const toggle = (key: ToggleKey) => {
    const next: AutoDetectConfig = { ...(autoDetect ?? {}), [key]: !isChecked(key) };
    setAutoDetect(next);
  };

  const commitExtras = (text: string): void => {
    const selectors = parseExtraSelectors(text);
    const next: AutoDetectConfig = {
      ...(autoDetect ?? {}),
      extraSelectors: selectors.length > 0 ? selectors : undefined,
    };
    setAutoDetect(next);
  };

  const handleDone = () => {
    commitExtras(extraText);
    setView('STEP_LIST');
  };

  return (
    <div className="view">
      <div className="view-header">
        <BackButton />
        <h2 className="view-title">Detection Settings</h2>
      </div>

      <p className="view-subtitle">
        Auto-pause the scraper when these things appear on the page. The scraper waits for you to handle them, then continues.
      </p>

      {TOGGLES.map((t) => (
        <div key={t.key} className="form-group">
          <label className="form-check">
            <input
              type="checkbox"
              checked={isChecked(t.key)}
              onChange={() => toggle(t.key)}
            />
            {t.label}
          </label>
          <p className="form-hint">{t.hint}</p>
        </div>
      ))}

      <div className="form-group">
        <label className="form-label">Extra things to watch for (advanced)</label>
        <textarea
          className="form-textarea"
          rows={4}
          value={extraText}
          onChange={(e) => setExtraText(e.target.value)}
          onBlur={() => commitExtras(extraText)}
          placeholder="#some-blocker&#10;.paywall"
        />
        <p className="form-hint">
          One CSS selector per line. The scraper pauses if any of them appears on the page.
        </p>
      </div>

      <div className="form-group">
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setView('LEARNED_DETECTION')}
        >
          View learned ignores
        </button>
        <p className="form-hint">
          When you click "Skip on this site" on a pause banner, the trigger is remembered per site. Manage them here.
        </p>
      </div>

      <div className="form-actions">
        <button className="btn btn-primary btn-full" onClick={handleDone}>
          Done
        </button>
      </div>
    </div>
  );
}
