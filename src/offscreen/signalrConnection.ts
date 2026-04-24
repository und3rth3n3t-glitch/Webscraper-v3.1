import * as signalR from '@microsoft/signalr';
import type { QueueTask } from '../types/signalr';

export class ScraperHubConnection {
  private connection: signalR.HubConnection | null = null;
  private clientId = '';

  async connect(serverUrl: string, token: string, clientId: string): Promise<void> {
    this.clientId = clientId;

    this.connection = new signalR.HubConnectionBuilder()
      .withUrl(`${serverUrl}/api/scraper-hub`, {
        headers: { Authorization: `Bearer ${token}` },
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

    this.connection.onreconnected(() => {
      this.connection!
        .invoke('RegisterWorker', this.clientId, browser.runtime.getManifest().version)
        .catch(console.error);
    });

    this.connection.onclose((err) => {
      browser.runtime.sendMessage({
        type: 'CONNECTION_LOST',
        payload: { error: String(err ?? 'closed') },
      });
    });

    await this.connection.start();
    await this.connection.invoke(
      'RegisterWorker',
      clientId,
      browser.runtime.getManifest().version,
    );
    browser.runtime.sendMessage({ type: 'CONNECTION_READY', payload: { clientId } });
  }

  async invoke(method: string, ...args: unknown[]): Promise<void> {
    if (this.connection?.state !== signalR.HubConnectionState.Connected) return;
    await this.connection.invoke(method, ...args);
  }

  isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }

  disconnect(): void {
    this.connection?.stop();
  }
}
