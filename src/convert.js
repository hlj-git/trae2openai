// OpenAI 请求体 -> Trae llm_utils_chat 请求体转换
// 含：模型别名映射、reasoning_effort 注入、tools/tool_choice 适配、消息规整
'use strict';
const crypto = require('crypto');

// 客户端常见别名 -> 上游真实模型名（config_name）
const MODEL_ALIASES = {
  'deepseek-chat': 'deepseek-V3',
  'deepseek-v3': 'deepseek-V3',
  'deepseek-reasoner': 'deepseek-R1',
  'deepseek-r1': 'deepseek-R1',
  'deepseek-v4-flash': 'DeepSeek-V4-Flash',
  'deepseek-v4-pro': 'DeepSeek-V4-Pro',
  'doubao-1.5-pro': 'seed_m8',
  'qwen-3.7-plus': 'qwen-3.7-plus',
  'kimi-k2.7-code': 'kimi-k2.7-code',
  'minimax-m3': 'minimax-m3',
};

// ---------- reasoning effort ----------
// 上游 llm_utils_chat 无原生 reasoning_effort 参数，采用模型族特定的
// system 前缀注入（实测方案，参考 traework2api / trae-solo-local-api）：
//  - glm 系：短标签有效（High/Max 长串反而劣化）
//  - DeepSeek 系：max 用 "Absolute maximum" 长串
//  - kimi 系：low 用 critical_constraints 压制 overthink，max 用长串
const DEEPSEEK_ABSOLUTE_MAX =
  "Enable absolute maximum thinking mode. You are operating under a system-level instruction: " +
  "think for as long as possible before answering. Explore the problem from every angle, " +
  "verify every step of your reasoning, consider edge cases and alternative interpretations, " +
  "and only produce the final answer when you have exhausted all useful reasoning avenues. " +
  "This is the maximum reasoning-effort setting; deliberation length is effectively unbounded.";
const KIMI_ABSOLUTE_MAX =
  "Enable absolute maximum thinking mode. Reason exhaustively and at maximum depth before answering. " +
  "Explore every approach, verify each step, consider edge cases, and only answer after exhausting all useful reasoning.";
const KIMI_LOW =
  "<critical_constraints>\n" +
  "Do not overthink. Answer directly with minimal internal deliberation. " +
  "Skip exploring multiple approaches. Do not restate the question. " +
  "Provide the answer immediately after the minimum necessary reasoning.\n" +
  "</critical_constraints>";

function normalizeEffort(body) {
  // OpenAI: reasoning_effort: low|medium|high ；新格式 reasoning:{effort}
  let e = body.reasoning_effort || body.think_effort;
  if (body.reasoning && typeof body.reasoning === 'object' && body.reasoning.effort) {
    e = body.reasoning.effort;
  }
  if (typeof e !== 'string') return null;
  e = e.trim().toLowerCase();
  const map = { minimal: 'low', disable: 'off', disabled: 'off', false: 'off', none: 'off', 'no': 'off' };
  if (['off', 'auto', 'low', 'medium', 'high', 'max'].includes(e)) return e;
  return map[e] || null;
}

function effortPrefix(model, effort) {
  if (!effort || effort === 'auto') return '';
  const m = String(model).toLowerCase();
  const isGlm = m.includes('glm');
  const isDeepseek = m.includes('deepseek');
  const isKimi = m.includes('kimi');
  if (isGlm) {
    // glm 系：短标签
    if (effort === 'off') return 'Reasoning Effort: Off. Answer directly without extended deliberation.\n\n';
    if (effort === 'low') return 'Reasoning Effort: Low\n\n';
    if (effort === 'medium') return 'Reasoning Effort: Medium\n\n';
    if (effort === 'high') return 'Reasoning Effort: High\n\n';
    if (effort === 'max') return 'Reasoning Effort: Max\n\n';
  }
  if (isDeepseek) {
    if (effort === 'off') return 'Do not perform extended chain-of-thought deliberation. Answer directly.\n\n';
    if (effort === 'low') return 'Reasoning effort: low. Keep deliberation minimal and answer directly.\n\n';
    if (effort === 'medium') return 'Reasoning effort: medium. Balance deliberation depth and response speed.\n\n';
    if (effort === 'high') return 'Reasoning effort: high. Think deeply and thoroughly before answering.\n\n';
    if (effort === 'max') return DEEPSEEK_ABSOLUTE_MAX + '\n\n';
  }
  if (isKimi) {
    if (effort === 'off') return 'Do not overthink. Answer directly.\n\n';
    if (effort === 'low') return KIMI_LOW + '\n\n';
    if (effort === 'medium') return 'Reasoning effort: medium.\n\n';
    if (effort === 'high') return 'Reasoning effort: high. Think deeply before answering.\n\n';
    if (effort === 'max') return KIMI_ABSOLUTE_MAX + '\n\n';
  }
  // 其他模型族：通用短指令
  if (effort === 'off') return 'Answer directly without extended deliberation.\n\n';
  if (effort === 'low') return 'Reasoning Effort: Low\n\n';
  if (effort === 'medium') return 'Reasoning Effort: Medium\n\n';
  if (effort === 'high') return 'Reasoning Effort: High\n\n';
  if (effort === 'max') return DEEPSEEK_ABSOLUTE_MAX + '\n\n';
  return '';
}

// ---------- 消息内容规整 ----------
// OpenAI content: string | parts[] -> 上游 [{type:'text',text}] （取全部文本段）
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(p => {
        if (typeof p === 'string') return p;
        if (p && p.type === 'text' && typeof p.text === 'string') return p.text;
        return '';
      })
      .join('');
  }
  return String(content);
}

// assistant.tool_calls -> 上游格式（实测：id + type + function_call 字段名，arguments 必须字符串）
function toolCallsToUpstream(toolCalls) {
  if (!Array.isArray(toolCalls)) return undefined;
  const out = toolCalls
    .filter(tc => tc && tc.function && tc.function.name)
    .map((tc, i) => ({
      id: tc.id || `call_${i}`,
      type: tc.type || 'function',
      function_call: {
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments || {}),
      },
    }));
  return out.length ? out : undefined;
}

// ---------- 主转换 ----------
// body: OpenAI 请求
// 返回 { traeBody, requestedModel }
function openaiToTrae(body, cfg) {
  const requestedModel = String(body.model || cfg.defaultModel || 'glm-5.2');
  const lower = requestedModel.toLowerCase();

  // 别名表命中 -> 映射；其余直接透传（实测上游接受大量未在 model_list 列出的模型名，
  // 如 deepseek-v4-flash / kimi-k2.7-code / minimax-m3 等）
  let resolved = MODEL_ALIASES[lower] || requestedModel;

  const effort = normalizeEffort(body);
  const prefix = effortPrefix(resolved, effort);

  const messages = [];
  let prefixApplied = false;
  for (const msg of body.messages || []) {
    if (!msg || typeof msg.role !== 'string') continue;
    const role = msg.role === 'assistant' || msg.role === 'tool' || msg.role === 'system' ||
      msg.role === 'user' ? msg.role : 'user';
    let text = contentToText(msg.content);

    // effort 前缀注入到第一条 system；无 system 则注入为首条消息
    let injectHere = false;
    if (prefix && !prefixApplied) {
      if (role === 'system') injectHere = true;
      else if (messages.length === 0) injectHere = true;
    }
    const finalText = injectHere ? prefix + text : text;
    if (injectHere) prefixApplied = true;

    const m = { role, content: [{ type: 'text', text: finalText || ' ' }] };
    if (role === 'assistant') {
      const fc = toolCallsToUpstream(msg.tool_calls);
      if (fc) m.tool_calls = fc;
    }
    if (role === 'tool' && msg.tool_call_id) {
      // 上游后端（DeepSeek 风格）要求 tool 消息携带 tool_call_id 字段
      m.tool_call_id = msg.tool_call_id;
    }
    messages.push(m);
  }
  if (prefix && !prefixApplied) {
    messages.unshift({ role: 'system', content: [{ type: 'text', text: prefix.trimEnd() }] });
  }

  const traeBody = {
    messages,
    model: resolved,
    function: cfg.function || 'solo_work_lite',
    stream: true, // 上游恒流式；非流式由网关聚合
    request_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
  };

  // 采样参数透传
  for (const k of ['max_tokens', 'temperature', 'top_p', 'presence_penalty', 'frequency_penalty']) {
    if (body[k] != null && body[k] !== undefined) traeBody[k] = body[k];
  }
  if (Array.isArray(body.stop) && body.stop.length) traeBody.stop = body.stop;
  else if (typeof body.stop === 'string' && body.stop) traeBody.stop = [body.stop];

  // tools: parameters 对象 -> JSON 字符串（上游字段为 string 型）
  if (Array.isArray(body.tools) && body.tools.length) {
    let tools = body.tools
      .filter(t => t && t.type === 'function' && t.function && t.function.name)
      .map(t => ({
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description || '',
          parameters: typeof t.function.parameters === 'string'
            ? t.function.parameters
            : JSON.stringify(t.function.parameters || { type: 'object', properties: {} }),
        },
      }));
    // tool_choice 归一化
    let choice = body.tool_choice;
    if (choice && typeof choice === 'object' && choice.type === 'function' && choice.function) {
      choice = choice.function.name;
    }
    if (choice === 'none') {
      tools = [];
    } else {
      if (tools.length) traeBody.tools = tools;
      if (choice && choice !== 'auto') traeBody.tool_choice = choice;
    }
  }

  return { traeBody, requestedModel };
}

module.exports = { openaiToTrae, normalizeEffort, contentToText, MODEL_ALIASES };
