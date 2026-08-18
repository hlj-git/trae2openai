// 端到端验证：非流式 / 流式思维链 / reasoning_effort / 工具调用 / 工具结果回传
// 用法: node test-e2e.js   （服务启用 api_key 时设置环境变量 API_KEY，如 API_KEY=sk-xx node test-e2e.js）
'use strict';
const BASE = 'http://127.0.0.1:8787/v1';
const API_KEY = process.env.API_KEY || '';

async function post(body) {
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { 'Authorization': `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function main() {
  console.log('===== 1) 非流式 deepseek-R1（应含 reasoning_content）=====');
  {
    const res = await post({ model: 'deepseek-R1', stream: false, messages: [{ role: 'user', content: '9.11 和 9.8 哪个大？只回答答案。' }] });
    const r = await res.json();
    const m = r.choices[0].message;
    console.log('finish_reason:', r.choices[0].finish_reason);
    console.log('reasoning(前100):', m.reasoning_content ? m.reasoning_content.slice(0, 100) : '(无)');
    console.log('content:', m.content);
    console.log('usage:', JSON.stringify(r.usage));
  }

  console.log('\n===== 2) 流式 glm-5.2 + reasoning_effort=low + include_usage =====');
  {
    const res = await post({
      model: 'glm-5.2', stream: true, reasoning_effort: 'low',
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: '一句话解释递归' }],
    });
    const text = await res.text();
    let reasoning = '', content = '', finish = '', usage = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const p = line.slice(6).trim();
      if (p === '[DONE]') continue;
      const o = JSON.parse(p);
      if (o.choices && o.choices.length) {
        const d = o.choices[0].delta || {};
        if (d.reasoning_content) reasoning += d.reasoning_content;
        if (d.content) content += d.content;
        if (o.choices[0].finish_reason) finish = o.choices[0].finish_reason;
      }
      if (o.usage) usage = o.usage;
    }
    console.log('reasoning 长度:', reasoning.length, '| content 长度:', content.length, '| finish:', finish);
    console.log('usage:', JSON.stringify(usage));
    console.log('content:', content.slice(0, 120));
  }

  console.log('\n===== 3) 工具调用（get_weather，非流式）=====');
  let firstToolCalls = null;
  {
    const res = await post({
      model: 'glm-5.2', stream: false,
      messages: [{ role: 'user', content: '北京今天天气怎么样？请调用工具查询。' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather', description: '查询指定城市当前天气',
          parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] },
        },
      }],
      tool_choice: 'auto',
    });
    const r = await res.json();
    console.log('finish_reason:', r.choices[0].finish_reason);
    const tc = r.choices[0].message.tool_calls;
    if (tc && tc.length) {
      console.log('tool_call:', tc[0].id, tc[0].function.name, tc[0].function.arguments);
      firstToolCalls = tc;
    } else {
      console.log('!! tool_calls 缺失, content =', r.choices[0].message.content);
    }
  }

  if (firstToolCalls) {
    console.log('\n===== 4) 工具结果回传（多轮）=====');
    const res = await post({
      model: 'glm-5.2', stream: false,
      messages: [
        { role: 'user', content: '北京今天天气怎么样？请调用工具查询。' },
        { role: 'assistant', content: null, tool_calls: firstToolCalls },
        { role: 'tool', tool_call_id: firstToolCalls[0].id, content: '{"temp_c": 31, "condition": "晴转多云"}' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather', description: '查询指定城市当前天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      }],
    });
    const r = await res.json();
    console.log('finish_reason:', r.choices[0].finish_reason);
    console.log('content:', (r.choices[0].message.content || '').slice(0, 200));
  }

  console.log('\n===== 5) 流式工具调用 =====');
  {
    const res = await post({
      model: 'glm-5.2', stream: true,
      messages: [{ role: 'user', content: '查一下上海的天气' }],
      tools: [{
        type: 'function',
        function: { name: 'get_weather', description: '查询城市天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
      }],
    });
    const text = await res.text();
    let merged = {}, finish = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const p = line.slice(6).trim();
      if (p === '[DONE]') continue;
      const o = JSON.parse(p);
      if (o.choices && o.choices.length) {
        const d = o.choices[0].delta || {};
        if (d.tool_calls) for (const t of d.tool_calls) {
          merged[t.index] = merged[t.index] || { id: '', name: '', args: '' };
          if (t.id) merged[t.index].id = t.id;
          if (t.function && t.function.name) merged[t.index].name = t.function.name;
          if (t.function && t.function.arguments) merged[t.index].args += t.function.arguments;
        }
        if (o.choices[0].finish_reason) finish = o.choices[0].finish_reason;
      }
    }
    console.log('finish:', finish, '| tool_calls:', JSON.stringify(merged));
  }
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
