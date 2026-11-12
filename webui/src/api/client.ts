/**
 * 极简 fetch 封装：
 * - 会话 token 存在 sessionStorage，通过 `x-admin-token` 头携带；
 * - 每个请求默认 20s 超时，可用 timeoutMs 覆盖（模型探测/摘要刷新用 120s）；
 * - 401 统一触发 onUnauthorized（清 token + 跳登录页）；
 * - 后端错误体 `{ error }` 直接作为 Error.message。
 */

const TOKEN_KEY = 'busychat_admin_token';

/** 普通请求默认超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** 长耗时请求（模型探测、拉取模型、摘要刷新）的超时（毫秒） */
export const LONG_REQUEST_TIMEOUT_MS = 120_000;

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let unauthorizedHandler: (() => void) | undefined;

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler;
}

export function getToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token: string | undefined): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // 隐私模式下忽略
  }
}

export function clearToken(): void {
  setToken(undefined);
}

/**
 * 兼容旧版 `/ui?token=<legacy authToken>` 链接。
 *
 * @deprecated 会话 token 不应出现在 URL 中；这里只保留对显式 legacy
 * `token` 参数的读取，不再读取 `t` 参数，也不会生成带 token 的 URL。
 */
export function consumeUrlToken(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') ?? '';
    if (token) {
      setToken(token);
      params.delete('token');
      const search = params.toString();
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
      );
    }
    return token;
  } catch {
    return '';
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** 单次请求超时（毫秒），默认 {@link DEFAULT_TIMEOUT_MS}；<= 0 表示不超时 */
  timeoutMs?: number;
  /** 401 时是否触发全局登出（登录接口本身不触发） */
  skipUnauthorizedHandler?: boolean;
};

interface TimeoutHandle {
  signal: AbortSignal;
  /** 是否由超时触发取消（用于区分调用方主动 abort） */
  timedOut: () => boolean;
  cleanup: () => void;
}

/** 把超时和调用方提供的 signal 合并成一个 AbortSignal */
function createTimeoutSignal(timeoutMs: number, external?: AbortSignal): TimeoutHandle {
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

  const onAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = createTimeoutSignal(timeoutMs, options.signal);

  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: timeout.signal,
  };

  const token = getToken();
  if (token) headers['x-admin-token'] = token;

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  let raw = '';
  try {
    response = await fetch(path, init);
    raw = await response.text();
  } catch (error) {
    if (timeout.timedOut()) {
      const seconds = timeoutMs > 0 ? Math.round(timeoutMs / 1000) : 0;
      throw new ApiError(0, seconds > 0 ? `Request timed out after ${seconds}s` : 'Request timed out');
    }
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new ApiError(0, 'Network error: unable to reach the server');
  } finally {
    timeout.cleanup();
  }

  let payload: unknown = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = raw;
    }
  }

  if (response.status === 401) {
    if (!options.skipUnauthorizedHandler) unauthorizedHandler?.();
    throw new ApiError(401, 'Session expired. Please sign in again.');
  }

  if (!response.ok) {
    const message =
      (payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : '') ||
      (typeof payload === 'string' && payload) ||
      `Request failed (HTTP ${response.status})`;
    throw new ApiError(response.status, message);
  }

  return payload as T;
}
