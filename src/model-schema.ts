import type { ModelFamily } from './types';

/**
 * Provider 参数 schema —— WebUI 模型表单据此动态渲染字段。
 *
 * 参考 AstrBot 的 schema 驱动配置表单（AstrBotConfig.vue / ConfigItemRenderer.vue）：
 * 后端只声明每个 provider × family 支持哪些参数字段，前端遍历 schema 生成对应控件，
 * 不再为 baseUrl/apiKey/model 等写死固定表单。
 */

export interface ModelFieldMeta {
  /** parameters 里的键名 */
  key: string;
  /** 表单上显示的中文标签 */
  label: string;
  /** 控件类型：string→文本框，text→多行文本，password→密码框，int/float→数字(+slider)，bool→开关 */
  type: 'string' | 'text' | 'password' | 'int' | 'float' | 'bool';
  hint?: string;
  placeholder?: string;
  /** 新建模型时的默认值 */
  default?: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  /** 模型名字段：可用模型列表点击可填充 */
  isModelName?: boolean;
  /** 数字类型额外渲染滑块（与输入框联动） */
  slider?: boolean;
}

export interface ModelProviderSchema {
  provider: string;
  family: ModelFamily;
  fields: ModelFieldMeta[];
}

/** openai-compatible 所有 family 共用的基础参数 */
const openAiCommonFields: ModelFieldMeta[] = [
  {
    key: 'baseUrl',
    label: 'Base URL',
    type: 'string',
    required: true,
    placeholder: 'https://api.example.com/v1',
    hint: 'OpenAI 兼容接口地址，一般以 /v1 结尾',
  },
  {
    key: 'apiKey',
    label: 'API Key',
    type: 'password',
    placeholder: 'sk-...',
    hint: '留空则发起无鉴权请求',
  },
  {
    key: 'model',
    label: '模型名',
    type: 'string',
    required: true,
    isModelName: true,
    placeholder: '如 claude-sonnet-5',
    hint: '可先填 Base URL 后点「拉取可用模型」自动选择',
  },
  {
    key: 'timeoutMs',
    label: '请求超时 (ms)',
    type: 'int',
    default: 30000,
    min: 1000,
    step: 1000,
    hint: '单次上游请求的超时毫秒数',
  },
];

/** 语言类模型额外参数（当前 generateText 实际支持的温度/最大 token/系统提示词） */
const openAiLanguageFields: ModelFieldMeta[] = [
  {
    key: 'systemPrompt',
    label: '系统提示词',
    type: 'text',
    hint: '可选，注入到 system 消息；留空则只发送用户消息',
  },
  {
    key: 'temperature',
    label: '温度 temperature',
    type: 'float',
    default: 0.7,
    min: 0,
    max: 2,
    step: 0.1,
    slider: true,
    hint: '采样温度，越高越发散',
  },
  {
    key: 'maxTokens',
    label: '最大输出 tokens',
    type: 'int',
    min: 1,
    hint: '限制单次回复的最大 token 数',
  },
];

const MODEL_SCHEMAS: ModelProviderSchema[] = [
  {
    provider: 'openai-compatible',
    family: 'language',
    fields: [...openAiCommonFields, ...openAiLanguageFields],
  },
  {
    provider: 'openai-compatible',
    family: 'speech-to-text',
    fields: openAiCommonFields,
  },
  {
    provider: 'openai-compatible',
    family: 'embedding',
    fields: openAiCommonFields,
  },
  {
    provider: 'openai-compatible',
    family: 'rerank',
    fields: openAiCommonFields,
  },
  // rule-based 为内置回退，无任何参数
];

/** 取某 provider × family 的参数 schema；无匹配返回空数组 */
export function schemaFor(provider: string, family: ModelFamily): ModelFieldMeta[] {
  const schema = MODEL_SCHEMAS.find((item) => item.provider === provider && item.family === family);
  return schema ? schema.fields : [];
}

/** 全部 provider × family 的组合列表，供 WebUI 遍历 */
export function listProviderSchemas(): ModelProviderSchema[] {
  return MODEL_SCHEMAS.map((schema) => ({
    ...schema,
    fields: schema.fields.map((field) => ({ ...field })),
  }));
}
