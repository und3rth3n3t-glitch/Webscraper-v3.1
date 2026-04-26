import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';

export default function AwaitActionPauseAlert() {
  const awaitActionPaused = useUiStore(s => s.awaitActionPaused);
  const setAwaitActionPaused = useUiStore(s => s.setAwaitActionPaused);

  if (!awaitActionPaused) return null;

  const handleResume = async () => {
    try {
      await sendToContent('RESUME_AFTER_CLOUDFLARE');
      setAwaitActionPaused(null);
    } catch {
      // content script may have torn down — clear local state regardless
      setAwaitActionPaused(null);
    }
  };

  return (
    <div className="detection-banner detection-banner--warning">
      <div className="detection-banner-body">
        <strong>Action needed</strong>
        <p>{awaitActionPaused.message}</p>
      </div>
      <button className="btn btn-secondary btn-sm" onClick={handleResume}>
        Continue
      </button>
    </div>
  );
}
