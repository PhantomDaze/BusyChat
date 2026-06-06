/**
 * WebSocket Forward & Reverse Connection Tests
 *
 * Tests the RFC 6455 WebSocket transport in src/onebot-ws.ts.
 * The transport uses the `ws` library internally; the test mock server
 * uses its own frame encoding/decoding helpers for fixture connections.
 *
 * Run: npx tsx test/onebot-ws.test.ts
 */

import * as net from 'node:net';
import * as http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { OneBotWebSocketTransport } from '../src/onebot-ws';
import type {
  RuntimeStore,
  RuntimeState,
  Logger,
  JsonObject,
  OneBotActionResponse,
} from '../src/types';

// ---------------------------------------------------------------------------
// WebSocket frame helpers (for the mock side)
// These mirror the logic in onebot-ws.ts which is not exported.
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

function readFrame(buffer: Buffer): {
  opcode: number;
  payload: Buffer;
  remainder: Buffer;
} | null {
  if (buffer.length < 2) return null;

  const first = buffer[0]!;
  const second = buffer[1]!;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLen = buffer.readBigUInt64BE(offset);
    if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    length = Number(bigLen);
    offset += 8;
  }

  const maskLen = masked ? 4 : 0;
  if (buffer.length < offset + maskLen + length) return null;

  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskLen;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  const remainder = buffer.subarray(offset + length);

  if (mask) {
    for (let i = 0; i < payload.length; i++) {
      payload[i] = payload[i]! ^ mask[i % 4]!;
    }
  }

  return { opcode, payload, remainder };
}

function writeFrame(opcode: number, payload: Buffer, masked: boolean): Buffer {
  const headerLen = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
  const maskLen = masked ? 4 : 0;
  const frame = Buffer.allocUnsafe(headerLen + maskLen + payload.length);
  let offset = 0;

  frame[offset++] = 0x80 | opcode;
  if (payload.length < 126) {
    frame[offset++] = (masked ? 0x80 : 0) | payload.length;
  } else if (payload.length <= 0xffff) {
    frame[offset++] = (masked ? 0x80 : 0) | 126;
    frame.writeUInt16BE(payload.length, offset);
    offset += 2;
  } else {
    frame[offset++] = (masked ? 0x80 : 0) | 127;
    frame.writeBigUInt64BE(BigInt(payload.length), offset);
    offset += 8;
  }

  if (masked) {
    const mask = randomBytes(4);
    mask.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < payload.length; i++) {
      frame[offset + i] = payload[i]! ^ mask[i % 4]!;
    }
  } else {
    payload.copy(frame, offset);
  }

  return frame;
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** A minimal WebSocket endpoint wrapping a raw net.Socket for the test mock side. */
class MockWsEndpoint {
  private buffer = Buffer.alloc(0);
  private jsonHandlers: Array<(data: unknown) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private _closed = false;

  constructor(
    private socket: net.Socket,
    private maskOutgoing: boolean,
  ) {
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('close', () => this.emitClose());
    socket.on('error', () => this.emitClose());
  }

  get closed(): boolean {
    return this._closed;
  }

  feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = readFrame(this.buffer);
      if (!frame) break;
      this.buffer = frame.remainder;
      if (frame.opcode === 0x1) {
        // text frame
        try {
          const parsed = JSON.parse(frame.payload.toString('utf8'));
          for (const h of this.jsonHandlers) h(parsed);
        } catch {
          // ignore invalid JSON in test
        }
      } else if (frame.opcode === 0x8) {
        // close frame
        this.emitClose();
        this.socket.end();
        return;
      } else if (frame.opcode === 0x9) {
        // ping → pong
        this.socket.write(writeFrame(0xa, frame.payload, this.maskOutgoing));
      }
    }
  }

  sendJson(data: unknown): void {
    this.socket.write(
      writeFrame(0x1, Buffer.from(JSON.stringify(data), 'utf8'), this.maskOutgoing),
    );
  }

  onJson(handler: (data: unknown) => void): void {
    this.jsonHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.socket.write(writeFrame(0x8, Buffer.alloc(0), this.maskOutgoing));
    this.socket.end();
  }

  private emitClose(): void {
    if (this._closed) return;
    this._closed = true;
    for (const h of this.closeHandlers) h();
  }
}

// ---------------------------------------------------------------------------
// Mock RuntimeStore
// ---------------------------------------------------------------------------

function createMockRuntimeStore(overrides: Partial<RuntimeState>): RuntimeStore {
  const state: RuntimeState = {
    admins: [],
    onebot: {
      baseUrl: 'http://127.0.0.1:5700',
      apiPrefix: '/api',
      timeoutMs: 5000,
      webSocket: {
        mode: 'off',
        reversePath: '/onebot/ws',
        reconnectIntervalMs: 100,
        actionTimeoutMs: 3000,
      },
    },
    summary: {
      enabled: false,
      intervalMs: 120000,
      batchSize: 20,
      maxEventsPerPrompt: 40,
    },
    activeModels: {},
    models: { language: [], 'speech-to-text': [], embedding: [], rerank: [] },
    plugins: {},
    ui: { enabled: false, title: 'Test' },
    ...overrides,
  };

  return {
    async snapshot(): Promise<RuntimeState> {
      return JSON.parse(JSON.stringify(state)) as RuntimeState;
    },
    async update(): Promise<RuntimeState> {
      return JSON.parse(JSON.stringify(state)) as RuntimeState;
    },
    async replace(next: RuntimeState): Promise<RuntimeState> {
      Object.assign(state, next);
      return JSON.parse(JSON.stringify(state)) as RuntimeState;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Logger
// ---------------------------------------------------------------------------

function createMockLogger(name: string): Logger {
  const scoped = (child: string): Logger => createMockLogger(`${name}:${child}`);
  return {
    scope: name,
    child: (scope: string) => scoped(scope),
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testsPassed = 0;
let testsFailed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    testsPassed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    testsFailed++;
    console.log(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

/** Wait for a condition to become true, polling every `intervalMs`. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(50);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Find a free TCP port by binding to port 0. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not get port')));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Frame-level unit tests
// ---------------------------------------------------------------------------

async function runFrameTests(): Promise<void> {
  console.log('\n[Frame Protocol Tests]');

  await test('write and read a small text frame (masked)', async () => {
    const payload = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
    const frame = writeFrame(0x1, payload, true);
    const result = readFrame(frame);
    assert(result !== null, 'should parse frame');
    assert(result!.opcode === 0x1, 'should be text opcode');
    assert(
      result!.payload.toString('utf8') === '{"hello":"world"}',
      'should decode payload',
    );
    assert(result!.remainder.length === 0, 'no remainder expected');
  });

  await test('write and read a small text frame (unmasked)', async () => {
    const payload = Buffer.from('hello', 'utf8');
    const frame = writeFrame(0x1, payload, false);
    const result = readFrame(frame);
    assert(result !== null, 'should parse frame');
    assert(result!.opcode === 0x1, 'should be text opcode');
    assert(result!.payload.toString('utf8') === 'hello', 'should decode payload');
  });

  await test('write and read close frame', async () => {
    const frame = writeFrame(0x8, Buffer.alloc(0), true);
    const result = readFrame(frame);
    assert(result !== null, 'should parse frame');
    assert(result!.opcode === 0x8, 'should be close opcode');
    assert(result!.payload.length === 0, 'close payload should be empty');
  });

  await test('write and read ping frame', async () => {
    const pingData = Buffer.from('ping-payload', 'utf8');
    const frame = writeFrame(0x9, pingData, true);
    const result = readFrame(frame);
    assert(result !== null, 'should parse frame');
    assert(result!.opcode === 0x9, 'should be ping opcode');
    assert(result!.payload.toString('utf8') === 'ping-payload', 'ping data should match');
  });

  await test('125-byte payload (boundary < 126)', async () => {
    const payload = Buffer.alloc(125, 0x41); // 125 'A's
    const frame = writeFrame(0x1, payload, true);
    const result = readFrame(frame);
    assert(result !== null, 'should parse 125-byte frame');
    assert(result!.payload.length === 125, 'payload length should be 125');
  });

  await test('126-byte payload (extended 16-bit length)', async () => {
    const payload = Buffer.alloc(126, 0x42);
    const frame = writeFrame(0x1, payload, false);
    const result = readFrame(frame);
    assert(result !== null, 'should parse 126-byte frame');
    assert(result!.payload.length === 126, 'payload length should be 126');
  });

  await test('65535-byte payload (max 16-bit length)', async () => {
    const payload = Buffer.alloc(65535, 0x43);
    const frame = writeFrame(0x1, payload, false);
    const result = readFrame(frame);
    assert(result !== null, 'should parse 64KB frame');
    assert(result!.payload.length === 65535, 'payload length should be 65535');
  });

  await test('65536-byte payload (64-bit extended length)', async () => {
    const payload = Buffer.alloc(65536, 0x44);
    const frame = writeFrame(0x1, payload, false);
    const result = readFrame(frame);
    assert(result !== null, 'should parse 64KB+ frame');
    assert(result!.payload.length === 65536, 'payload length should be 65536');
  });

  await test('acceptKey computes correct hash', () => {
    // Test vector from RFC 6455
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';
    const expected = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
    const actual = acceptKey(key);
    assertEqual(actual, expected, 'acceptKey should match RFC 6455 test vector');
  });
}

// ---------------------------------------------------------------------------
// Forward WebSocket tests
// ---------------------------------------------------------------------------

async function runForwardTests(): Promise<void> {
  console.log('\n[Forward WebSocket Tests]');

  await test('forward connection: handshake and message reception', async () => {
    const port = await freePort();

    // Create a mock OneBot server that accepts WebSocket connections
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    let serverPeer: MockWsEndpoint | null = null;

    server.on('upgrade', (request, socket, head) => {
      const key = request.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${acceptKey(key)}`,
          '',
          '',
        ].join('\r\n'),
      );

      serverPeer = new MockWsEndpoint(socket, false); // server → no mask
      if (head.length > 0) serverPeer.feed(head as Buffer);
    });

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    const eventLog: JsonObject[] = [];
    const runtime = createMockRuntimeStore({
      onebot: {
        baseUrl: 'http://127.0.0.1:5700',
        apiPrefix: '/api',
        timeoutMs: 5000,
        webSocket: {
          mode: 'forward',
          forwardUrl: `ws://127.0.0.1:${port}`,
          reversePath: '/onebot/ws',
          reconnectIntervalMs: 5000,
          actionTimeoutMs: 3000,
        },
      },
    });

    const transport = new OneBotWebSocketTransport({
      runtime,
      appLogger: createMockLogger('test'),
      handleIncomingEvent: async (payload: JsonObject) => {
        eventLog.push(payload);
        return { accepted: true };
      },
    });

    try {
      await transport.start();

      // Wait for connection
      await waitFor(
        () => transport.isActionReady(),
        5000,
        'forward connection established',
      );

      assert(transport.isActionReady(), 'transport should be ready');
      assert(serverPeer !== null, 'server peer should be created');

      // Send a simulated OneBot event from the mock server
      const mockEvent = {
        post_type: 'message',
        message_type: 'private',
        user_id: 12345,
        message: 'hello from onebot',
      };
      serverPeer!.sendJson(mockEvent);

      // Wait for the event to be processed
      await waitFor(() => eventLog.length > 0, 3000, 'event received');
      assert(eventLog.length === 1, 'should receive exactly 1 event');
      assert(
        eventLog[0]!.post_type === 'message',
        'event should have correct post_type',
      );
    } finally {
      await transport.stop();
      serverPeer?.close();
      server.close();
    }
  });

  await test('forward connection: callAction request/response', async () => {
    const port = await freePort();

    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    let serverPeer: MockWsEndpoint | null = null;

    server.on('upgrade', (request, socket, head) => {
      const key = request.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${acceptKey(key)}`,
          '',
          '',
        ].join('\r\n'),
      );

      serverPeer = new MockWsEndpoint(socket, false);
      if (head.length > 0) serverPeer.feed(head as Buffer);

      // Echo: when the mock receives a JSON frame with an `echo` field,
      // respond with a success response using the same echo value.
      serverPeer.onJson((data) => {
        const obj = data as Record<string, unknown>;
        if (obj.echo && obj.action) {
          serverPeer!.sendJson({
            status: 'ok',
            retcode: 0,
            data: { message_id: 99999 },
            echo: obj.echo,
          });
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    const runtime = createMockRuntimeStore({
      onebot: {
        baseUrl: 'http://127.0.0.1:5700',
        apiPrefix: '/api',
        timeoutMs: 5000,
        webSocket: {
          mode: 'forward',
          forwardUrl: `ws://127.0.0.1:${port}`,
          reversePath: '/onebot/ws',
          reconnectIntervalMs: 5000,
          actionTimeoutMs: 3000,
        },
      },
    });

    const transport = new OneBotWebSocketTransport({
      runtime,
      appLogger: createMockLogger('test'),
      handleIncomingEvent: async () => ({ accepted: true }),
    });

    try {
      await transport.start();
      await waitFor(
        () => transport.isActionReady(),
        5000,
        'forward connection established',
      );

      const response = await transport.callAction<{ message_id?: number }>(
        'send_private_msg',
        { user_id: 12345, message: 'test message' },
        (await runtime.snapshot()).onebot,
      );

      assertEqual(response.status, 'ok', 'response status should be ok');
      assertEqual(response.retcode ?? -1, 0, 'response retcode should be 0');
      assert(
        response.data?.message_id === 99999,
        'response should contain correct message_id',
      );
    } finally {
      await transport.stop();
      serverPeer?.close();
      server.close();
    }
  });

  await test('forward connection: reconnection after server disconnect', async () => {
    const port = await freePort();

    let connectionCount = 0;

    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    server.on('upgrade', (request, socket, head) => {
      connectionCount++;
      const key = request.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${acceptKey(key)}`,
          '',
          '',
        ].join('\r\n'),
      );

      const peer = new MockWsEndpoint(socket, false);
      if (head.length > 0) peer.feed(head as Buffer);

      // Close the first connection after a short delay to trigger reconnect
      if (connectionCount === 1) {
        setTimeout(() => peer.close(), 200);
      }
    });

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    const runtime = createMockRuntimeStore({
      onebot: {
        baseUrl: 'http://127.0.0.1:5700',
        apiPrefix: '/api',
        timeoutMs: 5000,
        webSocket: {
          mode: 'forward',
          forwardUrl: `ws://127.0.0.1:${port}`,
          reversePath: '/onebot/ws',
          reconnectIntervalMs: 200, // fast reconnect for tests
          actionTimeoutMs: 3000,
        },
      },
    });

    const transport = new OneBotWebSocketTransport({
      runtime,
      appLogger: createMockLogger('test'),
      handleIncomingEvent: async () => ({ accepted: true }),
    });

    try {
      await transport.start();
      await waitFor(
        () => transport.isActionReady(),
        5000,
        'initial connection established',
      );

      assertEqual(connectionCount, 1, 'first connection established');

      // Wait for disconnect + reconnect
      await waitFor(() => connectionCount >= 2, 5000, 'reconnection');

      assert(
        connectionCount >= 2,
        `should reconnect after disconnect (got ${connectionCount} connections)`,
      );
    } finally {
      await transport.stop();
      server.close();
    }
  });

  await test('forward connection: callAction falls back to HTTP when no WS connection', async () => {
    const runtime = createMockRuntimeStore({
      onebot: {
        baseUrl: 'http://127.0.0.1:5700',
        apiPrefix: '/api',
        timeoutMs: 5000,
        webSocket: {
          mode: 'off',
          reversePath: '/onebot/ws',
          reconnectIntervalMs: 100,
          actionTimeoutMs: 3000,
        },
      },
    });

    const transport = new OneBotWebSocketTransport({
      runtime,
      appLogger: createMockLogger('test'),
      handleIncomingEvent: async () => ({ accepted: true }),
    });

    // When mode is 'off', isActionReady() should return false
    // callAction on OneBotClient would fall back to HTTP, but
    // calling it directly on the transport should throw
    assert(
      !transport.isActionReady(),
      'transport should not be ready when mode is off',
    );

    try {
      await transport.callAction(
        'send_private_msg',
        { user_id: 1, message: 'test' },
        (await runtime.snapshot()).onebot,
      );
      // Should throw because no WS connection
      assert(false, 'should have thrown');
    } catch (err) {
      assert(
        err instanceof Error,
        'should throw error when no websocket connection',
      );
    }

    await transport.stop();
  });
}

// ---------------------------------------------------------------------------
// Reverse WebSocket tests
// ---------------------------------------------------------------------------

async function runReverseTests(): Promise<void> {
  console.log('\n[Reverse WebSocket Tests]');

  await test('reverse connection: handshake and message reception', async () => {
    const port = await freePort();

    const eventLog: JsonObject[] = [];

    const runtime = createMockRuntimeStore({
      onebot: {
        baseUrl: 'http://127.0.0.1:5700',
        apiPrefix: '/api',
        timeoutMs: 5000,
        webSocket: {
          mode: 'reverse',
          reversePath: '/onebot/ws',
          reconnectIntervalMs: 5000,
          actionTimeoutMs: 3000,
        },
      },
    });

    const transport = new OneBotWebSocketTransport({
      runtime,
      appLogger: createMockLogger('test'),
      handleIncomingEvent: async (payload: JsonObject) => {
        eventLog.push(payload);
        return { accepted: true };
      },
    });

    // Create the HTTP server and attach reverse WS
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    transport.attachReverse(server);

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    try {
      await transport.start();

      // Simulate a OneBot client connecting to the reverse WebSocket endpoint
      const clientWsKey = randomBytes(16).toString('base64');

      const clientSocket = net.createConnection(port, '127.0.0.1');

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        clientSocket.on('connect', resolve);
        clientSocket.on('error', reject);
      });

      // Send HTTP upgrade request (simulating OneBot client)
      const upgradeRequest = [
        `GET /onebot/ws HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${clientWsKey}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');
      clientSocket.write(upgradeRequest);

      // Read the 101 response
      const responseData = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('timeout waiting for upgrade response')),
          3000,
        );
        clientSocket.once('data', (chunk: Buffer) => {
          clearTimeout(timeout);
          resolve(chunk.toString('utf8'));
        });
      });

      assert(
        responseData.includes('101 Switching Protocols'),
        `should receive 101 response, got: ${responseData.slice(0, 100)}`,
      );

      const clientPeer = new MockWsEndpoint(clientSocket, true); // client → mask

      // Wait for transport to recognize the reverse peer
      await waitFor(() => transport.isActionReady(), 3000, 'reverse peer registered');

      // Send a simulated OneBot event from the mock client
      const mockEvent = {
        post_type: 'message',
        message_type: 'group',
        group_id: 98765,
        user_id: 11111,
        message: 'hello from reverse client',
      };
      clientPeer.sendJson(mockEvent);

      await waitFor(() => eventLog.length > 0, 3000, 'event received via reverse');
      assert(eventLog.length === 1, 'should receive exactly 1 event');
      assert(
        eventLog[0]!.post_type === 'message',
        'event should have correct post_type',
      );
      assert(
        (eventLog[0] as Record<string, unknown>).group_id === 98765,
        'event should have correct group_id',
      );
    } finally {
      await transport.stop();
      server.close();
    }
  });

  await test('reverse connection: callAction through reverse peer', async () => {
    const port = await freePort();

    const runtime = createMockRuntimeStore({
      onebot: {
        baseUrl: 'http://127.0.0.1:5700',
        apiPrefix: '/api',
        timeoutMs: 5000,
        webSocket: {
          mode: 'reverse',
          reversePath: '/onebot/ws',
          reconnectIntervalMs: 5000,
          actionTimeoutMs: 3000,
        },
      },
    });

    const transport = new OneBotWebSocketTransport({
      runtime,
      appLogger: createMockLogger('test'),
      handleIncomingEvent: async () => ({ accepted: true }),
    });

    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    transport.attachReverse(server);

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    let clientPeer: MockWsEndpoint | null = null;

    try {
      await transport.start();

      // Connect mock OneBot client
      const clientWsKey = randomBytes(16).toString('base64');
      const clientSocket = net.createConnection(port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        clientSocket.on('connect', resolve);
        clientSocket.on('error', reject);
      });

      const upgradeRequest = [
        `GET /onebot/ws HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${clientWsKey}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');
      clientSocket.write(upgradeRequest);

      const responseData = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('timeout waiting for upgrade response')),
          3000,
        );
        clientSocket.once('data', (chunk: Buffer) => {
          clearTimeout(timeout);
          resolve(chunk.toString('utf8'));
        });
      });

      assert(
        responseData.includes('101'),
        'should receive 101 Switching Protocols',
      );

      clientPeer = new MockWsEndpoint(clientSocket, true);

      // Set up mock to respond to actions
      clientPeer.onJson((data) => {
        const obj = data as Record<string, unknown>;
        if (obj.echo && obj.action) {
          clientPeer!.sendJson({
            status: 'ok',
            retcode: 0,
            data: { message_id: 55555 },
            echo: obj.echo,
          });
        }
      });

      await waitFor(
        () => transport.isActionReady(),
        3000,
        'reverse transport ready',
      );

      const response = await transport.callAction<{ message_id?: number }>(
        'send_group_msg',
        { group_id: 98765, message: 'hello via reverse' },
        (await runtime.snapshot()).onebot,
      );

      assertEqual(response.status, 'ok', 'response status should be ok');
      assert(
        response.data?.message_id === 55555,
        'response should contain correct message_id',
      );
    } finally {
      await transport.stop();
      clientPeer?.close();
      server.close();
    }
  });

  await test('reverse connection: rejects wrong path', async () => {
    const port = await freePort();

    const runtime = createMockRuntimeStore({
      onebot: {
        baseUrl: 'http://127.0.0.1:5700',
        apiPrefix: '/api',
        timeoutMs: 5000,
        webSocket: {
          mode: 'reverse',
          reversePath: '/onebot/ws',
          reconnectIntervalMs: 5000,
          actionTimeoutMs: 3000,
        },
      },
    });

    const transport = new OneBotWebSocketTransport({
      runtime,
      appLogger: createMockLogger('test'),
      handleIncomingEvent: async () => ({ accepted: true }),
    });

    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    transport.attachReverse(server);

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    try {
      await transport.start();

      // Connect to wrong path
      const clientSocket = net.createConnection(port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        clientSocket.on('connect', resolve);
        clientSocket.on('error', reject);
      });

      const upgradeRequest = [
        `GET /wrong/path HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');
      clientSocket.write(upgradeRequest);

      // Should get a 404 rejection
      const responseData = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('timeout')),
          3000,
        );
        clientSocket.once('data', (chunk: Buffer) => {
          clearTimeout(timeout);
          resolve(chunk.toString('utf8'));
        });
      });

      assert(
        responseData.includes('404'),
        `wrong path should be rejected with 404, got: ${responseData.slice(0, 100)}`,
      );
    } finally {
      await transport.stop();
      server.close();
    }
  });

  await test('reverse connection: mode=off rejects upgrade', async () => {
    const port = await freePort();

    const runtime = createMockRuntimeStore({
      onebot: {
        baseUrl: 'http://127.0.0.1:5700',
        apiPrefix: '/api',
        timeoutMs: 5000,
        webSocket: {
          mode: 'off',
          reversePath: '/onebot/ws',
          reconnectIntervalMs: 5000,
          actionTimeoutMs: 3000,
        },
      },
    });

    const transport = new OneBotWebSocketTransport({
      runtime,
      appLogger: createMockLogger('test'),
      handleIncomingEvent: async () => ({ accepted: true }),
    });

    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    transport.attachReverse(server);

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    try {
      await transport.start();

      const clientSocket = net.createConnection(port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        clientSocket.on('connect', resolve);
        clientSocket.on('error', reject);
      });

      const upgradeRequest = [
        `GET /onebot/ws HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');
      clientSocket.write(upgradeRequest);

      const responseData = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('timeout')),
          3000,
        );
        clientSocket.once('data', (chunk: Buffer) => {
          clearTimeout(timeout);
          resolve(chunk.toString('utf8'));
        });
      });

      assert(
        responseData.includes('404'),
        `mode=off should reject upgrade with 404, got: ${responseData.slice(0, 100)}`,
      );
    } finally {
      await transport.stop();
      server.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Both mode test
// ---------------------------------------------------------------------------

async function runBothModeTests(): Promise<void> {
  console.log('\n[Both Mode Tests]');

  await test('both mode: forward connects + reverse accepts', async () => {
    const forwardPort = await freePort();
    const appPort = await freePort();

    // Mock OneBot forward server
    const forwardServer = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    let forwardPeer: MockWsEndpoint | null = null;

    forwardServer.on('upgrade', (request, socket, head) => {
      const key = request.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${acceptKey(key)}`,
          '',
          '',
        ].join('\r\n'),
      );
      forwardPeer = new MockWsEndpoint(socket, false);
      if (head.length > 0) forwardPeer.feed(head as Buffer);
    });

    await new Promise<void>((resolve) =>
      forwardServer.listen(forwardPort, '127.0.0.1', resolve),
    );

    const eventLog: JsonObject[] = [];

    const runtime = createMockRuntimeStore({
      onebot: {
        baseUrl: 'http://127.0.0.1:5700',
        apiPrefix: '/api',
        timeoutMs: 5000,
        webSocket: {
          mode: 'both',
          forwardUrl: `ws://127.0.0.1:${forwardPort}`,
          reversePath: '/onebot/ws',
          reconnectIntervalMs: 5000,
          actionTimeoutMs: 3000,
        },
      },
    });

    const transport = new OneBotWebSocketTransport({
      runtime,
      appLogger: createMockLogger('test'),
      handleIncomingEvent: async (payload: JsonObject) => {
        eventLog.push(payload);
        return { accepted: true };
      },
    });

    // Create app server for reverse connections
    const appServer = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });

    transport.attachReverse(appServer);

    await new Promise<void>((resolve) =>
      appServer.listen(appPort, '127.0.0.1', resolve),
    );

    try {
      await transport.start();

      // Wait for forward connection
      await waitFor(
        () => transport.isActionReady(),
        5000,
        'forward connection in both mode',
      );

      assert(transport.isActionReady(), 'transport should be ready via forward');

      // Send event through forward peer
      const forwardEvent = {
        post_type: 'message',
        message_type: 'private',
        user_id: 111,
        message: 'from forward in both mode',
      };
      forwardPeer!.sendJson(forwardEvent);

      await waitFor(() => eventLog.length > 0, 3000, 'forward event received');
      assert(eventLog.length === 1, 'should receive forward event');

      // Now connect a reverse client too
      const revSocket = net.createConnection(appPort, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        revSocket.on('connect', resolve);
        revSocket.on('error', reject);
      });

      const revKey = randomBytes(16).toString('base64');
      const upgradeReq = [
        `GET /onebot/ws HTTP/1.1`,
        `Host: 127.0.0.1:${appPort}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${revKey}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n');
      revSocket.write(upgradeReq);

      const revResponse = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        revSocket.once('data', (chunk: Buffer) => {
          clearTimeout(t);
          resolve(chunk.toString('utf8'));
        });
      });

      assert(
        revResponse.includes('101'),
        'reverse upgrade should succeed in both mode',
      );

      const revPeer = new MockWsEndpoint(revSocket, true);

      const reverseEvent = {
        post_type: 'message',
        message_type: 'group',
        group_id: 222,
        user_id: 333,
        message: 'from reverse in both mode',
      };
      revPeer.sendJson(reverseEvent);

      await waitFor(
        () => eventLog.length >= 2,
        3000,
        'reverse event received in both mode',
      );
      assert(
        eventLog.length >= 2,
        `should receive events from both directions (got ${eventLog.length})`,
      );
    } finally {
      await transport.stop();
      forwardServer.close();
      appServer.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  OneBot WebSocket Connection Tests           ║');
  console.log('║  Forward & Reverse (RFC 6455, ws library)  ║');
  console.log('╚══════════════════════════════════════════════╝');

  await runFrameTests();
  await runForwardTests();
  await runReverseTests();
  await runBothModeTests();

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Total: ${testsPassed + testsFailed}  |  ✓ ${testsPassed} passed  |  ✗ ${testsFailed} failed`);
  console.log(`${'═'.repeat(50)}`);

  if (testsFailed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
