# Muse Bridge — 架构与功能说明

Muse Bridge 让 AI 助手通过 WebSocket 直接操控用户 PC（VS Code 扩展内），无需轮询、事件驱动。

## 架构

```
┌─────────────┐         WSS (443)          ┌──────────────┐         HTTPS          ┌─────────────┐
│  Win 11 PC  │ ──► wss://<vps>/muse-bridge ──► │  VPS (nginx) │ ──► 1444/nginx ──► │  助手 VM    │
│ VS Code 扩展 │ ◄── 命令/文件操作推送 ──      │  ALPN 分流   │ ◄── 结果返回 ──    │  musepc CLI │
└─────────────┘                              └──────────────┘                    └─────────────┘
       │                                            │
       │ 出站 WSS 长连接                              │ 8471/muse-bridge.service
       │ 不开放公网端口                                │ (Python WebSocket 服务)
```

- **PC 只建立出站 WSS**，不开放新公网端口，复用现有 443。
- **VPS**：nginx stream 按 ALPN 分流（h2 → gost，other → bridge）；`muse-bridge.service` 维护 WebSocket 客户端表与待处理请求。
- **助手 VM**：`musepc` CLI 经 SSH 到 VPS，调 HTTP 接口，VPS 经 WS 推送到 PC。

## 连接与认证

- WSS 长连接，指数退避重连（2s 起，60s 封顶，±25% 抖动）。
- **心跳**：20s ping，10s 等 pong；连续 2 次无 pong 主动 `terminate`（半开连接 30s 内发现，原来靠 OS 超时分钟级）。
- **backoff 稳定阈值**：只有稳定在线 30s 才重置 backoff，防抖动期紧循环。
- Token 存 VS Code SecretStorage（`muse_bridge.token`），请求头 `X-Bridge-Token`。
- TLS：显式 `servername` + 自定义 IP 证书校验，不关闭验证。

## 权限模型

`~/.muse-bridge/permissions.json`：
```json
{"default":"allow","deny":[]}
```
- 默认全放行（用户要求不弹窗）。
- `deny` 子串命中 → 弹窗确认。
- 只读模式（`museBridge.readOnly`）下写操作一律拒绝。

## Shell 池

- 基线 4 常驻 `sh.exe`（Git Bash），排队时 burst 到 8，burst 空闲 60s 回收。
- 可配置：`poolSize`（1–16）、`poolMax`（1–32）、`burstIdleSeconds`（10–600）。
- 每个命令跑在子 shell（`cd`/环境变量不泄漏），cwd = 首个工作区根。
- 命令经 base64 + heredoc 喂给 bash（防 `)` 破坏 framing）。
- 超时/死亡 → `taskkill /F /T` 杀整棵树 + 补位。
- 输出超 256KB 返回 `truncated: true`。

## 操作列表

| Op | 说明 |
|---|---|
| `cmd` | 同步 shell 命令（timeout 5–600s） |
| `batch` | 一次往返跑 ≤32 条命令，池内并行 |
| `bash_bg` / `bash_output` / `bash_kill` | 后台任务：启动/轮询输出/杀死 |
| `read_file` | 分片读（单片 ≤8MB） |
| `write_file` / `edit_file` / `multi_edit` | 写/精确替换/批量编辑 |
| `list_dir` / `glob_files` / `grep_file` | 目录/Glob/递归 grep（跳过 .git/node_modules/二进制/>4MB） |
| `file_info` / `diagnostics` | 文件元信息 / VS Code 诊断 |
| `json_query` | jq 优先，缺失回退 Python |
| `watch_log` / `unwatch` | 日志文件监控，关键字命中推送 `log_alert` |
| `transfer_notify` | 大文件传输进度条（start/progress/done） |
| `clipboard_get` / `clipboard_set` | PC 剪贴板文本读写 |

## 路径解析

`resolvePath` 优先级：
1. `/c/...` → `C:\...`（Git Bash 盘符写法）
2. `/tmp`、`/home` 等非盘符 Unix 绝对路径 → 经 `cygpath -w` 翻译（`/tmp` → `%TEMP%`，其余 → Git 根）
3. Windows 绝对路径 → 直接用
4. 相对路径 → 按 `workspaceFolders` 顺序找，命中则用；否则落首个工作区

## 日志监控 (`watch_log`)

- `vscode.workspace.createFileSystemWatcher` + 2s stat 兜底。
- 从订阅时 EOF 开始，只处理新增；关键字不区分大小写。
- 单次 ≤4MB、≤20 行、每行 ≤500 字符；经 WS 主动推 `log_alert`。
- 文件截断/轮转（size < pos）自动从头开始。
- 订阅驻留内存，Reload 后不恢复。

## 大文件传输（配套脚本，不在插件内）

- `muse-fetch-big`（PC→VM）、`muse-send-big`（VM→PC）：经 GitHub draft release 中转，数据面绕过 VPS。
- >100MB 自动 7z 分卷；PC 下载 8 线程 Range 并发；sha256 校验；传完删 asset。
- 详见 `~/workspace/muse-bridge/BIG_FILE_TRANSFER.md`。

## 配置项

| Key | 默认 | 说明 |
|---|---|---|
| `museBridge.enabled` | false | 启用 Bridge |
| `museBridge.vpsHost` | "" | VPS 地址（必填） |
| `museBridge.poolSize` | 4 | 基线 shell 数 |
| `museBridge.poolMax` | 8 | burst 上限 |
| `museBridge.burstIdleSeconds` | 60 | burst 回收秒数 |
| `museBridge.readOnly` | false | 只读模式 |

## 安全说明

- 不做免杀/混淆/进程伪装；命令在 VS Code 输出面板可见。
- Token 存 SecretStorage，不落盘明文。
- 敏感操作（`deny` 命中）弹窗确认。
- 非公网 IP（`169.254/16`、`0/8`）本地 403，防 SSRF。
