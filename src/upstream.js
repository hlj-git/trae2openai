// Trae 上游客户端：headers 构造、模型列表、对话流式转发
'use strict';
const crypto = require('crypto');

const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const CLIENT_ID = 'en1oxy7wnw8j9n'; // SOLO stable
const EP_MODELS = '/api/ide/v1/model_list?type=llm_raw_chat';
const EP_CHAT = '/api/agent/v3/llm_utils_chat';

class UpstreamError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status || 502;
    this.code = code || 'upstream_error';
  }
}

function buildHeaders(auth, cfg) {
  const machineId = crypto.randomBytes(32).toString('hex');
  return {
    'Authorization': `Cloud-IDE-JWT ${auth.token}`,
    'X-Cloudide-Token': auth.token,
    'x-uid': String(auth.userId || ''),
    'x-app-id': APP_ID,
    'x-client-id': CLIENT_ID,
    'x-device-id': crypto.createHash('sha256').update(machineId).digest('hex').slice(0, 32),
    'x-machine-id': machineId,
    'x-request-id': crypto.randomUUID(),
    'x-ide-version': cfg.ide_version || '0.2.0',
    'x-ide-version-code': cfg.ide_version_code || '20260815',
    'x-device-type': 'windows',
    'x-device-brand': '83DG',
    'x-os-version': 'Windows 11 Pro',
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'User-Agent': 'TraeClient/TTNet',
  };
}

// GET 模型列表（get_detail_param，与 Trae 客户端一致）-> config_info_list 数组
// 失败时回退旧 model_list 接口（返回统一为 [{config_name, display_name, ...}] 形状）
async function fetchModelConfigs(auth, cfg) {
  const base = cfg.__base;
  const fn = cfg.function || 'solo_work_lite';
  // 主数据源：Trae 客户端实际使用的 get_detail_param（列表随 ide-version 变新）
  try {
    const res = await fetch(base + `/api/ide/v1/get_detail_param?function=${encodeURIComponent(fn)}`, {
      headers: { ...buildHeaders(auth, cfg), Accept: 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.config_info_list)) return data.config_info_list;
    }
  } catch { /* 落入回退 */ }
  // 回退：旧 model_list 接口
  const res = await fetch(base + EP_MODELS, {
    headers: { ...buildHeaders(auth, cfg), Accept: 'application/json' },
  });
  if (!res.ok) throw new UpstreamError(`模型列表请求失败: HTTP ${res.status}`, 502, 'models_error');
  const data = await res.json();
  const list = Array.isArray(data.model_configs) ? data.model_configs : [];
  return list
    .filter(m => m && m.name && m.status !== false)
    .map(m => ({
      config_name: m.name,
      config_switch: true,
      is_invisible_to_user: false,
      display_config: { display_name: m.display_name || m.name, model_capability: m.model_type },
      context_window_tokens: { dev: m.prompt_max_tokens },
    }));
}

// POST 对话（上游恒为 SSE 流）。返回 fetch Response。
async function chatStream(auth, cfg, traeBody, timeoutMs) {
  const base = cfg.__base;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 600_000);
  let res;
  try {
    res = await fetch(base + EP_CHAT, {
      method: 'POST',
      headers: buildHeaders(auth, cfg),
      body: JSON.stringify(traeBody),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new UpstreamError(`上游连接失败: ${e.message}`, 502, 'upstream_unreachable');
  }
  // 401：凭证失效，由调用层决定是否重读 storage.json 重试
  if (res.status === 401 || res.status === 403) {
    clearTimeout(timer);
    throw new UpstreamError('Trae 凭证已失效（401/403），请打开 Trae Work 让其自动续期后重试', res.status, 'auth_expired');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
    clearTimeout(timer);
    throw new UpstreamError(`上游返回 HTTP ${res.status}: ${detail || '(无响应体)'}`, res.status, 'upstream_http_error');
  }
  if (!res.body) {
    clearTimeout(timer);
    throw new UpstreamError('上游未返回流式响应体', 502, 'empty_body');
  }
  return { res, cleanup: () => clearTimeout(timer) };
}

module.exports = { fetchModelConfigs, chatStream, UpstreamError, buildHeaders };
