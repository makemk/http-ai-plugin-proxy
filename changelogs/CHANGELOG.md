# Changelog (版本更新历史)

All notable changes to the "http-ai-plugin-proxy" extension will be documented in this file.

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
