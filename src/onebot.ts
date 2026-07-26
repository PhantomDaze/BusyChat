import { createHash } from 'node:crypto';

import type {
  BotGateway,
  OneBotActionResponse,
  OneBotClientConfig,
  OneBotIncomingEvent,
  OneBotMessageSegment,
  OutgoingMessage,
  RuntimeStore,
  RuntimeState,
  SendResult,
  SendTarget,
  NormalizedMessageEvent,
} from './types';

export interface OneBotActionTransport {
  isActionReady(): boolean;
  callAction<T>(
    action: string,
    params: Record<string, unknown>,
    config: OneBotClientConfig,
  ): Promise<OneBotActionResponse<T>>;
}

function stringifyMessageSegment(segment: OneBotMessageSegment): string {
  switch (segment.type) {
    case 'text':
      return segment.data.text ?? '';
    case 'at':
      return `@${segment.data.qq ?? segment.data.user_id ?? ''}`;
    case 'image':
      return '[图片]';
    case 'record':
    case 'audio':
      return '[语音]';
    case 'video':
      return '[视频]';
    case 'file':
      return `[文件:${segment.data.file ?? 'unknown'}]`;
    case 'reply':
      return `[回复:${segment.data.id ?? 'unknown'}]`;
    case 'face':
      return `[表情:${segment.data.id ?? 'unknown'}]`;
    case 'location':
      return '[位置]';
    case 'json':
      return '[JSON消息]';
    case 'xml':
      return '[XML消息]';
    default:
      return `[${segment.type}]`;
  }
}

function unescapeCqText(value: string): string {
  return value.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');
}

function unescapeCqParam(value: string): string {
  return value
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/**
 * Decode a CQ-code string message ("hello [CQ:at,qq=123] world") into
 * segments. OneBot v11 implementations configured with
 * `post_message_format: string` deliver messages this way; without decoding,
 * every segment-based feature (@-mention detection, media labeling) is blind
 * and raw CQ markup leaks into stored text and LLM prompts.
 */
export function parseCqString(message: string): OneBotMessageSegment[] {
  const segments: OneBotMessageSegment[] = [];
  const re = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^,[\]]*)*)\]/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(message)) !== null) {
    if (match.index > last) {
      segments.push({ type: 'text', data: { text: unescapeCqText(message.slice(last, match.index)) } });
    }
    const data: Record<string, string> = {};
    for (const part of (match[2] ?? '').split(',')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      data[part.slice(0, eq)] = unescapeCqParam(part.slice(eq + 1));
    }
    segments.push({ type: match[1]!, data });
    last = re.lastIndex;
  }
  if (last < message.length) {
    segments.push({ type: 'text', data: { text: unescapeCqText(message.slice(last)) } });
  }
  return segments;
}

/** Coerce segment data values to strings — implementations send numbers too. */
function coerceSegmentData(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return out;
}

function normalizeSegments(message: OneBotIncomingEvent['message']): OneBotMessageSegment[] {
  if (Array.isArray(message)) {
    return message.map((segment) => ({
      type: segment.type,
      data: coerceSegmentData(segment.data as Record<string, unknown> | undefined),
    }));
  }
  if (typeof message === 'string') {
    return parseCqString(message);
  }
  return [];
}

function extractPlainText(message: OneBotIncomingEvent['message'], rawText?: string): string {
  if (Array.isArray(message)) {
    return message.map((segment) => stringifyMessageSegment(segment)).join('').trim();
  }
  if (typeof message === 'string') {
    // Render via the decoded segments so CQ markup becomes readable labels
    // ("[图片]", "@123...") instead of raw [CQ:...] noise in stored text.
    return parseCqString(message).map(stringifyMessageSegment).join('').trim();
  }
  return rawText?.trim() || '';
}

function buildEventId(payload: OneBotIncomingEvent): string {
  const hash = createHash('sha1');
  hash.update(JSON.stringify(payload));
  return hash.digest('hex');
}

function toIsoTime(time?: number): string {
  if (typeof time === 'number' && Number.isFinite(time)) {
    return new Date(time * 1000).toISOString();
  }
  return new Date().toISOString();
}

function getSelfId(payload: OneBotIncomingEvent, runtime: RuntimeState): string | undefined {
  const runtimeSelfId = runtime.onebot.selfId?.trim();
  if (runtimeSelfId) {
    return runtimeSelfId;
  }
  if (payload.self_id !== undefined) {
    return String(payload.self_id);
  }
  return undefined;
}

export function normalizeOneBotMessageEvent(
  payload: OneBotIncomingEvent,
  runtime: RuntimeState,
): NormalizedMessageEvent | null {
  if (payload.post_type !== 'message') {
    return null;
  }

  const senderId = String(payload.user_id ?? payload.sender?.user_id ?? '').trim();
  if (!senderId) {
    return null;
  }

  // Only accept the two known message types. Treating an unknown/missing
  // message_type as private would misclassify events and trigger the wrong
  // pipelines (e.g. per-message advice for what was actually group chat).
  if (payload.message_type !== 'group' && payload.message_type !== 'private') {
    return null;
  }
  const scope = payload.message_type;
  // A group message without a group id can't be attributed to a conversation —
  // dropping it beats merging unrelated groups into one "group:unknown" bucket.
  if (scope === 'group' && payload.group_id === undefined) {
    return null;
  }
  const conversationId =
    scope === 'group'
      ? `group:${String(payload.group_id)}`
      : `private:${senderId}`;
  const botSelfId = getSelfId(payload, runtime);
  const isBot = botSelfId ? senderId === botSelfId : false;
  const isAdmin = runtime.admins.includes(senderId);
  const segments = normalizeSegments(payload.message);
  const text = extractPlainText(payload.message, payload.raw_message);

  return {
    id: buildEventId(payload),
    source: 'onebot-v11',
    receivedAt: toIsoTime(payload.time),
    botSelfId,
    scope,
    conversationId,
    messageId: payload.message_id,
    sender: {
      userId: senderId,
      nickname: payload.sender?.nickname,
      card: payload.sender?.card,
      role: payload.sender?.role,
      isAdmin,
      isBot,
    },
    content: {
      text,
      segments,
      rawText: typeof payload.raw_message === 'string' ? payload.raw_message : undefined,
    },
    raw: payload,
    visibility: {
      fromAdmin: isAdmin,
      fromBot: isBot,
      includeInReports: !isAdmin && !isBot,
      eligibleForAdvice: isAdmin,
    },
  };
}

function buildActionUrl(config: OneBotClientConfig, action: string): URL {
  const normalizedBase = config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`;
  const prefix = config.apiPrefix.replace(/^\/+|\/+$/g, '');
  const path = prefix ? `${prefix}/${action}` : action;
  return new URL(path, normalizedBase);
}

async function callAction<T>(
  config: OneBotClientConfig,
  action: string,
  params: Record<string, unknown>,
): Promise<OneBotActionResponse<T>> {
  const response = await fetch(buildActionUrl(config, action), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.accessToken ? { authorization: `Bearer ${config.accessToken}` } : {}),
      ...(config.selfId ? { 'x-self-id': config.selfId } : {}),
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(config.timeoutMs),
  });

  // Read the body as text first so a non-JSON error page (e.g. a 502 from a
  // reverse proxy) yields a useful status message instead of a JSON parse error.
  const bodyText = await response.text();
  let payload: OneBotActionResponse<T> | undefined;
  try {
    payload = bodyText ? (JSON.parse(bodyText) as OneBotActionResponse<T>) : undefined;
  } catch {
    payload = undefined;
  }

  if (!response.ok || !payload || payload.status === 'failed') {
    throw new Error(
      payload?.message || `OneBot action ${action} failed with status ${response.status}`,
    );
  }
  return payload;
}

// QQ's practical single-message ceiling, and the room reserved for the
// "[i/n] " progress prefix added when a message spans multiple chunks.
const MAX_MESSAGE_LEN = 3800;
const PREFIX_RESERVE = 16;

/**
 * Split text so that even after the "[i/n] " prefix is prepended, no message
 * exceeds MAX_MESSAGE_LEN. A single-chunk message carries no prefix, so it is
 * allowed the full length; only multi-chunk output reserves prefix room.
 */
export function chunkWithPrefixBudget(text: string): string[] {
  const full = splitLongText(text, MAX_MESSAGE_LEN);
  if (full.length <= 1) return full;
  return splitLongText(text, MAX_MESSAGE_LEN - PREFIX_RESERVE);
}

export function splitLongText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Prefer paragraph boundaries
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt > maxLen * 0.5) {
      chunks.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
      continue;
    }

    // Then line boundaries
    splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt > maxLen * 0.5) {
      chunks.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
      continue;
    }

    // Then sentence boundaries (Chinese + English punctuation).
    // Search within maxLen-1 so the inclusive slice(0, splitAt + 1) never
    // exceeds maxLen characters.
    splitAt = Math.max(
      remaining.lastIndexOf('。', maxLen - 1),
      remaining.lastIndexOf('！', maxLen - 1),
      remaining.lastIndexOf('？', maxLen - 1),
      remaining.lastIndexOf('；', maxLen - 1),
      remaining.lastIndexOf('. ', maxLen - 1),
    );
    if (splitAt > maxLen * 0.4) {
      chunks.push(remaining.slice(0, splitAt + 1).trimEnd());
      remaining = remaining.slice(splitAt + 1).trimStart();
      continue;
    }

    // Hard split at maxLen
    chunks.push(remaining.slice(0, maxLen).trimEnd());
    remaining = remaining.slice(maxLen).trimStart();
  }

  return chunks;
}

export class OneBotClient implements BotGateway {
  private cachedSelfId: string | undefined;
  private actionTransport: OneBotActionTransport | undefined;

  constructor(private readonly runtime: RuntimeStore) {}

  setActionTransport(transport: OneBotActionTransport): void {
    this.actionTransport = transport;
  }

  get selfId(): string | undefined {
    return this.cachedSelfId;
  }

  async send(target: SendTarget, message: OutgoingMessage): Promise<SendResult> {
    if (target.type === 'group') {
      return this.sendGroupMessage(target.id, message);
    }
    return this.sendPrivateMessage(target.id, message);
  }

  async sendPrivateMessage(userId: string, message: OutgoingMessage): Promise<SendResult> {
    const config = await this.resolveConfig();
    const payload = await this.callAction<{ message_id?: number }>(config, 'send_private_msg', {
      user_id: Number(userId),
      message,
    });
    return {
      raw: payload,
      messageId: payload.data?.message_id,
    };
  }

  async sendGroupMessage(groupId: string, message: OutgoingMessage): Promise<SendResult> {
    const config = await this.resolveConfig();
    const payload = await this.callAction<{ message_id?: number }>(config, 'send_group_msg', {
      group_id: Number(groupId),
      message,
    });
    return {
      raw: payload,
      messageId: payload.data?.message_id,
    };
  }

  /** Send a potentially long text as chunked messages. Splits at paragraph / sentence boundaries. */
  async sendLongPrivateMessage(userId: string, text: string): Promise<void> {
    const chunks = chunkWithPrefixBudget(text);
    const total = chunks.length;
    for (let i = 0; i < total; i += 1) {
      const prefix = total > 1 ? `[${i + 1}/${total}] ` : '';
      await this.sendPrivateMessage(userId, prefix + chunks[i]!);
    }
  }

  /** Send a potentially long text as chunked messages to a group. */
  async sendLongGroupMessage(groupId: string, text: string): Promise<void> {
    const chunks = chunkWithPrefixBudget(text);
    const total = chunks.length;
    for (let i = 0; i < total; i += 1) {
      const prefix = total > 1 ? `[${i + 1}/${total}] ` : '';
      await this.sendGroupMessage(groupId, prefix + chunks[i]!);
    }
  }

  async getLoginInfo(): Promise<{ userId: number | undefined; nickname: string | undefined }> {
    const config = await this.resolveConfig();
    const payload = await this.callAction<{ user_id?: number; nickname?: string }>(config, 'get_login_info', {});
    return {
      userId: payload.data?.user_id,
      nickname: payload.data?.nickname,
    };
  }

  private async callAction<T>(
    config: OneBotClientConfig,
    action: string,
    params: Record<string, unknown>,
  ): Promise<OneBotActionResponse<T>> {
    if (this.actionTransport?.isActionReady()) {
      return this.actionTransport.callAction<T>(action, params, config);
    }

    return callAction<T>(config, action, params);
  }

  private async resolveConfig(): Promise<OneBotClientConfig> {
    const runtime = await this.runtime.snapshot();
    this.cachedSelfId = runtime.onebot.selfId;
    return runtime.onebot;
  }
}
