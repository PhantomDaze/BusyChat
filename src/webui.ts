import Hapi from '@hapi/hapi';

import { normalizeAppConfig } from './config';
import type {
  AppConfigStore,
  AppServices,
  AppSettings,
  JsonObject,
  Logger,
  ModelConfig,
  ModelTask,
} from './types';

interface WebServerDependencies {
  settings: AppSettings;
  config: AppConfigStore;
  runtime: AppServices['runtime'];
  models: AppServices['models'];
  plugins: AppServices['plugins'];
  summaries: AppServices['summaries'];
  knowledge: AppServices['knowledge'];
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

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function renderPage(title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root{--bg:#f5f6fa;--surface:#fff;--sidebar:#1e2433;--stext:#c8cdd8;--text:#1a1d2e;--text2:#6b7187;--border:#e2e5ee;--accent:#4f6ef6;--a2:#eef0ff;--green:#20a057;--g2:#e6f7ee;--red:#e03040;--r2:#fdebee;--r:8px;--nav-h:56px}
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
    <div class="row gap-16" style="margin-bottom:14px">
      <select id="model-task-sel"><option value="">选择任务...</option></select>
      <select id="model-id-sel"><option value="">选择模型...</option></select>
      <button class="primary" id="model-activate">绑定</button>
    </div>
    <div class="list" id="model-list"></div>
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
  </section>
  <section class="section" id="sec-admins">
    <h2>管理员</h2>
    <div class="row gap-16" style="margin-bottom:14px">
      <input id="admin-input" placeholder="QQ 号" />
      <button class="primary" id="admin-add">添加</button>
    </div>
    <div class="list" id="admin-list"></div>
    <p class="dim">管理员可使用所有命令，也是摘要和记忆报告的唯一接收者。</p>
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
  <a href="#log" data-nav="log"><span class="ni">📝</span>日志</a>
  <div class="footer-desktop">F261Agent</div>
</div>
<script>
var DATA={},configDirty=!1;
function toggleDrawer(){var n=document.querySelector('.bottom-nav'),b=document.querySelector('.backdrop'),o=n.classList.toggle('open');b.classList.toggle('open',o)}
document.querySelector('.hamburger').onclick=toggleDrawer;
document.querySelector('.backdrop').onclick=toggleDrawer;
document.querySelectorAll('.bottom-nav a').forEach(function(a){a.addEventListener('click',function(){document.querySelector('.bottom-nav').classList.remove('open');document.querySelector('.backdrop').classList.remove('open')})});
function toast(m,ok){var e=document.createElement('div');e.className='toast '+(ok?'toast-ok':'toast-err');e.textContent=m;document.body.appendChild(e);setTimeout(function(){e.remove()},2500)}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
async function api(p,opts){var r=await fetch(p,{headers:{'content-type':'application/json'},...opts});if(!r.ok){var b=await r.text().catch(function(){return''});throw new Error(r.status+' '+b)}return r.json()}
document.querySelectorAll('[data-nav]').forEach(function(a){a.addEventListener('click',function(e){e.preventDefault();document.querySelectorAll('[data-nav]').forEach(function(x){x.classList.remove('active')});a.classList.add('active');document.querySelectorAll('.section').forEach(function(s){s.classList.remove('active')});document.getElementById('sec-'+a.dataset.nav).classList.add('active');if(a.dataset.nav==='config')renderConfig();if(a.dataset.nav==='models')renderModels();if(a.dataset.nav==='knowledge')renderKnowledge();if(a.dataset.nav==='admins')renderAdmins();if(a.dataset.nav==='plugins')renderPlugins();if(a.dataset.nav==='ws')renderWs();if(a.dataset.nav==='log')renderLog()})});
function wsLabel(r){var w=r.onebot?.webSocket||{},m=w.mode||'off';if(m==='off')return'off';if(m==='forward'||m==='both')return m+' → '+(w.forwardUrl||'');if(m==='reverse')return m+' ← '+(w.reversePath||'');return m}
function renderDash(){var r=DATA.runtime||{},s=DATA.settings||{};var banner=DATA.fallbackOnly?'<div class="alert-banner"><strong>未配置真实AI模型</strong>当前仅有 rule-based fallback，摘要和建议将输出占位文本而非真实分析。请在 WebUI「模型管理」或 config.json 中配置真实模型。</div>':'';document.getElementById('dash-cards').innerHTML=banner+[['管理员',(r.admins||[]).length,''],['模型',(DATA.models||[]).length,''],['插件',(DATA.plugins||[]).length,(DATA.plugins||[]).filter(function(p){return p.enabled}).length+' 启用'],['消息',(DATA.events||[]).length,''],['摘要',(DATA.summaries||[]).length,(DATA.summaryStatus||{}).enabled?'每'+(Math.round(((DATA.summaryStatus||{}).intervalMs||120000)/1000))+'s, ≥'+(DATA.summaryStatus||{}).batchSize+'条':'已停用'],['知识库',(DATA.kbCount||0)+'条',r.knowledgeBase?.enabled?'已启用':'已禁用'],['WS','',wsLabel(r)],['目录',esc(s.dataDir||''),esc(s.host)+':'+s.port]].map(function(c){return'<div class="card"><div class="card-stat">'+esc(c[1])+'</div><div class="card-body"><div class="card-label">'+esc(c[0])+'</div><div class="dim" style="font-size:.7rem">'+esc(c[2])+'</div></div></div>'}).join('');document.getElementById('dash-events').innerHTML=(DATA.events||[]).slice(0,8).map(function(e){return'<div class="list-item"><div class="info"><div class="title">['+esc(e.scope)+'] '+esc((e.content?.text||'').slice(0,80))+'</div><div class="sub">'+esc(e.receivedAt)+' | '+esc(e.sender?.userId||'')+'</div></div></div>'}).join('')||'<div class="dim">暂无</div>';document.getElementById('dash-summaries').innerHTML=(DATA.summaries||[]).slice(0,5).map(function(s){return'<div class="list-item"><div class="info"><div class="title">'+esc((s.summaryText||'').slice(0,100))+'</div><div class="sub">'+esc(s.createdAt)+'</div></div></div>'}).join('')||'<div class="dim">暂无</div>'}
function renderModels(){var el=document.getElementById('model-list'),models=DATA.models||[],tasks=DATA.tasks||[];el.innerHTML=models.map(function(m){var s=m.enabled?'<span class="badge badge-on">启用</span>':'<span class="badge badge-off">禁用</span>',ts=(m.taskBindings||[]).map(function(t){var a=(m.activeTasks||[]).includes(t);return'<span class="badge '+(a?'badge-on':'badge-task')+'">'+esc(t)+(a?' ✓':'')+'</span>'}).join('');return'<div class="list-item"><div class="info"><div class="title">'+esc(m.id)+' <span style="font-weight:400;color:var(--text2)">'+esc(m.label||'')+'</span> '+s+'</div><div class="sub">'+esc(m.family)+' / '+esc(m.provider)+' '+ts+'</div></div><button class="small '+(m.enabled?'danger':'primary')+'" data-mt="'+esc(m.id)+'">'+(m.enabled?'禁用':'启用')+'</button></div>'}).join('')||'<div class="dim">暂无模型</div>';document.getElementById('model-task-sel').innerHTML='<option value="">选择任务...</option>'+tasks.map(function(t){return'<option>'+esc(t)+'</option>'}).join('');document.getElementById('model-id-sel').innerHTML='<option value="">选择模型...</option>'+models.filter(function(m){return m.enabled}).map(function(m){return'<option>'+esc(m.id)+'</option>'}).join('');document.querySelectorAll('[data-mt]').forEach(function(b){b.onclick=async function(){var id=b.dataset.mt,on=b.textContent.trim()==='禁用';try{await api('/api/models/'+encodeURIComponent(id)+'/enabled',{method:'POST',body:JSON.stringify({enabled:!on})});await load();toast(id+(on?' 已禁用':' 已启用'),!0)}catch(e){toast(e.message,!1)}}})}
document.getElementById('model-activate').onclick=async function(){var t=document.getElementById('model-task-sel').value,m=document.getElementById('model-id-sel').value;if(!t||!m){toast('请选择任务和模型',!1);return}try{await api('/api/models/'+encodeURIComponent(t)+'/activate',{method:'POST',body:JSON.stringify({modelId:m})});await load();toast(t+' → '+m,!0)}catch(e){toast(e.message,!1)}}
document.getElementById('plugin-reload').onclick=async function(){await api('/api/plugins/reload',{method:'POST'});await load();toast('已重新加载',!0)}
function renderPlugins(){var el=document.getElementById('plugin-list'),ps=DATA.plugins||[];el.innerHTML=ps.map(function(p){return'<div class="list-item"><div class="info"><div class="title">'+esc(p.name)+' <span class="badge '+(p.enabled?'badge-on':'badge-off')+'">'+(p.enabled?'启用':'禁用')+'</span></div><div class="sub">'+esc(p.description||'')+' v'+esc(p.version)+'</div></div><button class="small '+(p.enabled?'danger':'primary')+'" data-pt="'+esc(p.name)+'">'+(p.enabled?'禁用':'启用')+'</button></div>'}).join('')||'<div class="dim">暂无插件</div>';document.querySelectorAll('[data-pt]').forEach(function(b){b.onclick=async function(){var n=b.dataset.pt,on=b.textContent.trim()==='禁用';try{await api('/api/plugins/'+encodeURIComponent(n)+'/enabled',{method:'POST',body:JSON.stringify({enabled:!on})});await load();toast(n+(on?' 已禁用':' 已启用'),!0)}catch(e){toast(e.message,!1)}}})}
document.getElementById('kb-search-btn').onclick=async function(){var q=document.getElementById('kb-search-input').value.trim();if(!q){toast('请输入搜索内容',!1);return}try{var r=await api('/api/knowledge/search',{method:'POST',body:JSON.stringify({query:q})});renderKbList(r.map(function(x){return x.entry}))}catch(e){toast(e.message,!1)}}
document.getElementById('kb-add-btn').onclick=async function(){var t=document.getElementById('kb-add-input').value.trim();if(!t){toast('请输入内容',!1);return}try{await api('/api/knowledge',{method:'POST',body:JSON.stringify({text:t})});document.getElementById('kb-add-input').value='';await load();renderKnowledge();toast('已添加',!0)}catch(e){toast(e.message,!1)}}
function renderKnowledge(){api('/api/knowledge?limit=30').then(function(e){renderKbList(e)}).catch(function(){})}
function renderKbList(entries){var el=document.getElementById('kb-list');el.innerHTML=(entries||[]).map(function(e){return'<div class="list-item"><div class="info"><div class="title">'+esc((e.text||'').slice(0,120))+'</div><div class="sub">'+esc((e.id||'').slice(0,8))+' | '+esc(e.createdAt)+' | '+esc((e.metadata||{}).type||'')+'</div></div><button class="small danger" data-kd="'+esc(e.id)+'">删除</button></div>'}).join('')||'<div class="dim">暂无条目</div>';document.querySelectorAll('[data-kd]').forEach(function(b){b.onclick=async function(){var id=b.dataset.kd;try{await api('/api/knowledge/'+encodeURIComponent(id),{method:'DELETE'});await load();renderKnowledge();toast('已删除',!0)}catch(e){toast(e.message,!1)}}})}
document.getElementById('admin-add').onclick=async function(){var v=document.getElementById('admin-input').value.trim();if(!v){toast('请输入 QQ 号',!1);return}try{await api('/api/admins',{method:'POST',body:JSON.stringify({userId:v})});document.getElementById('admin-input').value='';await load();renderAdmins();toast('已添加 '+v,!0)}catch(e){toast(e.message,!1)}}
function renderAdmins(){var a=(DATA.runtime||{}).admins||[],el=document.getElementById('admin-list');el.innerHTML=a.map(function(id){return'<div class="list-item"><div class="info"><div class="title">'+esc(id)+'</div></div><button class="small danger" data-ad="'+esc(id)+'">移除</button></div>'}).join('')||'<div class="dim">暂无管理员</div>';document.querySelectorAll('[data-ad]').forEach(function(b){b.onclick=async function(){var id=b.dataset.ad;try{await api('/api/admins/'+encodeURIComponent(id),{method:'DELETE'});await load();renderAdmins();toast('已移除 '+id,!0)}catch(e){toast(e.message,!1)}}})}
document.getElementById('config-save').onclick=async function(){try{var c=JSON.parse(document.getElementById('config-json').value);await api('/api/config',{method:'POST',body:JSON.stringify(c)});configDirty=!1;document.getElementById('config-status').textContent='已保存 '+new Date().toLocaleTimeString();toast('配置已保存',!0);await load()}catch(e){toast('保存失败: '+(e&&e.message||e),!1)}}
document.getElementById('config-json').oninput=function(){configDirty=!0;document.getElementById('config-status').textContent='未保存'}
function renderConfig(){if(!configDirty)document.getElementById('config-json').value=JSON.stringify(DATA.config||{},null,2)}
async function load(){try{DATA=await api('/api/state');var a=(DATA.runtime||{}).admins||[],m=DATA.models||[],p=DATA.plugins||[];document.getElementById('header-info').textContent='👤'+a.length+' 🤖'+m.filter(function(x){return x.enabled}).length+' 🔌'+p.filter(function(x){return x.enabled}).length;renderDash()}catch(e){document.getElementById('dash-cards').innerHTML='<div class="card"><div class="card-stat">!</div><div class="card-body"><div class="card-label">加载失败</div></div></div>'}}
function dot(on){return'<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:'+(on?'#20a057':'#e03040')+';margin-right:4px"></span>'+(on?'已连接':'未连接')}
async function refreshWsStatus(){try{var s=await api('/api/ws-status');var t=s.transport||{};document.getElementById('ws-forward-dot').innerHTML=dot(t.forwardConnected);document.getElementById('ws-forward-detail').textContent=t.forwardConnected?'Connected':(s.config?.mode==='forward'||s.config?.mode==='both'?'等待连接…':'已关闭');document.getElementById('ws-reverse-dot').innerHTML=dot(t.reverseConnected);document.getElementById('ws-reverse-detail').textContent=t.reverseConnected?(t.reversePeerCount+' peer'+(t.reversePeerCount>1?'s':'')):(s.config?.mode==='reverse'||s.config?.mode==='both'?'等待协议端连接…':'已关闭');document.getElementById('ws-ready-dot').innerHTML=dot(t.forwardConnected||t.reverseConnected);document.getElementById('ws-ready-detail').textContent=t.forwardConnected||t.reverseConnected?'API 调用可用':'不可用'}catch(e){document.getElementById('ws-forward-dot').innerHTML=dot(!1);document.getElementById('ws-reverse-dot').innerHTML=dot(!1)}}
function toggleWsFields(){var m=document.getElementById('ws-mode').value;document.getElementById('ws-forward-row').style.display=(m==='forward'||m==='both')?'':'none';document.getElementById('ws-reverse-row').style.display=(m==='reverse'||m==='both')?'':'none'}
function renderWs(){var ws=(DATA.runtime||{}).onebot?.webSocket||{};document.getElementById('ws-mode').value=ws.mode||'off';document.getElementById('ws-forward-url').value=ws.forwardUrl||'';document.getElementById('ws-reverse-path').value=ws.reversePath||'/onebot/ws';document.getElementById('ws-reconnect').value=ws.reconnectIntervalMs||5000;document.getElementById('ws-timeout').value=ws.actionTimeoutMs||10000;toggleWsFields();refreshWsStatus()}
document.getElementById('ws-mode').onchange=toggleWsFields;
document.getElementById('ws-save').onclick=async function(){var cfg={mode:document.getElementById('ws-mode').value,forwardUrl:document.getElementById('ws-forward-url').value.trim()||undefined,reversePath:document.getElementById('ws-reverse-path').value.trim()||'/onebot/ws',reconnectIntervalMs:parseInt(document.getElementById('ws-reconnect').value,10)||5000,actionTimeoutMs:parseInt(document.getElementById('ws-timeout').value,10)||10000};try{await api('/api/ws-config',{method:'POST',body:JSON.stringify(cfg)});await load();renderWs();toast('WebSocket 配置已保存并重连',!0)}catch(e){toast('保存失败: '+(e&&e.message||e),!1)}}
document.getElementById('ws-refresh-status').onclick=function(){refreshWsStatus();toast('状态已刷新',!0)}
var logAutoRefresh=!0,logTimer=null;
function renderLog(){var filterScope=document.getElementById('log-filter-scope').value,filterAdmin=document.getElementById('log-filter-admin').checked,filterBot=document.getElementById('log-filter-bot').checked,filterUser=document.getElementById('log-filter-user').checked;api('/api/events').then(function(events){var filtered=(events||[]).filter(function(e){if(filterScope!=='all'&&e.scope!==filterScope)return!1;if(e.visibility?.fromAdmin&&!filterAdmin)return!1;if(e.visibility?.fromBot&&!filterBot)return!1;if(!e.visibility?.fromAdmin&&!e.visibility?.fromBot&&!filterUser)return!1;return!0});var html='<table style="width:100%;border-collapse:collapse;font-size:.82rem"><thead><tr style="position:sticky;top:0;background:var(--bg);z-index:1"><th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);width:52px;white-space:nowrap">时间</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);width:80px">范围</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border);width:90px">发送者</th><th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--border)">内容</th></tr></thead><tbody>';filtered.forEach(function(e){var time=(e.receivedAt||'').slice(11,19)||'--:--:--',scopeIcon=e.scope==='group'?'群':'私',scopeName=e.scope==='group'?(e.conversationId||'').replace('group:','')+(e.sender?.card?' @'+esc(e.sender.card.slice(0,10)):''):(e.sender?.userId||''),sender=esc(e.sender?.nickname||e.sender?.userId||'?'),text=esc((e.content?.text||'').slice(0,200)),flags=[];if(e.visibility?.fromAdmin)flags.push('<span class="badge badge-on" style="font-size:.68rem">管理</span>');if(e.visibility?.fromBot)flags.push('<span class="badge badge-off" style="font-size:.68rem;background:#f0e6ff;color:#7c3aed">Bot</span>');html+='<tr style="border-bottom:1px solid var(--border);'+(e.visibility?.fromAdmin?'background:rgba(79,110,246,.03)':'')+(e.visibility?.fromBot?'background:rgba(124,58,237,.03)':'')+'"><td style="padding:5px 8px;white-space:nowrap;font-variant-numeric:tabular-nums">'+esc(time)+'</td><td style="padding:5px 8px;white-space:nowrap;font-size:.76rem;color:var(--text2)">['+esc(scopeIcon)+'] '+esc(scopeName)+'</td><td style="padding:5px 8px;white-space:nowrap">'+sender+' '+flags.join(' ')+'</td><td style="padding:5px 8px;word-break:break-word">'+text+'</td></tr>'});html+='</tbody></table>';if(filtered.length===0)html='<div class="dim" style="padding:20px;text-align:center">暂无匹配消息</div>';document.getElementById('log-table').innerHTML=html;document.getElementById('log-count').textContent=filtered.length+' / '+(events||[]).length+' 条'});if(logAutoRefresh){clearTimeout(logTimer);logTimer=setTimeout(renderLog,5000)}}
document.getElementById('log-refresh').onclick=function(){renderLog();toast('日志已刷新',!0)}
document.getElementById('log-filter-scope').onchange=renderLog;
document.getElementById('log-filter-admin').onchange=renderLog;
document.getElementById('log-filter-bot').onchange=renderLog;
document.getElementById('log-filter-user').onchange=renderLog;
load();setInterval(load,10000);
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
<style>
  :root{--bg:#f5f6fa;--surface:#fff;--text:#1a1d2e;--text2:#6b7187;--accent:#4f6ef6;--border:#e2e5ee;--r:8px}
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
document.getElementById('f').onsubmit=async function(e){e.preventDefault();var pw=document.getElementById('pw').value;try{var r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw})});var j=await r.json();if(j.ok){location.href=location.pathname+'?t='+j.token}else{document.getElementById('err').style.display='block'}}catch(ex){document.getElementById('err').style.display='block'}}
</script>
</body>
</html>`;
}

function requireUiAuth(request: Hapi.Request, password?: string, authToken?: string): boolean {
  // No auth configured
  if (!password && !authToken) return true;

  // Password-based token (from login page)
  if (password) {
    const t = typeof request.query.t === 'string' ? request.query.t : undefined;
    if (t === Buffer.from(password).toString('base64')) return true;
  }

  // Legacy authToken
  if (authToken) {
    const headerToken = readHeaderValue(request.headers['x-admin-token']);
    const queryToken = typeof request.query.token === 'string' ? request.query.token : undefined;
    if (headerToken === authToken || queryToken === authToken) return true;
  }

  return false;
}

function requireOneBotAuth(request: Hapi.Request, accessToken?: string): boolean {
  if (!accessToken) {
    return true;
  }

  const auth = readHeaderValue(request.headers.authorization);
  if (auth?.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length) === accessToken;
  }

  const headerToken = readHeaderValue(request.headers['x-access-token']);
  return headerToken === accessToken;
}

async function getState(deps: WebServerDependencies) {
  const config = await deps.config.snapshotConfig();
  const [models, plugins, summaries, advice, commands, events, kbEntries] = await Promise.all([
    deps.models.listModels(),
    deps.plugins.list(),
    deps.storage.listSummaries(10),
    deps.storage.listAdvice(10),
    deps.storage.listCommands(20),
    deps.storage.listEventsAfter(undefined, 25),
    deps.knowledge.list(500),
  ]);
  const summaryStatus = await deps.summaries.status();
  const fallbackOnly = await deps.models.hasOnlyFallbackModels();

  return {
    config,
    settings: config.settings,
    runtime: config.runtime,
    models,
    plugins,
    summaries,
    advice,
    commands,
    events,
    kbCount: kbEntries.length,
    fallbackOnly,
    summaryStatus,
    tasks: deps.models.listTasks(),
    families: deps.models.listFamilies(),
  };
}

export async function createWebServer(deps: WebServerDependencies): Promise<Hapi.Server> {
  const server = Hapi.server({
    host: deps.settings.host,
    port: deps.settings.port,
    routes: {
      cors: true,
      security: true,
    },
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
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          // If password is set, show login page instead of 401
          if (runtime.ui.password) {
            return h.response(renderLoginPage(runtime.ui.title || 'F261Agent')).type('text/html; charset=utf-8');
          }
          return h.response({ error: 'unauthorized' }).code(401);
        }
        return h.response(renderPage(runtime.ui.title || 'F261Agent')).type('text/html; charset=utf-8');
      },
    },
    {
      method: 'POST',
      path: '/api/login',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        const payload = request.payload as JsonObject | undefined;
        const pw = typeof payload?.password === 'string' ? payload.password : '';
        const cfgPw = runtime.ui.password;
        if (!cfgPw) return h.response({ error: 'no password configured' }).code(400);
        if (pw === cfgPw) {
          return { ok: true, token: Buffer.from(cfgPw).toString('base64') };
        }
        return h.response({ error: 'wrong password' }).code(401);
      },
    },
    {
      method: 'GET',
      path: '/api/state',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
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
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        return deps.config.snapshotConfig();
      },
    },
    {
      method: 'POST',
      path: '/api/config',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }

        const payload = request.payload as JsonObject | undefined;
        if (!payload || Array.isArray(payload)) {
          return h.response({ error: 'invalid payload' }).code(400);
        }

        const normalized = normalizeAppConfig(payload as Parameters<typeof normalizeAppConfig>[0]);
        await deps.config.replaceConfig(normalized);
        await deps.summaries.start();
        if (deps.oneBotWebSocket) {
          await deps.oneBotWebSocket.restart();
        }
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/summary/settings',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        await deps.runtime.update((state) => {
          const enabled = typeof payload?.enabled === 'boolean' ? payload.enabled : state.summary.enabled;
          const intervalMs = typeof payload?.intervalMs === 'number' ? payload.intervalMs : state.summary.intervalMs;
          const batchSize = typeof payload?.batchSize === 'number' ? payload.batchSize : state.summary.batchSize;
          const maxEventsPerPrompt = typeof payload?.maxEventsPerPrompt === 'number' ? payload.maxEventsPerPrompt : state.summary.maxEventsPerPrompt;
          state.summary = { ...state.summary, enabled, intervalMs, batchSize, maxEventsPerPrompt };
        });
        await deps.summaries.start();
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/summary/flush',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const record = await deps.summaries.flush('manual');
        return record ? record : { ok: true, empty: true };
      },
    },
    {
      method: 'POST',
      path: '/api/admins',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
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
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
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
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        return deps.models.listModels();
      },
    },
    {
      method: 'POST',
      path: '/api/models',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        if (!payload || Array.isArray(payload)) {
          return h.response({ error: 'invalid payload' }).code(400);
        }
        await deps.models.upsertModel(payload as unknown as ModelConfig);
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/api/models/{task}/activate',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
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
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        const enabled = Boolean(payload?.enabled);
        await deps.models.setModelEnabled(String(request.params.id), enabled);
        return { ok: true };
      },
    },
    {
      method: 'GET',
      path: '/api/plugins',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
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
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
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
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
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

    // Knowledge base
    {
      method: 'GET',
      path: '/api/knowledge',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const limit = typeof request.query.limit === 'string'
          ? parseInt(request.query.limit, 10) || undefined
          : undefined;
        return deps.knowledge.list(limit);
      },
    },
    {
      method: 'POST',
      path: '/api/knowledge',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
        if (!text) {
          return h.response({ error: 'text is required' }).code(400);
        }
        const entry = await deps.knowledge.add(text, { source: 'webui', type: 'user' });
        return entry;
      },
    },
    {
      method: 'DELETE',
      path: '/api/knowledge/{id}',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const deleted = await deps.knowledge.delete(String(request.params.id));
        return { deleted };
      },
    },
    {
      method: 'POST',
      path: '/api/knowledge/search',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        const query = typeof payload?.query === 'string' ? payload.query.trim() : '';
        if (!query) {
          return h.response({ error: 'query is required' }).code(400);
        }
        const limit = typeof payload?.limit === 'number' ? payload.limit : undefined;
        return deps.knowledge.search(query, limit);
      },
    },
    {
      method: 'POST',
      path: '/api/knowledge/summarize',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
          return h.response({ error: 'unauthorized' }).code(401);
        }
        const payload = request.payload as JsonObject | undefined;
        const entryIds = Array.isArray(payload?.entryIds)
          ? (payload!.entryIds as unknown[]).map(String)
          : undefined;
        const result = await deps.knowledge.summarize(entryIds);
        if (!result) {
          return h.response({ error: 'no entries to summarize' }).code(404);
        }
        return result;
      },
    },
    {
      method: 'POST',
      path: '/api/ws-config',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
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
      method: 'GET',
      path: '/api/ws-status',
      handler: async (request, h) => {
        const runtime = await deps.runtime.snapshot();
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
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
        if (!requireUiAuth(request, runtime.ui.password, runtime.ui.authToken)) {
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

  return server;
}
