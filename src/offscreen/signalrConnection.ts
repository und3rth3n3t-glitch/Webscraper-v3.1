import * as signalR from '@microsoft/signalr';
import type { QueueTask } from '../types/signalr';
import type { ConnectionStatus } from '../types/messages';
import { dbg } from '../utils/debugLog';

export class ScraperHubConnection {
  private connection: signalR.HubConnection | null = null;
  private clientId = '';
  private extensionVersion = '';
  // Queued invocations while connecting/reconnecting, drained once Connected.
  private pendingInvocations: Array<{ method: string; args: unknown[] }> = [];

  async connect(serverUrl: string, token: string, clientId: string, version: string): Promise<void> {
    this.extensionVersion = version;
    if (this.connection) {
      const s = this.connection.state;
      if (
        s === signalR.HubConnectionState.Connected ||
        s === signalR.HubConnectionState.Connecting ||
        s === signalR.HubConnectionState.Reconnecting
      ) {
        // Already live — don't tear down an active connection for a duplicate INIT_SIGNALR.
        return;
      }
      try { await this.connection.stop(); } catch { /* expected */ }
      this.connection = null;
    }

    this.clientId = clientId;
    this.emitStatus('connecting');

    this.connection = new signalR.HubConnectionBuilder()
      .withUrl(`${serverUrl}/api/scraper-hub`, {
        accessTokenFactory: () => token,
      })
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (ctx) => {
          if (ctx.previousRetryCount >= 5) return null;
          return Math.min(1000 * Math.pow(2, ctx.previousRetryCount) + Math.random() * 500, 30_000);
        },
      })
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    this.connection.on('ReceiveTask', (task: QueueTask) => {
      browser.runtime.sendMessage({ type: 'TASK_RECEIVED', payload: task });
    });

    this.connection.on('ResumeAfterPause', (taskId: string) => {
      browser.runtime.sendMessage({ type: 'RESUME_TASK', payload: { taskId } });
    });

    this.connection.on('CancelTask', (taskId: string) => {
      browser.runtime.sendMessage({ type: 'CANCEL_TASK', payload: { taskId } });
    });

    this.connection.onreconnecting(() => {
      this.emitStatus('reconnecting');
    });

    this.connection.onreconnected(() => {
      this.emitStatus('connected');
      this.connection!
        .invoke('RegisterWorker', this.clientId, this.extensionVersion)
        .catch((err) => console.error('[SignalR] RegisterWorker after reconnect failed:', err));
      this.drainPending();
    });

    this.connection.onclose((err) => {
      const message = err ? String((err as Error).message ?? err) : 'closed';
      this.emitStatus('error', message);
      browser.runtime.sendMessage({
        type: 'CONNECTION_LOST',
        payload: { error: message },
      });
      // Discard any pending invocations — connection is gone.
      this.pendingInvocations = [];
    });

    try {
      await this.connection.start();
    } catch (err) {
      const message = (err as Error).message ?? 'Connection failed';
      this.emitStatus('error', message);
      this.connection = null;
      this.pendingInvocations = [];
      throw err;
    }

    this.emitStatus('connected');
    browser.runtime.sendMessage({ type: 'CONNECTION_READY', payload: { clientId } });

    // RegisterWorker updates the backend DB — fire without blocking the connect promise.
    dbg('[SignalR] Invoking RegisterWorker', { clientId, version, state: this.connection.state });
    this.connection.invoke('RegisterWorker', clientId, version)
      .then(() => dbg('[SignalR] RegisterWorker succeeded'))
      .catch((err) => {
        console.error('[SignalR] RegisterWorker failed:', err);
      });

    // Drain any invocations that arrived while we were connecting.
    this.drainPending();
  }

  async invoke(method: string, ...args: unknown[]): Promise<void> {
    if (!this.connection) {
      // No connection object yet (connect() not yet called) — queue for after connect().
      dbg('[SignalR] invoke queued (no connection):', method);
      this.pendingInvocations.push({ method, args });
      return;
    }
    if (this.connection.state === signalR.HubConnectionState.Disconnected) {
      console.warn('[SignalR] invoke dropped (Disconnected):', method);
      return;
    }
    if (this.connection.state !== signalR.HubConnectionState.Connected) {
      // Queue for delivery once Connected (handles initial connect and auto-reconnect).
      dbg('[SignalR] invoke queued (state:', this.connection.state, '):', method);
      this.pendingInvocations.push({ method, args });
      return;
    }
    dbg('[SignalR] invoke:', method);
    await this.connection.invoke(method, ...args);
  }

  isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }

  getStatus(): ConnectionStatus {
    if (!this.connection) return 'idle';
    switch (this.connection.state) {
      case signalR.HubConnectionState.Connected:     return 'connected';
      case signalR.HubConnectionState.Reconnecting:  return 'reconnecting';
      case signalR.HubConnectionState.Connecting:
      case signalR.HubConnectionState.Disconnecting: return 'connecting';
      default:                                        return 'idle';
    }
  }

  async disconnect(): Promise<void> {
    this.pendingInvocations = [];
    if (!this.connection) {
      this.emitStatus('idle');
      return;
    }
    try { await this.connection.stop(); } catch { /* expected */ }
    this.connection = null;
    this.emitStatus('idle');
  }

  private drainPending(): void {
    const pending = this.pendingInvocations.splice(0);
    for (const { method, args } of pending) {
      this.connection?.invoke(method, ...args).catch((err) =>
        console.error(`[SignalR] Deferred invoke(${method}) failed:`, err),
      );
    }
  }

  private emitStatus(status: ConnectionStatus, error?: string): void {
    browser.runtime.sendMessage({
      type: 'CONNECTION_STATUS',
      payload: { status, error },
    }).catch(() => { /* sidepanel may be closed */ });
  }
}
