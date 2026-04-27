import { useUiStore } from '../stores/uiStore';
import { sendToContent } from '../utils/messaging';
import { DetectionTrigger } from '../../types/messages';

const TRIGGER_LABEL: Record<string, string> = {
  cookieBanner: 'cookie banners',
  captcha: 'captchas',
  loginWall: 'sign-in prompts',
  customSelector: 'this',
  unconditional: 'this',
};

export default function AwaitActionPauseAlert() {
  const awaitActionPaused = useUiStore(s => s.awaitActionPaused);
  const setAwaitActionPaused = useUiStore(s => s.setAwaitActionPaused);

  if (!awaitActionPaused) return null;

  const { trigger, domain } = awaitActionPaused;
  // Cloudflare cannot be marked as false alarm — its iframe is unambiguous.
  const showSkipButton = !!trigger && !!domain && trigger !== DetectionTrigger.CLOUDFLARE;
  const triggerLabel = trigger ? TRIGGER_LABEL[trigger] ?? 'this' : 'this';

  const sendResume = async (markAsFalseAlarm: boolean) => {
    try {
      await sendToContent('RESUME_AFTER_PAUSE', { markAsFalseAlarm });
    } catch {
      // content script may be torn down; SW interceptor handles drain anyway.
    } finally {
      setAwaitActionPaused(null);
    }
  };

  return (
    <div className="detection-banner detection-banner--warning">
      <div className="detection-banner-body">
        <strong>Paused — action needed</strong>
        <p>{awaitActionPaused.message}</p>
        <p className="detection-banner-hint">Sort everything out in the page (sign in, accept cookies, etc.) — the scraper will wait. Click Continue when you're ready.</p>
      </div>
      <div className="detection-banner-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => sendResume(false)}>
          Continue
        </button>
        {showSkipButton && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => sendResume(true)}
            title={`Stop pausing for ${triggerLabel} on ${domain}`}
          >
            Skip {triggerLabel} on this site
          </button>
        )}
      </div>
    </div>
  );
}
