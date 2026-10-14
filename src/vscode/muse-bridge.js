/**
 * Muse Bridge — 让 Muse 通过 VPS 上的 WebSocket 命令总线直接操控本机。
 *
 * 架构: 本机 --wss--> VPS nginx :9443/muse-bridge --> 127.0.0.1:8471 (muse-bridge.py)
 *   - 纯出站长连接,本机不开放任何端口
 *   - 命令经 Git Bash 执行(用户要求:执行成功率高于 PowerShell)
 *   - 分级审批:只读命令自动放行,危险命令弹窗确认
 *   - token 存于 VS Code SecretStorage,不落配置文件
 */
const vscode = require('vscode');
const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const zlib = require('zlib');
const WebSocket = require('ws');

// 自定义证书名校验: 修复 Node 在某些版本上校验 IP SAN 证书的坑
// (默认校验对 IP 证书会误报 "Cert does not contain a DNS name")。
// 只放行 IP 与证书 IP SAN 匹配的情况; 链信任仍由 Node 单独验证, 不弱化安全。
// IP 不匹配时回落默认校验, 由默认校验给出正确报错。
function checkServerIdentityIP(host, cert) {
  if (net.isIP(host)) {
    const san = cert.subjectaltname || '';
    const ips = [...san.matchAll(/IP Address:([^,]+)/g)].map((m) => m[1].trim());
    if (ips.includes(host)) return undefined; // 接受
  }
  return tls.checkServerIdentity(host, cert);
}

const SECRET_KEY = 'muse_bridge.token';
const DEFAULT_HOST = '38.207.167.51'; // 443: 与 browser-gateway 同端口,经 nginx ALPN 分流

// Git Bash 候选 (按用户本机 AGENTS.md §1):
// - 绝不要用 PATH 上的裸 bash/sh: 本机 bash -> WSL (C:\windows\system32\bash.exe), sh -> Git Bash
// - 用户本机 Git 是便携安装, 在 %USERPROFILE%\git, 入口是 sh.exe
// - 统一用绝对路径 + existsSync 探测, 避免 WSL 陷阱
function gitBashCandidates() {
  const userProfile = process.env.USERPROFILE || require('os').homedir();
  return [
    path.join(userProfile, 'git', 'bin', 'sh.exe'),   // 便携安装 (用户本机, AGENTS.md §1.1)
    path.join(userProfile, 'git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\sh.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\sh.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
}

// 只读命令:自动放行(大小写不敏感,允许前导空白)
const READONLY_RE = /^\s*(echo|ls|dir|cat|type|pwd|cd|whoami|hostname|uname|df|du|ps|find|grep|head|tail|wc|sort|uniq|git\s+(status|log|diff|branch|remote)|node\s+--version|python3?\s+--version|where|which)\b/i;
// 危险模式:即使在 confirm-dangerous 下也强制弹窗(双重保险)
const DANGEROUS_RE = /\b(rm\s+-rf?\s+\/|del\s+\/[fsq]\s+[a-z]:\\|format\s+[a-z]:|mkfs|shutdown(\.exe)?\s+\/|reboot|reg\s+delete|rd\s+\/s\s+[a-z]:\\)/i;

const MAX_OUTPUT = 256 * 1024;
const POOL_SIZE = 4; // 基线常驻 shell 数
const POOL_MAX = 8; // 紧急扩容上限
const BURST_IDLE_MS = 60000; // burst shell 空闲 60s 后回收
const MAX_BG_BUFFER = 1024 * 1024; // 后台命令单流输出上限
const MAX_BG_JOBS = 30; // 后台任务保留上限
const MAX_GREP_FILE = 4 * 1024 * 1024; // grep 单文件上限, 超过跳过
const MAX_DIAGNOSTICS = 500; // 诊断返回上限

// shell 单引号转义: ' -> '\''
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Windows 路径 -> Git Bash POSIX 路径: C:\Users\x -> /c/Users/x
function toPosix(p) {
  const m = /^([A-Za-z]):[\\/]/.exec(p);
  if (m) return '/' + m[1].toLowerCase() + p.slice(2).replace(/\\/g, '/');
  return String(p).replace(/\\/g, '/');
}

// Python 回退脚本: 仅支持 jq 子集 (. / .a.b / .a[0] / .length / .keys)
// 超出子集时报错 (请装 jq)。filter 经 argv 传入, 不拼进 shell, 无注入。
const PY_JQ_FALLBACK = `
import json, sys

def fail(m):
    print("python fallback 不支持该 filter: " + m + " (请安装 jq)", file=sys.stderr)
    sys.exit(2)

with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
filt = sys.argv[2].strip()
if filt == ".":
    print(json.dumps(data, ensure_ascii=False))
    sys.exit(0)
# 纯字符串解析 (不用正则, 避免模板字符串转义坑): .field / [n] / .length / .keys
tokens = []
i = 0
n = len(filt)
while i < n:
    c = filt[i]
    if c == ".":
        j = i + 1
        while j < n and (filt[j].isalnum() or filt[j] == "_"):
            j += 1
        if j == i + 1:
            fail(filt)
        tokens.append(("field", filt[i + 1:j]))
        i = j
    elif c == "[":
        j = filt.find("]", i)
        if j < 0:
            fail(filt)
        num = filt[i + 1:j]
        if not num.isdigit():
            fail(filt)
        tokens.append(("index", int(num)))
        i = j + 1
    else:
        fail(filt)
cur = data
for kind, val in tokens:
    if kind == "field":
        if val == "length":
            cur = len(cur)
        elif val == "keys":
            if not isinstance(cur, dict):
                fail("keys 用于非对象")
            cur = sorted(cur.keys())
        else:
            if not isinstance(cur, dict) or val not in cur:
                fail("缺字段 " + val)
            cur = cur[val]
    else:
        if not isinstance(cur, list) or val >= len(cur):
            fail("下标越界 " + str(val))
        cur = cur[val]
print(cur if not isinstance(cur, (dict, list)) else json.dumps(cur, ensure_ascii=False))
`;

class MuseBridge {
  constructor(context, outputChannel) {
    this.context = context;
    this.out = outputChannel;
    this.ws = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 2000;
    this.stopping = false;
    this._bgJobs = new Map();
    this._bgSeq = 0;
    this._watches = new Map(); // watch_id -> { watcher, path, keywords, pos }
    this._watchSeq = 0;
    this._shellPool = null; // 懒创建: 首个命令时建池
    this._shellQueue = [];
    this._poolSeq = 0;

    // 池参数变更时重建池子 (下次命令懒创建, 用新参数)
    this._configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('httpAiProxy.museBridge.poolSize') ||
          e.affectsConfiguration('httpAiProxy.museBridge.poolMax') ||
          e.affectsConfiguration('httpAiProxy.museBridge.burstIdleSeconds')) {
        this.log('池参数变更, 重建 shell 池');
        this._destroyPool();
      }
    });
    context.subscriptions.push(this._configWatcher);
  }

  log(msg) {
    this.out.appendLine(`[MuseBridge] ${msg}`);
  }

  // 状态栏已移除 (用户看代理面板)。保留方法以免改所有调用处。
  setStatus(s, detail = '') {}

  getConfig() {
    const cfg = vscode.workspace.getConfiguration('httpAiProxy');
    return {
      enabled: cfg.get('museBridge.enabled', false),
      approvalMode: cfg.get('museBridge.approvalMode', 'confirm-dangerous'),
      gitBashPath: cfg.get('museBridge.gitBashPath', ''),
      vpsHost: cfg.get('museBridge.vpsHost', DEFAULT_HOST),
      permissionsPath: cfg.get('museBridge.permissionsPath', ''),
      readOnly: cfg.get('museBridge.readOnly', false),
      poolSize: cfg.get('museBridge.poolSize', POOL_SIZE),
      poolMax: cfg.get('museBridge.poolMax', POOL_MAX),
      burstIdleSeconds: cfg.get('museBridge.burstIdleSeconds', BURST_IDLE_MS / 1000),
    };
  }

  poolTuning() {
    const c = this.getConfig();
    const size = Math.max(1, Math.min(16, Math.floor(c.poolSize) || POOL_SIZE));
    const max = Math.max(size, Math.min(32, Math.floor(c.poolMax) || POOL_MAX));
    const idleMs = Math.max(10000, Math.min(600000, Math.floor(c.burstIdleSeconds * 1000) || BURST_IDLE_MS));
    return { size, max, idleMs };
  }

  // ---- 权限配置文件: ~/.muse-bridge/permissions.json ----
  // { "default": "allow", "deny": [] }  -> 全部放行,不弹窗
  // deny 里加子串(不区分大小写),命中则走弹窗确认; default 改为 "deny" 则退回 approvalMode 逻辑
  permissionsPath() {
    const cfg = this.getConfig();
    if (cfg.permissionsPath) return cfg.permissionsPath;
    return require('path').join(require('os').homedir(), '.muse-bridge', 'permissions.json');
  }

  ensurePermissionsFile() {
    const p = this.permissionsPath();
    if (fs.existsSync(p)) return;
    try {
      fs.mkdirSync(require('path').dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({
        _comment: 'default=allow: 全部放行不弹窗; deny 加子串(不区分大小写),命中则弹窗确认; default=deny 则退回 approvalMode',
        default: 'allow',
        deny: [],
      }, null, 2));
      this.log(`已创建权限配置: ${p}`);
    } catch (e) {
      this.log(`创建权限配置失败: ${e.message}`);
    }
  }

  loadPermissions() {
    try {
      const p = this.permissionsPath();
      const mtime = fs.statSync(p).mtimeMs;
      if (this._permCache && this._permCache.mtime === mtime) return this._permCache.data;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      this._permCache = { mtime, data };
      return data;
    } catch (_) {
      return null;
    }
  }

  checkPermissionFile(display) {
    // true=静默放行, false=走 legacy approvalMode 流程
    const perm = this.loadPermissions();
    if (!perm || perm.default !== 'allow') return false;
    const deny = Array.isArray(perm.deny) ? perm.deny : [];
    const low = String(display).toLowerCase();
    for (const pat of deny) {
      if (pat && low.includes(String(pat).toLowerCase())) return false;
    }
    return true;
  }

  resolveBash() {
    const cfg = this.getConfig();
    if (cfg.gitBashPath && fs.existsSync(cfg.gitBashPath)) return cfg.gitBashPath;
    for (const p of gitBashCandidates()) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  async getToken() {
    return (await this.context.secrets.get(SECRET_KEY)) || '';
  }

  async start() {
    this.stopping = false;
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      this.setStatus('off');
      return;
    }
    const token = await this.getToken();
    if (!token) {
      this.setStatus('error', '未设置 token');
      this.log('Bridge 已启用但未设置 token,请执行命令 "Muse Bridge: 设置 Token"。');
      vscode.window.showInformationMessage(
        'Muse Bridge 已启用,但还未设置 Token。',
        '设置 Token'
      ).then((sel) => {
        if (sel === '设置 Token') vscode.commands.executeCommand('museBridge.setToken');
      });
      return;
    }
    const bash = this.resolveBash();
    if (!bash) {
      this.setStatus('error', '未找到 Git Bash');
      this.log('未找到 Git Bash,请安装 Git for Windows 或在设置中指定 httpAiProxy.museBridge.gitBashPath。');
      vscode.window.showErrorMessage('Muse Bridge: 未找到 Git Bash,请先安装 Git for Windows。');
      return;
    }
    this.log(`使用 shell: ${bash}`);
    this.ensurePermissionsFile();
    this.connect(token, cfg);
  }

  stop() {
    this.stopping = true;
    this._destroyPool();
    for (const [wid, w] of this._watches) {
      try { w.watcher.dispose(); } catch (_) {}
      try { clearInterval(w.interval); } catch (_) {}
    }
    this._watches.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.reconnectDelay = 2000;
    this.setStatus('off');
    this.log('Bridge 已停止。');
  }

  async restart() {
    this.stop();
    this.stopping = false;
    await this.start();
  }

  connect(token, cfg) {
    if (this.stopping) return;
    this.setStatus('connecting');
    const url = `wss://${cfg.vpsHost}/muse-bridge`;
    this.log(`正在连接 ${url} ...`);
    let ws;
    try {
      // ws 库会对 IP 主机把 servername 置空, 导致 Node 按 DNS 名校验 IP 证书而失败
      // ("Cert does not contain a DNS name")。显式传入 servername, 让校验拿到真实 host。
      let servername;
      try { servername = new URL(url).hostname; } catch (_) { servername = undefined; }
      ws = new WebSocket(url, {
        headers: { 'X-Bridge-Token': token },
        handshakeTimeout: 15000,
        ...(servername ? { servername } : {}),
        checkServerIdentity: checkServerIdentityIP,
      });
    } catch (e) {
      this.log(`创建连接失败: ${e.message}`);
      return this.scheduleReconnect(token, cfg);
    }
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelay = 2000;
      this.setStatus('online');
      this.log('Bridge 已上线,等待 Muse 的命令。');
      ws.send(JSON.stringify({
        type: 'hello',
        client: `http-ai-plugin-proxy/${this.context.extension.packageJSON.version}`,
        hostname: require('os').hostname(),
      }));
    });

    ws.on('message', (data) => this.onMessage(data).catch((e) => this.log(`处理消息异常: ${e.message}`)));

    ws.on('close', (code) => {
      if (this.ws === ws) this.ws = null;
      this.setStatus('error', `连接断开 (${code})`);
      this.log(`连接断开 (code=${code}),准备重连...`);
      this.scheduleReconnect(token, cfg);
    });

    ws.on('error', (e) => {
      this.log(`连接错误: ${e.message}`);
    });

    // 应用层 ping 保活(穿过 nginx 长超时)
    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch (_) {}
      } else {
        clearInterval(pingTimer);
      }
    }, 25000);
  }

  scheduleReconnect(token, cfg) {
    if (this.stopping) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(this.reconnectDelay, 60000);
    this.log(`${(delay / 1000).toFixed(0)}s 后重连...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
      this.connect(token, cfg);
    }, delay);
  }

  async onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (!msg.id) return;
    if (msg.type === 'cmd') return this.onCmd(msg);
    if (['read_file', 'grep_file', 'file_info', 'write_file', 'json_query',
      'edit_file', 'multi_edit', 'list_dir', 'glob_files', 'diagnostics'].includes(msg.type)) {
      return this.onFileOp(msg);
    }
    if (msg.type === 'bash_bg') return this.onBgStart(msg);
    if (msg.type === 'bash_output') return this.onBgOutput(msg);
    if (msg.type === 'bash_kill') return this.onBgKill(msg);
    if (msg.type === 'batch') return this.onBatch(msg);
    if (msg.type === 'watch_log') return this.onWatchLog(msg);
    if (msg.type === 'unwatch') return this.onUnwatch(msg);
  }

  // 批量执行: 一次往返跑 N 条命令, 池内并行。合并为一次审批弹窗。
  async onBatch(msg) {
    const raw = Array.isArray(msg.commands) ? msg.commands : [];
    const list = raw.slice(0, 32).map((c) => ({
      command: String(c.command || ''),
      timeout: Math.min(Math.max(parseInt(c.timeout, 10) || 120, 5), 600),
    })).filter((c) => c.command);
    if (list.length === 0) return this.sendFileResult(msg.id, { ok: false, error: 'empty batch' });

    const display = `批量执行 ${list.length} 条命令:\n` +
      list.map((c, i) => `${i + 1}. ${c.command.slice(0, 100)}${c.command.length > 100 ? '...' : ''}`).join('\n');
    const allReadonly = list.every((c) => READONLY_RE.test(c.command));
    const approved = await this.checkApproval(display, allReadonly);
    if (!approved) {
      this.log(`批量命令 [${msg.id}] 被用户拒绝。`);
      return this.sendFileResult(msg.id, { ok: false, error: 'rejected by user' });
    }

    this.log(`批量执行 [${msg.id}]: ${list.length} 条并行`);
    const results = await Promise.all(list.map((c) => this.execute(c.command, c.timeout)));
    return this.sendFileResult(msg.id, { ok: true, results });
  }

  // ---- 日志监控: 订阅文件, 关键字命中时主动推送 ----
  async onWatchLog(msg) {
    const raw = String(msg.path || '');
    const p = this.resolvePath(raw);
    const keywords = Array.isArray(msg.keywords) ? msg.keywords.map(String).filter(Boolean) : [];
    const fs = require('fs');
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return this.sendFileResult(msg.id, { ok: false, error: 'not a file' });
    } catch (_) {
      return this.sendFileResult(msg.id, { ok: false, error: 'file not found' });
    }
    const watchId = `w${Date.now().toString(36)}${(this._watchSeq++).toString(36)}`;
    // 基线: 从文件末尾开始, 只看新增内容
    let pos = 0;
    try { pos = fs.statSync(p).size; } catch (_) {}
    const lowerKeywords = keywords.map((k) => k.toLowerCase());
    const checkNew = () => {
      let size = 0;
      try { size = fs.statSync(p).size; } catch (_) { return; }
      if (size < pos) pos = 0; // 文件被截断/轮转, 从头开始
      if (size === pos) return;
      let data = '';
      try {
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(Math.min(size - pos, 4 * 1024 * 1024));
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        data = buf.toString('utf8');
      } catch (_) { return; }
      pos = size;
      const lines = data.split('\n');
      const matches = [];
      for (const line of lines) {
        const ll = line.toLowerCase();
        for (const kw of lowerKeywords) {
          if (kw && ll.includes(kw)) { matches.push(line.slice(0, 500)); break; }
        }
      }
      if (matches.length > 0 && this.ws && this.ws.readyState === 1) {
        try {
          this.ws.send(JSON.stringify({ type: 'log_alert', watch_id: watchId, path: p, matches: matches.slice(0, 20) }));
        } catch (_) {}
      }
    };
    // VS Code 文件监听 + 定时兜底 (网络文件系统可能不触发)
    const watcher = vscode.workspace.createFileSystemWatcher(p);
    const onChange = () => checkNew();
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    const interval = setInterval(checkNew, 2000);
    this._watches.set(watchId, { watcher, interval, path: p });
    this.log(`日志监控启动 [${watchId}]: ${p}, 关键字: ${keywords.join(',') || '(无)'}`);
    return this.sendFileResult(msg.id, { ok: true, watch_id: watchId, path: p });
  }

  async onUnwatch(msg) {
    const watchId = String(msg.watch_id || '');
    const w = this._watches.get(watchId);
    if (!w) return this.sendFileResult(msg.id, { ok: false, error: 'unknown watch_id' });
    try { w.watcher.dispose(); } catch (_) {}
    try { clearInterval(w.interval); } catch (_) {}
    this._watches.delete(watchId);
    this.log(`日志监控停止 [${watchId}]`);
    return this.sendFileResult(msg.id, { ok: true });
  }

  async onCmd(msg) {
    const command = String(msg.command || '');
    const timeout = Math.min(Math.max(parseInt(msg.timeout, 10) || 120, 5), 600);
    this.log(`收到命令 [${msg.id}]: ${command.slice(0, 120)}${command.length > 120 ? '...' : ''}`);

    const approved = await this.checkApproval(command, READONLY_RE.test(command));
    if (!approved) {
      this.log(`命令 [${msg.id}] 被用户拒绝。`);
      return this.sendResult(msg.id, -1, '', 'rejected by user');
    }
    const res = await this.execute(command, timeout);
    this.log(`命令 [${msg.id}] 执行完毕,exit=${res.exit}`);
    this.sendResult(msg.id, res.exit, res.stdout, res.stderr);
  }

  // ---- 后台命令 (Claude Code BashOutput/KillBash 式): 启动后轮询输出, 可杀 ----
  async onBgStart(msg) {
    const command = String(msg.command || '');
    const timeout = Math.min(Math.max(parseInt(msg.timeout, 10) || 120, 5), 3600);
    const stream = !!msg.stream;
    if (!command) return this.sendFileResult(msg.id, { ok: false, error: 'empty command' });
    const approved = await this.checkApproval(command, READONLY_RE.test(command));
    if (!approved) {
      this.log(`后台命令 [${msg.id}] 被用户拒绝。`);
      return this.sendFileResult(msg.id, { ok: false, error: 'rejected by user' });
    }
    const bash = this.resolveBash();
    if (!bash) return this.sendFileResult(msg.id, { ok: false, error: 'Git Bash not found' });
    const jobId = `bg${Date.now().toString(36)}${(this._bgSeq++).toString(36)}`;
    const { spawn } = require('child_process');
    const child = spawn(bash, ['-l', '-c', command], { windowsHide: true });
    const job = { child, stdout: '', stderr: '', exit: null };
    this._bgJobs.set(jobId, job);
    if (this._bgJobs.size > MAX_BG_JOBS) { // 清理: 删一个最早已完成的
      for (const [k, v] of this._bgJobs) {
        if (v.exit !== null) { this._bgJobs.delete(k); break; }
      }
    }
    // 流式: 有输出就主动推 bg_chunk (服务端转发给等待的 /bg-stream 客户端)
    const pushChunk = (data) => {
      if (!stream || !this.ws || this.ws.readyState !== 1) return;
      try {
        this.ws.send(JSON.stringify({ type: 'bg_chunk', id: msg.id, job_id: jobId, data: String(data).slice(-65536) }));
      } catch (_) {}
    };
    child.stdout.on('data', (d) => {
      const s = d.toString();
      job.stdout = (job.stdout + s).slice(-MAX_BG_BUFFER);
      pushChunk(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      job.stderr = (job.stderr + s).slice(-MAX_BG_BUFFER);
      pushChunk(s);
    });
    // 必须监听 error: 否则 spawn 失败时未捕获的 error 事件会崩扩展宿主
    child.on('error', (err) => { job.exit = -1; job.stderr += `\n[SPAWN ERROR] ${err.message}`; });
    // exit 在进程退出时触发 (不等 stdio 管道关闭); close 在管道关闭时触发。
    // 只用 close 会漏: 子进程(如 sleep)还占着管道时 close 不触发, 任务永远显示 running。
    // code 为 null 表示被信号杀死, 记为 -1。
    const markDone = (code) => {
      if (job.exit === null) {
        job.exit = code !== null ? code : -1;
        if (stream && this.ws && this.ws.readyState === 1) {
          try {
            this.ws.send(JSON.stringify({ type: 'bg_chunk', id: msg.id, job_id: jobId, done: true, exit: job.exit }));
          } catch (_) {}
        }
      }
    };
    child.on('exit', markDone);
    child.on('close', markDone);
    setTimeout(() => {
      if (job.exit === null) {
        this._killJobTree(job);
        job.stderr += '\n[TIMEOUT] 后台命令超时已被终止';
      }
    }, timeout * 1000);
    this.log(`后台命令启动 [${jobId}]: ${command.slice(0, 120)}`);
    this.sendFileResult(msg.id, { ok: true, job_id: jobId });
  }

  async onBgOutput(msg) {
    const job = this._bgJobs.get(String(msg.job_id || ''));
    if (!job) return this.sendFileResult(msg.id, { ok: false, error: 'unknown job_id' });
    this.sendFileResult(msg.id, {
      ok: true, job_id: String(msg.job_id), running: job.exit === null,
      stdout: job.stdout.slice(-MAX_OUTPUT), stderr: job.stderr.slice(-MAX_OUTPUT), exit: job.exit,
      truncated: job.stdout.length > MAX_OUTPUT || job.stderr.length > MAX_OUTPUT,
    });
  }

  // 杀整棵进程树: child.kill() 只杀 sh.exe, 其子进程(如 sleep)会活着并占住管道。
  // taskkill /T /F 杀掉树上全部进程, 管道随之关闭, close 事件才能触发。
  _killJobTree(job) {
    this._taskkillPid(job.child.pid);
  }

  async onBgKill(msg) {
    const job = this._bgJobs.get(String(msg.job_id || ''));
    if (!job) return this.sendFileResult(msg.id, { ok: false, error: 'unknown job_id' });
    if (job.exit !== null) return this.sendFileResult(msg.id, { ok: true, killed: false, exit: job.exit });
    this._killJobTree(job);
    this.sendFileResult(msg.id, { ok: true, killed: true, exit: job.exit });
  }

  // jq 探测: JSON 处理优先 jq, 无 jq 则回退 Python (用户要求: 先查有没有, 再决定)
  async detectJq() {
    if (this._jqChecked !== undefined) return this._jqAvailable;
    this._jqChecked = true;
    try {
      const res = await this.execute('command -v jq', 10);
      this._jqAvailable = res.exit === 0 && !!res.stdout.trim();
    } catch (_) {
      this._jqAvailable = false;
    }
    this.log(`jq: ${this._jqAvailable ? '可用 (JSON 处理走 jq)' : '不可用 (JSON 处理回退 Python)'}`);
    return this._jqAvailable;
  }

  // JSON 查询: jq 优先 (filter 写临时文件, 写文件->跑文件, 不拼 shell);
  // 无 jq 时回退 Python 子集 (. / .a.b / .a[0] / .length / .keys)。只读, 不弹窗。
  async doJsonQuery(msg) {
    const p = String(msg.path || '');
    const filter = String(msg.filter || '.');
    if (!p) throw new Error('path required');
    const useJq = await this.detectJq();
    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'muse-jq-'));
    try {
      const posixPath = toPosix(p);
      if (useJq) {
        const filterFile = path.join(tmpDir, 'filter.jq');
        fs.writeFileSync(filterFile, filter);
        const res = await this.execute(
          `jq -r -f ${shQuote(toPosix(filterFile))} ${shQuote(posixPath)}`, 120);
        if (res.exit !== 0) {
          throw new Error(`jq failed: ${(res.stderr || res.stdout || '').slice(0, 500)}`);
        }
        return { ok: true, output: res.stdout, via: 'jq' };
      }
      const scriptFile = path.join(tmpDir, 'jq_fallback.py');
      fs.writeFileSync(scriptFile, PY_JQ_FALLBACK);
      const res = await this.execute(
        `python ${shQuote(toPosix(scriptFile))} ${shQuote(posixPath)} ${shQuote(filter)}`, 120);
      if (res.exit !== 0) {
        throw new Error(`python fallback failed: ${(res.stderr || res.stdout || '').slice(0, 500)}`);
      }
      return { ok: true, output: res.stdout, via: 'python' };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // 路径解析 (Claude Code 式): 相对路径优先工作区, 绝对路径直接用。
  // Git Bash 风格 /c/Users/... 转 Windows 盘符; 相对路径按工作区顺序找, 找到存在的就用,
  // 都不存在则落到首个工作区 (写新文件时就是这种情况)。
  resolvePath(p) {
    let s = String(p || '');
    const m = /^\/([a-zA-Z])\/.*/.exec(s);
    if (m) s = `${m[1].toUpperCase()}:\\${s.slice(3).replace(/\//g, '\\')}`;
    if (path.win32.isAbsolute(s)) return s;
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    for (const dir of folders) {
      const cand = path.join(dir, s);
      if (fs.existsSync(cand)) return cand;
    }
    if (folders.length) return path.join(folders[0], s);
    return s;
  }

  async onFileOp(msg) {
    const t = msg.type;
    const raw = String(msg.path || '');
    const p = this.resolvePath(raw);
    msg.path = p; // 统一解析, 各 handler 直接用 msg.path
    this.log(`文件操作 [${msg.id}]: ${t} ${p.slice(0, 100)}${p !== raw ? ` (解析自 ${raw.slice(0, 60)})` : ''}`);
    try {
      if (t === 'read_file') return this.sendFileResult(msg.id, await this.doRead(p, msg));
      if (t === 'grep_file') return this.sendFileResult(msg.id, await this.doGrep(p, msg));
      if (t === 'file_info') return this.sendFileResult(msg.id, await this.doInfo(p));
      if (t === 'json_query') return this.sendFileResult(msg.id, await this.doJsonQuery(msg));
      if (t === 'write_file') {
        // 写文件永远走审批(非只读)
        const ok = await this.checkApproval(`写入文件: ${p}`, false);
        if (!ok) {
          this.log(`写文件 [${msg.id}] 被用户拒绝。`);
          return this.sendFileResult(msg.id, { ok: false, error: 'rejected by user' });
        }
        return this.sendFileResult(msg.id, await this.doWrite(p, msg));
      }
      if (t === 'edit_file') {
        // 精确替换, 与 write_file 同级审批
        const ok = await this.checkApproval(`编辑文件: ${p}`, false);
        if (!ok) {
          this.log(`编辑文件 [${msg.id}] 被用户拒绝。`);
          return this.sendFileResult(msg.id, { ok: false, error: 'rejected by user' });
        }
        return this.sendFileResult(msg.id, await this.doEdit(p, msg));
      }
      if (t === 'multi_edit') {
        const ok = await this.checkApproval(`批量编辑文件: ${p}`, false);
        if (!ok) {
          this.log(`批量编辑 [${msg.id}] 被用户拒绝。`);
          return this.sendFileResult(msg.id, { ok: false, error: 'rejected by user' });
        }
        return this.sendFileResult(msg.id, await this.doMultiEdit(p, msg));
      }
      if (t === 'list_dir') return this.sendFileResult(msg.id, await this.doListDir(p, msg));
      if (t === 'glob_files') return this.sendFileResult(msg.id, await this.doGlob(msg));
      if (t === 'diagnostics') return this.sendFileResult(msg.id, await this.doDiagnostics(msg));
    } catch (e) {
      this.log(`文件操作 [${msg.id}] 异常: ${e.message}`);
      this.sendFileResult(msg.id, { ok: false, error: e.message });
    }
  }

  async doRead(p, msg) {
    const offset = Math.max(parseInt(msg.offset, 10) || 0, 0);
    const length = Math.min(Math.max(parseInt(msg.length, 10) || 1048576, 1), 8 * 1048576);
    const st = await fs.promises.stat(p);
    if (!st.isFile()) throw new Error('not a file');
    const end = Math.min(offset + length, st.size);
    const chunks = [];
    if (end > offset) {
      const stream = fs.createReadStream(p, { start: offset, end: end - 1 });
      for await (const c of stream) chunks.push(c);
    }
    const raw = Buffer.concat(chunks);
    return {
      data: zlib.deflateSync(raw, { level: 6 }).toString('base64'),
      compressed: true, bytes: raw.length, eof: end >= st.size,
    };
  }

  // glob 转正则: **/ -> 任意层目录, ** -> 任意字符, * -> 非斜杠, ? -> 单个非斜杠
  _globToRegExp(glob) {
    let re = '^';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') {
          if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
          else { re += '.*'; i++; }
        } else re += '[^/]*';
      } else if (c === '?') re += '[^/]';
      else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
      else re += c;
    }
    return new RegExp(re + '$');
  }

  // 递归列文件 (搜目录时用): 跳过 .git/node_modules/.vscode, 可按 glob 过滤
  async _walkFiles(dir, globFilter, root) {
    const out = [];
    const re = globFilter ? this._globToRegExp(globFilter) : null;
    const skip = new Set(['.git', 'node_modules', '.vscode']);
    const walk = async (d) => {
      let entries;
      try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (skip.has(e.name)) continue;
          await walk(full);
        } else if (e.isFile()) {
          if (re) {
            const rel = path.relative(root, full).replace(/\\/g, '/');
            const target = globFilter.includes('/') ? rel : e.name;
            if (!re.test(target)) continue;
          }
          out.push(full);
        }
      }
    };
    await walk(dir);
    return out;
  }

  // 内容搜索 (Claude Code Grep 式): 单文件或目录, 支持 glob 过滤 / 输出模式 / 上下文 / 大小写。
  async doGrep(p, msg) {
    const pattern = String(msg.pattern || '');
    if (!pattern) throw new Error('empty pattern');
    const maxMatches = Math.min(Math.max(parseInt(msg.max_matches, 10) || 200, 1), 5000);
    const outputMode = ['content', 'files_with_matches', 'count'].includes(msg.output_mode)
      ? msg.output_mode : 'content';
    const context = Math.min(Math.max(parseInt(msg.context, 10) || 0, 0), 10);
    const caseSensitive = msg.case_sensitive !== false && msg.case_sensitive !== 'false';
    const globFilter = String(msg.glob || '');
    const re = new RegExp(pattern, caseSensitive ? '' : 'i');
    const st = await fs.promises.stat(p);
    // 单文件: glob 过滤不适用 (用户已明确指定文件), 仅目录搜索时过滤
    const files = st.isDirectory() ? await this._walkFiles(p, globFilter, p) : [p];
    const matches = [];
    const filesHit = [];
    const counts = [];
    let total = 0;
    for (const f of files) {
      let buf;
      try {
        const fst = await fs.promises.stat(f);
        if (fst.size > MAX_GREP_FILE) continue; // 超大文件跳过
        buf = await fs.promises.readFile(f);
      } catch (_) { continue; }
      if (buf.indexOf(0) !== -1) continue; // 二进制跳过
      const lines = buf.toString('utf8').split(/\r?\n/);
      let fileCount = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        total++;
        fileCount++;
        if (outputMode === 'content' && matches.length < maxMatches) {
          const m = { file: f, line: i + 1, text: lines[i].slice(0, 500) };
          if (context > 0) {
            m.before = [];
            m.after = [];
            for (let j = Math.max(0, i - context); j < i; j++) m.before.push({ line: j + 1, text: lines[j].slice(0, 500) });
            for (let j = i + 1; j <= Math.min(lines.length - 1, i + context); j++) m.after.push({ line: j + 1, text: lines[j].slice(0, 500) });
          }
          matches.push(m);
        }
      }
      if (fileCount > 0) {
        filesHit.push(f);
        if (outputMode === 'count') counts.push({ file: f, count: fileCount });
      }
    }
    if (outputMode === 'files_with_matches') return { files: filesHit, total };
    if (outputMode === 'count') return { counts, total };
    return { matches, total };
  }

  async doInfo(p) {
    const st = await fs.promises.stat(p);
    return { size: st.size, mtime: st.mtimeMs, is_file: st.isFile() };
  }

  async doWrite(p, msg) {
    let raw = Buffer.from(String(msg.data || ''), 'base64');
    if (msg.compressed) raw = zlib.inflateSync(raw);
    await fs.promises.writeFile(p, raw, { flag: msg.mode === 'a' ? 'a' : 'w' });
    return { bytes: raw.length };
  }

  // 精确替换 (Claude Code Edit 式): 单条编辑即 MultiEdit, 逻辑复用 doMultiEdit。
  async doEdit(p, msg) {
    return this.doMultiEdit(p, {
      edits: [{ old_text: msg.old_text, new_text: msg.new_text, replace_all: msg.replace_all }],
    });
  }

  // 批量编辑 (Claude Code MultiEdit 式): 全部编辑在内存里顺序应用, 任一失败则整批不写。
  async doMultiEdit(p, msg) {
    const edits = msg.edits;
    if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits required');
    let content = await fs.promises.readFile(p, 'utf8');
    let total = 0;
    for (const e of edits) {
      const oldText = String(e?.old_text ?? '');
      const newText = String(e?.new_text ?? '');
      const replaceAll = e?.replace_all === true || e?.replace_all === 'true';
      if (!oldText) throw new Error('empty old_text in an edit');
      const count = content.split(oldText).length - 1;
      if (count === 0) throw new Error(`old_text not found: ${oldText.slice(0, 80)}`);
      if (count > 1 && !replaceAll) {
        throw new Error(`old_text matches ${count} times: ${oldText.slice(0, 80)}`);
      }
      content = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
      total += replaceAll ? count : 1;
    }
    await fs.promises.writeFile(p, content, 'utf8');
    return { replacements: total, bytes: Buffer.byteLength(content) };
  }

  // 目录列表 (Claude Code LS 式): 单层, 带类型/大小/时间。
  async doListDir(p, msg) {
    const st = await fs.promises.stat(p);
    if (!st.isDirectory()) throw new Error('not a directory');
    const entries = await fs.promises.readdir(p, { withFileTypes: true });
    const out = await Promise.all(entries.map(async (e) => {
      let size = 0, mtime = 0;
      try {
        const s = await fs.promises.stat(path.join(p, e.name));
        size = s.size; mtime = s.mtimeMs;
      } catch (_) { /* 断链等: 保留条目, 大小为 0 */ }
      let type = 'other';
      if (e.isDirectory()) type = 'dir';
      else if (e.isFile()) type = 'file';
      else if (e.isSymbolicLink()) type = 'link';
      return { name: e.name, type, size, mtime };
    }));
    return { entries: out };
  }

  // 文件模式搜索 (Claude Code Glob 式): 走 VS Code 原生 findFiles, 遵循 .gitignore。
  async doGlob(msg) {
    const pattern = String(msg.pattern || '');
    if (!pattern) throw new Error('empty pattern');
    const maxResults = Math.min(Math.max(parseInt(msg.max_results, 10) || 1000, 1), 10000);
    let uris;
    const base = String(msg.base || '');
    if (base) {
      const basePath = this.resolvePath(base);
      uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(vscode.Uri.file(basePath), pattern), null, maxResults);
    } else {
      uris = await vscode.workspace.findFiles(pattern, null, maxResults);
    }
    return { files: uris.map((u) => u.fsPath) };
  }

  // VS Code 诊断 (语言服务器报错/警告): 全部文件或指定文件。
  async doDiagnostics(msg) {
    const file = String(msg.file || '');
    let all;
    if (file) {
      const uri = vscode.Uri.file(this.resolvePath(file));
      all = [[uri, vscode.languages.getDiagnostics(uri)]];
    } else {
      all = vscode.languages.getDiagnostics();
    }
    const sevNames = ['error', 'warning', 'information', 'hint'];
    const out = [];
    for (const [uri, diags] of all) {
      for (const d of diags) {
        if (out.length >= MAX_DIAGNOSTICS) break;
        out.push({
          file: uri.fsPath,
          severity: sevNames[d.severity] || String(d.severity),
          message: d.message,
          source: d.source || '',
          code: (d.code && typeof d.code === 'object') ? d.code.value : (d.code || ''),
          range: {
            start: { line: d.range.start.line, character: d.range.start.character },
            end: { line: d.range.end.line, character: d.range.end.character },
          },
        });
      }
      if (out.length >= MAX_DIAGNOSTICS) break;
    }
    return { diagnostics: out, total: out.length };
  }

  sendFileResult(id, obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log(`文件结果 [${id}] 发送失败:连接已断开`);
      return;
    }
    try {
      this.ws.send(JSON.stringify({ type: 'file_result', id, ...obj }));
    } catch (e) {
      this.log(`文件结果 [${id}] 发送异常: ${e.message}`);
    }
  }

  async checkApproval(display, isReadonly) {
    // 计划模式 (只读): 非只读操作一律拒绝
    if (this.getConfig().readOnly && !isReadonly) {
      this.log(`只读模式: 拒绝 ${display.slice(0, 80)}`);
      return false;
    }
    if (this.checkPermissionFile(display)) return true; // 权限文件:默认全放行
    const mode = this.getConfig().approvalMode;
    const isDangerous = DANGEROUS_RE.test(display);
    if (mode === 'auto' && !isDangerous) return true;
    if (mode === 'confirm-dangerous' && isReadonly && !isDangerous) return true;
    const choice = await vscode.window.showWarningMessage(
      `Muse 请求在你电脑上执行:\n${display}`,
      { modal: true },
      '执行', '拒绝'
    );
    return choice === '执行';
  }

  // ---- 常驻 shell 池: 复用进程 (省每次 spawn) + 并发 (多 shell) + 子 shell 隔离 (无状态残留) ----
  // 每个命令包进子 shell: (\n命令\n) < /dev/null\necho "标记:$?"
  //  - 子 shell: cd/环境变量/函数只在子 shell 生效, 父 shell 永远干净
  //  - < /dev/null: 命令读 stdin 时直接 EOF, 不会吃掉后续的分隔符
  //  - 多行形式: heredoc 的结束符必须独占一行, 单行拼接会把分隔符吞进 heredoc
  //  - stdout/stderr 合并成一个流 (省双流竞态), stderr 字段为空
  //  - 池 shell 启动时 cwd = 首个工作区根 (pwd/ls 默认就是工作区)
  ensurePool() {
    if (this._shellPool) return;
    const t = this.poolTuning();
    this._poolSize = t.size;
    this._poolMax = t.max;
    this._burstIdleMs = t.idleMs;
    this._shellPool = [];
    this._shellQueue = [];
    for (let i = 0; i < this._poolSize; i++) {
      const shell = this._spawnShell();
      if (shell) this._shellPool.push(shell);
    }
  }

  _spawnShell(isBurst = false) {
    const bash = this.resolveBash();
    if (!bash) return null;
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const cwd = folders.length ? folders[0] : undefined;
    const { spawn } = require('child_process');
    const child = spawn(bash, ['-l'], { cwd, windowsHide: true });
    const shell = {
      child, buffer: '', current: null, alive: true, ready: false,
      burst: !!isBurst, idleTimer: null,
      readyMarker: `__MUSE_READY_${Date.now().toString(36)}${(this._poolSeq++).toString(36)}__`,
    };
    child.stdout.on('data', (d) => this._onShellData(shell, d.toString()));
    child.stderr.on('data', (d) => this._onShellData(shell, d.toString()));
    child.on('error', () => this._onShellDead(shell));
    child.on('close', () => this._onShellDead(shell));
    try { child.stdin.write(`echo "${shell.readyMarker}"\n`); } catch (_) { /* spawn 失败时 error 事件会处理 */ }
    // 兜底: 10 秒还不就绪 (bash 启动挂住), 杀掉重开, 不让它占着池位
    setTimeout(() => { if (!shell.ready && shell.alive) this._killShell(shell); }, 10000);
    return shell;
  }

  _taskkillPid(pid) {
    try {
      const { execFile } = require('child_process');
      execFile('taskkill', ['/F', '/T', '/PID', String(pid)], () => {});
    } catch (_) {}
  }

  _respawn() {
    const replacement = this._spawnShell();
    if (replacement && this._shellPool) this._shellPool.push(replacement);
    this._dispatch();
  }

  _dispatch() {
    if (!this._shellPool) return;
    // 兜底: 池空了 (shell 全死且 Git Bash 消失), 排队任务不再挂起
    if (this._shellPool.length === 0 && this._shellQueue.length > 0) {
      for (const job of this._shellQueue) {
        job.resolve({ exit: -1, stdout: '', stderr: 'Git Bash not found' });
      }
      this._shellQueue = [];
      return;
    }
    for (const shell of this._shellPool) {
      if (this._shellQueue.length === 0) break;
      if (!shell.alive || !shell.ready || shell.current) continue;
      const job = this._shellQueue.shift();
      shell.current = job;
      job.shell = shell;
      if (shell.idleTimer) { clearTimeout(shell.idleTimer); shell.idleTimer = null; } // burst shell 复用, 取消回收
      shell.buffer = ''; // 丢弃残留 (防御)
      job.timer = setTimeout(() => this._onJobTimeout(job), job.timeout * 1000);
      // base64 编码防 breakout: 命令里哪怕有单独一行的 `)`, 也不会提前闭合 subshell。
      // base64 字母表不含 `_`, heredoc 分隔符 `__MUSE_B64__` 不可能在编码中出现, 绝对安全。
      // `| bash` 子进程执行, cd/环境变量不泄漏到池 shell (与原来 `( )` 同等隔离)。
      const b64 = Buffer.from(job.command, 'utf8').toString('base64');
      const wrapped = `base64 -d << '__MUSE_B64__' | bash\n${b64}\n__MUSE_B64__\necho "${job.marker}:$?"\n`;
      try {
        shell.child.stdin.write(wrapped);
      } catch (_) {
        clearTimeout(job.timer);
        shell.current = null;
        this._onShellDead(shell);
        job.resolve({ exit: -1, stdout: '', stderr: 'shell stdin closed' });
      }
    }
    // 弹性扩容: 还有排队且没到上限, 加一个 burst shell (就绪后自动接任务)
    if (this._shellQueue.length > 0 && this._shellPool.length < (this._poolMax || POOL_MAX)) {
      const burst = this._spawnShell(true);
      if (burst) this._shellPool.push(burst);
    }
  }

  _reapBurstShell(shell) {
    shell.idleTimer = null;
    if (!shell.burst || !shell.alive || shell.current) return; // 已被复用或已死
    this._killShell(shell); // _killShell 对 burst 不重开 (见下)
  }

  _onShellData(shell, chunk) {
    shell.buffer = (shell.buffer + chunk).slice(-MAX_BG_BUFFER);
    if (!shell.ready) {
      // 就绪探针: shell 启动完成 (profile 加载完) 且缓冲区干净后才接任务
      const idx = shell.buffer.indexOf(shell.readyMarker);
      if (idx === -1) return;
      shell.ready = true;
      shell.buffer = '';
      this._dispatch();
      return;
    }
    const job = shell.current;
    if (!job) return;
    const idx = shell.buffer.indexOf(job.marker);
    if (idx === -1) return;
    const after = shell.buffer.slice(idx + job.marker.length);
    const m = /^:(-?\d+)/.exec(after);
    if (!m) return; // 退出码还没收全, 等更多数据
    const exit = parseInt(m[1], 10);
    const stdout = shell.buffer.slice(0, idx);
    let rest = after.slice(m[0].length);
    if (rest.startsWith('\r\n')) rest = rest.slice(2);
    else if (rest.startsWith('\n')) rest = rest.slice(1);
    shell.buffer = rest;
    clearTimeout(job.timer);
    shell.current = null;
    const truncated = stdout.length > MAX_OUTPUT;
    job.resolve({ exit, stdout: stdout.slice(-MAX_OUTPUT), stderr: '', truncated });
    // burst shell 空闲后开始倒计时回收 (基线 shell 常驻不回收)
    if (shell.burst && !shell.idleTimer) {
      shell.idleTimer = setTimeout(() => this._reapBurstShell(shell), this._burstIdleMs || BURST_IDLE_MS);
    }
    this._dispatch();
  }

  _onJobTimeout(job) {
    const shell = job.shell;
    if (!shell || shell.current !== job) return; // 已完成, 定时器是残留
    shell.current = null;
    const partial = shell.buffer;
    shell.buffer = '';
    this._killShell(shell);
    job.resolve({ exit: -1, stdout: partial.slice(-MAX_OUTPUT), stderr: '\n[TIMEOUT] 命令执行超时已被终止', truncated: partial.length > MAX_OUTPUT });
  }

  _killShell(shell) {
    if (!shell.alive) return;
    shell.alive = false;
    if (shell.idleTimer) { clearTimeout(shell.idleTimer); shell.idleTimer = null; }
    if (this._shellPool) {
      const idx = this._shellPool.indexOf(shell);
      if (idx !== -1) this._shellPool.splice(idx, 1);
    }
    if (shell.current) {
      clearTimeout(shell.current.timer);
      shell.current = null;
    }
    this._taskkillPid(shell.child.pid);
    if (!shell.burst) this._respawn(); // 基线 shell 补位; burst 不补 (用完即走)
    else this._dispatch(); // burst 走了, 看看排队里还有没有活
  }

  _onShellDead(shell) {
    if (!shell.alive) return; // 已处理 (如 _killShell)
    shell.alive = false;
    if (shell.idleTimer) { clearTimeout(shell.idleTimer); shell.idleTimer = null; }
    if (this._shellPool) {
      const idx = this._shellPool.indexOf(shell);
      if (idx !== -1) this._shellPool.splice(idx, 1);
    }
    if (shell.current) {
      const job = shell.current;
      clearTimeout(job.timer);
      shell.current = null;
      job.resolve({ exit: -1, stdout: '', stderr: 'shell died unexpectedly' });
    }
    if (!shell.burst) this._respawn();
    else this._dispatch();
  }

  _destroyPool() {
    if (!this._shellPool) return;
    for (const shell of this._shellPool) {
      shell.alive = false;
      if (shell.idleTimer) { clearTimeout(shell.idleTimer); shell.idleTimer = null; }
      if (shell.current) {
        const job = shell.current;
        clearTimeout(job.timer);
        shell.current = null;
        job.resolve({ exit: -1, stdout: '', stderr: 'bridge stopped' });
      }
      this._taskkillPid(shell.child.pid);
    }
    this._shellPool = null;
    for (const job of this._shellQueue) {
      job.resolve({ exit: -1, stdout: '', stderr: 'bridge stopped' });
    }
    this._shellQueue = [];
  }

  execute(command, timeout) {
    if (this.stopping) {
      return Promise.resolve({ exit: -1, stdout: '', stderr: 'bridge stopped' });
    }
    this.ensurePool();
    if (!this._shellPool || this._shellPool.length === 0) {
      return Promise.resolve({ exit: -1, stdout: '', stderr: 'Git Bash not found' });
    }
    return new Promise((resolve) => {
      const job = {
        command, timeout,
        resolve, timer: null, shell: null,
        marker: `__MUSE_END_${Date.now().toString(36)}${(this._poolSeq++).toString(36)}__`,
      };
      this._shellQueue.push(job);
      this._dispatch();
    });
  }

  sendResult(id, exit, stdout, stderr) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log(`结果 [${id}] 发送失败:连接已断开`);
      return;
    }
    try {
      this.ws.send(JSON.stringify({ type: 'result', id, exit, stdout, stderr }));
    } catch (e) {
      this.log(`结果 [${id}] 发送异常: ${e.message}`);
    }
  }
}

module.exports = { MuseBridge };
