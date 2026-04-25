import { useState, useEffect } from 'react';
import { getPrefs, setPref } from '../utils/storage';

export default function WelcomeSheet() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    getPrefs().then((prefs) => {
      if (!prefs.hasSeenWelcome) setShow(true);
    });
  }, []);

  async function dismiss() {
    await setPref('hasSeenWelcome', true);
    setShow(false);
  }

  if (!show) return null;

  return (
    <div className="welcome-overlay" role="dialog" aria-modal="true" onClick={dismiss}>
      <div className="welcome-sheet" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: 'var(--purple-primary)', marginBottom: '4px' }}>
          Welcome to Blueberry Scraper
        </h2>
        <p style={{ fontSize: '13px', color: 'var(--text-light)', lineHeight: 1.5 }}>
          Build automated scraping flows in 3 simple steps:
        </p>
        <div className="welcome-steps">
          <div className="welcome-step">
            <span className="welcome-step-num">1</span>
            <span className="welcome-step-text">
              <strong>Add steps</strong> to define what the scraper should do — type search terms, click buttons, and extract data.
            </span>
          </div>
          <div className="welcome-step">
            <span className="welcome-step-num">2</span>
            <span className="welcome-step-text">
              <strong>Save your config</strong> to reuse it later on this website.
            </span>
          </div>
          <div className="welcome-step">
            <span className="welcome-step-num">3</span>
            <span className="welcome-step-text">
              <strong>Run it</strong> with your search terms and download the results as JSON.
            </span>
          </div>
        </div>
        <button className="btn btn-primary btn-full btn-lg" onClick={dismiss}>
          Get Started
        </button>
      </div>
    </div>
  );
}
