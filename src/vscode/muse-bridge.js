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
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const WebSocket = require('ws');

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

class MuseBridge {
  constructor(context, outputChannel) {
    this.context = context;
    this.out = outputChannel;
    this.ws = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 2000;
    this.stopping = false;
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = 'museBridge.status';
    context.subscriptions.push(this.statusItem);
    this.setStatus('off');
  }

  log(msg) {
    this.out.appendLine(`[MuseBridge] ${msg}`);
  }

  setStatus(s, detail = '') {
    const map = {
      off: '$(circle-slash) Bridge 关',
      connecting: '$(sync~spin) Bridge 连接中',
      online: '$(check) Bridge 在线',
      error: '$(error) Bridge 异常',
    };
    this.statusItem.text = map[s] || map.off;
    this.statusItem.tooltip = `Muse Bridge: ${s}${detail ? ' - ' + detail : ''}`;
    this.statusItem.show();
  }

  getConfig() {
    const cfg = vscode.workspace.getConfiguration('httpAiProxy');
    return {
      enabled: cfg.get('museBridge.enabled', false),
      approvalMode: cfg.get('museBridge.approvalMode', 'confirm-dangerous'),
      gitBashPath: cfg.get('museBridge.gitBashPath', ''),
      vpsHost: cfg.get('museBridge.vpsHost', DEFAULT_HOST),
      permissionsPath: cfg.get('museBridge.permissionsPath', ''),
    };
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
      ws = new WebSocket(url, { headers: { 'X-Bridge-Token': token }, handshakeTimeout: 15000 });
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
    if (['read_file', 'grep_file', 'file_info', 'write_file'].includes(msg.type)) {
      return this.onFileOp(msg);
    }
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

  async onFileOp(msg) {
    const t = msg.type;
    const p = String(msg.path || '');
    this.log(`文件操作 [${msg.id}]: ${t} ${p.slice(0, 100)}`);
    try {
      if (t === 'read_file') return this.sendFileResult(msg.id, await this.doRead(p, msg));
      if (t === 'grep_file') return this.sendFileResult(msg.id, await this.doGrep(p, msg));
      if (t === 'file_info') return this.sendFileResult(msg.id, await this.doInfo(p));
      if (t === 'write_file') {
        // 写文件永远走审批(非只读)
        const ok = await this.checkApproval(`写入文件: ${p}`, false);
        if (!ok) {
          this.log(`写文件 [${msg.id}] 被用户拒绝。`);
          return this.sendFileResult(msg.id, { ok: false, error: 'rejected by user' });
        }
        return this.sendFileResult(msg.id, await this.doWrite(p, msg));
      }
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

  async doGrep(p, msg) {
    const pattern = String(msg.pattern || '');
    const maxMatches = Math.min(Math.max(parseInt(msg.max_matches, 10) || 200, 1), 5000);
    if (!pattern) throw new Error('empty pattern');
    const re = new RegExp(pattern);
    const matches = [];
    let total = 0, lineno = 0;
    const rl = require('readline').createInterface({
      input: fs.createReadStream(p, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      lineno++;
      if (re.test(line)) {
        total++;
        if (matches.length < maxMatches) matches.push({ line: lineno, text: line.slice(0, 500) });
      }
    }
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

  execute(command, timeout) {
    const bash = this.resolveBash();
    return new Promise((resolve) => {
      execFile(bash, ['-l', '-c', command], {
        timeout: timeout * 1000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        let exit = 0;
        let errText = stderr || '';
        if (err) {
          exit = typeof err.code === 'number' ? err.code : -1;
          if (err.killed) errText += '\n[TIMEOUT] 命令执行超时已被终止';
        }
        resolve({
          exit,
          stdout: (stdout || '').slice(-MAX_OUTPUT),
          stderr: String(errText).slice(-MAX_OUTPUT),
        });
      });
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
