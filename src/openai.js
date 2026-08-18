// Trae SSE -> OpenAI chat.completion(.chunk) 流转换
// 上游事件序列（实测）：
//   metadata -> timing_cost -> output×N (response/reasoning_content/tool_calls)
//   -> progress_notice(忽略) -> extra_info(忽略) -> token_usage -> done
'use strict';
const crypto = require('crypto');

function newId() { return 'chatcmpl-' + crypto.randomBytes(12).toString('hex'); }

// 解析上游 SSE 文本流为 {event, data} 序列
async function* parseSSE(bodyStream) {
  const decoder = new TextDecoder();
  const reader = bodyStream.getReader();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        yield line; // 输出原始行，由上层配对 event/data
      }
    }
    if (buf.trim()) yield buf.replace(/\r$/, '');
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

class ToolCallMerger {
  constructor() {
    this.map = new Map(); // index -> {id, type, name, args}
  }
  // 上游 tool_call 项 -> OpenAI 增量数组（可能一次输出多个）
  feed(tc) {
    const out = [];
    const list = Array.isArray(tc) ? tc : [tc];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!item) continue;
      let index = typeof item.index === 'number' ? item.index : i;
      // function 或 function_call（上游专属字段名）兼容
      const fn = item.function || item.function_call || {};
      let name = typeof fn.name === 'string' ? fn.name : undefined;
      let argsInc = '';
      if (typeof fn.arguments === 'string') argsInc = fn.arguments;
      else if (fn.arguments && typeof fn.arguments === 'object') argsInc = JSON.stringify(fn.arguments);
      else if (typeof fn.partial_arguments === 'string') argsInc = fn.partial_arguments;

      const cur = this.map.get(index) || { id: null, type: 'function', name: '', args: '', emittedArgs: '' };
      const delta = { index };
      let isNew = false;
      if (item.id && item.id !== cur.id) { cur.id = item.id; delta.id = item.id; delta.type = 'function'; isNew = true; }
      if (!cur.id) { cur.id = item.id || `call_${index}_${crypto.randomBytes(4).toString('hex')}`; delta.id = cur.id; delta.type = 'function'; isNew = true; }
      if (name && name !== cur.name) { cur.name = name; if (!isNew || delta.function) { /* name 变更也输出 */ } delta.function = delta.function || {}; delta.function.name = name; }

      // arguments 合并：区分快照（以已拼接内容为前缀）与纯增量
      let argDelta;
      if (argsInc) {
        const merged = cur.args + argsInc;
        if (argsInc.startsWith(cur.emittedArgs) && argsInc.length >= cur.emittedArgs.length && cur.emittedArgs) {
          // argsInc 是累积快照
          argDelta = argsInc.slice(cur.emittedArgs.length);
          cur.args = argsInc;
        } else {
          argDelta = argsInc;
          cur.args = merged;
        }
        cur.emittedArgs = cur.args;
        delta.function = delta.function || {};
        delta.function.arguments = argDelta;
      }
      this.map.set(index, cur);
      if (delta.id || delta.function) {
        out.push(delta);
      }
    }
    return out;
  }
  // 最终 OpenAI 格式（非流式聚合用）
  final() {
    return [...this.map.entries()].sort((a, b) => a[0] - b[0]).map(([index, c]) => ({
      index,
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }));
  }
  hasAny() { return this.map.size > 0; }
}

// 主转换器。
// opts: { model(回显名), stream, includeUsage }
// yield: { type:'chunk', chunk } | { type:'finish' }
// 抛出: UpstreamError（上游 error 事件 / 流异常）
async function* convertUpstreamStream(res, opts) {
  const id = newId();
  const created = Math.floor(Date.now() / 1000);
  const model = opts.model;
  const merger = new ToolCallMerger();

  const mkChunk = (delta, finishReason = null, withChoices = true) => ({
    id, object: 'chat.completion.chunk', created, model,
    ...(withChoices ? { choices: [{ index: 0, delta, ...(finishReason != null ? { finish_reason: finishReason } : {}) }] } : { choices: [] }),
  });

  let usage = null;
  let finishReason = null;
  let contentFull = '', reasoningFull = '';
  const roleSent = { value: false };

  function handleEvent(ev, dataStr, emit) {
    if (ev === 'output') {
      let d;
      try { d = JSON.parse(dataStr); } catch { return; }
      const delta = {};
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
        delta.reasoning_content = d.reasoning_content;
        reasoningFull += d.reasoning_content;
      }
      if (typeof d.response === 'string' && d.response) {
        delta.content = d.response;
        contentFull += d.response;
      }
      const tcDeltas = d.tool_calls ? merger.feed(d.tool_calls) : [];
      if (tcDeltas.length) delta.tool_calls = tcDeltas;
      if (Object.keys(delta).length) {
        if (!roleSent.value) { roleSent.value = true; delta.role = 'assistant'; }
        emit({ type: 'chunk', chunk: mkChunk(delta) });
      }
      return;
    }
    if (ev === 'token_usage') {
      try {
        const u = JSON.parse(dataStr);
        usage = {
          prompt_tokens: u.prompt_tokens ?? 0,
          completion_tokens: u.completion_tokens ?? 0,
          total_tokens: u.total_tokens ?? ((u.prompt_tokens || 0) + (u.completion_tokens || 0)),
        };
        if (u.reasoning_tokens != null) {
          usage.completion_tokens_details = { reasoning_tokens: u.reasoning_tokens };
        }
      } catch { /* ignore */ }
      return;
    }
    if (ev === 'done') {
      try {
        const d = JSON.parse(dataStr);
        if (d && typeof d.finish_reason === 'string') finishReason = d.finish_reason;
      } catch { /* ignore */ }
      return;
    }
    if (ev === 'error') {
      let code = '', message = dataStr;
      try {
        const d = JSON.parse(dataStr);
        code = d.code != null ? String(d.code) : '';
        message = d.message || dataStr;
      } catch { /* 裸文本 */ }
      const err = new Error(`上游错误${code ? ` [${code}]` : ''}: ${message}`);
      err.status = 502;
      err.code = code === '1005' ? 'quota_exhausted' : 'upstream_error';
      if (code === '1005') {
        err.message = `Trae 积分/额度已用尽（1005）：${message}。可到 Trae 官网签到领取积分后重试。`;
        err.status = 429;
      }
      throw err;
    }
    // metadata / timing_cost / progress_notice / extra_info -> 忽略
  }

  // 逐行状态机：event:/data: 配对，同步 emit 收集后逐个 yield
  let evName = '';
  let dataLines = [];
  const flush = (emit) => {
    if (evName && dataLines.length) handleEvent(evName, dataLines.join('\n'), emit);
    else if (evName) handleEvent(evName, '', emit);
    evName = '';
    dataLines = [];
  };
  for await (const line of parseSSE(res.body)) {
    if (line.startsWith('event:')) {
      const out = [];
      const emit = x => out.push(x);
      flush(emit);
      for (const o of out) { if (o.type === 'error') throw o.error; yield o; }
      evName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    } else if (line === '') {
      const out = [];
      const emit = x => out.push(x);
      flush(emit);
      for (const o of out) { if (o.type === 'error') throw o.error; yield o; }
    }
  }
  {
    const out = [];
    const emit = x => out.push(x);
    flush(emit);
    for (const o of out) { if (o.type === 'error') throw o.error; yield o; }
  }

  // 收尾
  if (!finishReason) finishReason = merger.hasAny() ? 'tool_calls' : 'stop';
  if (finishReason === 'stop' && merger.hasAny()) finishReason = 'tool_calls';
  if (finishReason === 'tool_calls' && !merger.hasAny()) finishReason = 'stop';

  if (usage && opts.includeUsage) {
    yield { type: 'chunk', chunk: mkChunk({}, null, false) , usage };
  }
  yield {
    type: 'finish',
    finishReason,
    usage,
    result: { // 非流式聚合所需
      id, created, model,
      content: contentFull,
      reasoningContent: reasoningFull,
      toolCalls: merger.final(),
    },
  };
}

module.exports = { convertUpstreamStream, ToolCallMerger };
