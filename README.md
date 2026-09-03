# HTTP AI 插件代理 (HTTP AI Plugin Proxy)

> **专为 VS Code 生态内 Claude Code、Cline、Continue、Codex、GitHub Copilot 等 AI 编程助手打造的高性能、硬件级加速代理网桥。**

本插件会在本地启动一个高性能的 HTTP/HTTPS 正向代理网关监听（默认 `127.0.0.1:18889`），并自动把本地流量转化为经过高强度 TLS 加密的专用通道，直连你的远程代理服务器。同时自动配置 VS Code 代理环境与终端环境变量，开箱即用。

---

## 🌟 核心特性与硬核性能调优

### 1. 动态硬件自适应压榨（满血发挥 PC 性能）
* **自动嗅探硬件规格**：启动时自动感应当前电脑的 CPU 型号、物理核心数与物理内存大小；
* **满载线程池调度**：在 Intel Core Ultra 7 265 等多核处理器上自动激活饱和并发线程调度（`UV_THREADPOOL_SIZE = 核心数`），充分发挥 Intel AES-NI 硬件加解密加速指令集；
* **支持灵活调参**：性能默认拉满，同时可在 VS Code 设置中自由调节并发线程与连接池大小，未来共享给不同配置的电脑也能完美自适应。

### 2. 0ms 内存级 FastDnsCache 引擎
* 内置基于 LRU + TTL（300秒）的内存 DNS 解析引擎；
* 对国内开发源及直连目标做本地缓存，彻底消除系统 `getaddrinfo` 产生的 20ms~80ms 阻塞等待，直连握手耗时降至 0.01ms。

### 3. 弹性自适应预热连接池（0ms 握手直出）
* 自动在后台维护就绪的 TLS 认证长连接；
* 当你的 AI 扩展发出对话请求时，**直接抓取预热连接，无需等待 400ms+ 的 TCP + TLS 跨国握手**，让 AI 首字输出极速响应。

### 4. AI 专属流式传输优化（AI Stream Optimization）
* **3 秒激进心跳保活**：精准识别 Claude、GPT、Gemini、DeepSeek 等 AI 端点，针对长耗时深度思考模型（如 Claude 3.7 Thinking、o1、o3-mini）自动注入 3 秒级 TCP Keep-Alive，防止 NAT 网关和路由器在长时间思考停顿时切断连接；
* **256KB 零拷贝高速流管道**：流控缓冲区直接对齐 L3 缓存与网络 BDP，打字机实时推流（SSE）零卡顿、零堆积。

### 5. 0 感知静默断线自愈（Auto-Healing）
* 在与上游网关握手阶段，若遭遇跨国网络丢包、抖动或预热连接空闲断开，自愈状态机将在 150ms 内自动丢弃并透明切入新连接重试（最多 3 次），**彻底消除 502 Bad Gateway / Connection Reset 报错**。

### 6. 企业级安全与隐私保护
* **系统凭据库存储**：密码可安全存储于 Windows 凭据管理器（SecretStorage），避免明文密码散落；
* **DNS 重绑定防御**：`/health` 监控接口强制进行本地回环与合法 Host 校验；
* **全流程脱敏**：状态栏与日志输出自动遮蔽敏感 IP 与用户信息。

---

## 🏗️ 模块化分层解耦架构

项目完全遵循单一职责原则（SRP）分层解耦，每个代码文件控制在 40 ~ 290 行，极低耦合且大幅节省 AI Token 消耗：

```text
http-ai-plugin-proxy/
├── src/
│   ├── proxy-server.js           # [兼容门面] 仅 30 行，对外提供标准 API，保障外部脚本 100% 兼容
│   ├── extension.js              # [VS Code 入口] 专注插件生命周期挂载与多窗口故障转移 (~290 行)
│   │
│   ├── core/                     # 【核心传输与调度层】
│   │   ├── server.js             # 代理服务器骨干编排类 (~290 行)
│   │   ├── warm-pool.js          # TLS 弹性预热连接池管理器 (~130 行)
│   │   ├── tunnel-bridge.js      # 双向流式转发高速管道 (256KB 缓冲 / SSE 优化) (~50 行)
│   │   └── failover.js           # 0 感知断线自愈与透明重试状态机 (~120 行)
│   │
│   ├── network/                  # 【网络与规则引擎层】
│   │   ├── dns-cache.js          # 内存级 FastDnsCache 引擎 (~60 行)
│   │   ├── domain-matcher.js     # AI 识别、国内镜像直连与自定义规则嗅探 (~90 行)
│   │   └── hardware.js           # 硬件动态探测引擎 (~40 行)
│   │
│   ├── vscode/                   # 【VS Code 交互层】
│   │   ├── status-bar.js         # 状态栏管理器 (实时 RTT 脉冲、性能大卡片) (~100 行)
│   │   ├── settings.js           # VS Code 配置读取与代理环境自动注入 (~140 行)
│   │   ├── secrets.js            # Windows 凭据管理器存储 (~80 行)
│   │   ├── commands.js           # 诊断测试、HTML 报告大屏、Windows 环境变量设置 (~230 行)
│   │   └── updater.js            # 双模自动更新管理器 (GitHub Releases / 私有 VPS) (~190 行)
│   │
│   └── utils/                    # 【通用基础工具层】
│       └── mask.js               # 敏感 IP / 用户名脱敏工具 (~20 行)
```

---

## 🚀 快速上手与使用指南

### 1. 安装插件
编译产物 `.vsix` 文件位于项目根目录：
* 路径：`http-ai-plugin-proxy-1.0.0.vsix`
* 安装方式：
  * **方式 A（界面安装）**：在 VS Code 扩展面板（`Ctrl+Shift+X`）点击右上角 `···` ➡️ 选择 **“从 VSIX 安装...”**，选中该文件；
  * **方式 B（命令行安装）**：
    ```bash
    code --install-extension http-ai-plugin-proxy-1.0.0.vsix --force
    ```

### 2. 状态栏指示灯
安装并激活后，右下角状态栏会显示运行状态：
* **`$(pulse) AI 代理: 18889 [⚡ 160ms]`**：表示已正常连接，绿色脉冲代表服务健康，中括号内为网关物理 RTT；
* **悬浮卡片（Hover Tooltip）**：将鼠标悬停在图标上，可即时查看当前占用的 CPU 核心数、弹性就绪连接数、DNS 缓存条数与自愈次数。

### 3. 一键控制面板
点击右下角状态栏图标（或按 `Ctrl+Shift+P` 输入 `HTTP AI 代理: 控制菜单`），即可唤出快捷功能菜单：
* **开启 / 关闭代理**：一键切换代理服务；
* **运行网络连通性与延迟诊断**：并行测试各大 AI 接口连通性并弹出图形化报告；
* **检查最新版本更新**：即时探测是否有新版本发布；
* **将密码安全迁移至系统凭据库**：一键抹除配置文件明文密码；
* **写入 / 清除 Windows 用户级全局环境变量**：让新开的外部 CMD / PowerShell 终端也能直接走代理；
* **打开扩展设置**：进入 VS Code 图形化设置面板。

---

## ⚙️ 配置文件说明 (`deployment.local.json`)

插件会自动在当前工程目录或用户主目录搜索配置文件（也可在设置中通过 `httpAiProxy.configPath` 自定义指定）：

```json
{
  "host": "你的远程服务器IP或域名",
  "port": 443,
  "username": "你的用户名",
  "password": "你的连接密码",
  "update": {
    "source": "https://github.com/你的用户名/你的仓库名"
  }
}
```

> **安全提示**：建议在控制菜单中使用【迁移并安全存储凭证至系统凭据库】功能，插件会将密码移入 Windows Credential Manager，随后你可以直接把 JSON 中的 `"password"` 字段删掉！

---

## 🔄 双模自动更新详解

插件自带全自动版本检测与后台静默升级系统，支持 **GitHub 模式** 与 **私有 VPS 模式**。

### 1. 配置更新源地址
按 `Ctrl + ,` 打开 VS Code 设置，搜索 **`httpAiProxy.updateSource`**（或者在控制菜单点击【检查最新版本更新】直接在弹窗中粘贴）：

| 模式 | 配置格式示例 | 说明 |
| :--- | :--- | :--- |
| **GitHub Releases**（推荐） | `https://github.com/用户名/仓库名` 或 `用户名/仓库名` | 全自动对接 GitHub 官方 Releases 接口 |
| **私有服务器** | `http://你的VPS公网IP/version.json` | 适合不想把插件公开到 GitHub 的私有化部署 |

---

### 2. 自动更新的工作原理

#### 它是怎么知道有新版本的？（版本比对机制）
1. **本地版本感知**：插件启动时读取当前 `package.json` 中的 `"version": "1.0.0"`；
2. **云端版本获取**：
   * **GitHub 模式**：插件请求 GitHub API，获取你发布的最新 Release 的 **Tag 标签名**（例如 `v1.0.1`）；
   * **VPS 模式**：插件请求 `version.json`，获取里面的 `"version": "1.0.1"`；
3. **语义化数字比较**：
   $$\text{云端版本 (1.0.1)} > \text{本地版本 (1.0.0)}$$
   只要云端数字大于本地，插件便立刻弹出更新通知。

#### 它是怎么找到 `.vsix` 文件并安装的？
* 插件会自动扫描 Release 里的所有文件，**精准抓取以 `.vsix` 结尾的安装包附件**；
* 通过本地高速代理通道将其下载到系统的临时目录（`os.tmpdir()`）；
* 调用 VS Code 原生安装通道在后台静默安装并清理临时文件；
* 弹窗提示【🎉 更新成功，点击立即重载】。

---

### 3. 你以后如何发布新版本？（极简两步）

当你对插件代码做了改动并希望自己或别人自动更新时：

* **第一步：修改版本号并打包**
  1. 打开 `package.json`，把 `"version": "1.0.0"` 改为 `"1.0.1"`；
  2. 运行打包命令：
     ```bash
     npx @vscode/vsce package --allow-missing-repository --out http-ai-plugin-proxy-1.0.1.vsix
     ```
* **第二步：上传发布**
  * **GitHub 模式**：在 GitHub 仓库网页端点击 **Releases** ➡️ **Draft a new release**，标签（Tag）填 `v1.0.1`，把打包好的 `http-ai-plugin-proxy-1.0.1.vsix` 拖拽上传并发布；
  * **私有 VPS 模式**：把 `.vsix` 传到 VPS，并把 `version.json` 里的版本号改成 `1.0.1`。

> 只要发布完成，所有安装了该插件的 VS Code 下次启动时（或手动点检查更新）就会自动收到弹窗并一键静默升级！

---

## 💻 独立命令行模式 (CLI)

如果你在不打开 VS Code 时也需要使用此代理，可以在终端直接运行：

* **Windows 一键启动批处理**：
  ```cmd
  start-proxy.bat
  ```
* **PowerShell 启动脚本**：
  ```powershell
  .\start-proxy.ps1
  ```
* **网络连通性诊断**：
  ```bash
  node test-connection.js
  ```
