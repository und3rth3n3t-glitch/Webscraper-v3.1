import * as signalR from '@microsoft/signalr';
import type { QueueTask } from '../types/signalr';

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export class ScraperHubConnection {
  private connection: signalR.HubConnection | null = null;
  private clientId = '';
  private extensionVersion = '';

  async connect(serverUrl: string, token: string, clientId: string, version: string): Promise<void> {
    this.extensionVersion = version;
    if (this.connection) {
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
    });

    this.connection.onclose((err) => {
      const message = err ? String((err as Error).message ?? err) : 'closed';
      this.emitStatus('error', message);
      browser.runtime.sendMessage({
        type: 'CONNECTION_LOST',
        payload: { error: message },
      });
    });

    try {
      await this.connection.start();
    } catch (err) {
      const message = (err as Error).message ?? 'Connection failed';
      this.emitStatus('error', message);
      this.connection = null;
      throw err;
    }

    this.emitStatus('connected');
    browser.runtime.sendMessage({ type: 'CONNECTION_READY', payload: { clientId } });

    // RegisterWorker updates the backend DB — fire without blocking the connect promise.
    console.log('[SignalR] Invoking RegisterWorker', { clientId, version, state: this.connection.state });
    this.connection.invoke('RegisterWorker', clientId, version)
      .then(() => console.log('[SignalR] RegisterWorker succeeded'))
      .catch((err) => {
        console.error('[SignalR] RegisterWorker failed:', err);
      });
  }

  async invoke(method: string, ...args: unknown[]): Promise<void> {
    if (this.connection?.state !== signalR.HubConnectionState.Connected) return;
    await this.connection.invoke(method, ...args);
  }

  isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }

  async disconnect(): Promise<void> {
    if (!this.connection) {
      this.emitStatus('idle');
      return;
    }
    try { await this.connection.stop(); } catch { /* expected */ }
    this.connection = null;
    this.emitStatus('idle');
  }

  private emitStatus(status: ConnectionStatus, error?: string): void {
    browser.runtime.sendMessage({
      type: 'CONNECTION_STATUS',
      payload: { status, error },
    }).catch(() => { /* sidepanel may be closed */ });
  }
}
