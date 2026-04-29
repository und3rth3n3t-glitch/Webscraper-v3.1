import { useQueueStore } from '../stores/queueStore';
import { sendToContent } from '../utils/messaging';
import { derivePauseCopy } from '../../common/pauseCopy';
import type { QueueTask } from '../../types/signalr';

interface PauseAlertProps {
  task: QueueTask;
}

export default function PauseAlert({ task }: PauseAlertProps): JSX.Element | null {
  const resumeTask = useQueueStore((s) => s.resumeTask);
  const info = task.pause;
  if (!info) return null;

  const copy = derivePauseCopy(info);

  const sendResume = (markAsFalseAlarm: boolean): void => {
    sendToContent('RESUME_AFTER_PAUSE', { taskId: task.id, markAsFalseAlarm })
      .catch(() => { /* SW interceptor still drains continuations */ });
    resumeTask(task.id);
  };

  return (
    <div className="detection-banner detection-banner--warning">
      <div className="detection-banner-body">
        <strong>{task.configName}: {copy.title}</strong>
        <p>{copy.body}</p>
        {copy.hint && <p className="detection-banner-hint">{copy.hint}</p>}
      </div>
      <div className="detection-banner-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => sendResume(false)}>
          Continue
        </button>
        {copy.showSkipButton && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => sendResume(true)}
            title={`Stop pausing for ${copy.triggerLabel} on ${copy.sanitizedDomain}`}
          >
            Skip {copy.triggerLabel} on this site
          </button>
        )}
      </div>
    </div>
  );
}
