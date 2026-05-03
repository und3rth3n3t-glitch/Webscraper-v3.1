import { dbg, ensureDebugInit } from '../utils/debugLog';
import type { QueueTask } from '../types/signalr';
import { PREFS_KEY, getAllConfigs } from '../sidepanel/utils/storage';
import { Scheduler, type PersistedActiveRecord } from '../background/scheduler';
import { originOf } from '../background/originOf';
import {
  attachIfNeeded as cdpAttach,
  dispatchClick as cdpDispatchClick,
  dispatchMouseMove as cdpDispatchMouseMove,
  dispatchType as cdpDispatchType,
  dispatchPressKey as cdpDispatchPressKey,
  isCdpEnabled,
  initCdpModule,
} from '../background/cdpInput';
import {
  isTaskNotification,
  isBatchNotification,
  taskIdFromNotificationId,
  taskNotificationId,
} from '../background/notifications';
import { createOffscreenManager, type SignalRConfig } from '../background/offscreen';
import { createBadgeManager } from '../background/badge';
import { createSessionPersistence } from '../background/sessionPersistence';
import { createPauseStateManager } from '../background/pauseState';
import { createRemoteTaskRunner, type RemoteTaskRunner } from '../background/remoteTaskRunner';

export default defineBackground(() => {
  ensureDebugInit();
  // Hydrates `useRealInput` pref + checks current debugger permission;
  // listens for permission revoke + chrome.debugger.onDetach.
  initCdpModule();
  console.warn('[SW] ✦ background loaded | version:', __APP_VERSION__, '| built:', __BUILD_TIME__);
  const frameRegistry = new Map<number, Map<number, { url: string; isTop: boolean }>>();
  const pendingContinuations = new Map<number, unknown>();
  let lastFocusedTabId: number | null = null;

  // Note: offscreen manager closes over a getter for signalrConfig so it always
  // reads the latest value (signalrConfig is mutated when INIT_SIGNALR arrives
  // from the sidepanel). A snapshot would go stale across SW lifetime.
  const offscreen = createOffscreenManager({ getSignalrConfig: () => signalrConfig });
  const badge = createBadgeManager();
  const pauseState = createPauseStateManager();

  // ── Remote queue state ──
  //
  // Scheduler owns the per-task records (active Map, pending queue, recent
  // history, single-flight `starting` gate). The remote-task runner owns the
  // start/drain/flow-event lifecycle. `pauseState` is the singleton "is the
  // active task paused?" mirror — read here in the message router (for the
  // GET_PAUSE_STATE handshake and the continuation-hold check in
  // tabs.onUpdated) and inside the runner. PR4 will move pause state per-task.

  // Late binding: `runner` is constructed below (after scheduler + persistence,
  // because the runner depends on both). The Scheduler's startTask callback
  // captures the binding lazily — by the time a task is actually dispatched,
  // `runner` has been populated. Cast via `null!` is the simplest escape from
  // TS's strict-init complaint without loosening the file-wide tsconfig.
  let runner: RemoteTaskRunner = null!;

  const scheduler = new Scheduler({
    startTask: (task) => {
      // runner.start handles its own resolver/window-create failures via
      // scheduler.recordStartFailed. The .catch here is a backstop for
      // unforeseen rejections from chrome APIs that escape those handlers —
      // matches HEAD's defensive logging pattern.
      runner.start(task).catch((err) => console.error('[SW] runner.start failed:', err));
    },
    broadcastResumeForDrain: (records) => {
      for (const r of records) {
        console.warn('[SW] RESUME_FOR_DRAIN | taskId:', r.task.id, '| tabId:', r.tabId, '| origin:', r.origin);
        chrome.tabs.sendMessage(r.tabId, {
          type: 'RESUME_FOR_DRAIN',
          payload: { taskId: r.task.id },
        }).catch((err: Error) => {
          console.error('[SW] RESUME_FOR_DRAIN send failed | taskId:', r.task.id, '| err:', err.message);
        });
      }
    },
  });

  const persistence = createSessionPersistence({ scheduler });

  let signalrConfig: SignalRConfig | null = null;

  // PR6 — notification toggles. Hydrated from chrome.storage.local on SW
  // start; updated via SET_BATCH_SETTINGS messages from sidepanel.
  let notifyOnPause = true;
  let notifyOnBatchComplete = true;

  runner = createRemoteTaskRunner({
    scheduler,
    offscreen,
    badge,
    persistence,
    pauseState,
    getNotifyOnPause: () => notifyOnPause,
    getNotifyOnBatchComplete: () => notifyOnBatchComplete,
    setLastFocusedTabId: (id) => { lastFocusedTabId = id; },
    isDebugMode,
  });

  // Badge "!" while any task is paused. Cleared when the last paused task
  // resumes or completes. Badge background uses the warning token from
  // index.css (--warning #F57F17) so the chip is visually consistent.

  // Restore state from session storage on SW restart (state is lost when SW is killed by Chrome).
  chrome.storage.session.get(['signalrConfig', 'activeRemoteTasks', 'recentRemoteTasks']).then((data: Record<string, unknown>) => {
    if (data.signalrConfig) signalrConfig = data.signalrConfig as SignalRConfig;
    if (Array.isArray(data.activeRemoteTasks)) {
      scheduler.restoreActive(data.activeRemoteTasks as PersistedActiveRecord[]);
    }
    if (Array.isArray(data.recentRemoteTasks)) {
      scheduler.setRecent(data.recentRemoteTasks as QueueTask[]);
    }
  }).catch(() => {});

  // PR6 — hydrate notification toggles from chrome.storage.local. Defaults
  // (true/true) apply if storage is empty.
  chrome.storage.local.get(['notifyOnPause', 'notifyOnBatchComplete']).then((data: Record<string, unknown>) => {
    if (typeof data.notifyOnPause === 'boolean') notifyOnPause = data.notifyOnPause;
    if (typeof data.notifyOnBatchComplete === 'boolean') notifyOnBatchComplete = data.notifyOnBatchComplete;
  }).catch(() => {});

  // One-shot cleanup of the pre-PR2 singular key. chrome.storage.session is
  // wiped on browser restart, so this only matters for an in-place extension
  // reload during the upgrade window. Safe to remove this line in PR3+.
  chrome.storage.session.remove('activeRemoteTask').catch(() => {});

  // Debug-mode flag (mirrors the toggle read by scrapingEngine.ts). Read
  // fresh at decision time inside runner.drainNext — caching it at SW
  // startup races with FLOW_COMPLETE on a freshly woken SW.
  async function isDebugMode(): Promise<boolean> {
    try {
      const result = await chrome.storage.local.get(PREFS_KEY);
      const prefs = (result[PREFS_KEY] as Record<string, unknown> | undefined) || {};
      return !!prefs.debug;
    } catch {
      return false;
    }
  }

  // ── Install: inject content scripts into existing tabs ──

  browser.runtime.onInstalled.addListener(async () => {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url?.startsWith('http') || !tab.id) continue;
      try {
        await browser.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content-scripts/content.js'],
        });
      } catch { /* tab may not be scriptable */ }
    }
  });

  // ── Side panel: open on action click (Chrome-only) ──

  browser.action.onClicked.addListener(async (tab) => {
    if (!tab.id) return;
    try {
      await (chrome.sidePanel as { open: (opts: { tabId: number }) => Promise<void> }).open({ tabId: tab.id });
    } catch (err) {
      console.error('[SW] Failed to open side panel:', err);
    }
  });

  // ── Track focused tab ──

  browser.tabs.onActivated.addListener(({ tabId }: { tabId: number }) => {
    lastFocusedTabId = tabId;
  });

  // ── Message routing ──

  // Direct-match handler signature. Handlers that complete synchronously
  // return void; handlers using sendResponse asynchronously return true to
  // keep the message channel open (Chrome runtime contract).
  type MessageHandler = (
    message: Record<string, unknown>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => boolean | void;

  // One entry per direct-match message type. Each entry is the original
  // handler body verbatim — only the `if (type === 'X') { ... return; }`
  // boilerplate is gone. Closures capture offscreen/badge/pauseState/runner/
  // scheduler/persistence/frameRegistry/pendingContinuations/notifyOnPause/
  // notifyOnBatchComplete by binding, so let-mutations (notifyOnPause etc)
  // are observed live. Declared here (just before addListener) so all factory
  // constructions above have completed by the time the map is built.
  //
  // RESUME_AFTER_PAUSE is intentionally NOT in this map — see the explicit
  // if-block below for the fallthrough contract.
  const directHandlers: Record<string, MessageHandler> = {
    OFFSCREEN_READY: () => {
      offscreen.markReady();
    },

    __SW_LOG__: (message) => {
      console.warn('[page]', message.payload);
    },

    REGISTER_CONTINUATION: (message, sender) => {
      const tabId = sender.tab?.id;
      if (tabId) {
        const p = message.payload as Record<string, unknown>;
        console.warn('[SW] REGISTER_CONTINUATION tabId:', tabId, '| startTermIndex:', p.startTermIndex, '| startLoopStepIndex:', p.startLoopStepIndex, '| searchTerms:', p.searchTerms);
        pendingContinuations.set(tabId, message.payload);
      }
    },

    CANCEL_CONTINUATION: (message, sender) => {
      const tabId = sender.tab?.id;
      if (tabId) {
        const had = pendingContinuations.has(tabId);
        pendingContinuations.delete(tabId);
        console.warn('[SW] CANCEL_CONTINUATION | tabId:', tabId, '| hadEntry:', had);
      } else {
        console.warn('[SW] CANCEL_CONTINUATION received with no sender.tab.id');
      }
    },

    // Fetch Flourish data (needs SW fetch origin).
    FETCH_FLOURISH_DATA: (message, _sender, sendResponse) => {
      const payload = message.payload as { visualizationId?: string } | undefined;
      const vizId = payload?.visualizationId;
      if (!vizId || !/^\d+$/.test(vizId)) {
        sendResponse({ error: 'Invalid visualization ID' });
        return true;
      }
      fetch(`https://public.flourish.studio/visualisation/${vizId}/visualisation.json`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data) => sendResponse({ data }))
        .catch((err: Error) => sendResponse({ error: err.message }));
      return true;
    },

    // Sidepanel: SW-routed authenticated login.
    //
    // Runs in the service worker so credentials:'include' lands the host's
    // session cookie in Chrome's main cookie jar. That jar is shared across
    // all extension contexts (sidepanel, SW, offscreen) — subsequent
    // API_FETCH calls and the offscreen SignalR connection inherit it
    // without needing a bearer token. SHA-512 pre-hash matches what the
    // BBWT3 SPA sends to /api/account/login.
    AUTH_LOGIN: (message, _sender, sendResponse) => {
      const p = (message.payload ?? {}) as { serverUrl: string; email: string; password: string };
      (async () => {
        try {
          const pwBytes = new TextEncoder().encode(p.password);
          const pwHash = await crypto.subtle.digest('SHA-512', pwBytes);
          const pwHex = Array.from(new Uint8Array(pwHash))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');

          const res = await fetch(`${p.serverUrl}/api/account/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ email: p.email, password: pwHex }),
          });

          if (!res.ok) {
            const code = res.status === 401 ? 'invalid_credentials' : 'login_failed';
            sendResponse({ ok: false, error: code, status: res.status });
            return;
          }
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: 'network_error', message: (err as Error).message });
        }
      })();
      return true;
    },

    // Sidepanel: SW-routed authenticated API fetch.
    //
    // Generic wrapper used by the sidepanel for any host API call that needs
    // the session cookie. The cookie auto-attaches via credentials:'include'
    // because the SW (and Chrome's cookie jar) already holds it from
    // AUTH_LOGIN — no manual cookie forwarding needed.
    API_FETCH: (message, _sender, sendResponse) => {
      const p = (message.payload ?? {}) as {
        serverUrl: string;
        path: string;
        options?: RequestInit;
      };
      (async () => {
        try {
          // BBWT3 enables AutoValidateAntiforgeryTokenAttribute globally, so
          // non-GET requests need the XSRF-TOKEN cookie value mirrored as the
          // X-XSRF-TOKEN header. Mirrors what the host SPA's HttpClient
          // interceptor does. GET requests are not antiforgery-protected.
          const method = (p.options?.method ?? 'GET').toUpperCase();
          const xsrfHeader: Record<string, string> = {};
          if (method !== 'GET' && method !== 'HEAD') {
            try {
              const cookie = await chrome.cookies.get({ url: p.serverUrl, name: 'XSRF-TOKEN' });
              if (cookie?.value) xsrfHeader['X-XSRF-TOKEN'] = decodeURIComponent(cookie.value);
            } catch { /* best effort — backend will 400 if missing and required */ }
          }
          const res = await fetch(`${p.serverUrl}${p.path}`, {
            ...p.options,
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              ...xsrfHeader,
              ...(p.options?.headers ?? {}),
            },
          });
          if (!res.ok) {
            sendResponse({ ok: false, error: `Request failed: ${res.status}`, status: res.status });
            return;
          }
          // Some endpoints (e.g. logout) return no body. Try JSON first,
          // fall back to null.
          const text = await res.text();
          const data = text ? JSON.parse(text) : null;
          sendResponse({ ok: true, data });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
      })();
      return true;
    },

    // Frame registration.
    FRAME_REGISTER: (_message, sender) => {
      const cs = sender;
      const tabId = cs.tab?.id;
      if (!tabId) return;
      if (!frameRegistry.has(tabId)) frameRegistry.set(tabId, new Map());
      frameRegistry.get(tabId)!.set(cs.frameId ?? 0, {
        url: cs.url ?? '',
        isTop: (cs.frameId ?? 0) === 0,
      });
    },

    SET_BATCH_SETTINGS: (message) => {
      const p = (message.payload ?? {}) as {
        drainParallelCap?: number;
        preflightQuietMs?: number;
        notifyOnPause?: boolean;
        notifyOnBatchComplete?: boolean;
      };
      if (typeof p.drainParallelCap === 'number') {
        scheduler.setDrainParallelCap(p.drainParallelCap);
        console.warn('[SW] batch settings | drainParallelCap:', p.drainParallelCap);
      }
      if (typeof p.preflightQuietMs === 'number') {
        chrome.storage.local.set({ batchPreflightQuietMs: p.preflightQuietMs }).catch(() => {});
      }
      if (typeof p.notifyOnPause === 'boolean') {
        notifyOnPause = p.notifyOnPause;
        chrome.storage.local.set({ notifyOnPause }).catch(() => {});
        console.warn('[SW] batch settings | notifyOnPause:', notifyOnPause);
      }
      if (typeof p.notifyOnBatchComplete === 'boolean') {
        notifyOnBatchComplete = p.notifyOnBatchComplete;
        chrome.storage.local.set({ notifyOnBatchComplete }).catch(() => {});
        console.warn('[SW] batch settings | notifyOnBatchComplete:', notifyOnBatchComplete);
      }
    },

    // Inbound queue task: start or queue it.
    TASK_RECEIVED: (message) => {
      const task = message.payload as QueueTask;
      // Resolve origin async so the same-origin gate has data to work with
      // during drain. Tasks without a resolvable URL get null origin and
      // are treated as ungated.
      void (async () => {
        let origin: string | null = null;
        try {
          if (task.inlineConfig?.url) {
            origin = originOf(task.inlineConfig.url);
          } else {
            const localConfigs = await getAllConfigs();
            const cfg = localConfigs.find((c) => c.id === task.configId);
            if (cfg?.url) origin = originOf(cfg.url);
          }
        } catch {
          // resolution failure → null origin, no gate
        }
        scheduler.enqueueTask(task, origin);
      })();
    },

    CDP_CLICK: (message, sender, sendResponse) => {
      const p = (message.payload ?? {}) as { tabId?: number; x: number; y: number };
      const tabId = p.tabId ?? sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, reason: 'no-tabId' });
        return true;
      }
      cdpDispatchClick(tabId, p.x, p.y)
        .then((ok) => sendResponse({ ok }))
        .catch((err: Error) => sendResponse({ ok: false, reason: err.message }));
      return true;
    },

    CDP_MOUSE_MOVE: (message, sender, sendResponse) => {
      const p = (message.payload ?? {}) as { tabId?: number; x: number; y: number };
      const tabId = p.tabId ?? sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, reason: 'no-tabId' });
        return true;
      }
      cdpDispatchMouseMove(tabId, p.x, p.y)
        .then((ok) => sendResponse({ ok }))
        .catch((err: Error) => sendResponse({ ok: false, reason: err.message }));
      return true;
    },

    CDP_TYPE: (message, sender, sendResponse) => {
      const p = (message.payload ?? {}) as { tabId?: number; text: string };
      const tabId = p.tabId ?? sender.tab?.id;
      if (!tabId || !p.text) {
        sendResponse({ ok: false, reason: 'invalid-args' });
        return true;
      }
      cdpDispatchType(tabId, p.text)
        .then((ok) => sendResponse({ ok }))
        .catch((err: Error) => sendResponse({ ok: false, reason: err.message }));
      return true;
    },

    CDP_PRESS_KEY: (message, sender, sendResponse) => {
      const p = (message.payload ?? {}) as { tabId?: number; key: string };
      const tabId = p.tabId ?? sender.tab?.id;
      if (!tabId || !p.key) {
        sendResponse({ ok: false, reason: 'invalid-args' });
        return true;
      }
      cdpDispatchPressKey(tabId, p.key)
        .then((ok) => sendResponse({ ok }))
        .catch((err: Error) => sendResponse({ ok: false, reason: err.message }));
      return true;
    },

    // Server-initiated task control (handled directly — no sidepanel required).
    RESUME_TASK: (message) => {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      const target = taskId ? scheduler.getActiveTask(taskId) : scheduler.getFirstActive();
      if (target) {
        browser.tabs.sendMessage(target.tabId, { type: 'RESUME_AFTER_PAUSE' })
          .catch((err) => console.error('[SW] RESUME_AFTER_PAUSE failed:', err));
        pauseState.clear();
        badge.markUnpaused(target.task.id);
        chrome.notifications.clear(taskNotificationId(target.task.id)).catch(() => {});
        chrome.runtime.sendMessage({ type: 'TASK_RESUMED', payload: { taskId: target.task.id } }).catch(() => {});
      }
    },

    CANCEL_TASK: (message) => {
      const { taskId } = (message.payload ?? {}) as { taskId?: string };
      const target = taskId ? scheduler.getActiveTask(taskId) : scheduler.getFirstActive();
      if (target) {
        browser.tabs.sendMessage(target.tabId, { type: 'ABORT_FLOW' })
          .catch((err) => console.error('[SW] ABORT_FLOW failed:', err));
      } else if (taskId) {
        // May still be in pending — drop it without starting.
        scheduler.cancelPending(taskId);
      }
    },

    GET_PAUSE_STATE: (_message, _sender, sendResponse) => {
      // Property name `pauseState` shadows the local variable in the value
      // position — JS-legal, just looks like a self-reference.
      sendResponse({ pauseState: pauseState.get() });
    },

    GET_QUEUE_SNAPSHOT: (_message, _sender, sendResponse) => {
      sendResponse({
        active: runner.snapshotActive(),
        pending: [...scheduler.getPendingTasks()],
        recent: [...scheduler.getRecent()],
      });
      return true;
    },
  };

  browser.runtime.onMessage.addListener((
    rawMessage: unknown,
    rawSender: unknown,
    sendResponse: (r: unknown) => void,
  ) => {
    const message = rawMessage as Record<string, unknown>;
    const sender = rawSender as chrome.runtime.MessageSender;
    const type = message.type as string;

    // RESUME_AFTER_PAUSE intentionally falls through to the sidepanelToContent
    // routing block below: its handler does pre-relay work (clear pause state,
    // drain held continuations, route to the specific task tab when one
    // matches), and then returns control so the standard active-tab routing
    // can deliver the message to whatever live content script is listening.
    // Kept outside the directHandlers map because that map's contract is
    // "handler runs, dispatch ends" — RESUME_AFTER_PAUSE is the one type that
    // breaks that contract.
    if (type === 'RESUME_AFTER_PAUSE') {
      const ps = pauseState.get();
      const wasPaused = ps !== null;
      const resumePayload = (message.payload ?? {}) as { taskId?: string; markAsFalseAlarm?: boolean };

      // Capture false-alarm signal BEFORE clearing pauseState.
      // Cloudflare cannot be marked as false alarm (UI doesn't expose the button).
      if (
        resumePayload.markAsFalseAlarm
        && ps?.reason === 'awaitUserAction'
        && ps?.trigger
        && ps?.domain
      ) {
        const { domain, trigger } = ps;
        // Async fire-and-forget; don't block the resume on storage write.
        import('../sidepanel/utils/detectionMemory').then(({ addIgnoredTrigger }) => {
          addIgnoredTrigger(domain, trigger).catch((err) => {
            console.error('[SW] addIgnoredTrigger failed:', err);
          });
          console.warn('[SW] markAsFalseAlarm recorded | domain:', domain, '| trigger:', trigger);
        });
      }

      pauseState.clear();
      // Clear pause UI signals: drop this taskId from the paused set, refresh
      // badge (clears if no other pauses), and clear any pending notification
      // for this task. Safe to call when no notification was fired — clear()
      // is idempotent.
      if (resumePayload.taskId) {
        badge.markUnpaused(resumePayload.taskId);
        chrome.notifications.clear(taskNotificationId(resumePayload.taskId)).catch(() => {});
        // Notify the sidepanel so it clears the ribbon regardless of which
        // surface (in-page banner or sidepanel button) triggered the resume.
        chrome.runtime.sendMessage({ type: 'TASK_RESUMED', payload: { taskId: resumePayload.taskId } }).catch(() => {});
      }
      console.warn('[SW] sidepanel resume | type:', type, '| taskId:', resumePayload.taskId, '| wasPaused:', wasPaused, '| markAsFalseAlarm:', resumePayload.markAsFalseAlarm);

      // PR5 — per-task routing. If a taskId is present, route to that task's
      // tab directly (bypasses active-tab assumption, supports multiple
      // simultaneously paused tasks). Falls through to active-tab routing
      // when taskId is absent (sidepanel-mode runs without a queue task).
      if (resumePayload.taskId) {
        const target = scheduler.getActiveTask(resumePayload.taskId);
        if (target) {
          browser.tabs.sendMessage(target.tabId, {
            type: 'RESUME_AFTER_PAUSE',
            payload: resumePayload,
          }).catch((err: Error) => console.warn('[SW] per-task resume sendMessage failed:', err.message));

          cdpAttach(target.tabId).catch(() => { /* best effort */ });

          // Drain any held continuation for that specific tab (pause-driven nav).
          const continuation = pendingContinuations.get(target.tabId);
          if (continuation) {
            pendingContinuations.delete(target.tabId);
            console.warn('[SW] resume — draining held continuation | tabId:', target.tabId);
            setTimeout(() => {
              const enriched = {
                ...(continuation as Record<string, unknown>),
                drainResumed: scheduler.findByTabId(target.tabId)?.drainResumed ?? false,
              };
              browser.tabs.sendMessage(target.tabId, { type: 'EXECUTE_FLOW', payload: enriched })
                .then(() => console.warn('[SW] held continuation delivered | tabId:', target.tabId))
                .catch((err: Error) => {
                  console.warn('[SW] held continuation delivery failed | tabId:', target.tabId, '— re-registering | err:', err.message);
                  pendingContinuations.set(target.tabId, continuation);
                });
            }, 300);
          }
          return; // handled — do not fall through to active-tab routing
        }
        console.warn('[SW] RESUME_AFTER_PAUSE — no active task for taskId:', resumePayload.taskId);
        // No matching task — fall through to active-tab routing as a fallback.
      }

      // Legacy / sidepanel-mode path: route to active tab.
      browser.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
        const tabId = activeTab?.id;
        if (!tabId) return;
        const continuation = pendingContinuations.get(tabId);
        if (continuation) {
          pendingContinuations.delete(tabId);
          console.warn('[SW] resume — draining held continuation | tabId:', tabId);
          setTimeout(() => {
            const enriched = {
              ...(continuation as Record<string, unknown>),
              drainResumed: scheduler.findByTabId(tabId)?.drainResumed ?? false,
            };
            browser.tabs.sendMessage(tabId, { type: 'EXECUTE_FLOW', payload: enriched })
              .then(() => console.warn('[SW] held continuation delivered | tabId:', tabId))
              .catch((err: Error) => {
                console.warn('[SW] held continuation delivery failed | tabId:', tabId, '— re-registering | err:', err.message);
                pendingContinuations.set(tabId, continuation);
              });
          }, 300);
        }
      }).catch(() => { /* ignore */ });
      // Fall through to sidepanelToContent routing for the live content script.
    }

    // Direct dispatch. Map entries handle the bulk of message types — see
    // `directHandlers` declaration above. Anything not matched here continues
    // on to the allowlist-based relay sections below.
    const handler = directHandlers[type];
    if (handler) return handler(message, sender, sendResponse);

    // ── Offscreen → Sidepanel relay ──

    const offscreenToSidepanel = [
      'CONNECTION_READY', 'CONNECTION_LOST', 'CONNECTION_STATUS',
    ];
    if (offscreenToSidepanel.includes(type)) {
      browser.runtime.sendMessage(message).catch(() => { /* sidepanel may not be open */ });
      return;
    }

    // ── Sidepanel → Offscreen relay ──

    const sidepanelToOffscreen = [
      'INIT_SIGNALR', 'STOP_SIGNALR',
      'SEND_TASK_PROGRESS', 'SEND_TASK_COMPLETE',
      'SEND_TASK_ERROR', 'SEND_TASK_PAUSED', 'GET_CONNECTION_STATUS',
    ];
    if (sidepanelToOffscreen.includes(type)) {
      // Messages from relayHubInvocation already carry _fromSW and go directly
      // to the offscreen; don't re-relay them or we create an infinite loop.
      if (message._fromSW) return;
      dbg('[SW] Relaying to offscreen:', type);
      if (type === 'INIT_SIGNALR') {
        signalrConfig = message.payload as SignalRConfig;
        chrome.storage.session.set({ signalrConfig }).catch(() => {});
      }
      if (type === 'STOP_SIGNALR') {
        signalrConfig = null;
        chrome.storage.session.remove('signalrConfig').catch(() => {});
      }
      const relay = async () => {
        await offscreen.ensure();
        await offscreen.waitForReady();
        // Tag the relay so the offscreen can ignore direct sidepanel broadcasts
        // of the same message (runtime.sendMessage is a broadcast to all contexts).
        return browser.runtime.sendMessage({ ...(message as object), _fromSW: true });
      };
      relay()
        .then((response) => {
          dbg('[SW] Relay response for', type, response);
          sendResponse(response);
        })
        .catch((err: Error) => {
          console.error('[SW] Offscreen relay error:', err);
          sendResponse({ ok: false, error: err.message });
        });
      return true;
    }

    // ── Content → Sidepanel relay (also taps queue mode forwarding) ──

    const contentToSidepanel = [
      'ELEMENT_PICKED', 'ELEMENT_HOVER', 'PICKER_CANCELLED', 'PONG',
      'FLOW_PROGRESS', 'FLOW_COMPLETE', 'FLOW_ERROR',
      'CLOUDFLARE_DETECTED', 'FLOW_PAUSED', 'FLOW_RESUMED',
      'FLOW_PREFLIGHT_READY',
      'NETWORK_CALL_CAPTURED', 'PAGE_INFO',
      'SCAN_PROGRESS', 'SCAN_COMPLETE', 'SCAN_ERROR',
    ];
    if (contentToSidepanel.includes(type)) {
      if (type === 'FLOW_PREFLIGHT_READY') {
        const p = (message.payload ?? {}) as { taskId?: string };
        if (p.taskId) {
          console.warn('[SW] FLOW_PREFLIGHT_READY | taskId:', p.taskId, '| phaseBefore:', scheduler.getPhase());
          scheduler.markPreflightReady(p.taskId);
          console.warn('[SW] FLOW_PREFLIGHT_READY | taskId:', p.taskId, '| phaseAfter:', scheduler.getPhase());
        } else {
          console.warn('[SW] FLOW_PREFLIGHT_READY ignored — no taskId');
        }
      }
      if (type === 'FLOW_RESUMED') {
        console.warn('[SW] FLOW_RESUMED relayed | activeTaskId:', scheduler.getFirstActive()?.task.id);
      }
      browser.runtime.sendMessage(message).catch(() => { /* sidepanel may not be open */ });

      // Mirror pause state for sidepanel-only runs. runner.handleFlowEvent
      // below also sets it but only when there is an active queue-mode
      // record. Both paths converge on the same pauseState manager.
      if (type === 'FLOW_PAUSED') {
        const fp = (message.payload ?? {}) as { reason?: string; message?: string; trigger?: import('../types/messages').DetectionTrigger; domain?: string };
        if (fp.reason === 'cloudflare' || fp.reason === 'awaitUserAction') {
          pauseState.set({
            reason: fp.reason as 'cloudflare' | 'awaitUserAction',
            message: fp.message,
            trigger: fp.trigger,
            domain: fp.domain,
          });
        }
      }
      if (type === 'FLOW_RESUMED') {
        pauseState.clear();
      }

      runner.handleFlowEvent(type, (message.payload ?? {}) as Record<string, unknown>);
      return;
    }

    // ── Sidepanel → Content routing ──

    const sidepanelToContent = [
      'PING', 'START_PICKER', 'CANCEL_PICKER',
      'EXECUTE_FLOW', 'ABORT_FLOW', 'RESUME_AFTER_PAUSE',
      'HIGHLIGHT_ELEMENT', 'UNHIGHLIGHT_ELEMENT', 'GET_PAGE_INFO',
      'SCAN_ELEMENTS', 'SCAN_ABORT',
    ];
    if (sidepanelToContent.includes(type)) {
      const frameId = message.frameId as number | undefined;
      const targetTabId = lastFocusedTabId;

      browser.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
        const tabId = (type === 'EXECUTE_FLOW' && targetTabId) ? targetTabId : activeTab?.id;
        if (!tabId) {
          sendResponse({ error: 'No active tab' });
          return;
        }

        if (type === 'START_PICKER') {
          const frames = frameRegistry.get(tabId);
          if (frames && frames.size > 0) {
            for (const [fId] of frames) {
              browser.tabs.sendMessage(tabId, message, { frameId: fId }).catch(() => {});
            }
          } else {
            browser.tabs.sendMessage(tabId, message).catch(() => {});
          }
          sendResponse({ ok: true });
        } else {
          const opts = frameId !== null && frameId !== undefined ? { frameId } : {};
          chrome.tabs.sendMessage(tabId, message, opts, (response: unknown) => {
            if (chrome.runtime.lastError) {
              sendResponse({ error: chrome.runtime.lastError.message });
            } else {
              sendResponse(response);
            }
          });
        }
      });
      return true as const;
    }
  });

  // ── Tab lifecycle ──

  browser.tabs.onRemoved.addListener((tabId: number) => {
    frameRegistry.delete(tabId);
    pendingContinuations.delete(tabId);
    const orphaned = scheduler.findByTabId(tabId);
    if (orphaned) {
      runner.relayHubInvocation('SEND_TASK_ERROR', {
        taskId: orphaned.task.id,
        configId: orphaned.task.configId,
        error: 'Task tab was closed',
        failedAt: new Date().toISOString(),
      });
      runner.drainNext(orphaned.task.id, 'failed');
    }
  });

  browser.tabs.onUpdated.addListener((tabId: number, changeInfo: { status?: string; url?: string }) => {
    if (changeInfo.status === 'loading') {
      frameRegistry.delete(tabId);
    }
    if (changeInfo.status === 'complete') {
      const continuation = pendingContinuations.get(tabId);
      if (continuation) {
        const cp = continuation as Record<string, unknown>;
        // Pause-resilience: while pauseState is set, the user is still
        // working on the obstacle. The page may have navigated as part of that
        // (e.g. login submit redirect). HOLD the continuation in the map and
        // do NOT deliver — it will be drained by the sidepanel-resume handler
        // when the user clicks Continue.
        const ps = pauseState.get();
        if (ps) {
          console.warn('[SW] tabs.onUpdated — holding continuation (pause active) | tabId:', tabId, '| reason:', ps.reason);
          return;
        }

        // Capture tab URL at fire time so we can correlate with the content
        // script's view of where it is when its waitAfterAction returns.
        browser.tabs.get(tabId).then((t) => {
          console.warn('[SW] tabs.onUpdated firing continuation | tabId:', tabId, '| tabUrl:', t.url, '| changeInfoUrl:', changeInfo.url, '| startTermIndex:', cp.startTermIndex, '| startLoopStepIndex:', cp.startLoopStepIndex, '| searchTerms:', cp.searchTerms, '| previousIterations.length:', Array.isArray(cp.previousIterations) ? (cp.previousIterations as unknown[]).length : 'n/a');
        }).catch(() => {
          console.warn('[SW] tabs.onUpdated firing continuation | tabId:', tabId, '| (tab.get failed) | startTermIndex:', cp.startTermIndex, '| startLoopStepIndex:', cp.startLoopStepIndex);
        });
        // Delete immediately so that a second 'complete' event firing before the
        // setTimeout resolves (e.g. redirect then page-load) does NOT double-fire
        // EXECUTE_FLOW. If delivery actually fails we re-add so the next 'complete'
        // can retry — this preserves the redirect-retry behaviour without double-fire.
        pendingContinuations.delete(tabId);
        setTimeout(() => {
          const taskRecord = scheduler.findByTabId(tabId);
          const drainResumedValue = taskRecord?.drainResumed ?? false;
          console.warn('[SW] tabs.onUpdated enriching | tabId:', tabId, '| recordFound:', !!taskRecord, '| recordTaskId:', taskRecord?.task.id, '| drainResumed:', drainResumedValue, '| schedulerActiveCount:', scheduler.getActiveCount());
          const enriched = {
            ...(continuation as Record<string, unknown>),
            drainResumed: drainResumedValue,
          };
          browser.tabs.sendMessage(tabId, { type: 'EXECUTE_FLOW', payload: enriched })
            .then(() => { console.warn('[SW] Continuation delivered to tabId:', tabId); })
            .catch((err: Error) => {
              console.warn('[SW] Continuation delivery failed for tabId:', tabId, '— re-registering for retry | err:', err.message);
              pendingContinuations.set(tabId, continuation);
            });
        }, 600);
      }
    }
  });

  // PR6 — notification click routing. Wrapped in try/catch because some
  // browsers may not have chrome.notifications even with the permission set.
  try {
    chrome.notifications.onClicked.addListener((id) => {
      if (isTaskNotification(id)) {
        const taskId = taskIdFromNotificationId(id);
        if (taskId) {
          const target = scheduler.getActiveTask(taskId);
          if (target) {
            chrome.windows.update(target.windowId, { focused: true, state: 'normal' })
              .catch((err: Error) => console.warn('[notifications] focus failed:', err.message));
          }
        }
        chrome.notifications.clear(id);
        return;
      }
      if (isBatchNotification(id)) {
        chrome.notifications.clear(id);
        return;
      }
    });
  } catch (err) {
    console.warn('[notifications] onClicked listener registration failed:', (err as Error).message);
  }
});
