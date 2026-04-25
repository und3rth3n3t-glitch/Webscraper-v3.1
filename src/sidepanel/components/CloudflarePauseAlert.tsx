import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';

export default function CloudflarePauseAlert() {
  const setCloudflarePaused = useUiStore(s => s.setCloudflarePaused);

  const handleResume = async () => {
    try {
      await sendToContent('RESUME_AFTER_CLOUDFLARE');
      setCloudflarePaused(false);
    } catch {
      // content script will auto-detect and resume
    }
  };

  return (
    <div className="detection-banner detection-banner--warning">
      <div className="detection-banner-body">
        <strong>Security check detected</strong>
        <p>The site is showing a Cloudflare challenge. Complete it in the page, then resume.</p>
      </div>
      <button className="btn btn-secondary btn-sm" onClick={handleResume}>
        Resume
      </button>
    </div>
  );
}
