# claude-zai-usage

A zero-dependency custom [status line](https://code.claude.com/docs/en/statusline) for **Claude Code** that shows your **real server-side quota** for the Zhipu GLM / Z.ai Coding Plan, plus the context-window usage:

```
glm-5.3 · high │ ctx 24.6k/200K 12.3% │ zai 5h 28% · wk 44% · web 6%
```

- model name, with the `[1m]` 1M-context suffix trimmed and the reasoning effort after a `·` separator (`high`; shows `think` for models that only report extended thinking)
- `ctx` — context-window usage, taken from the JSON Claude Code feeds the script on stdin; yellow above 70%, red above 90%
- `zai` — quotas from the Coding Plan endpoint, one segment per window it returns: `5h` rolling token window, `wk` weekly token window, and `web` tools quota (search-prime / web-reader / zread). The whole badge is colored by its highest value: green below 70%, yellow at 70, red at 90; hidden when no quota is available

## Install

Node ≥ 18. No dependencies, no build step.

```bash
npm i -g @alecliu/claude-zai-usage
```

Then add a `statusLine` block to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "zai-usage-statusline",
  "refreshInterval": 60
}
```

Or skip the global install and point straight at the file (forward slashes on Windows — Claude Code runs the command through Git Bash):

```json
"statusLine": {
  "type": "command",
  "command": "node /path/to/claude-zai-usage/bin/statusline.mjs",
  "refreshInterval": 60
}
```

Restart Claude Code afterwards.

## How the numbers are sourced

- **Context usage** comes from Claude Code itself: the `context_window` object on stdin (`total_input_tokens` = input + cache read + cache creation of the last API response, over `context_window_size`). Before the first API response and right after `/compact` it reads `ctx 0.0k/200K 0.0%` (the real window size once Claude Code reports it).
- **z.ai** comes from the Coding Plan quota endpoint:
  `GET {base}/api/monitor/usage/quota/limit` with `Authorization: Bearer <key>`. One request covers all three windows: the token-window rows' `unit=3` percentage (5h), `unit=6` percentage (weekly), and the `TIME_LIMIT` percentage (web tools). The rows are typed `TOKENS_LIMIT` on older plans and `CREDIT_LIMIT` on current ones — same encoding, both accepted. The badge shows percentages; the absolute credit counts the API includes are plan-specific and not displayed.

Responses are cached in `os.tmpdir()` for **45 s**, keyed by a hash of base + key — concurrent sessions share one request per expiry, and the key itself is never written to disk.

### Key and base URL

Both are read from the environment (Claude Code copies its settings `env` block into the process environment, so a key configured there just works — no `settings.json` parsing here):

- Key: `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`.
- Quota host, derived from the *hostname* of `ANTHROPIC_BASE_URL`:

| `ANTHROPIC_BASE_URL` host | quota base |
| --- | --- |
| `bigmodel.cn` or a subdomain | `https://open.bigmodel.cn` |
| `z.ai` or a subdomain | `https://api.z.ai` |
| anything else | badge omitted — **no request is made, and the key is never sent anywhere else** |

Set `ZAI_USAGE_BASE` to override the quota host explicitly. It must be an `https://` URL; plain `http://` is accepted only for loopback hosts (`127.0.0.1`, `localhost`, `[::1]`), for testing against a local server.

### Behavior notes

- The script always exits 0 and always prints a line, so a failed quota lookup just hides the badge instead of blanking the status line.
- A failed fetch is retried at most once per 45 s. The last successful values stay on screen for up to 10 minutes after the endpoint stops answering, then the badge is hidden; a response that lists no quota windows hides it right away.
- Without Git Bash on Windows, Claude Code runs the command through PowerShell — `node` still resolves as long as it is on `PATH`.
- Corporate proxies: Node's built-in `fetch` honors `HTTPS_PROXY`/`HTTP_PROXY` only on Node ≥ 22.21 / ≥ 24, and only with `NODE_USE_ENV_PROXY=1` in the environment (e.g. the same settings `env` block). On older Node the quota request bypasses the proxy — behind a mandatory proxy the badge stays hidden.

## 中文说明

`claude-zai-usage` 是一个零依赖的 Claude Code 自定义状态栏脚本，显示智谱 GLM / Z.ai Coding Plan 的**服务端真实用量**和上下文窗口占用：

```
glm-5.3 · high │ ctx 24.6k/200K 12.3% │ zai 5h 28% · wk 44% · web 6%
```

- 模型名，自动去掉 `[1m]` 1M 上下文后缀，并用 `·` 分隔符附加推理强度（`high`；只上报扩展思考的模型显示 `think`）
- `ctx` — 上下文窗口占用，取自 Claude Code 通过 stdin 传给状态栏脚本的 JSON；超过 70% 变黄，超过 90% 变红
- `zai` — Coding Plan 配额，接口返回哪些窗口就显示哪些：`5h` 5 小时滚动 token 窗口、`wk` 周窗口、`web` 网页工具配额（search-prime / web-reader / zread）。整个徽章按其中最高值着色：低于 70% 绿色，70% 黄色，90% 红色；取不到配额时隐藏

### 安装

需要 Node ≥ 18，无任何依赖：

```bash
npm i -g @alecliu/claude-zai-usage
```

然后在 `~/.claude/settings.json` 中加入：

```json
"statusLine": {
  "type": "command",
  "command": "zai-usage-statusline",
  "refreshInterval": 60
}
```

也可以不全局安装，直接指向文件（Windows 下请用正斜杠，Claude Code 通过 Git Bash 执行该命令）：

```json
"statusLine": {
  "type": "command",
  "command": "node /path/to/claude-zai-usage/bin/statusline.mjs",
  "refreshInterval": 60
}
```

保存后重启 Claude Code。

### 数据来源

- **上下文占用**来自 Claude Code 本身（stdin 中的 `context_window`，即最近一次 API 响应的 input + cache read + cache creation），首次响应前与 `/compact` 之后显示 `ctx 0.0k/200K 0.0%`（Claude Code 上报窗口大小后显示真实值）。
- **zai** 来自 Coding Plan 配额接口：`GET {base}/api/monitor/usage/quota/limit`（Bearer 鉴权）。一次请求覆盖全部三个窗口：token 窗口行的 `unit=3` 百分比（5h）、`unit=6` 百分比（周窗口），以及 `TIME_LIMIT` 的百分比（网页工具）。行类型在旧套餐为 `TOKENS_LIMIT`，当前套餐为 `CREDIT_LIMIT`——编码相同，两者都接受。徽章只显示百分比；接口返回的绝对额度数因套餐而异，不予展示。结果按 base+key 的哈希缓存在系统临时目录，**45 秒**内所有会话共享、同一过期周期最多请求一次，密钥不会写盘。

密钥与 base URL 均从环境变量读取（Claude Code 会把 settings 的 `env` 块注入子进程环境）：密钥取 `ANTHROPIC_AUTH_TOKEN`，其次 `ANTHROPIC_API_KEY`；配额域名按 `ANTHROPIC_BASE_URL` 的主机名严格匹配（`*.bigmodel.cn` → `open.bigmodel.cn`，`*.z.ai` → `api.z.ai`），其他域名一律不发请求、不显示徽章——密钥只会发给它所属的厂商。可用 `ZAI_USAGE_BASE` 显式覆盖配额域名，必须为 `https://`；仅回环地址（`127.0.0.1`、`localhost`、`[::1]`）允许 `http://`，便于对本地服务器测试。

脚本始终以 0 退出且必有输出：配额请求失败只会隐藏徽章，不会让状态栏变白；失败后每 45 秒最多重试一次，最后一次成功的数值在接口停止应答后最多保留 10 分钟，届时隐藏徽章；接口正常应答但未返回任何配额窗口时立即隐藏。

公司代理：Node 内置 `fetch` 仅在 Node ≥ 22.21 / ≥ 24 且设置了 `NODE_USE_ENV_PROXY=1` 时才走 `HTTPS_PROXY`/`HTTP_PROXY`（可放进 settings 的 `env` 块）。旧版 Node 会直连——强制代理环境下徽章将保持隐藏。

## License

MIT — see [LICENSE](LICENSE).
