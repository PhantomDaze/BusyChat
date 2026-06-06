# F261Agent

OneBot v11 AI assistant framework for QQ account supervision, message summarization, admin reporting, controlled outbound messaging, plugin extensions, model routing, and JSON-based configuration.

## Quick Start

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 生产构建
npm run build
npm start
```

首次运行会自动创建 `config.json`，使用 [`config.example.json`](./config.example.json) 作为模板。

## 测试

```bash
# 类型检查
npm run typecheck

# WebSocket 正向/反向连接测试（18 项）
npm run test:ws

# 知识库功能测试（14 项）
npm run test:kb

# 全部测试
npm run test:all
```

## 配置 WebSocket

编辑 `config.json` → `runtime.onebot.webSocket`：

| 字段 | 说明 |
|---|---|
| `mode` | `off` \| `forward`（应用连协议）\| `reverse`（协议连应用）\| `both` |
| `forwardUrl` | 正向模式下的 OneBot WS 地址，例如 `ws://127.0.0.1:6700` |
| `reversePath` | 反向模式下的接收路径，默认 `/onebot/ws` |

### 正向 WebSocket 示例（推荐）

协议端（go-cqhttp / LLOneBot）开启正向 WS 后，F261Agent 主动连接：

```json
"webSocket": {
  "mode": "forward",
  "forwardUrl": "ws://127.0.0.1:6700",
  "reversePath": "/onebot/ws",
  "reconnectIntervalMs": 5000,
  "actionTimeoutMs": 10000
}
```

### 反向 WebSocket 示例

F261Agent 暴露 `/onebot/ws`，协议端主动连接：

```json
"webSocket": {
  "mode": "reverse",
  "reversePath": "/onebot/ws",
  "reconnectIntervalMs": 5000,
  "actionTimeoutMs": 10000
}
```

## 配置模型

### 语言模型（OpenAI 兼容接口）

支持所有兼容 OpenAI `/v1/chat/completions` 格式的 API。在 `runtime.models.language` 数组中添加条目，然后修改 `runtime.activeModels` 绑定任务。

**DeepSeek：**

```json
{
  "id": "deepseek-chat",
  "label": "DeepSeek V3",
  "family": "language",
  "provider": "openai-compatible",
  "enabled": true,
  "taskBindings": ["summary", "advice", "chat", "classifier", "moderation", "memory-summary"],
  "parameters": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-your-deepseek-api-key",
    "model": "deepseek-chat",
    "temperature": 0.7,
    "maxTokens": 4096,
    "timeoutMs": 30000,
    "systemPrompt": "你是一个QQ群管理助手，请用中文简洁回复。"
  }
}
```

### 绑定模型到任务

```json
"activeModels": {
  "summary": "deepseek-chat",
  "advice": "deepseek-chat",
  "chat": "deepseek-chat",
  "classifier": "deepseek-chat",
  "moderation": "deepseek-chat",
  "memory-summary": "deepseek-chat"
}
```

### 嵌入模型和重排序模型

目前 `openai-compatible` provider 仅支持语言模型（`generateText`）。如需真实 embedding/rerank 模型，需要在 `src/models.ts` 中扩展 `OpenAICompatibleProvider` 的 `embed()` 和 `rerank()` 方法。详见 [`docs/development.md`](./docs/development.md)。

### 模型参数说明

| 参数 | 说明 |
|---|---|
| `baseUrl` | API 端点地址，会拼接 `/chat/completions` |
| `apiKey` | API 密钥，自动作为 `Authorization: Bearer` 发送 |
| `model` | 模型名称，直接传给 API |
| `temperature` | 生成温度（可选，0-2） |
| `maxTokens` | 最大输出 token 数（可选） |
| `timeoutMs` | 请求超时毫秒（可选，默认 30000） |
| `systemPrompt` | 系统提示词（可选） |

### 模型选择优先级

1. `activeModels[task]` 显式绑定的模型
2. 该 family 下第一个 `enabled: true` 且 `taskBindings` 包含该 task 的模型
3. `rule-based` fallback（内置，永不可用）

## 内置命令

所有命令都需提供中文说明。在 QQ 中发送 `/help` 即可查看完整列表。

| 命令 | 说明 | 权限 |
|---|---|---|
| `/help` | 显示所有可用命令 | 任何人 |
| `/summary now` | 立即生成摘要并发送 | 管理员 |
| `/summary status` | 查看摘要配置状态 | 管理员 |
| `/report list` | 查看最近摘要记录 | 管理员 |
| `/send private <QQ> <内容>` | 让机器人代发私聊消息 | 管理员 |
| `/send group <群号> <内容>` | 让机器人代发群消息 | 管理员 |
| `/remember <内容>` | 将文本写入知识库 | 管理员 |
| `/recall <查询> [数量]` | 语义搜索知识库 | 管理员 |
| `/forget <ID>` | 从知识库删除条目 | 管理员 |
| `/kb-summarize [数量]` | AI 总结知识库内容 | 管理员 |
| `/reply list` | 查看待回复消息 | 管理员 |
| `/reply <ID> <指示>` | AI 生成回复并发送 | 管理员 |
| `/reply dismiss <ID>` | 忽略待回复消息 | 管理员 |
| `/notify keywords list` | 查看告警关键词 | 管理员 |
| `/notify keywords add <词>` | 添加告警关键词 | 管理员 |
| `/notify quiet <开始> <结束>` | 设置免打扰时段 | 管理员 |
| `/model list` | 列出所有模型 | 管理员 |
| `/model activate <任务> <ID>` | 切换任务模型 | 管理员 |
| `/plugin list` | 列出已加载插件 | 管理员 |
| `/plugin enable/disable <名>` | 启停插件 | 管理员 |
| `/admin list/add/remove` | 管理管理员 | 管理员 |
| `/auto-memory status` | 自动记忆插件状态 | 管理员 |
| `/auto-memory trigger` | 手动触发每日总结 | 管理员 |

## Documentation

The detailed project notes live in [`docs`](./docs). Keep README as the entry point and put implementation details there.

- [Architecture notes](./docs/architecture.md): boundaries, data flow, invariants, configuration ownership, and future split points.
- [Development guide](./docs/development.md): install/build workflow, repository layout, JSON config workflow, runtime persistence, plugin authoring, model extension, WebUI workflow, and admin reporting rules.
- [Engineering principles](./docs/engineering-principles.md): implementation rules for transport, admin separation, plugin permissions, storage, model tasks, config files, and UTF-8 text.
