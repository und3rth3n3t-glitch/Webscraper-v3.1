/**
 * SignalR method-name constants. Mirror the backend's
 * `BBWM.WebScraper.Hubs.ScraperHubMethodNames` (C# class). A rename on either
 * side without a matching change here silently breaks the wire protocol.
 */

export const HubServerMethods = {
  RegisterWorker: 'RegisterWorker',
  TaskProgress:   'TaskProgress',
  TaskComplete:   'TaskComplete',
  TaskError:      'TaskError',
  TaskPaused:     'TaskPaused',
} as const;

export const HubClientEvents = {
  ReceiveTask:          'ReceiveTask',
  CancelTask:           'CancelTask',
  ResumeAfterPause:     'ResumeAfterPause',
  // The three below are documented for completeness — emitted by the backend but
  // not currently consumed by the extension. Kept here so a future listener can
  // import them directly instead of resurrecting the raw string.
  BatchProgress:        'BatchProgress',
  ScraperConfigUpdated: 'ScraperConfigUpdated',
  ScraperConfigDeleted: 'ScraperConfigDeleted',
} as const;
