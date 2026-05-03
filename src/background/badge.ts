export type BadgeManager = {
  /** Mark this task as paused — adds to the set and refreshes the badge. */
  markPaused(taskId: string): void;
  /** Unpause this task — removes from the set and refreshes the badge. */
  markUnpaused(taskId: string): void;
};

export function createBadgeManager(): BadgeManager {
  const pausedTaskIds = new Set<string>();

  function refresh(): void {
    if (pausedTaskIds.size > 0) {
      chrome.action.setBadgeText({ text: '!' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ color: '#F57F17' }).catch(() => {});
    } else {
      chrome.action.setBadgeText({ text: '' }).catch(() => {});
    }
  }

  function markPaused(taskId: string): void {
    pausedTaskIds.add(taskId);
    refresh();
  }

  function markUnpaused(taskId: string): void {
    pausedTaskIds.delete(taskId);
    refresh();
  }

  return { markPaused, markUnpaused };
}
