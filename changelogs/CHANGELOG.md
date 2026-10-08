# Changelog (版本更新历史)

All notable changes to the "http-ai-plugin-proxy" extension will be documented in this file.

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
