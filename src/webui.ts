import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import Hapi from '@hapi/hapi';

import { normalizeAppConfig } from './config';
import { listProviderSchemas } from './model-schema';
import type {
  AppConfigFile,
  AppConfigStore,
  AppServices,
  AppSettings,
  JsonObject,
  Logger,
  ModelConfig,
  ModelTask,
} from './types';

const REDACTED = '__redacted__';

/** Constant-time string comparison that never short-circuits on length. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Deep-clone a config and replace every secret with a redaction marker. */
function redactConfig(config: AppConfigFile): AppConfigFile {
  const copy = JSON.parse(JSON.stringify(config)) as AppConfigFile;
  if (copy.runtime?.ui) {
    if (copy.runtime.ui.password) copy.runtime.ui.password = REDACTED;
    if (copy.runtime.ui.authToken) copy.runtime.ui.authToken = REDACTED;
  }
  if (copy.runtime?.onebot && copy.runtime.onebot.accessToken) {
    copy.runtime.onebot.accessToken = REDACTED;
  }
  for (const group of Object.values(copy.runtime?.models ?? {})) {
    for (const model of group) {
      if (model.parameters && typeof model.parameters.apiKey === 'string' && model.parameters.apiKey) {
        model.parameters.apiKey = REDACTED;
      }
    }
  }
  return copy;
}

/** Strip apiKey from a list of models before sending to the browser. */
function redactModels(models: ModelConfig[]): ModelConfig[] {
  return models.map((model) => {
    if (model.parameters && typeof model.parameters.apiKey === 'string' && model.parameters.apiKey) {
      return { ...model, parameters: { ...model.parameters, apiKey: REDACTED } };
    }
    return model;
  });
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
      if (!model.parameters || model.parameters.apiKey !== REDACTED) continue;
      const prevKey = currentModels.get(model.id)?.parameters?.apiKey;
      if (typeof prevKey === 'string') {
        model.parameters.apiKey = prevKey;
      } else {
        delete model.parameters.apiKey;
        warnings.push(
          `模型 "${model.id}" 的 apiKey 无法从原配置恢复（id 可能已改名），该模型现在没有密钥`,
        );
      }
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
): Promise<ModelConfig | null> {
  if (!payload || Array.isArray(payload)) return null;
  const family = typeof payload.family === 'string' ? payload.family : '';
  const provider = typeof payload.provider === 'string' ? payload.provider.trim() : '';
  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  const rawParams = payload.parameters && typeof payload.parameters === 'object' ? payload.parameters : {};
  const params: JsonObject = { ...(rawParams as JsonObject) };

  if (!deps.models.listFamilies().includes(family as ModelConfig['family'])) return null;
  if (!provider) return null;

  // 恢复被脱敏的 apiKey
  if (params.apiKey === REDACTED) {
    if (id) {
      const existing = (await deps.models.listModels()).find((m) => m.id === id);
      const prevKey = existing?.parameters?.apiKey;
      if (typeof prevKey === 'string') params.apiKey = prevKey;
      else delete params.apiKey;
    } else {
      delete params.apiKey;
    }
  }

  return {
    id: id || 'probe',
    label: '',
    family: family as ModelConfig['family'],
    provider,
    enabled: true,
    taskBindings: [],
    parameters: params,
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
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
    getStatus(): { forwardConnected: boolean; reverseConnected: boolean; reversePeerCount: number; stopped: boolean };
  };
  handleIncomingEvent: (payload: JsonObject, headers: Record<string, unknown>) => Promise<unknown>;
  appLogger: Logger;
}

function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readHeaderValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function renderPage(title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<script>
(function(){try{var t=localStorage.getItem('f261_theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light')}catch(e){}})();
</script>
<style>
  :root{--bg:#f5f6fa;--surface:#fff;--sidebar:#1e2433;--stext:#c8cdd8;--text:#1a1d2e;--text2:#6b7187;--border:#e2e5ee;--accent:#4f6ef6;--a2:#eef0ff;--green:#20a057;--g2:#e6f7ee;--red:#e03040;--r2:#fdebee;--r:8px;--nav-h:56px}
  :root[data-theme="dark"]{--bg:#0e1117;--surface:#171b26;--sidebar:#11141d;--stext:#99a2b6;--text:#e5e8f0;--text2:#8b93a8;--border:#232b3a;--accent:#6f89f8;--a2:#1c2440;--green:#3bc37a;--g2:#0f2e22;--red:#ff5c6b;--r2:#381c24}
  :root[data-theme="dark"] .alert-banner{background:#2c2a17;border-color:#8a7a1a;color:#d8c47a}
  :root[data-theme="dark"] .bottom-nav{background:var(--sidebar)}
  :root[data-theme="dark"] input,:root[data-theme="dark"] select,:root[data-theme="dark"] textarea{background:var(--surface);border-color:var(--border)}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);display:flex;min-height:100vh;line-height:1.5}
  a{color:var(--accent);text-decoration:none}
  button,input,select,textarea{font-family:inherit;font-size:.85rem;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);padding:7px 14px;outline:none;transition:border-color .15s}
  button{cursor:pointer;font-weight:500}
  button:focus-visible,input:focus-visible,select:focus-visible{box-shadow:0 0 0 3px rgba(79,110,246,.15)}
  input:focus,select:focus,textarea:focus{border-color:var(--accent)}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button.primary:hover{filter:brightness(1.08)}
  button.danger{background:var(--red);border-color:var(--red);color:#fff}
  button.small{padding:3px 10px;font-size:.78rem}
  h2{font-size:1.05rem;font-weight:600;margin-bottom:4px}
  h3{font-size:.9rem;font-weight:600;margin-bottom:8px}
  .dim{color:var(--text2);font-size:.82rem}
  .header{display:none}
  .bottom-nav{width:220px;background:var(--sidebar);color:var(--stext);display:flex;flex-direction:column;flex-shrink:0;padding:24px 0;order:-1}
  .bottom-nav .brand-desktop{padding:0 20px 28px;font-size:1.15rem;font-weight:700;color:#fff;letter-spacing:-.3px}
  .bottom-nav a{display:block;padding:10px 20px;color:var(--stext);font-size:.84rem;border-left:3px solid transparent;text-decoration:none;transition:all .12s}
  .bottom-nav a:hover,.bottom-nav a.active{color:#fff;background:rgba(255,255,255,.06);border-left-color:var(--accent)}
  .bottom-nav a .ni{display:none}
  .bottom-nav .footer-desktop{padding:20px;margin-top:auto;font-size:.72rem;color:rgba(200,205,216,.4)}
  .main{flex:1;padding:28px 32px;overflow-y:auto;max-width:1100px}
  .section{display:none}
  .section.active{display:block}
  .section h2{margin-bottom:18px;font-size:1.25rem}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-bottom:24px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px 20px}
  .card .card-stat{font-size:1.8rem;font-weight:700;color:var(--accent)}
  .card .card-body{flex:1}
  .card .card-label{font-size:.78rem;color:var(--text2);margin-top:2px}
  .list{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
  .list-item{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:.84rem;gap:12px}
  .list-item .info{flex:1;min-width:0}
  .list-item .info .title{font-weight:600;word-break:break-word}
  .list-item .info .sub{font-size:.76rem;color:var(--text2);margin-top:1px;word-break:break-word}
  .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.72rem;font-weight:600}
  .badge-on{background:var(--g2);color:var(--green)}
  .badge-off{background:var(--r2);color:var(--red)}
  .badge-task{background:var(--a2);color:var(--accent);margin-left:3px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .row input,.row select{flex:1;min-width:120px}
  .stack{display:flex;flex-direction:column;gap:10px}
  .gap-16{gap:16px}
  .config-json{width:100%;min-height:420px;font-family:'SF Mono','Cascadia Code','Fira Code','Consolas',monospace;font-size:.78rem;resize:vertical;padding:14px;border-radius:var(--r);border:1px solid var(--border);background:var(--surface)}
  .log-wrap{max-height:70vh;overflow:auto;border:1px solid var(--border);border-radius:var(--r);background:var(--surface)}
  #log-table table{table-layout:fixed;width:100%}
  #log-table td:nth-child(1){width:52px!important}
  #log-table td:nth-child(2){width:80px!important;white-space:normal!important;overflow:hidden;text-overflow:ellipsis}
  #log-table td:nth-child(3){width:90px!important;white-space:normal!important;overflow:hidden;text-overflow:ellipsis}
  .search-input{padding:8px 14px;font-size:.85rem;width:100%}
  .toast{position:fixed;top:16px;right:16px;padding:10px 18px;border-radius:6px;font-size:.84rem;font-weight:500;z-index:99;animation:fade .3s}
  .toast-ok{background:var(--g2);color:var(--green);border:1px solid var(--green)}
  .toast-err{background:var(--r2);color:var(--red);border:1px solid var(--red)}
  .alert-banner{background:#fff3cd;border:1px solid #ffc107;color:#856404;padding:10px 14px;border-radius:var(--r);margin-bottom:14px;font-size:.82rem;line-height:1.5}
  .alert-banner strong{display:block;margin-bottom:2px}
  @keyframes fade{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
  /* ---- 模型管理 workbench（参考 AstrBot provider-workbench 布局） ---- */
  .model-workbench{display:grid;grid-template-columns:280px 1px minmax(0,1fr);align-items:stretch;height:calc(100vh - 160px);min-height:520px;max-height:760px}
  .model-sources{background:var(--surface);border:1px solid var(--border);border-radius:var(--r) 0 0 var(--r);display:flex;flex-direction:column;min-height:0;overflow:hidden}
  .model-sources-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 14px 10px;border-bottom:1px solid var(--border)}
  .model-sources-head h3{margin:0;font-size:.9rem}
  .model-sources-list{flex:1;min-height:0;overflow-y:auto;padding:6px}
  .model-source-item{position:relative;display:flex;flex-direction:column;gap:5px;padding:10px 12px;border-radius:10px;cursor:pointer;color:inherit;text-align:left}
  .model-source-item:hover{background:rgba(79,110,246,.06)}
  .model-source-item.active{background:var(--a2)}
  .model-source-item__title{font-size:.84rem;font-weight:600;overflow-wrap:anywhere;padding-right:38px}
  .model-source-item__sub{font-size:.74rem;color:var(--text2);overflow-wrap:anywhere}
  .model-source-item__badges{display:flex;flex-wrap:wrap;gap:4px}
  .model-source-item__toggle{position:absolute;top:9px;right:10px}
  .model-divider{background:var(--border)}
  .model-main{background:var(--surface);border:1px solid var(--border);border-left:0;border-radius:0 var(--r) var(--r) 0;padding:18px 20px;display:flex;flex-direction:column;gap:16px;min-height:0;overflow-y:auto}
  .model-main-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .model-main-title{font-size:1.05rem;font-weight:700}
  .model-main-sub{font-size:.76rem;color:var(--text2);margin-top:3px}
  .model-main-sub .badge{margin-right:4px}
  .model-main-head__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .model-form{display:flex;flex-direction:column;gap:12px;max-width:680px}
  .mf-row{display:grid;grid-template-columns:150px minmax(0,1fr);align-items:center;gap:10px}
  .mf-row>label{font-size:.82rem;font-weight:600;color:var(--text2)}
  .mf-row input[type=text],.mf-row input[type=password],.mf-row input[type=number],.mf-row input:not([type]),.mf-row select,.mf-row textarea{width:100%}
  .mf-row .mf-range{display:flex;gap:8px;align-items:center}
  .mf-row .mf-range input[type=range]{flex:1;padding:0;border:0;background:transparent}
  .mf-row .mf-range input[type=number]{width:84px}
  .mf-hint{grid-column:2;font-size:.72rem;color:var(--text2);margin-top:-4px}
  .mf-row--actions{display:flex;gap:8px}
  .mf-tasks{display:flex;flex-wrap:wrap;gap:6px}
  .mf-tasks label{display:flex;align-items:center;gap:4px;font-size:.78rem;white-space:nowrap;cursor:pointer;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:4px 8px}
  .mf-tasks input{margin:0}
  .switch-line{display:inline-flex;align-items:center;gap:6px;font-size:.78rem;color:var(--text2);cursor:pointer;user-select:none}
  .switch-line input{display:none}
  .switch-line i{display:inline-block;width:34px;height:18px;border-radius:999px;background:var(--border);position:relative;transition:background .15s}
  .switch-line i::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:#fff;transition:transform .15s}
  .switch-line input:checked+i{background:var(--accent)}
  .switch-line input:checked+i::after{transform:translateX(16px)}
  .model-source-item__toggle .switch-line i{width:30px;height:16px}
  .model-source-item__toggle .switch-line i::after{width:12px;height:12px}
  .model-source-item__toggle .switch-line input:checked+i::after{transform:translateX(14px)}
  .model-remote{border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;background:var(--bg)}
  .model-remote__head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
  .model-remote__head h3{margin:0}
  .model-remote__head .dim{flex:1}
  .model-remote-list-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:.82rem;margin-bottom:6px}
  .model-remote-list-item code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
  .model-activate{margin-top:auto;border-top:1px solid var(--border);padding-top:14px}
  .model-activate h3{margin-bottom:8px}
  .model-activate .row select{flex:1;min-width:0}
  @media(max-width:768px){
    .model-workbench{grid-template-columns:1fr;height:auto;min-height:0;max-height:none}
    .model-divider{display:none}
    .model-sources{border-radius:var(--r)}
    .model-sources-list{max-height:220px}
    .model-main{border-left:1px solid var(--border);border-radius:var(--r);min-height:0;overflow:visible}
    .mf-row{grid-template-columns:104px minmax(0,1fr)}
  }
  @media(max-width:768px){
    body{display:block}
    .header{display:flex;position:sticky;top:0;z-index:30;background:var(--surface);border-bottom:1px solid var(--border);padding:7px 10px;align-items:center;gap:8px}
    .header-title{font-size:.95rem;font-weight:700}
    .header-sub{font-size:.68rem;color:var(--text2)}
    .hamburger{width:34px;height:34px;display:flex;flex-direction:column;justify-content:center;gap:5px;cursor:pointer;padding:8px 6px;-webkit-tap-highlight-color:transparent;flex-shrink:0}
    .hamburger span{display:block;height:2px;background:var(--text);border-radius:1px;transition:all .15s}
    .bottom-nav{position:fixed;top:0;left:0;bottom:0;z-index:40;width:230px;background:var(--surface);box-shadow:2px 0 16px rgba(0,0,0,.12);flex-direction:column;height:auto;padding:12px 0;transform:translateX(-100%);transition:transform .22s ease}
    .bottom-nav.open{transform:translateX(0)}
    .bottom-nav .brand-desktop{padding:10px 18px 14px;font-size:.95rem;font-weight:700;color:var(--text);border-bottom:1px solid var(--border);margin-bottom:4px;display:block}
    .bottom-nav .footer-desktop{display:none}
    .bottom-nav a{flex:none;display:block;padding:11px 18px;font-size:.88rem;color:var(--text);border:none;text-align:left}
    .bottom-nav a.active{color:var(--accent);background:var(--a2);border:none;font-weight:600}
    .bottom-nav a .ni{display:none}
    .backdrop{position:fixed;inset:0;z-index:35;background:rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .22s}
    .backdrop.open{opacity:1;pointer-events:auto}
    .main{padding:8px 10px;max-width:none}
    .section h2{margin-bottom:10px;font-size:1.05rem}
    .cards{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
    .card{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:6px}
    .card .card-stat{font-size:1rem;min-width:40px}
    .card .card-label{font-size:.75rem}
    .config-json{min-height:50vh}
    .log-wrap{max-height:50vh;-webkit-overflow-scrolling:touch}
    .toast{top:48px;left:8px;right:8px}
    .stack{gap:8px}
  }
</style>
</head>
<body>
<header class="header">
  <div class="hamburger"><span></span><span></span><span></span></div>
  <div style="flex:1;min-width:0"><div class="header-title">${escapeHtml(title)}</div><div class="header-sub" id="header-info"></div></div>
</header>
<div class="backdrop"></div>
<main class="main">
  <section class="section active" id="sec-dashboard">
    <h2>仪表盘</h2>
    <div class="cards" id="dash-cards"></div>
    <h3 style="margin-top:8px">最近消息</h3>
    <div class="list" id="dash-events"></div>
    <h3 style="margin-top:8px">最近摘要</h3>
    <div class="list" id="dash-summaries"></div>
  </section>
  <section class="section" id="sec-models">
    <h2>模型管理</h2>
    <div class="model-workbench">
      <aside class="model-sources">
        <div class="model-sources-head">
          <h3>模型列表</h3>
          <button class="small primary" id="mf-new">＋ 新建</button>
        </div>
        <div class="model-sources-list" id="model-list"></div>
      </aside>
      <div class="model-divider"></div>
      <div class="model-main">
        <div class="model-main-head" id="model-main-head" style="display:none">
          <div class="model-main-head__copy">
            <div class="model-main-title" id="model-main-title">新建模型</div>
            <div class="model-main-sub" id="model-main-sub"></div>
          </div>
          <div class="model-main-head__actions">
            <label class="switch-line" title="保存时生效"><span>启用</span><input type="checkbox" id="mf-enabled" checked /><i></i></label>
            <button class="small" id="mf-test">测试连接</button>
            <button class="small primary" id="mf-fetch">拉取可用模型</button>
            <button class="small danger" id="mf-delete" style="display:none">删除</button>
          </div>
        </div>
        <div id="mf-panel" class="model-form" style="display:none">
          <div class="mf-row"><label>ID</label><input id="mf-id" placeholder="如 claude-sonnet-5" /></div>
          <div class="mf-row"><label>显示名</label><input id="mf-label" placeholder="可选" /></div>
          <div class="mf-row"><label>类型</label><select id="mf-family"><option value="language">语言 language</option><option value="speech-to-text">语音转文字 speech-to-text</option><option value="embedding">嵌入 embedding</option><option value="rerank">重排序 rerank</option></select></div>
          <div class="mf-row"><label>Provider</label><select id="mf-provider"><option value="openai-compatible">openai-compatible</option><option value="rule-based">rule-based (内置回退)</option></select></div>
          <div id="mf-fields"></div>
          <div class="mf-row"><label>任务绑定</label><div id="mf-tasks" class="mf-tasks"></div></div>
          <div class="mf-row mf-row--actions">
            <button class="primary" id="mf-save">保存</button>
            <button id="mf-reset">重置</button>
            <span class="dim" id="mf-status"></span>
          </div>
        </div>
        <div class="model-remote" id="model-remote" style="display:none">
          <div class="model-remote__head">
            <h3>可用模型</h3>
            <span class="dim" id="model-remote-note"></span>
            <button class="small" id="model-remote-close" title="关闭">✕</button>
          </div>
          <div class="list" id="model-remote-list"></div>
        </div>
        <div class="model-activate">
          <h3>任务激活</h3>
          <div class="row">
            <select id="model-task-sel"><option value="">选择任务...</option></select>
            <select id="model-id-sel"><option value="">选择模型...</option></select>
            <button class="primary" id="model-activate">绑定</button>
          </div>
          <p class="dim" style="margin-top:6px">为任务指定当前使用的模型；未绑定的任务会自动使用第一个启用的候选模型。</p>
        </div>
      </div>
    </div>
  </section>
  <section class="section" id="sec-plugins">
    <h2>插件管理</h2>
    <div class="row gap-16" style="margin-bottom:14px"><button class="primary" id="plugin-reload">重新加载</button></div>
    <div class="list" id="plugin-list"></div>
  </section>
  <section class="section" id="sec-knowledge">
    <h2>知识库</h2>
    <div class="row gap-16" style="margin-bottom:14px">
      <input class="search-input" id="kb-search-input" placeholder="语义搜索..." />
      <button class="primary" id="kb-search-btn">搜索</button>
    </div>
    <div class="row gap-16" style="margin-bottom:14px">
      <input class="search-input" id="kb-add-input" placeholder="添加知识条目..." />
      <button class="primary" id="kb-add-btn">添加</button>
    </div>
    <div class="list" id="kb-list"></div>
    <div class="stack gap-16" style="max-width:520px;margin-top:18px">
      <div class="row"><label style="width:110px;font-weight:600;flex-shrink:0">启用</label><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="kb-enabled" /> 启用知识库（语义搜索/记忆）</label></div>
      <div class="row"><label style="width:110px;font-weight:600;flex-shrink:0">搜索返回条数</label><input id="kb-maxresults" type="number" style="flex:1" min="1" step="1" /></div>
      <div class="row"><label style="width:110px;font-weight:600;flex-shrink:0">向量维度</label><input id="kb-dim" type="number" style="flex:1" min="1" step="1" placeholder="留空 = 自动" /></div>
      <div class="row"><button class="primary" id="kb-settings-save">保存设置</button><span class="dim" id="kb-settings-status"></span></div>
    </div>
  </section>
  <section class="section" id="sec-admins">
    <h2>管理员</h2>
    <div class="row gap-16" style="margin-bottom:14px">
      <input id="admin-input" placeholder="QQ 号" />
      <button class="primary" id="admin-add">添加</button>
    </div>
    <div class="list" id="admin-list"></div>
    <p class="dim">管理员可使用所有命令，也是摘要和记忆报告的唯一接收者。</p>
    <h2 style="margin-top:28px">管理密码</h2>
    <div class="row gap-16" style="margin-bottom:8px">
      <input id="pw-input" type="password" placeholder="新密码（至少 6 位）" />
      <button class="primary" id="pw-set">设置</button>
    </div>
    <p class="dim" id="pw-hint"></p>
  </section>
  <section class="section" id="sec-config">
    <h2>配置编辑</h2>
    <p class="dim" style="margin-bottom:10px">直接编辑 config.json。修改 settings.* 字段后需手动重启应用。</p>
    <textarea class="config-json" id="config-json"></textarea>
    <div class="row" style="margin-top:10px">
      <button class="primary" id="config-save">保存</button>
      <span class="dim" id="config-status"></span>
    </div>
  </section>
  <section class="section" id="sec-ws">
    <h2>WebSocket 管理</h2>
    <div class="cards" id="ws-status-cards" style="margin-bottom:18px">
      <div class="card"><div class="card-stat" id="ws-forward-dot">—</div><div class="card-body"><div class="card-label">正向连接</div><div class="dim" style="font-size:.7rem" id="ws-forward-detail"></div></div></div>
      <div class="card"><div class="card-stat" id="ws-reverse-dot">—</div><div class="card-body"><div class="card-label">反向连接</div><div class="dim" style="font-size:.7rem" id="ws-reverse-detail"></div></div></div>
      <div class="card"><div class="card-stat" id="ws-ready-dot">—</div><div class="card-body"><div class="card-label">API 就绪</div><div class="dim" style="font-size:.7rem" id="ws-ready-detail"></div></div></div>
    </div>
    <p class="dim" style="margin-bottom:14px">修改后自动保存并重连，无需重启应用。</p>
    <div class="stack gap-16" style="max-width:520px">
      <div class="row">
        <label style="width:100px;font-weight:600;flex-shrink:0">连接模式</label>
        <select id="ws-mode" style="flex:1">
          <option value="off">关闭 (off)</option>
          <option value="forward">正向 (forward) — 应用主动连接协议端</option>
          <option value="reverse">反向 (reverse) — 协议端连接应用</option>
          <option value="both">双向 (both)</option>
        </select>
      </div>
      <div class="row" id="ws-forward-row">
        <label style="width:100px;font-weight:600;flex-shrink:0">正向地址</label>
        <input id="ws-forward-url" style="flex:1" placeholder="ws://127.0.0.1:6700" />
      </div>
      <div class="row" id="ws-reverse-row">
        <label style="width:100px;font-weight:600;flex-shrink:0">反向路径</label>
        <input id="ws-reverse-path" style="flex:1" placeholder="/onebot/ws" />
      </div>
      <div class="row">
        <label style="width:100px;font-weight:600;flex-shrink:0">重连间隔</label>
        <input id="ws-reconnect" style="flex:1" placeholder="5000" type="number" min="1000" step="500" />
        <span class="dim" style="flex-shrink:0">ms</span>
      </div>
      <div class="row">
        <label style="width:100px;font-weight:600;flex-shrink:0">动作超时</label>
        <input id="ws-timeout" style="flex:1" placeholder="10000" type="number" min="1000" step="1000" />
        <span class="dim" style="flex-shrink:0">ms</span>
      </div>
      <div class="row">
        <button class="primary" id="ws-save">保存并重连</button>
        <button class="" id="ws-refresh-status">刷新状态</button>
        <span class="dim" id="ws-status-text"></span>
      </div>
    </div>
  </section>
  <section class="section" id="sec-log">
    <h2>消息日志</h2>
    <div class="row gap-16" style="margin-bottom:10px">
      <select id="log-filter-scope" style="min-width:80px"><option value="all">全部</option><option value="private">私聊</option><option value="group">群聊</option></select>
      <label style="font-size:.8rem;white-space:nowrap"><input type="checkbox" id="log-filter-admin" checked />管理</label>
      <label style="font-size:.8rem;white-space:nowrap"><input type="checkbox" id="log-filter-bot" />Bot</label>
      <label style="font-size:.8rem;white-space:nowrap"><input type="checkbox" id="log-filter-user" checked />用户</label>
      <button class="primary small" id="log-refresh">刷新</button>
      <span class="dim" id="log-count" style="white-space:nowrap"></span>
    </div>
    <div class="log-wrap" id="log-table">
      <div class="dim" style="padding:20px;text-align:center">加载中…</div>
    </div>
  </section>
  <section class="section" id="sec-onebot">
    <h2>OneBot 连接设置</h2>
    <p class="dim" style="margin-bottom:14px">HTTP API 与事件上报的连接参数。保存后即时生效。</p>
    <div class="stack gap-16" style="max-width:520px">
      <div class="row"><label style="width:100px;font-weight:600;flex-shrink:0">API 地址</label><input id="ob-baseurl" style="flex:1" placeholder="http://127.0.0.1:5700" /></div>
      <div class="row"><label style="width:100px;font-weight:600;flex-shrink:0">API 前缀</label><input id="ob-apiprefix" style="flex:1" placeholder="/api" /></div>
      <div class="row"><label style="width:100px;font-weight:600;flex-shrink:0">Access Token</label><input id="ob-token" type="password" style="flex:1" placeholder="留空则不使用 token" /></div>
      <div class="row"><label style="width:100px;font-weight:600;flex-shrink:0">自身 QQ 号</label><input id="ob-selfid" style="flex:1" placeholder="可选，留空自动获取" /></div>
      <div class="row"><label style="width:100px;font-weight:600;flex-shrink:0">请求超时</label><input id="ob-timeout" type="number" style="flex:1" min="500" step="500" /><span class="dim" style="flex-shrink:0">ms</span></div>
      <div class="row"><button class="primary" id="ob-save">保存</button><span class="dim" id="ob-status"></span></div>
    </div>
  </section>
  <section class="section" id="sec-summary">
    <h2>摘要设置</h2>
    <p class="dim" style="margin-bottom:14px">定时消息摘要工作器。修改保存后即时生效，无需重启。</p>
    <div class="stack gap-16" style="max-width:520px">
      <div class="row"><label style="width:110px;font-weight:600;flex-shrink:0">启用</label><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="sm-enabled" /> 定时生成摘要</label></div>
      <div class="row"><label style="width:110px;font-weight:600;flex-shrink:0">生成间隔</label><input id="sm-interval" type="number" style="flex:1" min="5000" step="1000" /><span class="dim" style="flex-shrink:0">ms</span></div>
      <div class="row"><label style="width:110px;font-weight:600;flex-shrink:0">触发条数</label><input id="sm-batch" type="number" style="flex:1" min="1" step="1" /><span class="dim" style="flex-shrink:0">新消息数 ≥ 此值触发</span></div>
      <div class="row"><label style="width:110px;font-weight:600;flex-shrink:0">单次最大事件</label><input id="sm-maxevents" type="number" style="flex:1" min="1" step="1" /><span class="dim" style="flex-shrink:0">每条摘要含最多事件数</span></div>
      <div class="row"><button class="primary" id="sm-save">保存</button><button id="sm-flush">立即生成摘要</button><span class="dim" id="sm-status"></span></div>
    </div>
  </section>
  <section class="section" id="sec-notify">
    <h2>关键词告警</h2>
    <p class="dim" style="margin-bottom:14px">消息含关键词时立即私聊通知管理员（免打扰时段除外）。</p>
    <div class="row gap-16" style="margin-bottom:10px;max-width:560px">
      <input id="nt-kw" placeholder="新关键词..." style="flex:1" />
      <button class="primary" id="nt-kw-add">添加</button>
    </div>
    <div class="list" id="nt-kw-list" style="max-width:560px"></div>
    <h2 style="margin-top:24px">免打扰时段</h2>
    <p class="dim" style="margin-bottom:10px">时段内普通消息不推送，关键词告警仍生效。</p>
    <div class="row gap-16" style="max-width:520px">
      <input id="nt-qh-start" placeholder="23:00" style="flex:1" />
      <span class="dim" style="flex-shrink:0">至</span>
      <input id="nt-qh-end" placeholder="07:00" style="flex:1" />
      <button class="primary" id="nt-qh-save">保存</button>
      <button id="nt-qh-off">关闭免打扰</button>
    </div>
    <span class="dim" id="nt-status"></span>
  </section>
  <section class="section" id="sec-reply">
    <h2>待回复管理</h2>
    <p class="dim" style="margin-bottom:10px">被 @ 或疑似需要回复的消息会暂存于此，可让 AI 生成回复或忽略。</p>
    <div class="row gap-16" style="margin-bottom:10px"><button class="primary small" id="rp-refresh">刷新</button><span class="dim" id="rp-count"></span></div>
    <div class="list" id="rp-list"></div>
  </section>
</main>
<div class="bottom-nav">
  <div class="brand-desktop">${escapeHtml(title)}</div>
  <a href="#dashboard" class="active" data-nav="dashboard"><span class="ni">📊</span>仪表盘</a>
  <a href="#models" data-nav="models"><span class="ni">🤖</span>模型</a>
  <a href="#plugins" data-nav="plugins"><span class="ni">🔌</span>插件</a>
  <a href="#knowledge" data-nav="knowledge"><span class="ni">📚</span>知识库</a>
  <a href="#admins" data-nav="admins"><span class="ni">👤</span>管理员</a>
  <a href="#config" data-nav="config"><span class="ni">⚙️</span>配置</a>
  <a href="#ws" data-nav="ws"><span class="ni">🔗</span>WS</a>
  <a href="#onebot" data-nav="onebot"><span class="ni">🛰️</span>OneBot</a>
  <a href="#summary" data-nav="summary"><span class="ni">🧾</span>摘要</a>
  <a href="#notify" data-nav="notify"><span class="ni">🔔</span>告警</a>
  <a href="#reply" data-nav="reply"><span class="ni">💬</span>回复</a>
  <a href="#log" data-nav="log"><span class="ni">📝</span>日志</a>
  <div class="footer-desktop">
    <select id="theme-sel" aria-label="主题" style="width:100%;margin-bottom:8px;font-size:.76rem;background:rgba(255,255,255,.06);color:#c8cdd8;border-color:rgba(200,205,216,.3)">
      <option value="system">🌓 跟随系统</option>
      <option value="light">☀️ 浅色</option>
      <option value="dark">🌙 深色</option>
    </select>
    <div>F261Agent</div>
  </div>
</div>
<script>
var DATA={},configDirty=!1;
function toggleDrawer(){var n=document.querySelector('.bottom-nav'),b=document.querySelector('.backdrop'),o=n.classList.toggle('open');b.classList.toggle('open',o)}
document.querySelector('.hamburger').onclick=toggleDrawer;
document.querySelector('.backdrop').onclick=toggleDrawer;
document.querySelectorAll('.bottom-nav a').forEach(function(a){a.addEventListener('click',function(){document.querySelector('.bottom-nav').classList.remove('open');document.querySelector('.backdrop').classList.remove('open')})});
function toast(m,ok){var e=document.createElement('div');e.className='toast '+(ok?'toast-ok':'toast-err');e.textContent=m;document.body.appendChild(e);setTimeout(function(){e.remove()},2500)}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
var AUTH='';var am=location.search.match(/[?&]t=([^&]+)/);
if(am){AUTH=decodeURIComponent(am[1]);try{sessionStorage.setItem('f261_token',AUTH)}catch(e){}
/* Strip the token from the address bar so it stays out of history and Referer. */
try{history.replaceState(null,'',location.pathname+location.hash)}catch(e){}}
else{try{AUTH=sessionStorage.getItem('f261_token')||''}catch(e){AUTH=''}}
function api(p,opts){var o=opts||{};var h=Object.assign({'content-type':'application/json'},o.headers||{});if(AUTH)h['x-admin-token']=AUTH;var r=fetch(p,Object.assign({},o,{headers:h}));return r.then(function(r){if(r.status===401){try{sessionStorage.removeItem('f261_token')}catch(e){}location.replace(location.pathname);return Promise.reject(new Error('会话已过期，请重新登录'))}if(!r.ok)return r.text().then(function(b){throw new Error(r.status+' '+b)});return r.json()})}
document.querySelectorAll('[data-nav]').forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();document.querySelectorAll('[data-nav]').forEach(function(x){x.classList.remove('active')});a.classList.add('active');document.querySelectorAll('.section').forEach(function(s){s.classList.remove('active')});document.getElementById('sec-'+a.dataset.nav).classList.add('active');if(a.dataset.nav==='config')renderConfig();if(a.dataset.nav==='models')renderModels();if(a.dataset.nav==='knowledge')renderKnowledge();if(a.dataset.nav==='admins')renderAdmins();if(a.dataset.nav==='plugins')renderPlugins();if(a.dataset.nav==='ws')renderWs();if(a.dataset.nav==='onebot')renderOnebot();if(a.dataset.nav==='summary')renderSummary();if(a.dataset.nav==='notify')renderNotify();if(a.dataset.nav==='reply')renderReply();if(a.dataset.nav==='log')renderLog()})});
function wsLabel(r){var w=r.onebot?.webSocket||{},m=w.mode||'off';if(m==='off')return'off';if(m==='forward'||m==='both')return m+' → '+(w.forwardUrl||'');if(m==='reverse')return m+' ← '+(w.reversePath||'');return m}
function renderDash(){var r=DATA.runtime||{},s=DATA.settings||{};var banner='';if(!(r.ui||{}).password)banner+='<div class="alert-banner"><strong>未设置管理密码</strong>当前任何能访问此地址的人都可以完全控制机器人。请前往「管理员」页立即设置密码。</div>';if((r.admins||[]).length===0)banner+='<div class="alert-banner"><strong>未配置管理员</strong>摘要无法送达，且没人能使用 QQ 命令。请在「管理员」页添加你的 QQ 号。</div>';if(DATA.fallbackOnly)banner+='<div class="alert-banner"><strong>未配置真实AI模型</strong>当前仅有 rule-based fallback，摘要和建议将输出占位文本而非真实分析。请在 WebUI「模型管理」或 config.json 中配置真实模型。</div>';document.getElementById('dash-cards').innerHTML=banner+[['管理员',(r.admins||[]).length,''],['模型',(DATA.models||[]).length,''],['插件',(DATA.plugins||[]).length,(DATA.plugins||[]).filter(function(p){return p.enabled}).length+' 启用'],['消息',(DATA.events||[]).length,''],['摘要',(DATA.summaries||[]).length,(DATA.summaryStatus||{}).enabled?'每'+(Math.round(((DATA.summaryStatus||{}).intervalMs||120000)/1000))+'s, ≥'+(DATA.summaryStatus||{}).batchSize+'条':'已停用'],['知识库',(DATA.kbCount||0)+'条',(DATA.knowledgeStatus||{}).enabled?'已启用':'已禁用'],['WS','',wsLabel(r)],['目录',s.dataDir||'',(s.host||'')+':'+s.port]].map(function(c){return'<div class="card"><div class="card-stat">'+esc(c[1])+'</div><div class="card-body"><div class="card-label">'+esc(c[0])+'</div><div class="dim" style="font-size:.7rem">'+esc(c[2])+'</div></div></div>'}).join('');document.getElementById('dash-events').innerHTML=(DATA.events||[]).slice(0,8).map(function(e){return'<div class="list-item"><div class="info"><div class="title">['+esc(e.scope)+'] '+esc((e.content?.text||'').slice(0,80))+'</div><div class="sub">'+esc(e.receivedAt)+' | '+esc(e.sender?.userId||'')+'</div></div></div>'}).join('')||'<div class="dim">暂无</div>';document.getElementById('dash-summaries').innerHTML=(DATA.summaries||[]).slice(0,5).map(function(s){return'<div class="list-item"><div class="info"><div class="title">'+esc((s.summaryText||'').slice(0,100))+'</div><div class="sub">'+esc(s.createdAt)+'</div></div></div>'}).join('')||'<div class="dim">暂无</div>'}
function modelSchemaFor(family,provider){return(DATA.modelSchema||[]).find(function(s){return s.provider===provider&&s.family===family})}
function renderModels(){var el=document.getElementById('model-list'),models=DATA.models||[],cur=(DATA.mfEditing||{}).id;el.innerHTML=models.map(function(m){var act=m.id===cur?' active':'',bs='<span class="badge '+(m.enabled?'badge-on':'badge-off')+'">'+(m.enabled?'启用':'禁用')+'</span>',ts=(m.activeTasks||[]).map(function(t){return'<span class="badge badge-task">'+esc(t)+'</span>'}).join('');return'<div class="model-source-item'+act+'" data-mi="'+esc(m.id)+'"><div class="model-source-item__title">'+esc(m.id)+(m.label?' <span style="font-weight:400;color:var(--text2)">'+esc(m.label)+'</span>':'')+'</div><div class="model-source-item__sub">'+esc(m.family)+' · '+esc(m.provider)+'</div><div class="model-source-item__badges">'+bs+ts+'</div><span class="model-source-item__toggle"><label class="switch-line" title="立即启用/禁用"><input type="checkbox" data-mt="'+esc(m.id)+'"'+(m.enabled?' checked':'')+' /><i></i></label></span></div>'}).join('')||'<div class="dim" style="padding:20px;text-align:center">暂无模型<br><span style="font-size:.74rem">点击右上角「＋ 新建」添加</span></div>';document.getElementById('model-task-sel').innerHTML='<option value="">选择任务...</option>'+(DATA.tasks||[]).map(function(t){return'<option>'+esc(t)+'</option>'}).join('');document.getElementById('model-id-sel').innerHTML='<option value="">选择模型...</option>'+models.filter(function(m){return m.enabled}).map(function(m){return'<option>'+esc(m.id)+'</option>'}).join('');document.querySelectorAll('[data-mi]').forEach(function(item){item.onclick=function(e){if(e.target.closest('.model-source-item__toggle'))return;var m=(DATA.models||[]).find(function(x){return x.id===item.dataset.mi});if(!m)return;DATA.mfEditing=m;renderModelForm();renderModels()}});document.querySelectorAll('[data-mt]').forEach(function(cb){cb.onchange=async function(){var id=cb.dataset.mt,prev=cb.checked;try{await api('/api/models/'+encodeURIComponent(id)+'/enabled',{method:'POST',body:JSON.stringify({enabled:prev})});if(DATA.mfEditing&&DATA.mfEditing.id===id)DATA.mfEditing.enabled=prev;await load();renderModels();renderModelForm();toast(id+(prev?' 已启用':' 已禁用'),!0)}catch(e){cb.checked=!prev;toast(e.message,!1)}}})}
document.getElementById('model-activate').onclick=async function(){var t=document.getElementById('model-task-sel').value,m=document.getElementById('model-id-sel').value;if(!t||!m){toast('请选择任务和模型',!1);return}try{await api('/api/models/'+encodeURIComponent(t)+'/activate',{method:'POST',body:JSON.stringify({modelId:m})});await load();renderModels();toast(t+' → '+m,!0)}catch(e){toast(e.message,!1)}}
document.getElementById('plugin-reload').onclick=async function(){try{await api('/api/plugins/reload',{method:'POST'});await load();renderPlugins();toast('已重新加载',!0)}catch(e){toast('重载失败: '+(e&&e.message||e),!1)}}
function renderPlugins(){var el=document.getElementById('plugin-list'),ps=DATA.plugins||[];el.innerHTML=ps.map(function(p){return'<div class="list-item"><div class="info"><div class="title">'+esc(p.name)+' <span class="badge '+(p.enabled?'badge-on':'badge-off')+'">'+(p.enabled?'启用':'禁用')+'</span></div><div class="sub">'+esc(p.description||'')+' v'+esc(p.version)+'</div></div><button class="small '+(p.enabled?'danger':'primary')+'" data-pt="'+esc(p.name)+'">'+(p.enabled?'禁用':'启用')+'</button></div>'}).join('')||'<div class="dim">暂无插件</div>';document.querySelectorAll('[data-pt]').forEach(function(b){b.onclick=async function(){var n=b.dataset.pt,on=b.textContent.trim()==='禁用';try{await api('/api/plugins/'+encodeURIComponent(n)+'/enabled',{method:'POST',body:JSON.stringify({enabled:!on})});await load();renderPlugins();toast(n+(on?' 已禁用':' 已启用'),!0)}catch(e){toast(e.message,!1)}}})}
document.getElementById('kb-search-btn').onclick=async function(){var q=document.getElementById('kb-search-input').value.trim();if(!q){toast('请输入搜索内容',!1);return}try{var r=await api('/api/knowledge/search',{method:'POST',body:JSON.stringify({query:q})});renderKbList(r.map(function(x){return x.entry}))}catch(e){toast(e.message,!1)}}
document.getElementById('kb-add-btn').onclick=async function(){var t=document.getElementById('kb-add-input').value.trim();if(!t){toast('请输入内容',!1);return}try{await api('/api/knowledge',{method:'POST',body:JSON.stringify({text:t})});document.getElementById('kb-add-input').value='';await load();renderKnowledge();toast('已添加',!0)}catch(e){toast(e.message,!1)}}
function renderKnowledge(){api('/api/knowledge?limit=30').then(function(e){renderKbList(e)}).catch(function(){});renderKnowledgeSettings()}
async function renderKnowledgeSettings(){var s;try{s=await api('/api/knowledge/settings')}catch(e){return}document.getElementById('kb-enabled').checked=s.enabled!==false;document.getElementById('kb-maxresults').value=s.maxResults||10;document.getElementById('kb-dim').value=(s.vectorDimension!=null&&s.vectorDimension!=='')?s.vectorDimension:''}
document.getElementById('kb-settings-save').onclick=async function(){var dimRaw=document.getElementById('kb-dim').value.trim();var payload={maxResults:parseInt(document.getElementById('kb-maxresults').value,10)||10,enabled:document.getElementById('kb-enabled').checked};payload.vectorDimension=dimRaw===''?null:parseInt(dimRaw,10)||null;try{await api('/api/knowledge/settings',{method:'POST',body:JSON.stringify(payload)});await load();renderKnowledgeSettings();toast('知识库设置已保存',!0)}catch(e){toast(e.message,!1)}}
function renderKbList(entries){var el=document.getElementById('kb-list');el.innerHTML=(entries||[]).map(function(e){return'<div class="list-item"><div class="info"><div class="title">'+esc((e.text||'').slice(0,120))+'</div><div class="sub">'+esc((e.id||'').slice(0,8))+' | '+esc(e.createdAt)+' | '+esc((e.metadata||{}).type||'')+'</div></div><button class="small danger" data-kd="'+esc(e.id)+'">删除</button></div>'}).join('')||'<div class="dim">暂无条目</div>';document.querySelectorAll('[data-kd]').forEach(function(b){b.onclick=async function(){var id=b.dataset.kd;try{var r=await api('/api/knowledge/'+encodeURIComponent(id),{method:'DELETE'});await load();renderKnowledge();toast(r&&r.deleted?'已删除':'未找到该条目',!!(r&&r.deleted))}catch(e){toast(e.message,!1)}}})}
document.getElementById('admin-add').onclick=async function(){var v=document.getElementById('admin-input').value.trim();if(!v){toast('请输入 QQ 号',!1);return}try{await api('/api/admins',{method:'POST',body:JSON.stringify({userId:v})});document.getElementById('admin-input').value='';await load();renderAdmins();toast('已添加 '+v,!0)}catch(e){toast(e.message,!1)}}
function renderAdmins(){var a=(DATA.runtime||{}).admins||[],el=document.getElementById('admin-list');el.innerHTML=a.map(function(id){return'<div class="list-item"><div class="info"><div class="title">'+esc(id)+'</div></div><button class="small danger" data-ad="'+esc(id)+'">移除</button></div>'}).join('')||'<div class="dim">暂无管理员</div>';document.querySelectorAll('[data-ad]').forEach(function(b){b.onclick=async function(){var id=b.dataset.ad;try{await api('/api/admins/'+encodeURIComponent(id),{method:'DELETE'});await load();renderAdmins();toast('已移除 '+id,!0)}catch(e){toast(e.message,!1)}}});document.getElementById('pw-hint').textContent=((DATA.runtime||{}).ui||{}).password?'已设置密码。在此输入新密码可更换，所有旧登录会话将失效。':'尚未设置密码 — 当前任何人都可访问此面板，强烈建议立即设置。'}
document.getElementById('pw-set').onclick=async function(){var v=document.getElementById('pw-input').value;if(v.length<6){toast('密码至少 6 位',!1);return}try{var r=await api('/api/ui-password',{method:'POST',body:JSON.stringify({password:v})});if(r.token){AUTH=r.token;try{sessionStorage.setItem('f261_token',r.token)}catch(e2){}}document.getElementById('pw-input').value='';await load();renderAdmins();toast('密码已设置',!0)}catch(e){toast(e.message,!1)}}
document.getElementById('config-save').onclick=async function(){
/* Refuse to save an empty/partial document: posting {} before the first state
   load would normalize to pure defaults and wipe the entire config. */
if(!DATA.config||!DATA.config.runtime){toast('配置尚未加载完成，请稍候再试',!1);return}
try{var c=JSON.parse(document.getElementById('config-json').value);
if(!c||typeof c!=='object'||Array.isArray(c)||!c.settings||!c.runtime){toast('配置必须包含 settings 与 runtime 两个部分',!1);return}
var r=await api('/api/config',{method:'POST',body:JSON.stringify(c)});
configDirty=!1;document.getElementById('config-status').textContent='已保存 '+new Date().toLocaleTimeString();
if(r&&r.warnings&&r.warnings.length)r.warnings.forEach(function(w){toast(w,!1)});else toast('配置已保存',!0);
await load()}catch(e){toast('保存失败: '+(e&&e.message||e),!1)}}
window.addEventListener('beforeunload',function(e){if(configDirty){e.preventDefault();e.returnValue=''}});
document.getElementById('config-json').oninput=function(){configDirty=!0;document.getElementById('config-status').textContent='未保存'}
function renderConfig(){if(!configDirty)document.getElementById('config-json').value=JSON.stringify(DATA.config||{},null,2)}
async function load(){try{DATA=await api('/api/state');var a=(DATA.runtime||{}).admins||[],m=DATA.models||[],p=DATA.plugins||[];document.getElementById('header-info').textContent='👤'+a.length+' 🤖'+m.filter(function(x){return x.enabled}).length+' 🔌'+p.filter(function(x){return x.enabled}).length;renderDash()}catch(e){document.getElementById('dash-cards').innerHTML='<div class="card"><div class="card-stat">!</div><div class="card-body"><div class="card-label">加载失败</div></div></div>'}}
function dot(on){return'<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:'+(on?'#20a057':'#e03040')+';margin-right:4px"></span>'+(on?'已连接':'未连接')}
async function refreshWsStatus(){try{var s=await api('/api/ws-status');var t=s.transport||{};document.getElementById('ws-forward-dot').innerHTML=dot(t.forwardConnected);document.getElementById('ws-forward-detail').textContent=t.forwardConnected?'Connected':(s.config?.mode==='forward'||s.config?.mode==='both'?'等待连接…':'已关闭');document.getElementById('ws-reverse-dot').innerHTML=dot(t.reverseConnected);document.getElementById('ws-reverse-detail').textContent=t.reverseConnected?(t.reversePeerCount+' peer'+(t.reversePeerCount>1?'s':'')):(s.config?.mode==='reverse'||s.config?.mode==='both'?'等待协议端连接…':'已关闭');document.getElementById('ws-ready-dot').innerHTML=dot(t.forwardConnected||t.reverseConnected);document.getElementById('ws-ready-detail').textContent=t.forwardConnected||t.reverseConnected?'API 调用可用':'不可用'}catch(e){document.getElementById('ws-forward-dot').innerHTML=dot(!1);document.getElementById('ws-reverse-dot').innerHTML=dot(!1)}}
function toggleWsFields(){var m=document.getElementById('ws-mode').value;document.getElementById('ws-forward-row').style.display=(m==='forward'||m==='both')?'':'none';document.getElementById('ws-reverse-row').style.display=(m==='reverse'||m==='both')?'':'none'}
function renderWs(){var ws=(DATA.runtime||{}).onebot?.webSocket||{};document.getElementById('ws-mode').value=ws.mode||'off';document.getElementById('ws-forward-url').value=ws.forwardUrl||'';document.getElementById('ws-reverse-path').value=ws.reversePath||'/onebot/ws';document.getElementById('ws-reconnect').value=ws.reconnectIntervalMs||5000;document.getElementById('ws-timeout').value=ws.actionTimeoutMs||10000;toggleWsFields();refreshWsStatus()}
document.getElementById('ws-mode').onchange=toggleWsFields;
document.getElementById('ws-save').onclick=async function(){var cfg={mode:document.getElementById('ws-mode').value,forwardUrl:document.getElementById('ws-forward-url').value.trim(),reversePath:document.getElementById('ws-reverse-path').value.trim()||'/onebot/ws',reconnectIntervalMs:parseInt(document.getElementById('ws-reconnect').value,10)||5000,actionTimeoutMs:parseInt(document.getElementById('ws-timeout').value,10)||10000};try{await api('/api/ws-config',{method:'POST',body:JSON.stringify(cfg)});await load();renderWs();toast('WebSocket 配置已保存并重连',!0)}catch(e){toast('保存失败: '+(e&&e.message||e),!1)}}
document.getElementById('ws-refresh-status').onclick=async function(){try{await refreshWsStatus();toast('状态已刷新',!0)}catch(e){toast('刷新失败: '+(e&&e.message||e),!1)}}
var logAutoRefresh=!0,logTimer=null;
function renderLog(){var filterScope=document.getElementById('log-filter-scope').value,filterAdmin=document.getElementById('log-filter-admin').checked,filterBot=document.getElementById('log-filter-bot').checked,filterUser=document.getElementById('log-filter-user').checked;api('/api/events').then(function(events){var filtered=(events||[]).filter(function(e){if(filterScope!=='all'&&e.scope!==filterScope)return!1;if(e.visibility?.fromAdmin&&!filterAdmin)return!1;if(e.visibility?.fromBot&&!filterBot)return!1;if(!e.visibility?.fromAdmin&&!e.visibility?.fromBot&&!filterUser)return!1;return!0});var html='<table style="width:100%;border-collapse:collapse;font-size:.82rem"><thead><tr style="position:sticky;top:0;background:var(--bg);z-index:1"><th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);width:52px;white-space:nowrap">时间</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);width:80px">范围</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);width:90px">发送者</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border)">内容</th></tr></thead><tbody>';filtered.forEach(function(e){var time=(e.receivedAt||'').slice(11,19)||'--:--:--',scopeIcon=e.scope==='group'?'群':'私',scopeName=e.scope==='group'?(e.conversationId||'').replace('group:','')+(e.sender?.card?' @'+e.sender.card.slice(0,10):''):(e.sender?.userId||''),sender=esc(e.sender?.nickname||e.sender?.userId||'?'),text=esc((e.content?.text||'').slice(0,200)),flags=[];if(e.visibility?.fromAdmin)flags.push('<span class="badge badge-on" style="font-size:.68rem">管理</span>');if(e.visibility?.fromBot)flags.push('<span class="badge badge-off" style="font-size:.68rem;background:#f0e6ff;color:#7c3aed">Bot</span>');html+='<tr style="border-bottom:1px solid var(--border);'+(e.visibility?.fromAdmin?'background:rgba(79,110,246,.03)':'')+(e.visibility?.fromBot?'background:rgba(124,58,237,.03)':'')+'"><td style="padding:5px 8px;white-space:nowrap;font-variant-numeric:tabular-nums">'+esc(time)+'</td><td style="padding:5px 8px;white-space:nowrap;font-size:.76rem;color:var(--text2)">['+esc(scopeIcon)+'] '+esc(scopeName)+'</td><td style="padding:5px 8px;white-space:nowrap">'+sender+' '+flags.join(' ')+'</td><td style="padding:5px 8px;word-break:break-word">'+text+'</td></tr>'});html+='</tbody></table>';if(filtered.length===0)html='<div class="dim" style="padding:20px;text-align:center">暂无匹配消息</div>';document.getElementById('log-table').innerHTML=html;document.getElementById('log-count').textContent=filtered.length+' / '+(events||[]).length+' 条'});if(logAutoRefresh&&document.getElementById('sec-log').classList.contains('active')){clearTimeout(logTimer);logTimer=setTimeout(renderLog,5000)}}
document.getElementById('log-refresh').onclick=function(){renderLog();toast('日志已刷新',!0)}
document.getElementById('log-filter-scope').onchange=renderLog;
document.getElementById('log-filter-admin').onchange=renderLog;
document.getElementById('log-filter-bot').onchange=renderLog;
document.getElementById('log-filter-user').onchange=renderLog;
function applyTheme(){var t='system';try{t=localStorage.getItem('f261_theme')||'system'}catch(e){}var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');var s=document.getElementById('theme-sel');if(s)s.value=t}
document.getElementById('theme-sel').onchange=function(){try{localStorage.setItem('f261_theme',this.value)}catch(e){}applyTheme()};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyTheme);
applyTheme();
function renderOnebot(){var ob=((DATA.runtime||{}).onebot)||{};document.getElementById('ob-baseurl').value=ob.baseUrl||'';document.getElementById('ob-apiprefix').value=ob.apiPrefix||'/api';document.getElementById('ob-token').value=ob.accessToken?'·已设置·':'';document.getElementById('ob-selfid').value=ob.selfId||'';document.getElementById('ob-timeout').value=ob.timeoutMs||10000}
document.getElementById('ob-save').onclick=async function(){var token=document.getElementById('ob-token').value.trim();var payload={baseUrl:document.getElementById('ob-baseurl').value.trim(),apiPrefix:document.getElementById('ob-apiprefix').value.trim()||'/api',selfId:document.getElementById('ob-selfid').value.trim(),timeoutMs:parseInt(document.getElementById('ob-timeout').value,10)||10000};if(token&&token!=='·已设置·')payload.accessToken=token;try{await api('/api/onebot-config',{method:'POST',body:JSON.stringify(payload)});await load();renderOnebot();toast('OneBot 配置已保存',!0)}catch(e){toast(e.message,!1)}}
function renderSummary(){var s=(DATA.summaryStatus||{});document.getElementById('sm-enabled').checked=s.enabled!==false;document.getElementById('sm-interval').value=s.intervalMs||120000;document.getElementById('sm-batch').value=s.batchSize||5;document.getElementById('sm-maxevents').value=s.maxEventsPerPrompt||40}
document.getElementById('sm-save').onclick=async function(){try{await api('/api/summary/settings',{method:'POST',body:JSON.stringify({enabled:document.getElementById('sm-enabled').checked,intervalMs:parseInt(document.getElementById('sm-interval').value,10)||120000,batchSize:parseInt(document.getElementById('sm-batch').value,10)||5,maxEventsPerPrompt:parseInt(document.getElementById('sm-maxevents').value,10)||40})});await load();renderSummary();toast('摘要设置已保存',!0)}catch(e){toast(e.message,!1)}}
document.getElementById('sm-flush').onclick=async function(){var st=document.getElementById('sm-status');st.textContent='生成中…';try{var r=await api('/api/summary/flush',{method:'POST'});st.textContent=r.empty?'暂无新消息，未生成':('已生成: '+String((r.summaryText||'').slice(0,60)));toast(r.empty?'暂无新消息':'摘要已生成',!0)}catch(e){st.textContent='';toast(e.message,!1)}}
async function renderNotify(){var n;try{n=await api('/api/notify/settings')}catch(e){document.getElementById('nt-kw-list').innerHTML='<div class="dim">加载失败</div>';return}var kws=n.notifyKeywords||[],qh=n.quietHours||null;document.getElementById('nt-kw-list').innerHTML=kws.map(function(k){return'<div class="list-item"><div class="info"><div class="title">'+esc(k)+'</div></div><button class="small danger" data-nk="'+esc(k)+'">移除</button></div>'}).join('')||'<div class="dim">暂无关键词</div>';document.querySelectorAll('[data-nk]').forEach(function(b){b.onclick=async function(){try{await api('/api/notify/settings',{method:'POST',body:JSON.stringify({notifyKeywords:kws.filter(function(x){return x!==b.dataset.nk})})});await load();renderNotify()}catch(e){toast(e.message,!1)}}});document.getElementById('nt-qh-start').value=qh?qh.start:'23:00';document.getElementById('nt-qh-end').value=qh?qh.end:'07:00'}
document.getElementById('nt-kw-add').onclick=async function(){var v=document.getElementById('nt-kw').value.trim();if(!v){toast('请输入关键词',!1);return}var n;try{n=await api('/api/notify/settings')}catch(e){toast(e.message,!1);return}var kws=n.notifyKeywords||[];if(kws.indexOf(v)>=0){toast('关键词已存在',!1);return}try{await api('/api/notify/settings',{method:'POST',body:JSON.stringify({notifyKeywords:kws.concat([v])})});document.getElementById('nt-kw').value='';await load();renderNotify();toast('已添加',!0)}catch(e){toast(e.message,!1)}}
document.getElementById('nt-qh-save').onclick=async function(){var st=document.getElementById('nt-qh-start').value.trim(),en=document.getElementById('nt-qh-end').value.trim();if(!/^\\d{1,2}:\\d{2}$/.test(st)||!/^\\d{1,2}:\\d{2}$/.test(en)){toast('时间格式无效，请使用 HH:MM',!1);return}try{await api('/api/notify/settings',{method:'POST',body:JSON.stringify({quietHours:{start:st,end:en}})});await load();renderNotify();toast('免打扰时段已保存',!0)}catch(e){toast(e.message,!1)}}
document.getElementById('nt-qh-off').onclick=async function(){try{await api('/api/notify/settings',{method:'POST',body:JSON.stringify({quietHours:null})});await load();renderNotify();toast('免打扰已关闭',!0)}catch(e){toast(e.message,!1)}}
async function renderReply(){try{var r=await api('/api/reply/pending');var items=r.items||[];document.getElementById('rp-count').textContent=items.length+' 条待处理';var el=document.getElementById('rp-list');el.innerHTML=items.map(function(p){var scope=p.scope==='group'?'群':'私';return'<div class="list-item" style="flex-direction:column;align-items:stretch;gap:8px"><div class="info"><div class="title">['+esc(scope)+'] '+esc(p.senderName)+' ('+esc(p.senderId)+')</div><div class="sub">'+esc(p.createdAt)+' | '+esc(p.idShort)+'</div></div><div style="font-size:.82rem">'+esc(p.text)+'</div><div class="row"><input id="rp-in-'+esc(p.idShort)+'" placeholder="回复指示，如: 告诉他稍后处理" style="flex:1" /><button class="primary small" data-rg="'+esc(p.id)+'">生成回复</button><button class="small" data-rd="'+esc(p.id)+'">忽略</button></div></div>'}).join('')||'<div class="dim">暂无待回复消息</div>';document.querySelectorAll('[data-rg]').forEach(function(b){b.onclick=async function(){var id=b.dataset.rg,ins=document.getElementById('rp-in-'+id.slice(0,8)).value.trim();if(!ins){toast('请输入回复指示',!1);return}try{var x=await api('/api/reply/generate',{method:'POST',body:JSON.stringify({id:id,instruction:ins})});await renderReply();toast('已回复 '+(x.target||''),!0)}catch(e){toast(e.message,!1)}}});document.querySelectorAll('[data-rd]').forEach(function(b){b.onclick=async function(){try{await api('/api/reply/'+encodeURIComponent(b.dataset.rd)+'/dismiss',{method:'POST'});await renderReply();toast('已忽略',!0)}catch(e){toast(e.message,!1)}}})}catch(e){document.getElementById('rp-list').innerHTML='<div class="dim">加载失败: '+esc(e.message)+'</div>'}}
document.getElementById('rp-refresh').onclick=function(){renderReply();toast('已刷新',!0)};
document.getElementById('mf-new').onclick=function(){DATA.mfEditing=null;renderModelForm();renderModels()};
document.getElementById('mf-family').onchange=function(){renderSchemaFields();fillSchemaFields();fillTaskChecks()};
document.getElementById('mf-provider').onchange=function(){renderSchemaFields();fillSchemaFields();fillTaskChecks()};
function fillTaskChecks(){var tasks=DATA.tasks||[],cur=(DATA.mfEditing&&DATA.mfEditing.taskBindings)||[];document.getElementById('mf-tasks').innerHTML=tasks.map(function(t){var c=cur.indexOf(t)>=0;return'<label><input type="checkbox" data-task="'+esc(t)+'"'+(c?' checked':'')+' /> '+esc(t)+'</label>'}).join('')||'<span class="dim">无可用任务</span>'}
function fieldRow(f){var id='mf-p-'+f.key,req=f.required?' required':'',hint=f.hint?'<div class="mf-hint">'+esc(f.hint)+'</div>':'',defAttr=f.default!=null?' data-def="'+f.default+'"':'';if(f.type==='text')return'<div class="mf-row"><label>'+esc(f.label)+'</label><div><textarea id="'+id+'" data-pk="'+esc(f.key)+'" data-pt="text" rows="2"'+req+'></textarea>'+hint+'</div></div>';if(f.type==='int')return'<div class="mf-row"><label>'+esc(f.label)+'</label><div><input id="'+id+'" data-pk="'+esc(f.key)+'" data-pt="int"'+defAttr+' type="number" step="'+(f.step||1)+'"'+(f.min!=null?' min="'+f.min+'"':'')+(f.max!=null?' max="'+f.max+'"':'')+' />'+hint+'</div></div>';if(f.type==='float'){if(f.slider)return'<div class="mf-row"><label>'+esc(f.label)+'</label><div class="mf-range"><input id="'+id+'" data-pk="'+esc(f.key)+'" data-pt="float"'+defAttr+' type="range" min="'+(f.min!=null?f.min:0)+'" max="'+(f.max!=null?f.max:2)+'" step="'+(f.step||0.1)+'" /><input id="'+id+'-num" data-pk="'+esc(f.key)+'" data-pt="float"'+defAttr+' type="number" min="'+(f.min!=null?f.min:0)+'" max="'+(f.max!=null?f.max:2)+'" step="'+(f.step||0.1)+'" style="width:84px" /></div>'+hint+'</div>';return'<div class="mf-row"><label>'+esc(f.label)+'</label><div><input id="'+id+'" data-pk="'+esc(f.key)+'" data-pt="float"'+defAttr+' type="number" step="'+(f.step||0.1)+'"'+(f.min!=null?' min="'+f.min+'"':'')+(f.max!=null?' max="'+f.max+'"':'')+' />'+hint+'</div></div>'}if(f.type==='password')return'<div class="mf-row"><label>'+esc(f.label)+'</label><div><input id="'+id+'" data-pk="'+esc(f.key)+'" data-pt="password" type="password" placeholder="'+esc(f.placeholder||'')+'"'+req+' />'+hint+'</div></div>';return'<div class="mf-row"><label>'+esc(f.label)+'</label><div><input id="'+id+'" data-pk="'+esc(f.key)+'" data-pt="string" type="text" placeholder="'+esc(f.placeholder||'')+'"'+req+(f.isModelName?' data-model-name="1"':'')+' />'+hint+'</div></div>'}
function renderSchemaFields(){var el=document.getElementById('mf-fields'),family=document.getElementById('mf-family').value,provider=document.getElementById('mf-provider').value,s=modelSchemaFor(family,provider),fields=(s&&s.fields)||[];el.innerHTML=fields.map(function(f){return fieldRow(f)}).join('')||'<div class="dim">该 Provider 无参数配置</div>'}
function fillSchemaFields(){var m=DATA.mfEditing||{},params=m.parameters||{};document.querySelectorAll('#mf-fields [data-pk]').forEach(function(input){var key=input.dataset.pk,type=input.dataset.pt,def=input.dataset.def,val=params[key],fb=(def===undefined||def==='')?'':def;if(type==='password'){input.value=(val==='__redacted__'||val==='·已设置·')?'·已设置·':(val==null?'':val);return}if(input.type==='range'){var num=document.getElementById(input.id+'-num'),v=(val==null||val==='')?fb:val;input.value=v;if(num)num.value=v;return}input.value=(val==null||val==='')?fb:val});document.querySelectorAll('#mf-fields input[type=range]').forEach(function(r){r.oninput=function(){var num=document.getElementById(r.id+'-num');if(num)num.value=r.value}});document.querySelectorAll('#mf-fields input[type=number]').forEach(function(n){n.oninput=function(){var r=document.getElementById(n.id.replace(/-num$/,''));if(r&&r.type==='range')r.value=n.value}})}
function collectParams(){var params={};document.querySelectorAll('#mf-fields [data-pk]').forEach(function(input){if(input.type==='range')return;var key=input.dataset.pk,type=input.dataset.pt,raw=String(input.value).trim();if(type==='password'){if(raw==='·已设置·')params[key]='__redacted__';else if(raw)params[key]=raw;return}if(raw==='')return;if(type==='int'){var n=parseInt(raw,10);if(!isNaN(n))params[key]=n;return}if(type==='float'){var f=parseFloat(raw);if(!isNaN(f))params[key]=f;return}params[key]=raw});return params}
function modelFormToPayload(){var el=function(id){return document.getElementById(id).value};var tasks=[];document.querySelectorAll('[data-task]').forEach(function(c){if(c.checked)tasks.push(c.dataset.task)});var params=collectParams(),p={id:el('mf-id').trim(),label:el('mf-label').trim(),family:el('mf-family'),provider:el('mf-provider'),enabled:document.getElementById('mf-enabled').checked,taskBindings:tasks};if(Object.keys(params).length)p.parameters=params;return p}
function renderModelForm(){var m=DATA.mfEditing||{};document.getElementById('model-main-head').style.display='flex';document.getElementById('mf-panel').style.display='flex';document.getElementById('model-main-title').textContent=m.id?m.id:'新建模型';document.getElementById('model-main-sub').innerHTML='<span class="badge badge-task">'+esc(m.family||'language')+'</span><span class="badge badge-task">'+esc(m.provider||'openai-compatible')+'</span>';document.getElementById('mf-id').value=m.id||'';document.getElementById('mf-id').disabled=!!m.id;document.getElementById('mf-label').value=m.label||'';document.getElementById('mf-family').value=m.family||'language';document.getElementById('mf-provider').value=m.provider||'openai-compatible';document.getElementById('mf-enabled').checked=m.enabled!==false;document.getElementById('mf-delete').style.display=m.id?'':'none';document.getElementById('model-remote').style.display='none';renderSchemaFields();fillSchemaFields();fillTaskChecks()}
function probePayload(){var p=modelFormToPayload();return{id:p.id,family:p.family,provider:p.provider,parameters:p.parameters||{}}}
document.getElementById('mf-test').onclick=async function(){var btn=this,p=probePayload();if(!p.parameters.baseUrl){toast('请先填写 Base URL',!1);return}btn.disabled=!0;btn.textContent='测试中…';try{var r=await api('/api/models/test',{method:'POST',body:JSON.stringify(p)});toast(r.message||(r.ok?'连接成功':'连接失败'),!!r.ok)}catch(e){toast(e.message,!1)}finally{btn.disabled=!1;btn.textContent='测试连接'}};
document.getElementById('mf-fetch').onclick=async function(){var btn=this,p=probePayload();if(!p.parameters.baseUrl){toast('请先填写 Base URL',!1);return}btn.disabled=!0;btn.textContent='拉取中…';try{var r=await api('/api/models/fetch',{method:'POST',body:JSON.stringify(p)});if(r.ok)showRemoteModels(r.models||[]);else toast(r.message||'拉取失败',!1)}catch(e){toast(e.message,!1)}finally{btn.disabled=!1;btn.textContent='拉取可用模型'}};
function showRemoteModels(list){var box=document.getElementById('model-remote'),el=document.getElementById('model-remote-list');document.getElementById('model-remote-note').textContent='共 '+list.length+' 个，点击「使用」填入模型名';el.innerHTML=list.map(function(id){return'<div class="model-remote-list-item"><code>'+esc(id)+'</code><button class="small primary" data-rm="'+esc(id)+'">使用</button></div>'}).join('')||'<div class="dim">上游返回空列表</div>';box.style.display='block';document.querySelectorAll('[data-rm]').forEach(function(btn){btn.onclick=function(){var mi=document.getElementById('mf-p-model');if(mi){mi.value=btn.dataset.rm;mi.focus()}toast('已填入模型名: '+btn.dataset.rm,!0)}})}
document.getElementById('model-remote-close').onclick=function(){document.getElementById('model-remote').style.display='none'};
document.getElementById('mf-reset').onclick=function(){renderModelForm()};
document.getElementById('mf-save').onclick=async function(){var p=modelFormToPayload();if(!p.id){toast('模型 ID 必填',!1);return}try{await api('/api/models',{method:'POST',body:JSON.stringify(p)});await load();DATA.mfEditing=(DATA.models||[]).find(function(x){return x.id===p.id})||null;renderModels();renderModelForm();toast('模型已保存',!0)}catch(e){toast(e.message,!1)}};
document.getElementById('mf-delete').onclick=async function(){var id=document.getElementById('mf-id').value.trim();if(!id||!confirm('确认删除模型 '+id+' ？'))return;try{await api('/api/models/'+encodeURIComponent(id),{method:'DELETE'});DATA.mfEditing=null;await load();renderModels();renderModelForm();toast('已删除',!0)}catch(e){toast(e.message,!1)}};
(function(){var h=location.hash.slice(1);if(h&&h!=='dashboard'&&document.getElementById('sec-'+h)){var a=document.querySelector('[data-nav="'+h+'"]');if(a)a.click()}})();load();setInterval(function(){if(!document.hidden)load()},10000);
</script>
</body>
</html>`;
}

function renderLoginPage(title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — 登录</title>
<script>
(function(){try{var t=localStorage.getItem('f261_theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light')}catch(e){}})();
</script>
<style>
  :root{--bg:#f5f6fa;--surface:#fff;--text:#1a1d2e;--text2:#6b7187;--accent:#4f6ef6;--border:#e2e5ee;--r:8px}
  :root[data-theme="dark"]{--bg:#0e1117;--surface:#171b26;--text:#e5e8f0;--text2:#8b93a8;--accent:#6f89f8;--border:#232b3a}
  :root[data-theme="dark"] .box{box-shadow:0 2px 12px rgba(0,0,0,.4)}
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg);display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .box{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px 28px;width:100%;max-width:360px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
  .box h1{font-size:1.2rem;font-weight:700;margin-bottom:4px;color:var(--text)}
  .box .sub{font-size:.82rem;color:var(--text2);margin-bottom:20px}
  input{width:100%;font-family:inherit;font-size:.9rem;padding:10px 14px;border:1px solid var(--border);border-radius:var(--r);outline:none;background:var(--bg)}
  input:focus{border-color:var(--accent)}
  button{width:100%;margin-top:12px;padding:11px;font-family:inherit;font-size:.9rem;font-weight:600;background:var(--accent);color:#fff;border:none;border-radius:var(--r);cursor:pointer}
  .err{color:#e03040;font-size:.82rem;margin-top:8px;display:none}
</style>
</head>
<body>
<div class="box">
  <h1>${escapeHtml(title)}</h1>
  <div class="sub">请输入管理密码</div>
  <form id="f"><input type="password" id="pw" placeholder="密码" autofocus /><button type="submit">登录</button></form>
  <div class="err" id="err">密码错误</div>
</div>
<script>
/* Resume an existing session if this is just a refresh: the token lives in
   sessionStorage, not the URL, so the server sees an unauthenticated GET. */
(function(){var t='';try{t=sessionStorage.getItem('f261_token')||''}catch(e){}
if(!t)return;
fetch('/api/state',{headers:{'x-admin-token':t}}).then(function(r){
if(r.ok){location.replace(location.pathname+'?t='+encodeURIComponent(t))}
else{try{sessionStorage.removeItem('f261_token')}catch(e){}}}).catch(function(){})})();
document.getElementById('f').onsubmit=async function(e){e.preventDefault();var pw=document.getElementById('pw').value;try{var r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw})});var j=await r.json();if(j.ok){try{sessionStorage.setItem('f261_token',j.token)}catch(ex2){}location.href=location.pathname+'?t='+encodeURIComponent(j.token)}else{var el=document.getElementById('err');el.textContent=r.status===429?'尝试次数过多，请 5 分钟后再试':'密码错误';el.style.display='block'}}catch(ex){document.getElementById('err').style.display='block'}}
</script>
</body>
</html>`;
}

/** Extract the session token from the header (preferred) or query string. */
function readSessionToken(request: Hapi.Request): string {
  const header = readHeaderValue(request.headers['x-admin-token']);
  if (header) return header;
  return typeof request.query.t === 'string' ? request.query.t : '';
}

function requireUiAuth(
  request: Hapi.Request,
  sessions: SessionStore,
  password?: string,
  authToken?: string,
): boolean {
  // No auth configured
  if (!password && !authToken) return true;

  // Session token minted by /api/login
  if (password) {
    const token = readSessionToken(request);
    if (token && sessions.verify(token, password, Date.now())) return true;
  }

  // Legacy authToken
  if (authToken) {
    const headerToken = readHeaderValue(request.headers['x-admin-token']);
    const queryToken = typeof request.query.token === 'string' ? request.query.token : undefined;
    if (headerToken && safeEqual(headerToken, authToken)) return true;
    if (queryToken && safeEqual(queryToken, authToken)) return true;
  }

  return false;
}

function requireOneBotAuth(request: Hapi.Request, accessToken?: string): boolean {
  if (!accessToken) {
    return true;
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

  static fingerprint(password: string): string {
    return createHash('sha256').update(password).digest('hex');
  }

  create(password: string, now: number): string {
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
      fingerprint: SessionStore.fingerprint(password),
    });
    return token;
  }

  verify(token: string, password: string, now: number): boolean {
    const meta = this.sessions.get(token);
    if (!meta) return false;
    if (now >= meta.expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    // A password change retires every session minted under the old one.
    if (meta.fingerprint !== SessionStore.fingerprint(password)) {
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
  // Paths that must keep working even when the dashboard is disabled: health
  // checks and OneBot event ingestion. Everything else (dashboard + admin API)
  // is gated on runtime.ui.enabled.
  const alwaysOn = new Set(['/health', deps.settings.eventPath]);
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

  server.ext('onPreAuth', async (request, h) => {
    if (alwaysOn.has(request.path)) return h.continue;
    const runtime = await deps.runtime.snapshot();
    if (runtime.ui.enabled === false) {
      return h.response({ error: 'web ui is disabled' }).code(404).takeover();
    }
    return h.continue;
  });

  server.route([
    {
      method: 'GET',
      path: '/health',
      handler: () => ({ ok: true, service: 'f261agent' }),
    },
    {
      method: 'GET',
      path: deps.settings.uiPath,
      handler: async (request, h) => {
        // The page is fully self-contained (inline CSS/JS, no external assets),
        // so a strict CSP costs nothing and blocks injected script sources.
        const html = (body: string): Hapi.ResponseObject =>
          h
            .response(body)
            .type('text/html; charset=utf-8')
            .header(
              'content-security-policy',
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
                "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            )
            .header('referrer-policy', 'no-referrer');

        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          // If password is set, show login page instead of 401
          if (runtime.ui.password) {
            return html(renderLoginPage(runtime.ui.title || 'F261Agent'));
          }
          return h.response({ error: 'unauthorized' }).code(401);
        }
        return html(renderPage(runtime.ui.title || 'F261Agent'));
      },
    },
    {
      method: 'POST',
      path: '/api/login',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        const ip = request.info.remoteAddress || 'unknown';
        const now = Date.now();
        if (loginThrottle.isLocked(ip, now)) {
          return h.response({ error: 'too many attempts, try again later' }).code(429);
        }
        const payload = request.payload as JsonObject | undefined;
        const pw = typeof payload?.password === 'string' ? payload.password : '';
        const cfgPw = runtime.ui.password;
        if (!cfgPw) return h.response({ error: 'no password configured' }).code(400);
        if (pw && safeEqual(pw, cfgPw)) {
          loginThrottle.reset(ip);
          return { ok: true, token: sessions.create(cfgPw, now) };
        }
        loginThrottle.recordFailure(ip, now);
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
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        const password = typeof payload?.password === 'string' ? payload.password : '';
        if (password.length < 6 || password.length > 128) {
          return h.response({ error: '密码长度需在 6-128 个字符之间' }).code(400);
        }
        await deps.runtime.update((state) => {
          state.ui.password = password;
        });
        // Changing the password retires all existing sessions (they are bound
        // to the old password's fingerprint), so hand back a fresh one to keep
        // the current browser logged in.
        return { ok: true, token: sessions.create(password, Date.now()) };
      },
    },
    {
      method: 'GET',
      path: '/api/state',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        return getState(deps);
      },
    },
    {
      method: 'GET',
      path: '/api/config',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        return redactConfig(await deps.config.snapshotConfig());
      },
    },
    {
      method: 'POST',
      path: '/api/config',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
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
        await deps.config.replaceConfig(normalized);
        if (deps.summaries) await deps.summaries.start();
        if (deps.oneBotWebSocket) {
          await deps.oneBotWebSocket.restart();
        }
        return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/admins',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
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
        return { ok: true };
      },
    },
    {
      method: 'DELETE',
      path: '/api/admins/{id}',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const userId = String(request.params.id);
        await deps.runtime.update((state) => {
          state.admins = state.admins.filter((item) => item !== userId);
        });
        return { ok: true };
      },
    },
    {
      method: 'GET',
      path: '/api/models',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        return redactModels(await deps.models.listModels());
      },
    },
    {
      method: 'POST',
      path: '/api/models',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
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
        if (!Array.isArray(payload.taskBindings) || !payload.taskBindings.every((t) => typeof t === 'string')) {
          return h.response({ error: 'taskBindings must be an array of strings' }).code(400);
        }
        const model = payload as unknown as ModelConfig;
        // Restore a redacted apiKey from the existing model of the same id.
        if (model.parameters && model.parameters.apiKey === REDACTED) {
          const existing = (await deps.models.listModels()).find((m) => m.id === id);
          const prevKey = existing?.parameters?.apiKey;
          if (typeof prevKey === 'string') model.parameters.apiKey = prevKey;
          else delete model.parameters.apiKey;
        }
        try {
          await deps.models.upsertModel(model);
        } catch (error) {
          return h.response({ error: error instanceof Error ? error.message : 'upsert failed' }).code(400);
        }
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/models/{task}/activate',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        const modelId = String(payload?.modelId ?? '');
        await deps.models.setActiveModel(String(request.params.task) as ModelTask, modelId);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/models/{id}/enabled',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        const enabled = Boolean(payload?.enabled);
        await deps.models.setModelEnabled(String(request.params.id), enabled);
        return { ok: true };
      },
    },
    {
      method: 'DELETE',
      path: '/api/models/{id}',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        await deps.models.removeModel(String(request.params.id));
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/models/test',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const model = await buildProbeModel(deps, request.payload as JsonObject | undefined);
        if (!model) {
          return h.response({ ok: false, message: '需要有效的 family / provider 参数' });
        }
        try {
          const message = await deps.models.testConnection(model);
          return { ok: true, message };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : '连接测试失败' };
        }
      },
    },
    {
      method: 'POST',
      path: '/api/models/fetch',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const model = await buildProbeModel(deps, request.payload as JsonObject | undefined);
        if (!model) {
          return h.response({ ok: false, message: '需要有效的 family / provider 参数' });
        }
        try {
          const models = await deps.models.listRemoteModels(model);
          return { ok: true, models };
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : '拉取模型列表失败' };
        }
      },
    },
    {
      method: 'GET',
      path: '/api/plugins',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        return deps.plugins.list();
      },
    },
    {
      method: 'POST',
      path: '/api/plugins/{name}/enabled',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const name = String(request.params.name);
        const payload = request.payload as JsonObject | undefined;
        const enabled = Boolean(payload?.enabled);
        await deps.plugins.setEnabled(name, enabled);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/plugins/reload',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        await deps.plugins.reload();
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: deps.settings.eventPath,
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireOneBotAuth(request, runtime.onebot.accessToken)) {
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
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        if (!payload || Array.isArray(payload)) {
          return h.response({ error: 'invalid payload' }).code(400);
        }
        await deps.runtime.update((state) => {
          const ws = state.onebot.webSocket;
          if (typeof payload.mode === 'string') {
            ws.mode = payload.mode as 'off' | 'forward' | 'reverse' | 'both';
          }
          if (typeof payload.forwardUrl === 'string') {
            ws.forwardUrl = payload.forwardUrl.trim();
          }
          if (typeof payload.reversePath === 'string') {
            ws.reversePath = payload.reversePath.trim() || '/onebot/ws';
          }
          if (typeof payload.reconnectIntervalMs === 'number') {
            ws.reconnectIntervalMs = Math.max(1000, payload.reconnectIntervalMs);
          }
          if (typeof payload.actionTimeoutMs === 'number') {
            ws.actionTimeoutMs = Math.max(1000, payload.actionTimeoutMs);
          }
        });
        if (deps.oneBotWebSocket) {
          await deps.oneBotWebSocket.restart();
        }
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/onebot-config',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        if (!payload || Array.isArray(payload)) {
          return h.response({ error: 'invalid payload' }).code(400);
        }
        await deps.runtime.update((state) => {
          const ob = state.onebot;
          if (typeof payload.baseUrl === 'string') ob.baseUrl = payload.baseUrl.trim();
          if (typeof payload.apiPrefix === 'string') ob.apiPrefix = payload.apiPrefix.trim();
          if (typeof payload.selfId === 'string') ob.selfId = payload.selfId.trim();
          if (typeof payload.timeoutMs === 'number') ob.timeoutMs = Math.max(500, payload.timeoutMs);
          // accessToken 前端读到的是脱敏值，只有提供了新的非脱敏值才更新
          if (typeof payload.accessToken === 'string' && payload.accessToken && payload.accessToken !== REDACTED) {
            ob.accessToken = payload.accessToken;
          }
        });
        return { ok: true };
      },
    },
    {
      method: 'GET',
      path: '/api/ws-status',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const config = runtime.onebot.webSocket;
        const transport = deps.oneBotWebSocket?.getStatus() ?? { forwardConnected: false, reverseConnected: false, reversePeerCount: 0, stopped: true };
        return { config: { mode: config.mode, forwardUrl: config.forwardUrl, reversePath: config.reversePath }, transport };
      },
    },
    {
      method: 'GET',
      path: '/api/events',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const limit = typeof request.query.limit === 'string'
          ? Math.min(parseInt(request.query.limit, 10) || 64, 64)
          : 64;
        const cursor = typeof request.query.cursor === 'string' ? request.query.cursor : undefined;
        return deps.storage.listEventsAfter(cursor, limit);
      },
    },
  ]);

  // 挂载插件注册的 WebUI 路由
  for (const entry of deps.plugins.collectWebUiRoutes()) {
    const route = entry.route;
    server.route([
      {
        method: route.method,
        path: route.path,
        handler: async (request, h) => {
          if (route.requireAuth !== false) {
            const runtime = await deps.runtime.snapshot();
            if (!requireUiAuth(request, sessions, runtime.ui.password, runtime.ui.authToken)) {
              return h.response({ error: 'unauthorized' }).code(401);
            }
          }
          const query: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(request.query as Record<string, unknown>)) {
            query[k] = v;
          }
          // 路径参数注入到 query 里，方便插件处理
          const params = request.params as Record<string, unknown>;
          if (params) {
            for (const [k, v] of Object.entries(params)) {
              query[k] = v;
            }
          }
          try {
            const result = await route.handler(request.payload as JsonObject | undefined, query);
            return result;
          } catch (error) {
            return h
              .response({ error: error instanceof Error ? error.message : String(error) })
              .code(400);
          }
        },
      },
    ]);
  }

  // Loud warning if the dashboard is reachable off-host with no password: the
  // default config ships without one, which disables auth entirely.
  try {
    const runtime = await deps.runtime.snapshot();
    const host = deps.settings.host;
    const offHost = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
    if (runtime.ui.enabled !== false && offHost && !runtime.ui.password && !runtime.ui.authToken) {
      deps.appLogger.warn(
        'WebUI is bound to a non-loopback address with NO password — the admin API is exposed unauthenticated. Set runtime.ui.password.',
        { host, port: deps.settings.port },
      );
    }
  } catch {
    // Non-fatal: never block server creation on the advisory check.
  }

  return server;
}
