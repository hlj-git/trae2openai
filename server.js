// trae2openai —— 将本机 Trae Work（TRAE SOLO CN）转换为 OpenAI 兼容 API
// 零依赖 Node.js（>=18），支持：流式/非流式、reasoning_content 思维链、
// tool_calls 工具调用、reasoning_effort 注入、实时模型列表
// CLI: --host --port --api-key --edition --function --help
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AuthManager } = require('./src/auth');
const upstream = require('./src/upstream');
const { openaiToTrae, normalizeEffort } = require('./src/convert');
const { convertUpstreamStream } = require('./src/openai');

// ---------- CLI 参数解析 ----------
const HELP = `trae2openai 用法: node server.js [选项]

选项（优先级高于 config.json 与环境变量）:
  --host <addr>        监听地址（默认 127.0.0.1；WSL/局域网访问用 0.0.0.0）
  --port <n>           监听端口（默认 8787）
  --api-key <key>      API Key，可多次指定或逗号分隔（启用后校验 Bearer）
  --edition <name>     凭证版本：auto|TRAE SOLO CN|TRAE WORK|Trae CN|TRAE SOLO|Trae
  --function <name>    上游通道：solo_work_lite|inline_chat|chat_v3
  -h, --help           显示帮助

日志: 默认开启。每次启动自动生成 log/trae2openai-<启动时间戳>.log，
      记录每个请求的完整对话（输入/回复/思维链）、模型与参数、用量、耗时与错误。

示例:
  node server.js --host 0.0.0.0 --api-key sk-mine
  node server.js --port 9000 --edition "TRAE SOLO CN"`;

function parseArgs(argv) {
  const out = { apiKeys: [] };
  for (let i = 2; i < argv.length; i++) {
    let a = argv[i], val;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const next = () => val !== undefined ? val : argv[++i];
    switch (a) {
      case '--host': out.host = next(); break;
      case '--port': out.port = parseInt(next(), 10); break;
      case '--api-key':
        out.apiKeys.push(...String(next() ?? '').split(',').map(s => s.trim()).filter(Boolean));
        break;
      case '--log': // 已废弃：日志默认开启；兼容旧命令，吞掉可选的文件名参数
        if (val === undefined && argv[i + 1] && !String(argv[i + 1]).startsWith('-')) i++;
        break;
      case '--edition': out.edition = next(); break;
      case '--function': out.function = next(); break;
      case '--help': case '-h': out.help = true; break;
      default:
        (out.unknown = out.unknown || []).push(a);
    }
  }
  return out;
}
const args = parseArgs(process.argv);
if (args.help) { console.log(HELP); process.exit(0); }

// ---------- 日志（默认开启：每次启动生成带时间戳的日志文件，双写控制台） ----------
const LOG_DIR = path.join(__dirname, 'log');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
const _d = new Date(), _p = n => String(n).padStart(2, '0');
const _bootTs = `${_d.getFullYear()}${_p(_d.getMonth() + 1)}${_p(_d.getDate())}-${_p(_d.getHours())}${_p(_d.getMinutes())}${_p(_d.getSeconds())}`;
const logFile = path.join(LOG_DIR, `trae2openai-${_bootTs}.log`);
function log(...a) {
  const line = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' +
    a.map(x => (typeof x === 'string' ? x : require('util').inspect(x))).join(' ');
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* ignore */ }
}

// ---------- 配置 ----------
const DEFAULT_CFG = {
  host: '127.0.0.1',
  port: 8787,
  api_keys: [],                    // 非空时校验 Bearer
  trae: {
    edition: 'auto',               // auto | TRAE SOLO CN | TRAE WORK | Trae CN | TRAE SOLO | Trae
    base_url: '',                  // 留空按 region 自动
    function: 'solo_work_lite',    // 通道：solo_work_lite | inline_chat | chat_v3
    ide_version: '0.2.0',
    ide_version_code: '20260815',
    default_model: 'glm-5.2',
    manual_token: '',
    manual_user_id: '',
  },
  models_cache_ttl: 300,           // 模型列表缓存秒数
  request_timeout: 600,            // 上游超时秒数
};

function loadConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));
  const p = path.join(__dirname, 'config.json');
  if (fs.existsSync(p)) {
    try {
      const user = JSON.parse(fs.readFileSync(p, 'utf8'));
      Object.assign(cfg, user, { trae: { ...cfg.trae, ...(user.trae || {}) } });
    } catch (e) { console.error('[config] config.json 解析失败，使用默认配置:', e.message); }
  }
  // 环境变量覆盖
  if (process.env.PORT) cfg.port = parseInt(process.env.PORT, 10);
  if (process.env.HOST) cfg.host = process.env.HOST;
  if (process.env.API_KEY) cfg.api_keys = [process.env.API_KEY];
  if (process.env.API_KEYS) cfg.api_keys = process.env.API_KEYS.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.TRAE_EDITION) cfg.trae.edition = process.env.TRAE_EDITION;
  if (process.env.TRAE_BASE_URL) cfg.trae.base_url = process.env.TRAE_BASE_URL;
  if (process.env.TRAE_FUNCTION) cfg.trae.function = process.env.TRAE_FUNCTION;
  if (process.env.TRAE_DEFAULT_MODEL) cfg.trae.default_model = process.env.TRAE_DEFAULT_MODEL;
  if (process.env.TRAE_MANUAL_TOKEN) cfg.trae.manual_token = process.env.TRAE_MANUAL_TOKEN;
  if (process.env.TRAE_MANUAL_USER_ID) cfg.trae.manual_user_id = process.env.TRAE_MANUAL_USER_ID;
  // CLI 参数优先级最高
  if (args.host) cfg.host = args.host;
  if (args.port) cfg.port = args.port;
  if (args.apiKeys.length) cfg.api_keys = args.apiKeys;
  if (args.edition) cfg.trae.edition = args.edition;
  if (args.function) cfg.trae.function = args.function;
  return cfg;
}

// ---------- 模型列表缓存 ----------
// 数据源：get_detail_param?function=<通道>（与 Trae 客户端一致，实时）；
// 过滤规则与 Trae UI 一致：排除 is_invisible_to_user / custom_model_* 占位 / 无显示名
const modelCache = { at: 0, list: [] };
function normalizeModelConfig(c) {
  const d = c.display_config || {};
  const name = c.config_name || '';
  const display = d.display_name || '';
  // 与 Trae UI 一致的可见性判断
  if (!name || c.is_invisible_to_user === true) return null;
  if (name.startsWith('custom_model_')) return null;   // 自定义模型占位配置
  if (!display || display === '-') return null;         // 无显示名的内部配置
  if (c.config_switch === false) return null;           // 已下线开关
  return {
    id: name,
    object: 'model',
    created: 1700000000,
    owned_by: 'trae',
    display_name: display,
    context_window: (c.context_window_tokens && (c.context_window_tokens.dev || c.context_window_tokens.max)) || null,
    model_type: d.model_capability || 'chat_model',
  };
}
async function getModelList(cfg, force = false) {
  const now = Date.now();
  if (!force && modelCache.list.length && now - modelCache.at < (cfg.models_cache_ttl || 300) * 1000) {
    return modelCache;
  }
  const auth = await authManager.get();
  const traeCfg = { ...cfg.trae, __base: authManager.regionBase() };
  const configs = await upstream.fetchModelConfigs(auth, traeCfg);
  const seen = new Set();
  const list = [];
  for (const c of configs) {
    const m = normalizeModelConfig(c);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    list.push(m);
  }
  // 用户自定义补充（config.json extra_models）
  for (const name of (cfg.extra_models || [])) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    list.push({ id: name, object: 'model', created: 1700000000, owned_by: 'trae', model_type: 'chat_model' });
  }
  modelCache.at = now;
  modelCache.list = list;
  return modelCache;
}

// ---------- 工具 ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}
function sendError(res, status, message, code, type) {
  sendJSON(res, status, { error: { message, type: type || 'api_error', code: code || null } });
}
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------- 鉴权 ----------
function checkAuth(cfg, req) {
  if (!cfg.api_keys || !cfg.api_keys.length) return true;
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return !!(m && cfg.api_keys.includes(m[1].trim()));
}

// ---------- 对话处理 ----------
// 请求级日志：完整记录请求对话 / 关键参数 / 上游回复 / 用量耗时，写入本次启动的日志文件
function fmtMessagesForLog(messages) {
  return (messages || []).map(m => {
    let c = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join('')
      : JSON.stringify(m.content);
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      c += `\n    [tool_calls: ${m.tool_calls.map(tc =>
        `${tc.function && tc.function.name}(${tc.function && tc.function.arguments})`).join(', ')}]`;
    }
    if (m.role === 'tool') c = `(tool_call_id=${m.tool_call_id}) ${c}`;
    return `    ${m.role}: ${c}`;
  }).join('\n');
}

async function handleChat(req, res, cfg, bodyStr) {
  let body;
  try { body = JSON.parse(bodyStr || '{}'); } catch {
    return sendError(res, 400, '请求体不是合法 JSON', 'invalid_json', 'invalid_request_error');
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return sendError(res, 400, 'messages 不能为空', 'missing_messages', 'invalid_request_error');
  }

  const stream = !!body.stream;
  const includeUsage = !!(body.stream_options && body.stream_options.include_usage);
  const reqId = 'req-' + crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  const toolNames = (Array.isArray(body.tools) ? body.tools : [])
    .map(t => t.function && t.function.name).filter(Boolean).join(', ');
  log(`[${reqId}] ===== 对话请求 (${stream ? '流式' : '非流式'}) =====`);
  log(`[${reqId}] [参数] model=${body.model} reasoning_effort=${normalizeEffort(body) || '默认'} ` +
    `max_tokens=${body.max_tokens ?? '-'} temperature=${body.temperature ?? '-'} top_p=${body.top_p ?? '-'} ` +
    `tool_choice=${JSON.stringify(body.tool_choice ?? '-')} tools=${toolNames ? `[${toolNames}]` : '无'}`);
  log(`[${reqId}] [输入对话] ${(body.messages || []).length} 条:\n${fmtMessagesForLog(body.messages)}`);

  const auth = await authManager.get();
  const traeCfg = { ...cfg.trae, __base: authManager.regionBase() };
  const { traeBody, requestedModel } = openaiToTrae(body, cfg.trae);
  log(`[${reqId}] [上游] resolved_model=${traeBody.model} function=${traeBody.function} region_base=${traeCfg.__base}`);

  let fetchRes;
  try {
    fetchRes = await upstream.chatStream(auth, traeCfg, traeBody, (cfg.request_timeout || 600) * 1000);
  } catch (e) {
    if (e.code === 'auth_expired') {
      // 重读 storage.json（Trae 运行时会续期写回）后重试一次
      const fresh = await authManager.get(true);
      if (fresh && fresh.token !== auth.token) {
        log(`[${reqId}] [凭证] 过期，已重读 storage.json 并换新 token 重试`);
        try {
          fetchRes = await upstream.chatStream(fresh, traeCfg, traeBody, (cfg.request_timeout || 600) * 1000);
        } catch (e2) {
          log(`[${reqId}] [失败] ${e2.status || 502} ${e2.message}（${Date.now() - t0}ms）`);
          return sendError(res, e2.status || 502, e2.message, e2.code, 'upstream_error');
        }
      } else {
        log(`[${reqId}] [失败] 凭证过期且重读无效: ${e.message}（${Date.now() - t0}ms）`);
        return sendError(res, e.status, e.message + '。已尝试重读凭证仍失败，请打开 Trae Work 确认登录状态。', e.code, 'authentication_error');
      }
    } else {
      log(`[${reqId}] [失败] ${e.status || 502} ${e.message}（${Date.now() - t0}ms）`);
      return sendError(res, e.status || 502, e.message, e.code, 'upstream_error');
    }
  }
  const { res: upRes, cleanup } = fetchRes;

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    let usageOut = null, chars = 0, finish = null, finResult = null;
    try {
      for await (const ev of convertUpstreamStream(upRes, { model: requestedModel, stream: true, includeUsage })) {
        if (ev.type === 'chunk') {
          if (ev.usage) { const c = { ...ev.chunk, usage: ev.usage }; usageOut = ev.usage; send(c); }
          else { chars += JSON.stringify(ev.chunk).length; send(ev.chunk); }
        } else if (ev.type === 'finish') {
          finish = ev.finishReason;
          usageOut = usageOut || ev.usage;
          finResult = ev.result;
          send({
            id: ev.result.id, object: 'chat.completion.chunk', created: ev.result.created,
            model: requestedModel,
            choices: [{ index: 0, delta: {}, finish_reason: ev.finishReason }],
          });
        }
      }
      if (finResult) {
        if (finResult.reasoningContent) {
          log(`[${reqId}] [回复思维链] (${finResult.reasoningContent.length} 字):\n    ${finResult.reasoningContent.replace(/\n/g, '\n    ')}`);
        }
        if (finResult.toolCalls && finResult.toolCalls.length) {
          log(`[${reqId}] [回复工具调用]: ${finResult.toolCalls.map(tc =>
            `${tc.function.name}(${tc.function.arguments})`).join(', ')}`);
        }
        log(`[${reqId}] [回复正文] (${(finResult.content || '').length} 字):\n    ${(finResult.content || '(空)').replace(/\n/g, '\n    ')}`);
        log(`[${reqId}] [完成] finish=${finish} 耗时=${Date.now() - t0}ms 用量=${JSON.stringify(usageOut || {})}`);
      }
    } catch (e) {
      log(`[${reqId}] [失败] 流式中断: ${e.message}（${Date.now() - t0}ms）`);
      send({ error: { message: e.message, type: 'upstream_error', code: e.code || null } });
    } finally {
      res.write('data: [DONE]\n\n');
      res.end();
      cleanup();
    }
    return;
  }

  // 非流式：聚合
  try {
    let fin = null;
    for await (const ev of convertUpstreamStream(upRes, { model: requestedModel, stream: false, includeUsage: false })) {
      if (ev.type === 'finish') fin = ev;
    }
    const r = fin.result;
    const message = { role: 'assistant', content: r.content || '' };
    if (r.reasoningContent) message.reasoning_content = r.reasoningContent;
    if (r.toolCalls.length) {
      message.tool_calls = r.toolCalls.map(tc => ({
        index: tc.index, id: tc.id, type: 'function',
        function: tc.function,
      }));
    }
    const out = {
      id: r.id,
      object: 'chat.completion',
      created: r.created,
      model: requestedModel,
      choices: [{ index: 0, message, finish_reason: fin.finishReason }],
      usage: fin.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    if (r.reasoningContent) {
      log(`[${reqId}] [回复思维链] (${r.reasoningContent.length} 字):\n    ${r.reasoningContent.replace(/\n/g, '\n    ')}`);
    }
    if (r.toolCalls.length) {
      log(`[${reqId}] [回复工具调用]: ${r.toolCalls.map(tc =>
        `${tc.function.name}(${tc.function.arguments})`).join(', ')}`);
    }
    log(`[${reqId}] [回复正文] (${(r.content || '').length} 字):\n    ${(r.content || '(空)').replace(/\n/g, '\n    ')}`);
    log(`[${reqId}] [完成] finish=${fin.finishReason} 耗时=${Date.now() - t0}ms 用量=${JSON.stringify(out.usage)}`);
    sendJSON(res, 200, out);
  } catch (e) {
    log(`[${reqId}] [失败] ${e.status || 502} ${e.message}（${Date.now() - t0}ms）`);
    sendError(res, e.status || 502, e.message, e.code, 'upstream_error');
  } finally {
    cleanup();
  }
}

// ---------- 主服务 ----------
const cfg = loadConfig();
const authManager = new AuthManager(cfg.trae);

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  log(`${req.method} ${url} <- ${req.socket.remoteAddress}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    return res.end();
  }

  if (url === '/healthz' || url === '/health') {
    try {
      const auth = await authManager.get();
      return sendJSON(res, 200, {
        status: 'ok', edition: auth.edition, region: auth.region,
        user_id: String(auth.userId),
        token_expired_at: auth.expiredAt,
        base_url: authManager.regionBase(),
      });
    } catch (e) {
      return sendJSON(res, 503, { status: 'error', message: e.message });
    }
  }

  // 以下路由需要鉴权
  if (!checkAuth(cfg, req)) {
    return sendError(res, 401, '无效的 API Key', 'invalid_api_key', 'authentication_error');
  }

  try {
    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      const mc = await getModelList(cfg);
      return sendJSON(res, 200, { object: 'list', data: mc.list });
    }
    if (req.method === 'GET' && /^\/v1\/models\/[^/]+$/.test(url)) {
      const id = decodeURIComponent(url.split('/')[3]);
      const mc = await getModelList(cfg);
      const m = mc.list.find(m => m.id === id);
      if (!m) return sendError(res, 404, `模型 ${id} 不存在`, 'model_not_found', 'invalid_request_error');
      return sendJSON(res, 200, m);
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
      const bodyStr = await readBody(req);
      return await handleChat(req, res, cfg, bodyStr);
    }
    if (req.method === 'GET' && (url === '/' || url === '/v1')) {
      return sendJSON(res, 200, {
        name: 'trae2openai',
        endpoints: ['GET /v1/models', 'POST /v1/chat/completions', 'GET /healthz'],
        auth_required: !!(cfg.api_keys && cfg.api_keys.length),
      });
    }
    sendError(res, 404, `未知路由: ${req.method} ${url}`, 'not_found', 'invalid_request_error');
  } catch (e) {
    log('handler error:', e.stack || e.message);
    if (!res.headersSent) sendError(res, 500, e.message, 'internal_error', 'api_error');
    else res.end();
  }
});

server.listen(cfg.port, cfg.host, async () => {
  console.log(`trae2openai 已启动: http://${cfg.host}:${cfg.port}/v1`);
  console.log(`鉴权: ${cfg.api_keys && cfg.api_keys.length ? '已启用（Bearer Key 校验）' : '未启用（任何人均可访问）'}`);
  console.log(`日志文件: ${logFile}（本次启动，含完整请求/回复对话）`);
  if (cfg.host === '0.0.0.0' || cfg.host === '::') {
    console.log('WSL2 内访问: http://<Windows宿主IP>:' + cfg.port + '/v1（WSL 内执行 `ip route show default | awk \'{print $3}\'` 获取宿主 IP）');
    console.log('提示: 0.0.0.0 会暴露到局域网，建议配合 --api-key 使用');
  }
  try {
    const auth = await authManager.get();
    console.log(`凭证来源: ${auth.edition} (region=${auth.region}, userId=${auth.userId})`);
    console.log(`上游: ${authManager.regionBase()} | 通道: ${cfg.trae.function} | 默认模型: ${cfg.trae.default_model}`);
    try {
      const mc = await getModelList(cfg, true);
      console.log(`模型列表: ${mc.list.length} 个 -> ${(mc.list.map(m => m.id)).join(', ')}`);
    } catch (e) { console.warn('模型列表获取失败（不影响对话）:', e.message); }
  } catch (e) {
    console.error('凭证加载失败:', e.message);
    console.error('请先安装并登录 Trae Work（TRAE SOLO CN），或配置 config.json 中 trae.manual_token');
  }
});

process.on('uncaughtException', e => log('uncaught:', e.stack || e.message));
process.on('unhandledRejection', e => log('unhandled:', (e && e.stack) || (e && e.message) || e));
