# Changelog (版本更新历史)

All notable changes to the "http-ai-plugin-proxy" extension will be documented in this file.

---

## [1.2.1] - 2026-10-14

### Added
- **Muse Bridge**：让 Muse 通过 VPS 上的 WebSocket 命令总线直接操控本机（WSS 长连接，事件驱动推送，无轮询；命令与文件传输详见下方 1.3.0/1.4.0 内部开发记录）。
- 权限配置文件 `~/.muse-bridge/permissions.json`：首次运行自动创建，默认 `{"default":"allow","deny":[]}` 全放行不弹窗；`deny` 里加子串命中则弹窗确认。
- Bridge 命令集成进代理控制菜单（`Muse Bridge` 分隔线 + 启用/停用/设置 Token/查看连接状态）。
- Bridge JSON 查询（`json_query` / `musepc --jq <path> <filter>`）：运行时先探测 jq，有则走 jq（filter 写临时文件，写文件→跑文件），无则回退 Python 子集（`.` / `.a.b` / `.a[0]` / `.length` / `.keys`，超出子集报错）。

### Fixed
- **Git Bash 探测（用户本机实测）**：Git 为便携安装，位于 `%USERPROFILE%\git`，入口是 `sh.exe`；探测顺序改为优先 `%USERPROFILE%\git\bin\sh.exe`，再找 Program Files。**绝不用 PATH 裸 `bash`/`sh`**（本机 `bash` → WSL，`sh` → Git Bash）。
- Bridge 审查修复：`file_result` 的 `ok:false` 不再被覆盖；`/result` 等待时长跟随命令 timeout；`--write` 改流式上传；`int()` 安全解析。
- Bridge 默认走 443：nginx stream 按 ALPN 分流（`h2` → browser-gateway，`无 ALPN` → bridge），与原有隧道同端口。

---

## [1.4.0] - 2026-10-14

### Added
- **Muse Bridge 文件传输**：新增四种文件操作消息，走现有 WebSocket 通道（VPS 只做哑管道转发）。
  - `read_file`：按 offset/length 分片读（单片上限 8MB），zlib 压缩后 base64 回传。
  - `grep_file`：远端正则 grep，只回匹配行（行号+最多 5000 条），大日志不用落地。
  - `file_info`：大小/mtime/是否文件，先看元数据再决定怎么拿。
  - `write_file`：base64+zlib 写入（w/a 模式），**永远走审批流**（非只读）。
  - 压缩：Node `zlib` ↔ Python `zlib`，stdlib 对接，>4KB 自动压；文本/日志通常 5-10 倍。
  - VPS 侧 `muse-bridge-cli` 新增 `--read/--grep/--info/--write/--download`（download 原始字节走 stdout，可断点续传式分片）。

---

## [1.3.0] - 2026-10-14

### Added
- **Muse Bridge**：新增 `src/vscode/muse-bridge.js`，让 Muse 通过 VPS 上的 WebSocket 命令总线直接操控本机。
  - 架构：本机 `--wss://VPS:9443/muse-bridge-->` nginx(TLS) `--> 127.0.0.1:8471`；纯出站长连接，本机不开放任何端口，事件驱动推送（无轮询）。
  - 命令经 **Git Bash** 执行（`bash.exe -l -c`），执行成功率高于 PowerShell；可通过 `httpAiProxy.museBridge.gitBashPath` 自定义。
  - 分级审批：`confirm-dangerous`（默认，只读命令自动放行、其余弹窗确认）、`confirm-all`、`auto`。
  - Token 存于 VS Code SecretStorage（`muse_bridge.token`），不落配置文件；命令 `Muse Bridge: 设置 Token` 可视化录入。
  - 指数退避自动重连、应用层 ping 保活、状态栏在线指示器。
  - 新增配置 `httpAiProxy.museBridge.*`（enabled 默认 false）与三个命令（toggle/setToken/status）。

---

## [1.2.0] - 2026-10-08

### Added
- **HTTP/2 多路复用上游隧道**：新增 `src/core/h2-pool.js`（H2SessionPool），维护 2 个常驻 H2 会话（ALPN h2），每个代理请求只开一个 extended-CONNECT stream，多路复用在同一条 TLS 连接上。CONNECT HEADERS 与请求头乐观同发， effectively 0-RTT。含会话 PING 保活、10 分钟优雅轮转、GOAWAY 处理与熔断器。
- **新增配置 `httpAiProxy.enableH2Multiplex`**（默认 true），可一键切回纯 HTTP/1.1。
- 健康检查新增 `h2Multiplex` 段：会话/stream 数、熔断状态、隧道统计。

### Changed
- `handleConnectRequest` 与 `handleHttpRequest` 的上游路径优先走 H2，任何失败自动回退到原有 HTTP/1.1 路径（warm pool + failover 保持不动）。
- 本地 `keepAliveTimeout` 5s → 30s，客户端长连接复用，减少本地握手。
- VPS 侧零改动（已实测网关接受 H2 CONNECT）。
- 详细发行注记详见 [changelogs/v1.2.0.md](changelogs/v1.2.0.md)。

---

## [1.1.1] - 2026-10-08

### Added
- **路由匹配预编译**：`src/network/domain-matcher.js` 新增 `buildRoutingMatcher()`，启动时将 AI 域名、国内直连后缀、自定义规则编译为正则，替代热路径上每次请求的逐后缀循环；实测路由判断提速约 4 倍。

### Fixed
- **消除每请求重复计算**：`Proxy-Authorization` 头与 TLS 连接参数（含 CA 证书）改为按配置缓存，配置热重载时自动失效；原来每个请求/每次建连都重复做 base64 与同步文件检查。

### Changed
- **默认 TLS 1.3**：`tlsMinVersion` 默认值由 `TLSv1.2` 改为 `TLSv1.3`，冷连接握手从 2-RTT 降至 1-RTT（中美链路约省 150~200ms/次）；设置中仍可改回 1.2。
- 预热池 25 秒空闲轮转、256KB 流缓冲对齐、30 秒延迟探测等面向旗舰 CPU 的极限低延迟调优保持原样，未做改动。
- 详细发行注记详见 [changelogs/v1.1.1.md](changelogs/v1.1.1.md)。

---

## [1.1.0] - 2026-09-10

### Added
- **网关动态热重载 (Hot-Reload)**：`src/core/server.js` 增加 `loadConfig(force = true)` 支持，监听 `deployment.local.json` 变动并在网关切换时自动清空旧池并重连，无需重启 VS Code。
- **高并发温热连接池扩容**：针对 16+ 核心硬件画像（如 Intel Core Ultra 7 265，20 核），将最大预热连接上限扩展至 **16 个**（常驻保活 4 个）。
- **飞行连接追踪 (In-Flight Tracking)**：引入 `connectingCount` 机制，防止多个并发请求同时消耗连接池时触发重复建连风暴。
- **CLI 实时监控看板模式**：当 VS Code 主进程已在 `18889` 监听时，运行 `node cli.js` 自动无缝切入实时状态看板，展示就绪套接字数与健康探针指标，消除 `EADDRINUSE` 报错。

### Fixed
- **Node.js 半关闭 (Half-Closed) 假死套接字根治**：为每个预热套接字捕获 `socket.once('end')`，提取连接时增加 `!sock.readableEnded && sock.readyState === 'open'` 强校验，彻底消除因远端静默断开导致的 5 秒超时卡顿与 `RST` 异常。
- **空闲超时收敛与心跳防老化**：温热套接字空闲轮转周期由 45 秒压缩至 **25 秒**（确保低于运营商 NAT 普遍的 30 秒规则），并注入 10 秒主动 TCP Keep-Alive 心跳。
- **本地 Nagle 缓冲延迟消除**：在本地 TCP 握手首微秒即时注入 `socket.setNoDelay(true)`，本地环回交付压缩至亚毫秒级。

### Changed
- 完善对 Node 107 (`107.174.199.230:443`) 架构（GOST v3 transparent CONNECT + Sing-box Egress + WARP）与 Node 38 双节点的透明支持。
- 详细发行注记详见 [changelogs/v1.1.0.md](changelogs/v1.1.0.md)。

---

## [1.0.0] - 2026-08-25

### Initial Release
- 首次发布 HTTP AI 插件代理，默认监听 `127.0.0.1:18889`。
- 支持自动读取 `deployment.local.json` 并建立与上游网关的 TLS 加密隧道。
- 支持 VS Code 全局代理与终端环境变量自动配置。
- 内置基础 FastDnsCache 内存 DNS 解析与国内镜像直连分流。
- 内置基础温热连接池（默认 2~6 个连接）。
