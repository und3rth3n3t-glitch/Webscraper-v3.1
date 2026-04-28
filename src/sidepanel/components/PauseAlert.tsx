import { useQueueStore } from '../stores/queueStore';
import { sendToContent } from '../utils/messaging';
import { DetectionTrigger } from '../../types/messages';
import type { QueueTask } from '../../types/signalr';

const TRIGGER_LABEL: Record<string, string> = {
  cookieBanner: 'cookie banners',
  captcha: 'captchas',
  loginWall: 'sign-in prompts',
  customSelector: 'this',
  unconditional: 'this',
};

interface PauseAlertProps {
  task: QueueTask;
}

export default function PauseAlert({ task }: PauseAlertProps): JSX.Element | null {
  const resumeTask = useQueueStore((s) => s.resumeTask);
  const info = task.pause;
  if (!info) return null;

  const isCloudflare = info.reason === 'cloudflare';
  const trigger = info.trigger;
  const domain = info.domain;
  const showSkipButton = !isCloudflare && !!trigger && !!domain && trigger !== DetectionTrigger.CLOUDFLARE;
  const triggerLabel = trigger ? TRIGGER_LABEL[trigger] ?? 'this' : 'this';

  const sendResume = (markAsFalseAlarm: boolean): void => {
    // sendToContent emits the message into the runtime — the SW's
    // RESUME_AFTER_PAUSE interceptor (background.ts) routes per-task
    // when payload.taskId is present, falls back to active tab otherwise.
    sendToContent('RESUME_AFTER_PAUSE', { taskId: task.id, markAsFalseAlarm })
      .catch(() => { /* SW interceptor still drains continuations */ });
    resumeTask(task.id);
  };

  const title = isCloudflare ? 'Paused — security check' : 'Paused — action needed';
  const body = isCloudflare
    ? 'The site is showing a Cloudflare challenge. Complete it in the page (the scraper will wait) and click Continue when you’re through.'
    : (info.message ?? 'Action needed in your browser.');
  const hint = isCloudflare
    ? null
    : 'Sort everything out in the page (sign in, accept cookies, etc.) — the scraper will wait. Click Continue when you’re ready.';

  return (
    <div className="detection-banner detection-banner--warning">
      <div className="detection-banner-body">
        <strong>{task.configName}: {title}</strong>
        <p>{body}</p>
        {hint && <p className="detection-banner-hint">{hint}</p>}
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
