import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

import type { OneBotActionTransport } from './onebot';
import {
  effectiveClientIp,
  isLoopbackAddress,
  isLoopbackHost,
  isProxiedRequest,
  safeEqual,
} from './security';
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
  /** 是否信任反向代理头（与 settings.trustProxy 一致）。 */
  trustProxy?: boolean;
  handleIncomingEvent: (payload: JsonObject, headers: Record<string, unknown>) => Promise<unknown>;
}

interface PendingAction {
  resolve(value: OneBotActionResponse<unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  ws: WebSocket;
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

/**
 * 反向 WS 升级鉴权。未配置 accessToken 时只允许本机直连（回环地址且无代理头），
 * 否则远程连接会被拒绝 —— 避免反向 WS 成为一个无鉴权的远程代码执行入口。
 */
function authorizeUpgrade(request: IncomingMessage, accessToken: string | undefined, trustProxy: boolean): boolean {
  if (!accessToken) {
    return (
      isLoopbackAddress(effectiveClientIp(request, trustProxy)) &&
      !isProxiedRequest(request) &&
      isLoopbackHost(readHeaderValue(request.headers.host))
    );
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  const queryToken = url.searchParams.get('access_token') ?? undefined;
  if (queryToken && safeEqual(queryToken, accessToken)) {
    return true;
  }

  const auth = readHeaderValue(request.headers.authorization);
  if (auth?.startsWith('Bearer ') && safeEqual(auth.slice('Bearer '.length), accessToken)) {
    return true;
  }

  const headerToken = readHeaderValue(request.headers['x-access-token']);
  return Boolean(headerToken && safeEqual(headerToken, accessToken));
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
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private stopped = true;
  private connecting = false;
  private pending = new Map<string, PendingAction>();
  /** 每个 socket 上一次心跳 tick 之后是否收到过 pong/消息。 */
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private lastPongAt: number | null = null;
  private static readonly MAX_REVERSE_CLIENTS = 16;

  /** Pick a socket that is actually OPEN, preferring the forward connection. */
  private pickReadySocket(): WebSocket | null {
    if (this.forwardWs && this.forwardWs.readyState === WebSocket.OPEN) {
      return this.forwardWs;
    }
    for (const ws of this.reverseClients.keys()) {
      if (ws.readyState === WebSocket.OPEN) return ws;
    }
    return null;
  }

  constructor(private readonly deps: OneBotWebSocketTransportDependencies) {}

  // -----------------------------------------------------------------------
  // Reverse WS — attach upgrade handler to Hapi's HTTP server
  // -----------------------------------------------------------------------

  attachReverse(server: http.Server): void {
    this.reverseWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

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
    this.startHeartbeat(runtime.onebot.webSocket.heartbeatIntervalMs);
    if (runtime.onebot.webSocket.mode === 'forward' || runtime.onebot.webSocket.mode === 'both') {
      this.scheduleForwardReconnect(0);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.reconnectAttempts = 0;

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

  /** Release the reverse WebSocket server. Call once, at application shutdown. */
  async dispose(): Promise<void> {
    await this.stop();
    const wss = this.reverseWss;
    if (!wss) return;
    this.reverseWss = null;
    // Bound the wait: wss.close() waits for every tracked client's close
    // handshake, and a half-dead peer would otherwise stall shutdown (keeping
    // the store flush from ever running).
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      timer.unref?.();
      wss.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // -----------------------------------------------------------------------
  // Status (used by WebUI / API)
  // -----------------------------------------------------------------------

  isActionReady(): boolean {
    if (this.forwardWs && this.forwardWs.readyState === WebSocket.OPEN) return true;
    for (const ws of this.reverseClients.keys()) {
      if (ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  getStatus(): {
    forwardConnected: boolean;
    reverseConnected: boolean;
    reversePeerCount: number;
    stopped: boolean;
    lastPongAt: number | null;
  } {
    let reversePeerCount = 0;
    for (const ws of this.reverseClients.keys()) {
      if (ws.readyState === WebSocket.OPEN) reversePeerCount += 1;
    }
    return {
      forwardConnected: this.forwardWs !== null && this.forwardWs.readyState === WebSocket.OPEN,
      reverseConnected: reversePeerCount > 0,
      reversePeerCount,
      stopped: this.stopped,
      lastPongAt: this.lastPongAt,
    };
  }

  // -----------------------------------------------------------------------
  // Heartbeat (liveness detection for half-open sockets)
  // -----------------------------------------------------------------------

  private startHeartbeat(intervalMs: number | undefined): void {
    if (this.heartbeatTimer) return;
    const interval = intervalMs ?? 30_000;
    if (!Number.isFinite(interval) || interval <= 0) return;
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), interval);
    this.heartbeatTimer.unref?.();
  }

  private heartbeatTick(): void {
    const sockets: WebSocket[] = [];
    if (this.forwardWs) sockets.push(this.forwardWs);
    for (const ws of this.reverseClients.keys()) sockets.push(ws);

    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      // 上一 tick 之后完全没有 pong/消息：判定为半开连接，直接终止以触发重连。
      if (this.alive.get(ws) === false) {
        this.deps.appLogger.warn('onebot websocket heartbeat timed out; terminating socket');
        ws.terminate();
        continue;
      }
      this.alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }

  // -----------------------------------------------------------------------
  // OneBot action invocation (echo correlation)
  // -----------------------------------------------------------------------

  async callAction<T>(
    action: string,
    params: Record<string, unknown>,
    config: OneBotClientConfig,
  ): Promise<OneBotActionResponse<T>> {
    const ws = this.pickReadySocket();
    if (!ws) {
      throw new Error('onebot websocket is not connected');
    }

    const echo = `f261agent:${Date.now()}:${randomBytes(8).toString('hex')}`;
    const timeoutMs = config.webSocket.actionTimeoutMs || config.timeoutMs;

    return new Promise<OneBotActionResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        // 超时说明该连接可能已半死：终止它，让 forward 走重连、reverse 被移除，
        // 而不是继续把后续请求发给一个无响应的 socket。
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(new Error(`onebot websocket action ${action} timed out`));
      }, timeoutMs);

      this.pending.set(echo, {
        resolve: (value) => resolve(value as OneBotActionResponse<T>),
        reject,
        timer,
        ws,
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
    if (this.stopped) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

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

    if (this.reverseClients.size >= OneBotWebSocketTransport.MAX_REVERSE_CLIENTS) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    if (!authorizeUpgrade(request, runtime.onebot.accessToken, this.deps.trustProxy === true)) {
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
    this.alive.set(ws, true);

    ws.on('pong', () => {
      this.alive.set(ws, true);
      this.lastPongAt = Date.now();
    });

    ws.on('message', (data) => {
      this.alive.set(ws, true);
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
        void this.scheduleForwardReconnectFromConfig().catch(() => undefined);
      }
      // Only reject actions that were sent on THIS socket — a different, still
      // healthy socket may have unrelated calls in flight.
      this.rejectPendingForSocket(ws, new Error(`onebot ${label} websocket closed`));
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
      // An echo we issued but already timed out. It is an action response, not
      // an event — dropping it avoids a pointless event-pipeline round trip
      // (and a config read) per late reply.
      if (echo.startsWith('f261agent:')) {
        this.deps.appLogger.debug('discarded late onebot action response', { echo });
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
        void this.scheduleForwardReconnectFromConfig().catch(() => undefined);
      });
    }, delayMs);
  }

  private async scheduleForwardReconnectFromConfig(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const runtime = await this.deps.runtime.snapshot();
    this.scheduleForwardReconnect(this.nextReconnectDelay(runtime.onebot.webSocket.reconnectIntervalMs));
  }

  /**
   * 指数退避 + 抖动：base、2x、4x… 上限 60s，抖动 0.5x-1.5x，
   * 避免大量实例在协议端重启时同时重连。连接成功后 attempts 归零。
   */
  private nextReconnectDelay(baseMs: number): number {
    const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 5_000;
    const exponent = Math.min(this.reconnectAttempts, 16);
    const capped = Math.min(base * 2 ** exponent, 60_000);
    this.reconnectAttempts += 1;
    const jitter = 0.5 + Math.random();
    return Math.max(100, Math.min(60_000, Math.round(capped * jitter)));
  }

  private async connectForward(): Promise<void> {
    // Guard against overlapping connects (e.g. a restart landing mid-handshake),
    // which would otherwise orphan a socket that stop() can't reach.
    if (this.connecting) return;
    if (this.forwardWs && this.forwardWs.readyState === WebSocket.OPEN) return;

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

    this.connecting = true;
    try {
      await this.connectForwardInner(runtime, wsConfig.forwardUrl);
    } catch (error) {
      // Every failure path (invalid URL, synchronous WebSocket constructor
      // throw, handshake error) must reset the guard, or the reconnect loop is
      // permanently dead: the next attempt would hit `if (this.connecting)`
      // above, resolve successfully, and never reschedule.
      this.connecting = false;
      throw error;
    }
  }

  private async connectForwardInner(
    runtime: Awaited<ReturnType<RuntimeStore['snapshot']>>,
    forwardUrl: string,
  ): Promise<void> {
    // Append access_token to query string if configured
    const url = new URL(forwardUrl);
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

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        this.connecting = false;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          ws.close();
          reject(new Error('onebot forward websocket connect timed out'));
        });
      }, runtime.onebot.timeoutMs);

      ws.on('open', () => {
        finish(() => {
          // If we were stopped mid-handshake, don't adopt the socket.
          if (this.stopped) {
            ws.close();
            resolve();
            return;
          }
          this.forwardWs = ws;
          this.reconnectAttempts = 0;
          this.setupClient(ws, headers, 'forward');
          this.deps.appLogger.info('onebot forward websocket connected', { url: forwardUrl });
          resolve();
        });
      });

      ws.on('error', (error) => {
        finish(() => reject(error));
      });

      ws.on('unexpected-response', (_ws, response) => {
        finish(() => reject(new Error(`onebot forward websocket rejected: ${response.statusCode}`)));
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

  private rejectPendingForSocket(ws: WebSocket, error: Error): void {
    for (const [echo, pending] of this.pending.entries()) {
      if (pending.ws !== ws) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(echo);
    }
  }
}
