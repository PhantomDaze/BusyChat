import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

import Hapi from '@hapi/hapi';

import { normalizeAppConfig } from './config';
import { listProviderSchemas } from './model-schema';
import {
  credentialFingerprint,
  effectiveClientIp,
  hashPassword,
  hasUiCredential,
  isLoopbackAddress,
  isLoopbackHost,
  isProxiedRequest,
  originAllowed,
  REDACTED,
  redactConfig,
  redactModels,
  safeEqual,
  verifyPassword,
} from './security';
import type {
  AppConfigFile,
  AppConfigStore,
  AppServices,
  AppSettings,
  JsonObject,
  Logger,
  ModelConfig,
  ModelTask,
  UiSettings,
  WebUiRouteHandler,
} from './types';

/** 归一化 baseUrl（去空白与末尾斜杠），用于判断密钥回填目标是否未变。 */
function normalizeBaseUrl(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
}

/**
 * 仅当模型 id 对应的已保存模型 family、provider、baseUrl 全部一致时，才把
 * `__redacted__` 回填成真实 apiKey。否则删除密钥并返回 warning：
 * 防止把已保存的密钥发往/保存到被改写过的上游地址（密钥外泄）。
 */
function restoreModelApiKey(
  next: ModelConfig,
  existing: ModelConfig | undefined,
): string | null {
  if (!next.parameters || next.parameters.apiKey !== REDACTED) return null;

  if (
    !existing ||
    existing.family !== next.family ||
    existing.provider !== next.provider ||
    normalizeBaseUrl(next.parameters.baseUrl) === '' ||
    normalizeBaseUrl(next.parameters.baseUrl) !== normalizeBaseUrl(existing.parameters?.baseUrl)
  ) {
    delete next.parameters.apiKey;
    return `模型 "${next.id}" 的 baseUrl/provider/family 已变更，出于安全考虑未恢复已保存的 apiKey`;
  }

  const prevKey = existing.parameters?.apiKey;
  if (typeof prevKey === 'string' && prevKey.length > 0) {
    next.parameters.apiKey = prevKey;
    return null;
  }

  delete next.parameters.apiKey;
  return `模型 "${next.id}" 没有可恢复的 apiKey`;
}

/**
 * When the client saves a config it read back in redacted form, swap each
 * `__redacted__` marker back to the real secret from the current config.
 * ONLY the marker is restored: a key the operator deleted or blanked stays
 * cleared, so rotating out a leaked token actually removes it. Returns
 * warnings for markers that could not be resolved (e.g. a renamed model id),
 * because in that case the secret is silently dropped.
 */
function restoreSecrets(next: AppConfigFile, current: AppConfigFile): string[] {
  const warnings: string[] = [];

  if (next.runtime?.ui) {
    if (next.runtime.ui.passwordHash === REDACTED) {
      const prevHash = current.runtime?.ui?.passwordHash;
      if (prevHash) next.runtime.ui.passwordHash = prevHash;
      else delete next.runtime.ui.passwordHash;
    }
    if (next.runtime.ui.password === REDACTED) {
      next.runtime.ui.password = current.runtime?.ui?.password ?? '';
    }
    if (next.runtime.ui.authToken === REDACTED) {
      const prev = current.runtime?.ui?.authToken;
      if (prev) next.runtime.ui.authToken = prev;
      else delete next.runtime.ui.authToken;
    }
  }
  if (next.runtime?.onebot && next.runtime.onebot.accessToken === REDACTED) {
    const prev = current.runtime?.onebot?.accessToken;
    if (prev) next.runtime.onebot.accessToken = prev;
    else delete next.runtime.onebot.accessToken;
  }
  const currentModels = new Map<string, ModelConfig>();
  for (const group of Object.values(current.runtime?.models ?? {})) {
    for (const m of group) currentModels.set(m.id, m);
  }
  for (const group of Object.values(next.runtime?.models ?? {})) {
    for (const model of group) {
      const warning = restoreModelApiKey(model, currentModels.get(model.id));
      if (warning) warnings.push(warning);
    }
  }
  return warnings;
}

/**
 * 从 WebUI 的「测试连接 / 拉取模型」请求构造一个探针 ModelConfig。
 * apiKey 若为 REDACTED 标记，则从已保存的同 id 模型恢复真实密钥 ——
 * 前端只回传标记，不参与密钥的明文往返。
 */
async function buildProbeModel(
  deps: WebServerDependencies,
  payload: JsonObject | undefined,
): Promise<{ model: ModelConfig; warning: string | null } | null> {
  if (!payload || Array.isArray(payload)) return null;
  const family = typeof payload.family === 'string' ? payload.family : '';
  const provider = typeof payload.provider === 'string' ? payload.provider.trim() : '';
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  const rawParams = payload.parameters && typeof payload.parameters === 'object' ? payload.parameters : {};
  const params: JsonObject = { ...(rawParams as JsonObject) };

  if (!deps.models.listFamilies().includes(family as ModelConfig['family'])) return null;
  if (!provider) return null;

  const model: ModelConfig = {
    id: id || 'probe',
    label: '',
    family: family as ModelConfig['family'],
    provider,
    enabled: true,
    taskBindings: [],
    parameters: params,
  };

  // 只有目标地址/供应商未变时才恢复真实密钥（见 restoreModelApiKey）。
  const existing = id ? (await deps.models.listModels()).find((m) => m.id === id) : undefined;
  const warning = restoreModelApiKey(model, existing);
  if (warning) {
    deps.appLogger.warn('probe apiKey was not restored', { modelId: model.id, reason: warning });
  }

  return { model, warning };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 结构化管理审计日志：只记录动作、目标、远端地址、结果与警告数，
 * 绝不写入密码、令牌或 API Key。
 */
function auditLog(
  deps: WebServerDependencies,
  request: Hapi.Request,
  trustProxy: boolean,
  action: string,
  target: string,
  result: string,
  warnings = 0,
): void {
  deps.appLogger.info('audit', {
    action,
    target,
    remoteAddress: effectiveClientIp(request, trustProxy) || 'unknown',
    result,
    warnings,
  });
}

/**
 * 匹配插件路由模板到实际路径。支持字面量、`{param}` 与 `:param` 段；
 * 返回的路径参数会并入 query 与 payload。不匹配返回 null。
 */
function matchPluginRoute(pattern: string, actualPath: string): Record<string, string> | null {
  const patternSegments = pattern.split('/');
  const actualSegments = actualPath.split('/');
  if (patternSegments.length !== actualSegments.length) return null;

  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const expected = patternSegments[index] ?? '';
    const actual = actualSegments[index] ?? '';
    let name: string | undefined;
    if (expected.startsWith('{') && expected.endsWith('}')) {
      name = expected.slice(1, -1);
    } else if (expected.startsWith(':') && expected.length > 1) {
      name = expected.slice(1);
    }
    if (name) {
      if (!actual) return null;
      params[name] = actual;
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

/** listProviders 缺失时的兜底：内置 schema 声明的 provider + 规则回退。 */
function fallbackProviderNames(): string[] {
  const names = new Set(listProviderSchemas().map((schema) => schema.provider));
  names.add('rule-based');
  return [...names];
}

/** 校验字符串是否为 http(s) URL。 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

interface WebServerDependencies {
  settings: AppSettings;
  config: AppConfigStore;
  runtime: AppServices['runtime'];
  models: AppServices['models'];
  plugins: AppServices['plugins'];
  summaries?: AppServices['summaries'];
  knowledge?: AppServices['knowledge'];
  storage: AppServices['storage'];
  oneBotWebSocket?: {
    restart(): Promise<void>;
    getStatus(): { forwardConnected: boolean; reverseConnected: boolean; reversePeerCount: number; stopped: boolean; lastPongAt: number | null };
  };
  handleIncomingEvent: (payload: JsonObject, headers: Record<string, unknown>) => Promise<unknown>;
  appLogger: Logger;
}

// ---- 静态 WebUI 托管 ----
// 前端是独立构建的 Vue SPA（webui/ → webui-dist/）。这里只提供静态文件：
// 鉴权由 /api/* 路由负责，页面本身总是可加载，由前端决定展示登录页还是仪表盘。
const WEBUI_DIST = resolve(__dirname, '..', 'webui-dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
};

/**
 * SPA 的 CSP：Vuetify 依赖内联样式，Monaco 的 worker 走 blob/同源脚本；
 * 其余仍限制为同源，避免第三方脚本被注入到管理面板。
 */
const UI_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

interface StaticAsset {
  body: Buffer;
  type: string;
}

async function readStaticAsset(subPath: string): Promise<StaticAsset | null> {
  const normalized = subPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return null;
  const target = resolve(WEBUI_DIST, normalized);
  // 路径穿越保护：只允许读取 webui-dist 目录下的文件
  if (target !== WEBUI_DIST && !target.startsWith(`${WEBUI_DIST}${sep}`)) return null;
  try {
    const body = await readFile(target);
    return { body, type: MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

const UI_NOT_BUILT_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BusyChat WebUI 未构建</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:#1a1a1a;color:#e8eaed;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
  .card{max-width:560px;background:#242424;border:1px solid #333;border-radius:14px;padding:28px 30px}
  h1{font-size:18px;margin:0 0 8px}
  p{color:#a7adb8;font-size:13px;line-height:1.7;margin:8px 0}
  code{background:#1a1a1a;border:1px solid #3a3a3a;border-radius:6px;padding:2px 6px;font-size:12px;color:#8ec5e8}
  pre{background:#151515;border:1px solid #333;border-radius:8px;padding:12px 14px;overflow:auto;font-size:12px;color:#c8d0da}
</style>
</head>
<body>
<div class="card">
  <h1>WebUI 前端尚未构建 / WebUI frontend not built</h1>
  <p>后端已经启动，但没有找到 <code>webui-dist/</code> 构建产物。</p>
  <p>Build the dashboard first, then reload this page:</p>
  <pre>npm run install:webui
npm run build:webui</pre>
  <p>只跑后端时仍然可以使用全部 HTTP API（<code>/api/*</code>）。</p>
</div>
</body>
</html>`;

/** 给静态响应统一附加安全头 */
function applyUiHeaders(response: Hapi.ResponseObject): Hapi.ResponseObject {
  return response
    .header('content-security-policy', UI_CSP)
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff');
}

/** 读取 package.json 版本号（只读一次，失败不阻塞） */
let cachedVersion: Promise<string | undefined> | undefined;
function readPackageVersion(): Promise<string | undefined> {
  if (!cachedVersion) {
    cachedVersion = readFile(resolve(__dirname, '..', 'package.json'), 'utf8')
      .then((raw) => {
        const parsed = JSON.parse(raw) as { version?: unknown };
        return typeof parsed.version === 'string' ? parsed.version : undefined;
      })
      .catch(() => undefined);
  }
  return cachedVersion;
}

/** Hapi 的 header/query 值可能是数组，统一收敛为单个字符串 */
function readHeaderValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * 仅从请求头读取会话/旧版令牌（不再接受 query string，避免令牌进入日志、
 * 浏览器历史和 Referer）。
 */
function readSessionToken(request: Hapi.Request): string {
  return readHeaderValue(request.headers['x-admin-token']) ?? '';
}

/** 旧版明文密码只有达到最小长度才被视为有效凭据。 */
function legacyPasswordCredential(ui: UiSettings): string | undefined {
  return ui.password && ui.password.length >= 6 ? ui.password : undefined;
}

/**
 * WebUI 鉴权（fail-closed）：
 * - 配置了 passwordHash / 有效旧版 password / authToken 时，必须提供有效会话或令牌；
 * - 完全未配置凭据时，只允许“真正的本机直连”访问（回环地址且无代理头），
 *   其余请求一律 401 —— 不再因为没设密码就放行所有来源。
 */
function requireUiAuth(
  request: Hapi.Request,
  sessions: SessionStore,
  trustProxy: boolean,
  ui: UiSettings,
): boolean {
  const legacyPassword = legacyPasswordCredential(ui);
  const hasPassword = Boolean(ui.passwordHash || legacyPassword);
  const hasCredential = hasPassword || Boolean(ui.authToken);

  if (!hasCredential) {
    return (
      isLoopbackAddress(effectiveClientIp(request, trustProxy)) &&
      !isProxiedRequest(request) &&
      isLoopbackHost(readHeaderValue(request.headers.host) ?? request.info.host)
    );
  }

  const token = readSessionToken(request);
  if (!token) return false;

  if (hasPassword && sessions.verify(token, ui, Date.now())) return true;
  if (ui.authToken && safeEqual(token, ui.authToken)) return true;
  return false;
}

/** 无凭据时返回可操作的 401 文案（提示管理员设置密码）。 */
function uiUnauthorizedMessage(ui: UiSettings): string {
  if (!ui.passwordHash && !legacyPasswordCredential(ui) && !ui.authToken) {
    return 'no WebUI password is configured; only local requests are allowed — set a password in the WebUI';
  }
  return 'unauthorized';
}

/**
 * OneBot 事件入口鉴权：未配置 accessToken 时只允许本机直连，
 * 代理转发或远程来源一律拒绝。配置了 token 时使用常量时间比较。
 */
function requireOneBotAuth(request: Hapi.Request, trustProxy: boolean, accessToken?: string): boolean {
  if (!accessToken) {
    return (
      isLoopbackAddress(effectiveClientIp(request, trustProxy)) &&
      !isProxiedRequest(request) &&
      isLoopbackHost(readHeaderValue(request.headers.host) ?? request.info.host)
    );
  }

  const auth = readHeaderValue(request.headers.authorization);
  if (auth?.startsWith('Bearer ')) {
    return safeEqual(auth.slice('Bearer '.length), accessToken);
  }

  const headerToken = readHeaderValue(request.headers['x-access-token']);
  return headerToken ? safeEqual(headerToken, accessToken) : false;
}

async function getState(deps: WebServerDependencies) {
  const config = await deps.config.snapshotConfig();
  const [models, plugins, summaries, advice, commands, events, kbCount] = await Promise.all([
    deps.models.listModels(),
    deps.plugins.list(),
    deps.storage.listSummaries(10),
    deps.storage.listAdvice(10),
    deps.storage.listCommands(20),
    deps.storage.listEventsAfter(undefined, 25),
    deps.storage.countKnowledgeEntries(),
  ]);
  const summaryStatus = deps.summaries ? await deps.summaries.status() : undefined;
  const knowledgeStatus = deps.knowledge ? await deps.knowledge.status() : undefined;
  const fallbackOnly = await deps.models.hasOnlyFallbackModels();

  const safeConfig = redactConfig(config);

  return {
    config: safeConfig,
    settings: safeConfig.settings,
    runtime: safeConfig.runtime,
    models: redactModels(models),
    plugins,
    summaries,
    advice,
    commands,
    events,
    kbCount,
    fallbackOnly,
    summaryStatus,
    knowledgeStatus,
    tasks: deps.models.listTasks(),
    families: deps.models.listFamilies(),
    // 模型参数 schema：前端据此动态渲染 provider 配置表单
    modelSchema: listProviderSchemas(),
    // 后端版本号，供前端顶栏展示
    version: await readPackageVersion(),
  };
}

/**
 * Server-side session store for the dashboard.
 *
 * Replaces the previous scheme where the "token" was base64(password): that was
 * reversible (leaking the token leaked the admin password), never expired, and
 * could not be revoked. Sessions here are high-entropy random ids with a TTL,
 * bound to a fingerprint of the password that created them — so changing the
 * password invalidates every outstanding session.
 */
class SessionStore {
  private sessions = new Map<string, { expiresAt: number; fingerprint: string }>();
  private static readonly TTL_MS = 12 * 60 * 60 * 1000;
  private static readonly MAX_SESSIONS = 100;

  create(ui: UiSettings, now: number): string {
    this.prune(now);
    if (this.sessions.size >= SessionStore.MAX_SESSIONS) {
      // Drop the session closest to expiry to bound memory.
      let oldest: string | undefined;
      let oldestExp = Infinity;
      for (const [token, meta] of this.sessions) {
        if (meta.expiresAt < oldestExp) {
          oldestExp = meta.expiresAt;
          oldest = token;
        }
      }
      if (oldest) this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, {
      expiresAt: now + SessionStore.TTL_MS,
      fingerprint: credentialFingerprint(ui),
    });
    return token;
  }

  verify(token: string, ui: UiSettings, now: number): boolean {
    const meta = this.sessions.get(token);
    if (!meta) return false;
    if (now >= meta.expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    // 凭据（passwordHash / 旧版 password）变化后，旧会话全部失效。
    if (meta.fingerprint !== credentialFingerprint(ui)) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  destroy(token: string): void {
    this.sessions.delete(token);
  }

  private prune(now: number): void {
    for (const [token, meta] of this.sessions) {
      if (now >= meta.expiresAt) this.sessions.delete(token);
    }
  }
}

/** Simple per-IP login throttle: lock out after too many failures. */
class LoginThrottle {
  private attempts = new Map<string, { count: number; until: number }>();
  private static readonly MAX = 5;
  private static readonly WINDOW_MS = 5 * 60 * 1000;
  private static readonly MAX_ENTRIES = 10_000;

  isLocked(ip: string, now: number): boolean {
    const rec = this.attempts.get(ip);
    return Boolean(rec && rec.count >= LoginThrottle.MAX && now < rec.until);
  }

  recordFailure(ip: string, now: number): void {
    // Bound the map: an unauthenticated scan hitting /api/login from many
    // source IPs must not grow memory without limit. Sweep expired entries
    // first; if still full, drop the oldest insertion.
    if (this.attempts.size >= LoginThrottle.MAX_ENTRIES) {
      for (const [key, rec] of this.attempts) {
        if (now >= rec.until) this.attempts.delete(key);
      }
      while (this.attempts.size >= LoginThrottle.MAX_ENTRIES) {
        const oldest = this.attempts.keys().next().value;
        if (oldest === undefined) break;
        this.attempts.delete(oldest);
      }
    }
    const rec = this.attempts.get(ip);
    if (!rec || now >= rec.until) {
      this.attempts.set(ip, { count: 1, until: now + LoginThrottle.WINDOW_MS });
    } else {
      rec.count += 1;
      rec.until = now + LoginThrottle.WINDOW_MS;
    }
  }

  reset(ip: string): void {
    this.attempts.delete(ip);
  }
}

export async function createWebServer(deps: WebServerDependencies): Promise<Hapi.Server> {
  const loginThrottle = new LoginThrottle();
  const sessions = new SessionStore();
  const trustProxy = deps.settings.trustProxy === true;
  // Paths that must keep working even when the dashboard is disabled: health
  // checks and OneBot event ingestion. Everything else (dashboard + admin API)
  // is gated on runtime.ui.enabled.
  const alwaysOn = new Set(['/health', '/health/ready', deps.settings.eventPath]);
  // 归一化 uiPath：去掉结尾斜杠，根路径单独处理（根路径下不再重定向，避免自环）
  const uiPath = deps.settings.uiPath.replace(/\/+$/, '') || '/';
  const uiBasePath = uiPath === '/' ? '/' : `${uiPath}/`;
  const server = Hapi.server({
    host: deps.settings.host,
    port: deps.settings.port,
    routes: {
      // No CORS: the dashboard is same-origin. `cors: true` would emit
      // `access-control-allow-origin: *`, letting any web page the operator
      // visits read the admin API (and its secrets) cross-origin.
      cors: false,
      security: true,
    },
  });

  // 管理员 API 的 JSON 载荷限制：只接受 application/json，最大 2 MiB。
  const API_PAYLOAD = { allow: ['application/json'], maxBytes: 2 * 1024 * 1024 };
  const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  let warnedProxyHeaders = false;

  server.ext('onPreAuth', async (request, h) => {
    if (alwaysOn.has(request.path)) return h.continue;

    // 保持原有语义：仪表盘关闭时，非 alwaysOn 路径一律 404。
    const runtime = await deps.runtime.snapshot();
    if (runtime.ui.enabled === false) {
      return h.response({ error: 'web ui is disabled' }).code(404).takeover();
    }

    // CSRF 防护：浏览器发起的写操作必须与当前 Host 同源。
    if (request.path.startsWith('/api/') && MUTATING_METHODS.has(request.method.toUpperCase())) {
      if (!originAllowed(request, trustProxy)) {
        deps.appLogger.warn('cross-origin admin request rejected', {
          path: request.path,
          origin: typeof request.headers.origin === 'string' ? request.headers.origin : '',
        });
        return h.response({ error: 'cross-origin request rejected' }).code(403).takeover();
      }
    }

    // trustProxy=false 却收到代理头：说明部署方式与配置不符，日志提示一次。
    if (
      !trustProxy &&
      !warnedProxyHeaders &&
      request.path.startsWith('/api/') &&
      isProxiedRequest(request)
    ) {
      warnedProxyHeaders = true;
      deps.appLogger.warn(
        'proxy headers detected on an admin request but settings.trustProxy is false — client IP is the proxy address and forwarded requests are treated as non-local. Enable trustProxy only when the app is reachable exclusively through a trusted reverse proxy.',
        { path: request.path },
      );
    }

    return h.continue;
  });

  // API 与事件响应不应被缓存，也不应被浏览器嗅探或泄漏 Referer。
  // 同时统一记录服务端错误（5xx 或 Boom），便于在生产环境定位问题。
  server.ext('onPreResponse', (request, h) => {
    const response = request.response as
      | (Hapi.ResponseObject & {
          isBoom?: boolean;
          stack?: unknown;
          statusCode?: number;
          output?: { statusCode?: number; headers: Record<string, string> };
        })
      | undefined;
    const statusCode =
      typeof response?.output?.statusCode === 'number'
        ? response.output.statusCode
        : typeof response?.statusCode === 'number'
          ? response.statusCode
          : response?.isBoom
            ? 500
            : undefined;
    if (response?.isBoom || (statusCode !== undefined && statusCode >= 500)) {
      const meta: JsonObject = {
        method: request.method.toUpperCase(),
        path: request.path,
        status: statusCode ?? 500,
      };
      if (response && typeof response.stack === 'string') {
        meta.stack = response.stack;
      }
      deps.appLogger.error('http error response', meta);
    }

    if (request.path.startsWith('/api/') || request.path === deps.settings.eventPath) {
      if (response?.isBoom && response.output) {
        response.output.headers['cache-control'] = 'no-store';
        response.output.headers['x-content-type-options'] = 'nosniff';
        response.output.headers['referrer-policy'] = 'no-referrer';
      } else if (response && typeof response.header === 'function') {
        response
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff')
          .header('referrer-policy', 'no-referrer');
      }
    }
    return h.continue;
  });

  if (uiPath !== '/') {
    // 前端使用 hash 路由；不带结尾斜杠时补斜杠，保证相对静态资源解析正确。
    // 重定向保留 query（旧版 /ui?t=<token> 链接仍可登录）。
    server.route({
      method: 'GET',
      path: uiPath,
      handler: (request, h) => h.redirect(`${uiBasePath}${request.url.search}`),
    });
  }

  const routes: Hapi.ServerRoute[] = [
    {
      method: 'GET',
      path: '/health',
      handler: () => ({ ok: true, service: 'f261agent' }),
    },
    {
      // 就绪探针：存储不可用时返回 503；仅回退模型/传输断开属于降级（仍 200）。
      method: 'GET',
      path: '/health/ready',
      handler: async (_request, h) => {
        const runtime = await deps.runtime.snapshot();
        const storageHealth = deps.storage.getHealth?.();
        const storageOk = storageHealth ? storageHealth.ok : true;
        const fallbackOnly = await deps.models.hasOnlyFallbackModels();
        const mode = runtime.onebot.webSocket.mode;
        const transport = deps.oneBotWebSocket?.getStatus();
        const forwardConnected = transport?.forwardConnected === true;
        const reverseConnected = transport?.reverseConnected === true;

        let transportOk = true;
        if (mode === 'forward') transportOk = forwardConnected;
        else if (mode === 'reverse') transportOk = reverseConnected;
        else if (mode === 'both') transportOk = forwardConnected && reverseConnected;

        const summaryStatus = deps.summaries ? await deps.summaries.status() : undefined;
        const degraded = fallbackOnly || !transportOk;
        const status = storageOk && !degraded ? 'ok' : 'degraded';

        const storageCheck: { ok: boolean; lastSaveError?: string; sizeBytes?: number } = {
          ok: storageOk,
        };
        if (storageHealth?.lastSaveError !== undefined) {
          storageCheck.lastSaveError = storageHealth.lastSaveError;
        }
        if (storageHealth) {
          storageCheck.sizeBytes = storageHealth.sizeBytes;
        }

        return h
          .response({
            status,
            checks: {
              storage: storageCheck,
              transport: {
                ok: transportOk,
                mode,
                stopped: transport?.stopped ?? true,
                forwardConnected,
                reverseConnected,
                reversePeerCount: transport?.reversePeerCount ?? 0,
                lastPongAt: transport?.lastPongAt ?? null,
              },
              models: { fallbackOnly },
              summary: summaryStatus ?? { enabled: false },
            },
          })
          .code(storageOk ? 200 : 503);
      },
    },
    {
      method: 'GET',
      path: uiPath === '/' ? '/{path*}' : `${uiPath}/{path*}`,
      handler: async (request, h) => {
        const params = request.params as { path?: string };
        const subPath = params.path ?? '';
        // 根路径部署时，未注册的 /api/* 不应回落到 SPA 入口
        if (uiPath === '/' && (subPath === 'api' || subPath.startsWith('api/'))) {
          return h.response({ error: 'not found' }).code(404);
        }
        const isFileRequest = Boolean(subPath) && Boolean(extname(subPath));

        if (isFileRequest) {
          const asset = await readStaticAsset(subPath);
          if (!asset) return h.response({ error: 'not found' }).code(404);
          return applyUiHeaders(h.response(asset.body).type(asset.type)).header(
            'cache-control',
            subPath.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
        }

        // SPA 入口：任何非文件路径都返回 index.html
        const index = await readStaticAsset('index.html');
        if (!index) {
          return applyUiHeaders(h.response(UI_NOT_BUILT_HTML).type('text/html; charset=utf-8')).header(
            'cache-control',
            'no-store',
          );
        }
        return applyUiHeaders(h.response(index.body).type(index.type)).header('cache-control', 'no-cache');
      },
    },
    {
      method: 'POST',
      path: '/api/login',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        const ip = effectiveClientIp(request, trustProxy) || 'unknown';
        const now = Date.now();
        if (loginThrottle.isLocked(ip, now)) {
          auditLog(deps, request, trustProxy, 'login', 'webui', 'throttled');
          return h.response({ error: 'too many attempts, try again later' }).code(429);
        }
        const payload = request.payload as JsonObject | undefined;
        const pw = typeof payload?.password === 'string' ? payload.password : '';
        // 完全没有配置任何凭据时才返回 400；配置了凭据但密码不匹配则走 401。
        if (!hasUiCredential(runtime.ui)) {
          auditLog(deps, request, trustProxy, 'login', 'webui', 'failure');
          return h.response({ error: 'no password configured' }).code(400);
        }
        const usablePassword = Boolean(runtime.ui.passwordHash || legacyPasswordCredential(runtime.ui));
        const ok = pw.length > 0 && usablePassword && (await verifyPassword(pw, runtime.ui));
        if (ok) {
          loginThrottle.reset(ip);
          auditLog(deps, request, trustProxy, 'login', 'webui', 'success');
          return { ok: true, token: sessions.create(runtime.ui, now) };
        }
        loginThrottle.recordFailure(ip, now);
        auditLog(deps, request, trustProxy, 'login', 'webui', 'failure');
        return h.response({ error: 'wrong password' }).code(401);
      },
    },
    {
      method: 'POST',
      path: '/api/logout',
      handler: (request) => {
        const token = readSessionToken(request);
        if (token) sessions.destroy(token);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/ui-password',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        const password = typeof payload?.password === 'string' ? payload.password : '';
        if (password.length < 6 || password.length > 128) {
          return h.response({ error: '密码长度需在 6-128 个字符之间' }).code(400);
        }
        const passwordHash = await hashPassword(password);
        const updated = await deps.runtime.update((state) => {
          state.ui.passwordHash = passwordHash;
          // 迁移后不再保留明文。
          delete state.ui.password;
        });
        // Changing the credential retires all existing sessions (they are bound
        // to the old fingerprint), so hand back a fresh one to keep the current
        // browser logged in.
        const token = sessions.create(updated.ui, Date.now());
        deps.appLogger.info('webui admin password updated', {
          ip: effectiveClientIp(request, trustProxy) || 'unknown',
        });
        auditLog(deps, request, trustProxy, 'ui.password.change', 'ui', 'success');
        return { ok: true, token };
      },
    },
    {
      method: 'GET',
      path: '/api/state',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        return getState(deps);
      },
    },
    {
      method: 'GET',
      path: '/api/config',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        return redactConfig(await deps.config.snapshotConfig());
      },
    },
    {
      method: 'POST',
      path: '/api/config',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }

        const payload = request.payload as JsonObject | undefined;
        if (!payload || Array.isArray(payload)) {
          return h.response({ error: 'invalid payload' }).code(400);
        }
        // A payload without both top-level sections is almost certainly not a
        // real config (e.g. the editor saved before the first state load).
        // Normalizing it would replace everything with defaults — refuse.
        if (!payload.settings || !payload.runtime) {
          return h
            .response({ error: 'config must contain both "settings" and "runtime" sections' })
            .code(400);
        }

        const normalized = normalizeAppConfig(payload as Parameters<typeof normalizeAppConfig>[0]);
        // The client reads config back with secrets redacted, so restore any
        // secret it echoed as the redaction marker from the current config —
        // otherwise every save would wipe the password and all API keys.
        const current = await deps.config.snapshotConfig();
        const warnings = restoreSecrets(normalized, current);
        const uiWasEnabled = current.runtime.ui.enabled !== false;
        const uiWillBeEnabled = normalized.runtime.ui.enabled !== false;
        await deps.config.replaceConfig(normalized);
        if (deps.summaries) await deps.summaries.start();
        if (deps.oneBotWebSocket) {
          await deps.oneBotWebSocket.restart();
        }
        auditLog(deps, request, trustProxy, 'config.replace', 'config', 'success', warnings.length);
        if (uiWasEnabled !== uiWillBeEnabled) {
          auditLog(
            deps,
            request,
            trustProxy,
            'ui.enabled',
            'ui',
            uiWillBeEnabled ? 'enabled' : 'disabled',
          );
        }
        return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/admins',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        const userId = String(payload?.userId ?? '').trim();
        if (!userId) {
          return h.response({ error: 'userId is required' }).code(400);
        }
        await deps.runtime.update((state) => {
          if (!state.admins.includes(userId)) {
            state.admins = [...state.admins, userId];
          }
        });
        auditLog(deps, request, trustProxy, 'admins.add', userId, 'success');
        return { ok: true };
      },
    },
    {
      method: 'DELETE',
      path: '/api/admins/{id}',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const userId = String(request.params.id);
        await deps.runtime.update((state) => {
          state.admins = state.admins.filter((item) => item !== userId);
        });
        auditLog(deps, request, trustProxy, 'admins.remove', userId, 'success');
        return { ok: true };
      },
    },
    {
      method: 'GET',
      path: '/api/models',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        return redactModels(await deps.models.listModels());
      },
    },
    {
      method: 'POST',
      path: '/api/models',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        if (!payload || Array.isArray(payload)) {
          return h.response({ error: 'invalid payload' }).code(400);
        }
        // Validate the shape before casting so a malformed body can't crash the
        // upsert (e.g. non-iterable taskBindings) or poison config via a bogus
        // family key.
        const id = typeof payload.id === 'string' ? payload.id.trim() : '';
        const family = typeof payload.family === 'string' ? payload.family : '';
        const provider = typeof payload.provider === 'string' ? payload.provider.trim() : '';
        if (!id) return h.response({ error: 'id is required' }).code(400);
        if (!deps.models.listFamilies().includes(family as ModelConfig['family'])) {
          return h.response({ error: 'invalid family' }).code(400);
        }
        if (!provider) return h.response({ error: 'provider is required' }).code(400);
        // provider 必须是注册过的实现（listProviders 缺失时退回内置 schema 列表）。
        const registeredProviders =
          typeof deps.models.listProviders === 'function'
            ? deps.models.listProviders()
            : fallbackProviderNames();
        if (!registeredProviders.includes(provider)) {
          return h.response({ error: `unknown provider: ${provider}` }).code(400);
        }
        if (!Array.isArray(payload.taskBindings) || !payload.taskBindings.every((t) => typeof t === 'string')) {
          return h.response({ error: 'taskBindings must be an array of strings' }).code(400);
        }
        const model = payload as unknown as ModelConfig;
        // 只有 baseUrl/provider/family 与已保存模型一致时才回填真实 apiKey。
        const existing = (await deps.models.listModels()).find((m) => m.id === id);
        const keyWarning = restoreModelApiKey(model, existing);
        try {
          await deps.models.upsertModel(model);
        } catch (error) {
          auditLog(deps, request, trustProxy, 'model.upsert', id, 'failure');
          return h.response({ error: error instanceof Error ? error.message : 'upsert failed' }).code(400);
        }
        auditLog(deps, request, trustProxy, 'model.upsert', id, 'success');
        return keyWarning ? { ok: true, warnings: [keyWarning] } : { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/models/{task}/activate',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const task = String(request.params.task);
        const payload = request.payload as JsonObject | undefined;
        const modelId = typeof payload?.modelId === 'string' ? payload.modelId.trim() : '';
        if (!deps.models.listTasks().includes(task as ModelTask)) {
          auditLog(deps, request, trustProxy, 'model.activate', task, 'failure');
          return h.response({ error: `invalid task: ${task}` }).code(400);
        }
        if (!modelId) {
          auditLog(deps, request, trustProxy, 'model.activate', task, 'failure');
          return h.response({ error: 'modelId is required' }).code(400);
        }
        try {
          await deps.models.setActiveModel(task as ModelTask, modelId);
        } catch (error) {
          auditLog(deps, request, trustProxy, 'model.activate', `${task}:${modelId}`, 'failure');
          return h.response({ error: error instanceof Error ? error.message : 'activate failed' }).code(400);
        }
        auditLog(deps, request, trustProxy, 'model.activate', `${task}:${modelId}`, 'success');
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/models/{id}/enabled',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        if (!payload || Array.isArray(payload) || typeof payload.enabled !== 'boolean') {
          return h.response({ error: 'enabled must be a boolean' }).code(400);
        }
        const modelId = String(request.params.id);
        try {
          await deps.models.setModelEnabled(modelId, payload.enabled);
        } catch (error) {
          auditLog(deps, request, trustProxy, 'model.enable', modelId, 'failure');
          return h.response({ error: error instanceof Error ? error.message : 'update failed' }).code(400);
        }
        auditLog(deps, request, trustProxy, 'model.enable', modelId, 'success');
        return { ok: true };
      },
    },
    {
      method: 'DELETE',
      path: '/api/models/{id}',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const modelId = String(request.params.id);
        await deps.models.removeModel(modelId);
        auditLog(deps, request, trustProxy, 'model.delete', modelId, 'success');
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/models/test',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const probe = await buildProbeModel(deps, request.payload as JsonObject | undefined);
        if (!probe) {
          return h.response({ ok: false, message: '需要有效的 family / provider 参数' });
        }
        try {
          const message = await deps.models.testConnection(probe.model);
          return probe.warning ? { ok: true, message, warning: probe.warning } : { ok: true, message };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : '连接测试失败',
            ...(probe.warning ? { warning: probe.warning } : {}),
          };
        }
      },
    },
    {
      method: 'POST',
      path: '/api/models/fetch',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const probe = await buildProbeModel(deps, request.payload as JsonObject | undefined);
        if (!probe) {
          return h.response({ ok: false, message: '需要有效的 family / provider 参数' });
        }
        try {
          const models = await deps.models.listRemoteModels(probe.model);
          return probe.warning ? { ok: true, models, warning: probe.warning } : { ok: true, models };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : '拉取模型列表失败',
            ...(probe.warning ? { warning: probe.warning } : {}),
          };
        }
      },
    },
    {
      method: 'GET',
      path: '/api/plugins',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        return deps.plugins.list();
      },
    },
    {
      method: 'POST',
      path: '/api/plugins/{name}/enabled',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const name = String(request.params.name);
        const payload = request.payload as JsonObject | undefined;
        if (!payload || Array.isArray(payload) || typeof payload.enabled !== 'boolean') {
          return h.response({ error: 'enabled must be a boolean' }).code(400);
        }
        await deps.plugins.setEnabled(name, payload.enabled);
        auditLog(deps, request, trustProxy, 'plugin.enable', name, 'success');
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/plugins/reload',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        await deps.plugins.reload();
        auditLog(deps, request, trustProxy, 'plugin.reload', 'all', 'success');
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: deps.settings.eventPath,
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireOneBotAuth(request, trustProxy, runtime.onebot.accessToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        if (!payload || Array.isArray(payload)) {
          return h.response({ error: 'invalid payload' }).code(400);
        }
        await deps.handleIncomingEvent(payload, request.headers as Record<string, unknown>);
        return { ok: true };
      },
    },

    // Knowledge base routes are now provided by the builtin knowledge plugin
    // via collectWebUiRoutes() and mounted below.

    {
      method: 'POST',
      path: '/api/ws-config',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        if (!payload || Array.isArray(payload)) {
          return h.response({ error: 'invalid payload' }).code(400);
        }
        // 先整体校验，任何非法字段都直接 400，避免部分写入。
        const mode = payload.mode;
        if (
          mode !== undefined &&
          (typeof mode !== 'string' || !['off', 'forward', 'reverse', 'both'].includes(mode))
        ) {
          return h.response({ error: 'mode must be one of off/forward/reverse/both' }).code(400);
        }
        if (payload.forwardUrl !== undefined && typeof payload.forwardUrl !== 'string') {
          return h.response({ error: 'forwardUrl must be a string' }).code(400);
        }
        if (payload.reversePath !== undefined && typeof payload.reversePath !== 'string') {
          return h.response({ error: 'reversePath must be a string' }).code(400);
        }
        for (const key of ['reconnectIntervalMs', 'actionTimeoutMs'] as const) {
          const value = payload[key];
          if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
            return h.response({ error: `${key} must be a finite number` }).code(400);
          }
        }

        await deps.runtime.update((state) => {
          const ws = state.onebot.webSocket;
          if (typeof mode === 'string') {
            ws.mode = mode as 'off' | 'forward' | 'reverse' | 'both';
          }
          if (typeof payload.forwardUrl === 'string') {
            ws.forwardUrl = payload.forwardUrl.trim();
          }
          if (typeof payload.reversePath === 'string') {
            ws.reversePath = payload.reversePath.trim() || '/onebot/ws';
          }
          if (typeof payload.reconnectIntervalMs === 'number') {
            ws.reconnectIntervalMs = clampInt(payload.reconnectIntervalMs, 1000, 300000);
          }
          if (typeof payload.actionTimeoutMs === 'number') {
            ws.actionTimeoutMs = clampInt(payload.actionTimeoutMs, 1000, 300000);
          }
        });
        if (deps.oneBotWebSocket) {
          await deps.oneBotWebSocket.restart();
        }
        auditLog(deps, request, trustProxy, 'onebot.ws.update', 'onebot.webSocket', 'success');
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/onebot-config',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        if (!payload || Array.isArray(payload)) {
          return h.response({ error: 'invalid payload' }).code(400);
        }
        // 先校验，再一次性写入。
        let baseUrlValue: string | undefined;
        if (payload.baseUrl !== undefined) {
          if (typeof payload.baseUrl !== 'string') {
            return h.response({ error: 'baseUrl must be a string' }).code(400);
          }
          baseUrlValue = payload.baseUrl.trim();
          if (!isHttpUrl(baseUrlValue)) {
            return h.response({ error: 'baseUrl must be a valid http(s) URL' }).code(400);
          }
        }
        let apiPrefixValue: string | undefined;
        if (payload.apiPrefix !== undefined) {
          if (typeof payload.apiPrefix !== 'string') {
            return h.response({ error: 'apiPrefix must be a string' }).code(400);
          }
          apiPrefixValue = payload.apiPrefix.trim();
          if (!apiPrefixValue.startsWith('/')) {
            return h.response({ error: 'apiPrefix must be a path starting with "/"' }).code(400);
          }
        }
        if (
          payload.timeoutMs !== undefined &&
          (typeof payload.timeoutMs !== 'number' || !Number.isFinite(payload.timeoutMs))
        ) {
          return h.response({ error: 'timeoutMs must be a finite number' }).code(400);
        }

        await deps.runtime.update((state) => {
          const ob = state.onebot;
          if (baseUrlValue !== undefined) ob.baseUrl = baseUrlValue;
          if (apiPrefixValue !== undefined) ob.apiPrefix = apiPrefixValue;
          if (typeof payload.selfId === 'string') ob.selfId = payload.selfId.trim();
          if (typeof payload.timeoutMs === 'number') {
            ob.timeoutMs = clampInt(payload.timeoutMs, 500, 120000);
          }
          // accessToken 前端读到的是脱敏值，只有提供了新的非脱敏值才更新
          if (typeof payload.accessToken === 'string' && payload.accessToken && payload.accessToken !== REDACTED) {
            ob.accessToken = payload.accessToken;
          }
        });
        auditLog(deps, request, trustProxy, 'onebot.update', 'onebot', 'success');
        return { ok: true };
      },
    },
    {
      method: 'GET',
      path: '/api/ws-status',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        const config = runtime.onebot.webSocket;
        const transport = deps.oneBotWebSocket?.getStatus() ?? { forwardConnected: false, reverseConnected: false, reversePeerCount: 0, stopped: true, lastPongAt: null };
        return { config: { mode: config.mode, forwardUrl: config.forwardUrl, reversePath: config.reversePath }, transport };
      },
    },
    {
      method: 'GET',
      path: '/api/events',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
          return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
        }
        // limit 限制在 1..500；NaN/负数回落到默认 64。
        let limit = 64;
        if (typeof request.query.limit === 'string') {
          const parsed = parseInt(request.query.limit, 10);
          if (Number.isFinite(parsed) && parsed > 0) {
            limit = Math.min(Math.max(parsed, 1), 500);
          }
        }
        const cursor = typeof request.query.cursor === 'string' ? request.query.cursor : undefined;
        return deps.storage.listEventsAfter(cursor, limit);
      },
    },
  ];

  // 对 /api/* 的写请求施加 JSON 载荷限制；事件路径保持宽松，兼容各家 OneBot 实现。
  for (const route of routes) {
    if (
      typeof route.path === 'string' &&
      route.path.startsWith('/api/') &&
      route.method !== 'GET' &&
      route.path !== deps.settings.eventPath
    ) {
      route.options = { ...(route.options ?? {}), payload: API_PAYLOAD };
    }
  }

  server.route(routes);

  // 动态挂载插件 WebUI 路由：注册 /api/{path*} 通配路由（在核心路由之后，
  // Hapi 会优先匹配更具体的静态路由），每次请求实时查询插件路由表。
  // 这样插件被禁用/卸载后立即停止服务，新注册的路由无需重启。
  let warnedPluginAuthBypass = false;
  const pluginApiHandler = async (request: Hapi.Request, h: Hapi.ResponseToolkit) => {
    const rawPath = (request.params as { path?: string }).path ?? '';
    const actualPath = `/api/${rawPath}`;
    const method = request.method.toUpperCase();

    const entries = deps.plugins.collectWebUiRoutes();
    let matched:
      | { owner: string; route: WebUiRouteHandler; params: Record<string, string> }
      | undefined;
    for (const entry of entries) {
      if (entry.route.method.toUpperCase() !== method) continue;
      const params = matchPluginRoute(entry.route.path, actualPath);
      if (params) {
        matched = { owner: entry.owner, route: entry.route, params };
        break;
      }
    }
    if (!matched) {
      return h.response({ error: 'not found' }).code(404);
    }

    // 插件路由一律要求 UI 鉴权；旧插件即使声明 requireAuth:false 也忽略，并只告警一次。
    if (matched.route.requireAuth === false && !warnedPluginAuthBypass) {
      warnedPluginAuthBypass = true;
      deps.appLogger.warn(
        'plugin webui route requested requireAuth:false; UI auth is always enforced for plugin routes',
        { owner: matched.owner, path: matched.route.path },
      );
    }
    const runtime = await deps.runtime.snapshot();
    if (!requireUiAuth(request, sessions, trustProxy, runtime.ui)) {
      return h.response({ error: uiUnauthorizedMessage(runtime.ui) }).code(401);
    }

    const query: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.query as Record<string, unknown>)) {
      query[key] = value;
    }
    // 路径参数同时注入 query 和 payload：插件既能按 query.id 也能按 body.id 读取。
    let payload = request.payload as JsonObject | undefined;
    if (Object.keys(matched.params).length > 0) {
      for (const [key, value] of Object.entries(matched.params)) {
        query[key] = value;
      }
      const base =
        payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      payload = { ...base, ...matched.params } as JsonObject;
    }

    try {
      return await matched.route.handler(payload, query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 记录完整错误（含堆栈）到日志，但响应只返回消息，绝不泄漏堆栈。
      const meta: JsonObject = {
        owner: matched.owner,
        method,
        path: request.path,
        error: message,
      };
      if (error instanceof Error && typeof error.stack === 'string') {
        meta.stack = error.stack;
      }
      deps.appLogger.error('plugin webui route failed', meta);
      return h.response({ error: message }).code(400);
    }
  };

  server.route({
    method: 'GET',
    path: '/api/{path*}',
    handler: pluginApiHandler,
  });
  server.route({
    method: ['POST', 'PUT', 'PATCH', 'DELETE'],
    path: '/api/{path*}',
    options: { payload: API_PAYLOAD },
    handler: pluginApiHandler,
  });

  // 默认配置不带密码。即使绑定在回环地址，也要明确提示：未设置凭据时
  // 远程请求会被拒绝，只有本机直连可用。
  try {
    const runtime = await deps.runtime.snapshot();
    const legacyPassword = legacyPasswordCredential(runtime.ui);
    if (runtime.ui.enabled !== false && !runtime.ui.passwordHash && !legacyPassword && !runtime.ui.authToken) {
      deps.appLogger.warn(
        'WebUI is enabled with NO password — only loopback requests are allowed; remote admin requests are denied until a password is set. Set one in the WebUI or runtime.ui.passwordHash.',
        { host: deps.settings.host, port: deps.settings.port },
      );
    }
  } catch {
    // Non-fatal: never block server creation on the advisory check.
  }

  return server;
}
