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
const WebSocket = require('ws');

const SECRET_KEY = 'muse_bridge.token';
const DEFAULT_HOST = '38.207.167.51:9443';
const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

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
    };
  }

  resolveBash() {
    const cfg = this.getConfig();
    if (cfg.gitBashPath && fs.existsSync(cfg.gitBashPath)) return cfg.gitBashPath;
    for (const p of GIT_BASH_CANDIDATES) {
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
    if (msg.type !== 'cmd' || !msg.id) return;
    const command = String(msg.command || '');
    const timeout = Math.min(Math.max(parseInt(msg.timeout, 10) || 120, 5), 600);
    this.log(`收到命令 [${msg.id}]: ${command.slice(0, 120)}${command.length > 120 ? '...' : ''}`);

    const approved = await this.checkApproval(command);
    if (!approved) {
      this.log(`命令 [${msg.id}] 被用户拒绝。`);
      return this.sendResult(msg.id, -1, '', 'rejected by user');
    }
    const res = await this.execute(command, timeout);
    this.log(`命令 [${msg.id}] 执行完毕,exit=${res.exit}`);
    this.sendResult(msg.id, res.exit, res.stdout, res.stderr);
  }

  async checkApproval(command) {
    const mode = this.getConfig().approvalMode;
    const isReadonly = READONLY_RE.test(command);
    const isDangerous = DANGEROUS_RE.test(command);
    if (mode === 'auto' && !isDangerous) return true;
    if (mode === 'confirm-dangerous' && isReadonly && !isDangerous) return true;
    const choice = await vscode.window.showWarningMessage(
      `Muse 请求在本机执行命令:\n${command}`,
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
