import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import type { AppConfigFile, ModelConfig, RuntimeState, UiSettings } from './types';

/** 所有脱敏响应统一使用的占位标记。 */
export const REDACTED = '__redacted__';

/** scrypt 参数：N=16384（约 16 MiB 内存）、r=8、p=1、输出 64 字节。 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

const LOOPBACK_V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * 与 Hapi Request / Node IncomingMessage 都兼容的最小结构。
 * Hapi 用 info.remoteAddress，http.IncomingMessage 用 socket.remoteAddress。
 */
export interface RequestLike {
  headers: Record<string, unknown>;
  info?: { remoteAddress?: string | null; host?: string; referrer?: string };
  socket?: { remoteAddress?: string | null | undefined };
  connection?: { remoteAddress?: string | null | undefined };
}

function readHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * 常量时间字符串比较。先做 sha256 摘要再比较固定长度的摘要，
 * 因此长度差异不会短路，也不会泄漏输入长度。
 */
export function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function redactRuntimeSecrets(runtime: RuntimeState): RuntimeState {
  if (runtime.ui) {
    if (runtime.ui.password) runtime.ui.password = REDACTED;
    if (runtime.ui.passwordHash) runtime.ui.passwordHash = REDACTED;
    if (runtime.ui.authToken) runtime.ui.authToken = REDACTED;
  }
  if (runtime.onebot?.accessToken) {
    runtime.onebot.accessToken = REDACTED;
  }
  for (const group of Object.values(runtime.models ?? {})) {
    for (const model of group) {
      if (model.parameters && typeof model.parameters.apiKey === 'string' && model.parameters.apiKey) {
        model.parameters.apiKey = REDACTED;
      }
    }
  }
  return runtime;
}

/** 深拷贝配置并把所有密钥替换为脱敏标记。 */
export function redactConfig(config: AppConfigFile): AppConfigFile {
  const copy = clone(config);
  copy.runtime = redactRuntimeSecrets(copy.runtime);
  return copy;
}

/** 深拷贝运行时状态并脱敏（插件可复用）。 */
export function redactRuntime(runtime: RuntimeState): RuntimeState {
  return redactRuntimeSecrets(clone(runtime));
}

/** 深拷贝模型列表并移除 apiKey。 */
export function redactModels(models: ModelConfig[]): ModelConfig[] {
  return models.map((model) => {
    if (model.parameters && typeof model.parameters.apiKey === 'string' && model.parameters.apiKey) {
      return { ...model, parameters: { ...model.parameters, apiKey: REDACTED } };
    }
    return model;
  });
}

function deriveKey(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (error, derived) => {
        if (error) reject(error);
        else resolve(derived);
      },
    );
  });
}

/** 生成 `scrypt$N$r$p$saltHex$keyHex` 格式的密码摘要。 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await deriveKey(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

interface ParsedPasswordHash {
  salt: Buffer;
  key: Buffer;
}

function parsePasswordHash(value: string): ParsedPasswordHash | null {
  const parts = value.split('$');
  if (parts.length !== 6) return null;
  const [scheme, nRaw, rRaw, pRaw, saltHex, keyHex] = parts;
  if (scheme !== 'scrypt') return null;
  if (Number(nRaw) !== SCRYPT_N || Number(rRaw) !== SCRYPT_R || Number(pRaw) !== SCRYPT_P) return null;
  if (!saltHex || !keyHex || saltHex.length % 2 !== 0 || keyHex.length % 2 !== 0) return null;
  const salt = Buffer.from(saltHex, 'hex');
  const key = Buffer.from(keyHex, 'hex');
  if (salt.length === 0 || key.length === 0) return null;
  return { salt, key };
}

/**
 * 校验 WebUI 密码。优先使用 passwordHash（scrypt）；没有摘要时回退到旧版
 * 明文 password（常量时间比较）。摘要格式非法时按失败处理（fail-closed）。
 */
export async function verifyPassword(input: string, ui: UiSettings): Promise<boolean> {
  if (ui.passwordHash) {
    const parsed = parsePasswordHash(ui.passwordHash);
    if (!parsed) return false;
    try {
      const derived = await deriveKey(input, parsed.salt, parsed.key.length);
      if (derived.length !== parsed.key.length) return false;
      return timingSafeEqual(derived, parsed.key);
    } catch {
      return false;
    }
  }

  if (ui.password) {
    return safeEqual(input, ui.password);
  }

  return false;
}

/** 会话指纹：绑定当前凭据，密码/摘要变化后旧会话自动失效。 */
export function credentialFingerprint(ui: UiSettings): string {
  const credential = ui.passwordHash ?? ui.password ?? '';
  return createHash('sha256').update(credential).digest('hex');
}

/** 是否配置了任意一种 WebUI 凭据。 */
export function hasUiCredential(ui: UiSettings): boolean {
  return Boolean(ui.passwordHash || ui.password || ui.authToken);
}

/** 规范化地址：去方括号、IPv4 映射前缀、zone id。 */
function normalizeAddress(address: string): string {
  let value = address.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  const zoneIndex = value.indexOf('%');
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex);
  if (value.startsWith('::ffff:')) {
    value = value.slice('::ffff:'.length);
  }
  return value;
}

/** 判断地址是否属于回环范围：127.0.0.0/8、::1、::ffff:127.x。 */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const value = normalizeAddress(address);
  if (value === '::1' || value === 'localhost') return true;
  const match = LOOPBACK_V4.exec(value);
  return Boolean(match && match[1] === '127');
}

/**
 * Host 头是否指向本机。用于「无凭据仅本机可用」模式：仅检查 TCP 对端是回环
 * 还不够，DNS rebinding 会让浏览器把攻击者域名解析到 127.0.0.1，此时 Host
 * 是攻击者域名。要求 Host 也是回环名可以关闭这条路径。
 */
export function isLoopbackHost(rawHost: string | undefined | null): boolean {
  if (!rawHost) return false;
  const { hostname } = parseHost(rawHost);
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname === '::1') return true;
  return isLoopbackAddress(hostname);
}

/** 请求是否携带任何代理头（用于拒绝被代理转发的“本地”请求）。 */
export function isProxiedRequest(request: RequestLike): boolean {
  for (const name of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
    const value = readHeader(request.headers[name]);
    if (value && value.trim().length > 0) return true;
  }
  return false;
}

function normalizeClientIp(value: string): string {
  let address = value.trim();
  // XFF 偶尔写成 IPv4:port
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(address);
  if (v4WithPort?.[1]) address = v4WithPort[1];
  return normalizeAddress(address);
}

/**
 * 取客户端 IP：信任代理时用最左侧 X-Forwarded-For（真实客户端），
 * 否则直接使用 TCP 对端地址，避免伪造头影响鉴权。
 */
export function effectiveClientIp(request: RequestLike, trustProxy: boolean): string {
  if (trustProxy) {
    const forwardedFor = readHeader(request.headers['x-forwarded-for']);
    if (forwardedFor) {
      const first = forwardedFor.split(',')[0]?.trim();
      if (first) return normalizeClientIp(first);
    }
  }
  const remote =
    request.info?.remoteAddress ?? request.socket?.remoteAddress ?? request.connection?.remoteAddress;
  return remote ? normalizeClientIp(remote) : '';
}

interface HostParts {
  hostname: string;
  port: string | undefined;
}

function parseHost(raw: string): HostParts {
  const value = raw.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end !== -1) {
      const hostname = value.slice(1, end).toLowerCase();
      const rest = value.slice(end + 1);
      if (rest.startsWith(':')) {
        return { hostname, port: rest.slice(1) };
      }
      return { hostname, port: undefined };
    }
  }
  const firstColon = value.indexOf(':');
  const lastColon = value.lastIndexOf(':');
  // 只有一个冒号才视为 IPv4/域名 + 端口；多冒号说明是裸 IPv6。
  if (firstColon !== -1 && firstColon === lastColon) {
    return { hostname: value.slice(0, firstColon).toLowerCase(), port: value.slice(lastColon + 1) };
  }
  return { hostname: value.toLowerCase(), port: undefined };
}

function hostsMatch(source: URL, expectedHost: string): boolean {
  if (!expectedHost) return false;
  const expected = parseHost(expectedHost);
  if (!expected.hostname) return false;
  if (source.hostname.toLowerCase() !== expected.hostname) return false;

  const sourcePort = source.port || (source.protocol === 'https:' ? '443' : '80');
  if (expected.port) {
    const expectedPort = expected.port === '' ? sourcePort : expected.port;
    if (expectedPort !== sourcePort) return false;
  }
  return true;
}

/**
 * CSRF / 跨站请求防护：Origin（其次 Referer）必须与当前 Host 同源。
 * 两者都不存在时放行（非浏览器客户端，例如 curl / 脚本）。
 * trustProxy 时优先使用 X-Forwarded-Host（反向代理改写后的对外主机名）。
 */
export function originAllowed(request: RequestLike, trustProxy: boolean): boolean {
  const origin = readHeader(request.headers.origin);
  const referer = readHeader(request.headers.referer);
  const source = origin !== undefined ? origin : referer;
  if (source === undefined) return true;
  if (source.trim() === '' || source.trim().toLowerCase() === 'null') return false;

  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return false;
  }

  const forwardedHost = trustProxy ? readHeader(request.headers['x-forwarded-host']) : undefined;
  const expectedHost = forwardedHost?.split(',')[0]?.trim() || request.info?.host || '';
  return hostsMatch(parsed, expectedHost);
}
