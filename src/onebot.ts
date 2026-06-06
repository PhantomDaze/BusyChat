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

function normalizeSegments(message: OneBotIncomingEvent['message']): OneBotMessageSegment[] {
  if (Array.isArray(message)) {
    return message.map((segment) => ({
      type: segment.type,
      data: { ...segment.data },
    }));
  }
  return [];
}

function extractPlainText(message: OneBotIncomingEvent['message'], rawText?: string): string {
  if (Array.isArray(message)) {
    return message.map((segment) => stringifyMessageSegment(segment)).join('').trim();
  }
  if (typeof message === 'string') {
    return message.trim();
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

  const scope = payload.message_type === 'group' ? 'group' : 'private';
  const conversationId =
    scope === 'group'
      ? `group:${String(payload.group_id ?? 'unknown')}`
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

  const payload = (await response.json()) as OneBotActionResponse<T>;
  if (!response.ok || payload.status === 'failed') {
    throw new Error(
      payload.message || `OneBot action ${action} failed with status ${response.status}`,
    );
  }
  return payload;
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

    // Then sentence boundaries (Chinese + English punctuation)
    splitAt = Math.max(
      remaining.lastIndexOf('。', maxLen),
      remaining.lastIndexOf('！', maxLen),
      remaining.lastIndexOf('？', maxLen),
      remaining.lastIndexOf('；', maxLen),
      remaining.lastIndexOf('. ', maxLen),
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
    const chunks = splitLongText(text, 3800);
    const total = chunks.length;
    for (let i = 0; i < total; i += 1) {
      const prefix = total > 1 ? `[${i + 1}/${total}] ` : '';
      await this.sendPrivateMessage(userId, prefix + chunks[i]!);
    }
  }

  /** Send a potentially long text as chunked messages to a group. */
  async sendLongGroupMessage(groupId: string, text: string): Promise<void> {
    const chunks = splitLongText(text, 3800);
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
