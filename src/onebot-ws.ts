import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

import type { OneBotActionTransport } from './onebot';
import type {
  JsonObject,
  Logger,
  OneBotActionResponse,
  OneBotClientConfig,
  RuntimeStore,
} from './types';

interface OneBotWebSocketTransportDependencies {
  runtime: RuntimeStore;
  appLogger: Logger;
  handleIncomingEvent: (payload: JsonObject, headers: Record<string, unknown>) => Promise<unknown>;
}

interface PendingAction {
  resolve(value: OneBotActionResponse<unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

// ---------------------------------------------------------------------------
// Shared helpers (kept from original for reverse upgrade auth & path checks)
// ---------------------------------------------------------------------------

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function authorizeUpgrade(request: IncomingMessage, accessToken?: string): boolean {
  if (!accessToken) {
    return true;
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  const queryToken = url.searchParams.get('access_token') ?? undefined;
  if (queryToken && queryToken === accessToken) {
    return true;
  }

  const auth = readHeaderValue(request.headers.authorization);
  if (auth?.startsWith('Bearer ') && auth.slice('Bearer '.length) === accessToken) {
    return true;
  }

  const headerToken = readHeaderValue(request.headers['x-access-token']);
  return Boolean(headerToken && headerToken === accessToken);
}

function rejectUpgrade(socket: Socket, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function headersToRecord(headers: http.IncomingHttpHeaders): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    record[key] = value;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class OneBotWebSocketTransport implements OneBotActionTransport {
  private forwardWs: WebSocket | null = null;
  private reverseWss: WebSocketServer | null = null;
  private reverseClients = new Map<WebSocket, Record<string, unknown>>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private pending = new Map<string, PendingAction>();

  constructor(private readonly deps: OneBotWebSocketTransportDependencies) {}

  // -----------------------------------------------------------------------
  // Reverse WS — attach upgrade handler to Hapi's HTTP server
  // -----------------------------------------------------------------------

  attachReverse(server: http.Server): void {
    this.reverseWss = new WebSocketServer({ noServer: true });

    this.reverseWss.on('connection', (ws, request) => {
      const headers = headersToRecord(request.headers);
      this.deps.appLogger.info('onebot reverse websocket connected');
      this.setupClient(ws, headers, 'reverse');
    });

    server.on('upgrade', (request, socket, head) => {
      void this.handleReverseUpgrade(request, socket as Socket, head).catch((error) => {
        this.deps.appLogger.warn('onebot reverse websocket upgrade failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        socket.destroy();
      });
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    this.stopped = false;
    const runtime = await this.deps.runtime.snapshot();
    if (runtime.onebot.webSocket.mode === 'forward' || runtime.onebot.webSocket.mode === 'both') {
      this.scheduleForwardReconnect(0);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('onebot websocket transport stopped'));
    }
    this.pending.clear();

    if (this.forwardWs) {
      this.forwardWs.close();
      this.forwardWs = null;
    }
    for (const ws of this.reverseClients.keys()) {
      ws.close();
    }
    this.reverseClients.clear();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // -----------------------------------------------------------------------
  // Status (used by WebUI / API)
  // -----------------------------------------------------------------------

  isActionReady(): boolean {
    return Boolean(
      (this.forwardWs && this.forwardWs.readyState === WebSocket.OPEN) ||
        this.reverseClients.size > 0,
    );
  }

  getStatus(): { forwardConnected: boolean; reverseConnected: boolean; reversePeerCount: number; stopped: boolean } {
    return {
      forwardConnected: this.forwardWs !== null && this.forwardWs.readyState === WebSocket.OPEN,
      reverseConnected: this.reverseClients.size > 0,
      reversePeerCount: this.reverseClients.size,
      stopped: this.stopped,
    };
  }

  // -----------------------------------------------------------------------
  // OneBot action invocation (echo correlation)
  // -----------------------------------------------------------------------

  async callAction<T>(
    action: string,
    params: Record<string, unknown>,
    config: OneBotClientConfig,
  ): Promise<OneBotActionResponse<T>> {
    const ws = this.forwardWs ?? [...this.reverseClients.keys()][0];
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('onebot websocket is not connected');
    }

    const echo = `f261agent:${Date.now()}:${randomBytes(8).toString('hex')}`;
    const timeoutMs = config.webSocket.actionTimeoutMs || config.timeoutMs;

    return new Promise<OneBotActionResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`onebot websocket action ${action} timed out`));
      }, timeoutMs);

      this.pending.set(echo, {
        resolve: (value) => resolve(value as OneBotActionResponse<T>),
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  // -----------------------------------------------------------------------
  // Reverse upgrade
  // -----------------------------------------------------------------------

  private async handleReverseUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const runtime = await this.deps.runtime.snapshot();
    const wsConfig = runtime.onebot.webSocket;

    if (wsConfig.mode !== 'reverse' && wsConfig.mode !== 'both') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== wsConfig.reversePath) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    if (!authorizeUpgrade(request, runtime.onebot.accessToken)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const wss = this.reverseWss;
    if (!wss) {
      rejectUpgrade(socket, 500, 'Internal Server Error');
      return;
    }

    // Delegate to ws library for RFC 6455 handshake & framing
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }

  // -----------------------------------------------------------------------
  // Shared client setup (forward & reverse)
  // -----------------------------------------------------------------------

  private setupClient(ws: WebSocket, headers: Record<string, unknown>, label: 'forward' | 'reverse'): void {
    if (label === 'reverse') {
      this.reverseClients.set(ws, headers);
    }

    ws.on('message', (data) => {
      void this.handleMessage(data, headers).catch((error) => {
        this.deps.appLogger.warn('onebot websocket message handling failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    ws.on('close', () => {
      this.reverseClients.delete(ws);
      if (this.forwardWs === ws) {
        this.forwardWs = null;
        void this.scheduleForwardReconnectFromConfig();
      }
      this.rejectAllPending(new Error(`onebot ${label} websocket closed`));
      this.deps.appLogger.info(`onebot ${label} websocket disconnected`);
    });

    ws.on('error', (error) => {
      this.deps.appLogger.warn(`onebot ${label} websocket error`, {
        error: error.message,
      });
    });
  }

  // -----------------------------------------------------------------------
  // Message dispatch (event vs action response)
  // -----------------------------------------------------------------------

  private async handleMessage(data: Buffer | ArrayBuffer | Buffer[], headers: Record<string, unknown>): Promise<void> {
    let value: unknown;
    try {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data).toString('utf8');
      value = JSON.parse(text);
    } catch {
      this.deps.appLogger.warn('invalid onebot websocket json ignored');
      return;
    }

    if (!isJsonObject(value)) {
      return;
    }

    // Echo responses match pending API calls
    const echo = typeof value.echo === 'string' ? value.echo : undefined;
    if (echo) {
      const pending = this.pending.get(echo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(echo);
        pending.resolve(value as unknown as OneBotActionResponse<unknown>);
        return;
      }
    }

    await this.deps.handleIncomingEvent(value, headers);
  }

  // -----------------------------------------------------------------------
  // Forward reconnect loop
  // -----------------------------------------------------------------------

  private scheduleForwardReconnect(delayMs: number): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectForward().catch((error) => {
        this.deps.appLogger.warn('onebot forward websocket connect failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        void this.scheduleForwardReconnectFromConfig();
      });
    }, delayMs);
  }

  private async scheduleForwardReconnectFromConfig(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const runtime = await this.deps.runtime.snapshot();
    this.scheduleForwardReconnect(runtime.onebot.webSocket.reconnectIntervalMs);
  }

  private async connectForward(): Promise<void> {
    const runtime = await this.deps.runtime.snapshot();
    const wsConfig = runtime.onebot.webSocket;

    if (this.stopped || (wsConfig.mode !== 'forward' && wsConfig.mode !== 'both')) {
      return;
    }
    if (!wsConfig.forwardUrl) {
      this.deps.appLogger.warn('onebot forward websocket url is not configured');
      await this.scheduleForwardReconnectFromConfig();
      return;
    }

    // Append access_token to query string if configured
    const url = new URL(wsConfig.forwardUrl);
    if (runtime.onebot.accessToken && !url.searchParams.has('access_token')) {
      url.searchParams.set('access_token', runtime.onebot.accessToken);
    }

    // Build custom headers for auth
    const headers: Record<string, string> = {};
    if (runtime.onebot.accessToken) {
      headers['Authorization'] = `Bearer ${runtime.onebot.accessToken}`;
    }
    if (runtime.onebot.selfId) {
      headers['X-Self-ID'] = runtime.onebot.selfId;
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const ws = new WebSocket(url.toString(), {
        headers,
        handshakeTimeout: runtime.onebot.timeoutMs,
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error('onebot forward websocket connect timed out'));
      }, runtime.onebot.timeoutMs);

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.forwardWs = ws;
        this.setupClient(ws, headers, 'forward');
        this.deps.appLogger.info('onebot forward websocket connected', { url: wsConfig.forwardUrl ?? '' });
        resolve();
      });

      ws.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });

      ws.on('unexpected-response', (_ws, response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`onebot forward websocket rejected: ${response.statusCode}`));
      });
    });
  }

  // -----------------------------------------------------------------------
  // Pending action cleanup
  // -----------------------------------------------------------------------

  private rejectAllPending(error: Error): void {
    for (const [echo, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(echo);
    }
  }
}
