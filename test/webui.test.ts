/**
 * WebUI security tests
 *
 * Boots a real Hapi server and exercises the auth surface end to end:
 * session-token minting/revocation, secret redaction, login rate limiting,
 * and CORS policy.
 *
 * Run: npx tsx test/webui.test.ts
 */
import { createWebServer } from '../src/webui';
import type { AppSettings, RuntimeState } from '../src/types';
import {
  createDefaultAppSettings,
  createDefaultRuntimeState,
} from '../src/config';

const PASSWORD = 'super-secret-pw';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

const silent = {
  info() {}, warn() {}, error() {}, debug() {},
  child(): any { return silent; },
} as any;

async function main(): Promise<void> {
  console.log('WebUI Security Tests');
  console.log('='.repeat(50));

  const runtimeState: RuntimeState = createDefaultRuntimeState();
  runtimeState.ui.password = PASSWORD;
  runtimeState.models.language = [
    {
      id: 'm1', label: 'M1', family: 'language', provider: 'openai-compatible',
      enabled: true, taskBindings: ['summary'],
      parameters: { baseUrl: 'https://x/v1', apiKey: 'sk-SECRETKEY123456', model: 'm' },
    },
  ];

  const settings: AppSettings = { ...createDefaultAppSettings(), port: 39217, host: '127.0.0.1' };

  const runtime = {
    async snapshot() { return runtimeState; },
    async update(fn: any) { await fn(runtimeState); return runtimeState; },
    async replace(s: any) { return s; },
  } as any;

  const config = {
    async snapshotConfig() { return { settings, runtime: runtimeState }; },
    async ensureReady() {},
    async replaceConfig(c: any) { return c; },
  } as any;

  const empty = async () => [];
  const server = await createWebServer({
    settings,
    config,
    runtime,
    models: {
      async listModels() { return runtimeState.models.language; },
      listTasks() { return ['summary']; },
      listFamilies() { return ['language', 'embedding', 'rerank', 'speech-to-text']; },
      async hasOnlyFallbackModels() { return false; },
    } as any,
    plugins: { async list() { return []; } } as any,
    summaries: { async status() { return {}; }, async start() {} } as any,
    knowledge: { async list() { return []; } } as any,
    storage: {
      listSummaries: empty, listAdvice: empty, listCommands: empty, listEventsAfter: empty,
      countKnowledgeEntries: async () => 0,
    } as any,
    handleIncomingEvent: async () => ({}),
    appLogger: silent,
  });

  await server.start();
  const base = `http://127.0.0.1:${settings.port}`;

  console.log('\n[Session token flow]');

  // 1. Unauthenticated API access is rejected.
  const anon = await fetch(`${base}/api/state`);
  check('unauthenticated /api/state returns 401', anon.status === 401);

  // 2. Wrong password rejected.
  const bad = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'nope' }),
  });
  check('wrong password returns 401', bad.status === 401);

  // 3. Correct password mints a token that is NOT derived from the password.
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const { token } = (await login.json()) as { token: string };
  check('login succeeds', login.status === 200 && typeof token === 'string' && token.length > 20);
  check(
    'token is NOT base64(password)',
    token !== Buffer.from(PASSWORD).toString('base64'),
  );
  check(
    'password is not recoverable from token',
    !Buffer.from(token, 'base64url').toString('utf8').includes(PASSWORD),
  );

  // 4. Token works via header.
  const viaHeader = await fetch(`${base}/api/state`, { headers: { 'x-admin-token': token } });
  check('token authenticates via x-admin-token header', viaHeader.status === 200);

  // 5. Secrets are redacted in the response.
  const state = (await viaHeader.json()) as any;
  const body = JSON.stringify(state);
  check('apiKey is not leaked in /api/state', !body.includes('sk-SECRETKEY123456'));
  check('ui password is not leaked in /api/state', !body.includes(PASSWORD));

  // 6. Logout revokes the token.
  await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'x-admin-token': token } });
  const afterLogout = await fetch(`${base}/api/state`, { headers: { 'x-admin-token': token } });
  check('token is rejected after logout', afterLogout.status === 401);

  // 7. Password change invalidates outstanding sessions.
  const l2 = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const t2 = ((await l2.json()) as { token: string }).token;
  const ok2 = await fetch(`${base}/api/state`, { headers: { 'x-admin-token': t2 } });
  check('new session works', ok2.status === 200);
  runtimeState.ui.password = 'a-different-password';
  const afterChange = await fetch(`${base}/api/state`, { headers: { 'x-admin-token': t2 } });
  check('session invalidated after password change', afterChange.status === 401);
  runtimeState.ui.password = PASSWORD;

  // 8. Password can be set from the dashboard; short passwords are rejected.
  //    (Must run before the brute-force test below, which locks out this IP.)
  const l3 = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const t3 = ((await l3.json()) as { token: string }).token;
  const tooShort = await fetch(`${base}/api/ui-password`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': t3 },
    body: JSON.stringify({ password: '123' }),
  });
  check('short password rejected with 400', tooShort.status === 400);
  const setPw = await fetch(`${base}/api/ui-password`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': t3 },
    body: JSON.stringify({ password: 'brand-new-password' }),
  });
  const setPwBody = (await setPw.json()) as { ok: boolean; token: string };
  check('password change succeeds and returns a fresh token', setPw.status === 200 && !!setPwBody.token);
  const oldAfterPw = await fetch(`${base}/api/state`, { headers: { 'x-admin-token': t3 } });
  check('old session dies after password change via API', oldAfterPw.status === 401);
  const newAfterPw = await fetch(`${base}/api/state`, { headers: { 'x-admin-token': setPwBody.token } });
  check('fresh token from password change works', newAfterPw.status === 200);
  runtimeState.ui.password = PASSWORD;

  // 9. Login rate limiting kicks in.
  let sawLockout = false;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    if (r.status === 429) sawLockout = true;
  }
  check('brute-force attempts are rate limited (429)', sawLockout);

  // 9. No CORS wildcard.
  const corsProbe = await fetch(`${base}/api/state`, { headers: { origin: 'http://evil.test' } });
  check(
    'no access-control-allow-origin wildcard',
    corsProbe.headers.get('access-control-allow-origin') !== '*',
  );

  // 10. Dashboard page ships a Content-Security-Policy.
  const page = await fetch(`${base}${settings.uiPath}`);
  const csp = page.headers.get('content-security-policy') ?? '';
  check('UI page sends a CSP header', csp.includes("default-src 'none'"));
  check('UI page sends no-referrer policy', page.headers.get('referrer-policy') === 'no-referrer');

  await server.stop();

  console.log('\n' + '='.repeat(50));
  console.log(`  Total: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}`);
  console.log('='.repeat(50));
  if (failed > 0) process.exitCode = 1;
}

void main();
