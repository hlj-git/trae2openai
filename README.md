# trae2openai

将本机 **Trae Work（TRAE SOLO）/ Trae** 转换为 **OpenAI 兼容 API**，可在任何支持 OpenAI 协议的客户端（DSH / DeepSeek Harness、Cherry Studio、LobeChat 等）中复用 Trae 的模型额度。

零依赖（Node.js ≥ 18 原生 `fetch`/`crypto`），单服务启动即用。

## 特性

- **OpenAI 兼容端点**：`GET /v1/models`、`POST /v1/chat/completions`（流式 / 非流式）
- **实时模型列表（与 Trae 客户端一致）**：`/v1/models` 直接调用 Trae 同款 `get_detail_param` 接口（按 `function` 通道），返回与 Trae UI 完全一致的可见模型（含 GLM-5.3、DeepSeek-V4、Kimi-K3、Qwen3.8 等新模型）；接口不可用时自动回退旧 `model_list`
- **凭证自动获取**：自动探测并解密本机 Trae 登录凭证（`storage.json` 的 tc 加密字段），无需手动抓包；过期自动重读（Trae 运行时会续期写回）
- **推理思维链**：`reasoning_content` 全量透传（DeepSeek 风格 delta 流式 + 非流式 message 字段），含 `reasoning_tokens` 用量
- **深度推理控制**：支持 `reasoning_effort`（`off / low / medium / high / max / auto`），按模型族注入实测验证的前缀方案
- **工具调用**：完整 `tools` / `tool_choice` / `tool_calls` 适配，支持流式增量合并、多轮工具结果回传、并行多工具
- **多版本支持**：TRAE SOLO CN / TRAE WORK / Trae CN / TRAE SOLO / Trae（国际版）自动探测；支持 WSL2（`/mnt/c` 路径探测）

## 快速开始

### 前置条件

1. 本机已安装并登录 [Trae](https://www.trae.cn/)（任意支持版本，推荐 Trae Work / TRAE SOLO CN）
2. Node.js ≥ 18

### 启动

```bash
git clone <your-repo> trae2openai
cd trae2openai
node server.js
```

支持命令行参数（优先级高于 config.json 与环境变量，`node server.js --help` 查看全部）：

| 参数 | 说明 | 示例 |
|---|---|---|
| `--host <addr>` | 监听地址（默认 127.0.0.1；WSL/局域网访问用 0.0.0.0） | `--host 0.0.0.0` |
| `--port <n>` | 监听端口 | `--port 9000` |
| `--api-key <key>` | 启用 Bearer Key 校验，可多次指定或逗号分隔 | `--api-key sk-mine` |
| `--edition <name>` | 指定凭证版本 | `--edition "TRAE SOLO CN"` |
| `--function <name>` | 上游通道 | `--function chat_v3` |

常用组合：

```bash
# 对外/WSL 暴露 + 鉴权（推荐）
node server.js --host 0.0.0.0 --api-key sk-mine
```

### 日志（默认开启，无需参数）

每次启动自动生成独立日志文件 `log/trae2openai-<启动时间戳>.log`（同时输出到控制台），例如：

```
log/trae2openai-20260818-235029.log
```

每个对话请求只记录问答本身与关键参数（不含思维链/工具调用细节，保持日志精简）：

```
2026-08-18 16:03:21 [req-506fc2db] ===== 对话请求 (非流式) =====
2026-08-18 16:03:21 [req-506fc2db] [参数] model=deepseek-R1 reasoning_effort=默认 max_tokens=- temperature=- tools=无
2026-08-18 16:03:21 [req-506fc2db] [输入对话] 1 条:
    user: 9.11和9.8哪个大？只答答案
2026-08-18 16:03:21 [req-506fc2db] [上游] resolved_model=deepseek-R1 function=solo_work_lite region_base=https://...
2026-08-18 16:03:28 [req-506fc2db] [回复正文] (4 字):
    9.8大
2026-08-18 16:03:28 [req-506fc2db] [完成] finish=stop 耗时=6623ms 用量={"prompt_tokens":60,...}
```

记录项：请求参数（模型/effort/采样/工具名）、完整输入对话（system/user/assistant/tool 消息）、上游实际模型与通道、回复正文、token 用量、耗时、失败原因（上游错误/凭证续期重试）。思维链与工具调用过程不落盘（`finish=tool_calls` 时仅在完成行体现）。`GET /v1/models` 等简单请求记录单行访问日志（含来源 IP）。

看到以下输出即成功（凭证自动探测 + 模型列表实时拉取）：

```
trae2openai 已启动: http://127.0.0.1:8787/v1
凭证来源: TRAE SOLO CN (region=cn, userId=4021388834253792)
上游: https://trae-api-cn.mchost.guru | 通道: solo_work_lite | 默认模型: glm-5.2
模型列表: 15 个 -> Doubao-Seed-2.1-Pro, Doubao-Seed-2.1-Turbo, glm-5.3, glm-5.2, glm-5, DeepSeek-V4-Pro-Official, ..., kimi-k3, qwen3.8-max
```

### 验证

```bash
# 健康检查（凭证状态）
curl http://127.0.0.1:8787/healthz

# 模型列表
curl http://127.0.0.1:8787/v1/models

# 非流式对话（deepseek-R1 思维链）
curl http://127.0.0.1:8787/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "deepseek-R1",
  "stream": false,
  "messages": [{"role": "user", "content": "9.11 和 9.8 哪个大？"}]
}'
```

或运行完整自检（含思维链 / 流式 / 工具调用 / 多轮回传）：

```bash
node test-e2e.js
```

## 接入 DSH（DeepSeek Harness）

把 [`dsh-provider.example.yaml`](dsh-provider.example.yaml) 中的片段追加到 DSH 配置文件：

- Windows：`%USERPROFILE%\.dsh\settings.yaml`
- WSL：`~/.dsh/settings.yaml`

```yaml
llm-pi-ai:
  providers:
    trae-local:
      displayName: "Trae Work (本机)"
      api: openai-completions
      baseURL: http://127.0.0.1:8787/v1
      apiKey: no-key-needed
      models:
        - id: glm-5.2
          name: "GLM 5.2 (Trae)"
        # ...更多模型见示例文件
```

重启 DSH（`dsh web`）后，模型选择器会出现 **"Trae Work (本机)"** 供应商。DSH 中的 `reasoningEffort` 设置会透传为本服务的 `reasoning_effort` 参数。

### DSH 跑在 WSL2 时（could not reach 排查）

WSL2 默认 **NAT 网络模式，WSL 内的 `127.0.0.1` 指向 WSL 自身而非 Windows 宿主**，所以 `http://127.0.0.1:8787/v1/models` 会报 `could not reach`。修复：

```bash
# 1. Windows 侧：服务绑定 0.0.0.0 启动（建议同时加 key）
node server.js --host 0.0.0.0 --api-key sk-mine

# 2. WSL 内：查 Windows 宿主 IP（默认网关）
ip route show default | awk '{print $3}'     # 如 172.19.192.1

# 3. WSL 内验证
curl http://172.19.192.1:8787/healthz       # 应返回 {"status":"ok",...}

# 4. DSH 的 baseURL 改用宿主 IP
#    baseURL: http://172.19.192.1:8787/v1
```

注意：

- 宿主 IP（NAT 网关）在 WSL 重启后可能变化，以 `ip route` 实时查询为准
- 若 WSL curl 不通，通常是 Windows 防火墙拦截，放行端口：
  `New-NetFirewallRule -DisplayName trae2openai -Direction Inbound -LocalPort 8787 -Protocol TCP -Action Allow`（管理员 PowerShell）
- 替代方案：Windows 11 22H2+ / WSL 2.0+ 可在 `C:\Users\<你>\.wslconfig` 中设置 `[wsl2]` → `networkingMode=mirrored`，镜像模式下 WSL 与 Windows 共享 localhost，`127.0.0.1` 直通（改后需 `wsl --shutdown`）

## 配置

编辑 [`config.json`](config.json)（均可被同名环境变量覆盖）：

```jsonc
{
  "host": "127.0.0.1",          // 监听地址；对外暴露改为 0.0.0.0
  "port": 8787,                 // PORT
  "api_keys": [],               // API_KEY / API_KEYS（逗号分隔）；非空时校验 Bearer
  "trae": {
    "edition": "auto",          // auto | TRAE SOLO CN | TRAE WORK | Trae CN | TRAE SOLO | Trae
    "base_url": "",             // 留空按凭证 region 自动选择（cn -> trae-api-cn.mchost.guru）
    "function": "solo_work_lite", // 上游通道：solo_work_lite | inline_chat | chat_v3（均实测可用）
    "ide_version": "0.2.0",     // x-ide-version 请求头；版本越新模型列表越全（0.1.43 无 glm-5.3）
    "ide_version_code": "20260815",
    "default_model": "glm-5.2",
    "manual_token": "",         // 手动粘贴 token（F12 抓 Authorization: Cloud-IDE-JWT xxx）
    "manual_user_id": ""
  },
  "models_cache_ttl": 300,      // 模型列表缓存秒数（0 = 每次实时拉取）
  "request_timeout": 600,       // 上游请求超时秒数
  "extra_models": []            // 额外追加的模型 ID（一般留空，实时列表已够用）
}
```

## API 说明

### 模型

`/v1/models` 调用 Trae 同款 `get_detail_param?function=<通道>` 接口，**实时返回与 Trae 客户端一致的可见模型**（排除 `is_invisible_to_user`、`custom_model_*` 占位、无显示名的内部配置），每项含 `display_name`、`context_window`、`model_type`。当前实测列表（随上游动态变化）：

| 模型 ID | 显示名 | 类型 |
|---|---|---|
| `glm-5.3` | GLM-5.3 | reasoning_model |
| `glm-5.2` / `glm-5` | GLM-5.2 / GLM-5 | reasoning_model |
| `DeepSeek-V4-Pro` / `DeepSeek-V4-Flash` | DeepSeek-V4-Pro / Flash | reasoning_model |
| `DeepSeek-V4-Pro-Official` / `DeepSeek-V4-Flash-Official` | DeepSeek 正式版 | reasoning_model |
| `kimi-k3` / `kimi-k2.7-code` / `kimi-k2.6` | Kimi 系列 | reasoning_model |
| `minimax-m3` | MiniMax-M3 | reasoning_model |
| `qwen3.8-max` / `qwen-3.7-plus` | Qwen 系列 | reasoning_model |
| `Doubao-Seed-2.1-Pro` / `Doubao-Seed-2.1-Turbo` | 豆包 Seed 系列 | reasoning_model |

兼容别名：`deepseek-chat` → `deepseek-V3`、`deepseek-reasoner`/`deepseek-r1` → `deepseek-R1`、`deepseek-v4-flash` → `DeepSeek-V4-Flash`、`doubao-1.5-pro` → `seed_m8` 等；未知名直接透传上游（大量未列出模型实测可用）。

### 深度推理（reasoning effort）

请求携带 `reasoning_effort`（或 `reasoning.effort`）：

```json
{
  "model": "glm-5.2",
  "reasoning_effort": "max",
  "messages": [...]
}
```

上游无原生参数，本服务按模型族注入实测最优的 system 前缀：

- **GLM 系**：短标签（`Reasoning Effort: High/Max`）——长串反而劣化
- **DeepSeek 系**：`max` 用 "Absolute maximum" 长串（+40% 思考量）
- **Kimi 系**：`low` 用 `<critical_constraints>` 压制 overthink（-87%），`max` 用长串
- 其他模型族：通用指令

### 思维链输出

- **流式**：`delta.reasoning_content` 增量输出（与 `delta.content` 分离）
- **非流式**：`message.reasoning_content` 完整字符串
- **用量**：`usage.completion_tokens_details.reasoning_tokens`

### 工具调用

标准 OpenAI `tools` / `tool_choice` 格式，支持流式增量合并与多轮回传：

```json
{
  "model": "glm-5.2",
  "messages": [{"role": "user", "content": "北京今天天气怎么样？"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "查询城市天气",
      "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
    }
  }]
}
```

返回 `finish_reason: "tool_calls"`；工具结果以 `role: "tool"` + `tool_call_id` 回传即可继续对话。

## 项目结构

```
trae2openai/
├── server.js                    # 主服务：路由 / 鉴权 / 流式转发 / 模型缓存
├── config.json                  # 配置（环境变量可覆盖）
├── src/
│   ├── decrypt.js               # storage.json tc 加密凭证解密（AES-128-CBC + SHA-512 + 硬编码盐）
│   ├── auth.js                  # 多版本凭证探测 / 过期重读 / region 判定
│   ├── upstream.js              # 上游客户端：headers 构造、get_detail_param 实时模型列表、llm_utils_chat 流式
│   ├── convert.js               # OpenAI -> Trae 请求转换（模型映射 / effort 注入 / tools 适配）
│   └── openai.js                # Trae SSE -> OpenAI chunk 转换（output/done/token_usage/error）
├── dsh-provider.example.yaml    # DSH 接入配置片段
├── test-e2e.js                  # 端到端自检脚本（服务启用 key 时：API_KEY=sk-xx node test-e2e.js）
└── log/                         # 运行日志（每次启动一个带时间戳的文件，自动生成）
```

## 工作原理

```
DSH / OpenAI 客户端
        │  OpenAI 协议（/v1/chat/completions）
        ▼
┌──────────────────┐   自动解密 storage.json 凭证（过期自动重读）
│  trae2openai     │──────────────────────────────▶ %APPDATA%\TRAE SOLO CN\...\storage.json
│  (Node.js)       │
│                  │   GET  /api/ide/v1/get_detail_param?function=solo_work_lite（实时模型列表）
│  协议转换         │   POST /api/agent/v3/llm_utils_chat （function=solo_work_lite，SSE）
│                  │──────────────────────────────▶ trae-api-cn.mchost.guru
└──────────────────┘
```

1. **凭证**：读取 `%APPDATA%\{TRAE SOLO CN | Trae CN | ...}\User\globalStorage\storage.json` 中 `iCubeAuthInfo://icube.cloudide` 字段，Base64 → SHA-512 双重密钥派生（XOR 硬编码盐）→ AES-128-CBC 解密 → SHA-512 校验，得到 `{token, refreshToken, userId, expiredAt}`
2. **模型列表**：调用 Trae 客户端同款 `get_detail_param?function=<通道>`，`config_info_list` 中的 `config_name` 即模型 ID（直接用于对话请求的 `model` 字段）；按 Trae UI 规则过滤隐藏项
3. **上游对话**：`POST /api/agent/v3/llm_utils_chat`，Headers 带 `Authorization: Cloud-IDE-JWT` + 设备指纹（`x-app-id` / `x-machine-id` / `x-ide-version` 等）
4. **SSE 转换**：上游事件 `output`（`response` 正文 / `reasoning_content` 思维链 / `tool_calls`）、`token_usage`、`done` → OpenAI `chat.completion.chunk` 流

### 上游适配实测结论（逆向要点）

- **模型列表接口是 `get_detail_param?function=<通道>`**（需带 `function` 查询参数，否则返回空列表）；旧 `model_list` 是过时快照（无 GLM-5.3 等新模型），仅作回退
- **`x-ide-version` 请求头决定列表新旧**：`0.1.43` 返回 34 个 config（无 glm-5.3），`0.2.0` 返回 35 个（含 glm-5.3）；本项目默认 `0.2.0`
- 请求体**不能带 `config_name`** 字段（否则 `4001 param invalid`）；`model` 字段直接填 `config_name`（如 `DeepSeek-V4-Pro`、`glm-5.3`）即可
- assistant 工具回传格式为 `{id, type: "function", function_call: {name, arguments}}` —— 字段名是 `function_call`（非 OpenAI 的 `function`），且 `arguments` 必须是字符串
- `tools[].function.parameters` 对象需序列化为 JSON 字符串
- `tool` 消息必须携带 `tool_call_id` 字段
- 错误码 `1005` = Trae 积分用尽（服务返回 429 并提示签到）
- 上游接受大量未列出的模型名透传（大小写不敏感的路由映射，`model_detail_list` 中可见 `config_name → 真实模型__dev` 映射）

## 常见问题

**Q: 提示"未找到 Trae 登录凭证"？**
先安装并登录 [Trae](https://www.trae.cn/)；或 F12 抓包 `Authorization: Cloud-IDE-JWT xxx` 填入 `config.json` 的 `trae.manual_token`。

**Q: 401 / 凭证失效？**
Trae 的 JWT 有效期约 14 天。打开一次 Trae Work 让其自动续期写回 `storage.json`，本服务收到 401 时也会自动重读凭证重试一次。

**Q: 429 积分用尽（1005）？**
Trae 免费额度按积分计。到 Trae 官网/客户端签到领取积分后重试。

**Q: WSL2 中能跑吗？**
两种方式：① 服务跑 Windows，WSL 内客户端（如 dsh web）通过宿主 IP 访问（见上文 "DSH 跑在 WSL2 时"）；② 服务直接跑在 WSL 里（`node server.js`），凭证自动探测 `/mnt/c/Users/<name>/AppData/Roaming/` 路径，无需额外配置。

**Q: DSH 添加供应商报 could not reach？**
DSH 运行环境访问不到服务。Windows 内跑的 DSH 检查服务是否启动；WSL 内跑的 DSH 见上文 WSL2 章节（127.0.0.1 不通是 NAT 模式正常现象）。`log/` 目录下最新日志文件能看到每个进入的请求，可用于区分"请求没到"和"请求被拒"。

**Q: 对外暴露安全吗？**
监听 `127.0.0.1` 仅本机可访问；如需局域网/WSL 使用，改 `host` 为 `0.0.0.0`（或 `--host 0.0.0.0`）并**务必**配置 `api_keys`（或 `--api-key`）。

## 致谢

本项目参考了以下开源项目的逆向成果与实现思路：

- [laojichao/trae-local-api](https://github.com/laojichao/trae-local-api) / [ZedeX/trae-local-api](https://github.com/ZedeX/trae-local-api)（tc 解密算法、上游端点、SSE 解析）
- [Sliverkiss/traework2api](https://github.com/Sliverkiss/traework2api)（solo_work_lite 通道常量、工具调用字段格式、reasoning effort 方案）
- [Ttungx/trae-solo-local-api](https://github.com/Ttungx/trae-solo-local-api)（模型族 reasoning 前缀实测数据）
- [A-23187/trae-api](https://github.com/A-23187/trae-api) / [muskke/trae-api-proxy](https://github.com/muskke/trae-api-proxy)（SSE → OpenAI 转换参考）

## 免责声明

仅供个人学习与研究使用。请遵守 Trae 用户协议；凭证仅在本机读取，不经过任何第三方。
