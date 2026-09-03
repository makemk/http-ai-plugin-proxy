const tls = require('tls');
const net = require('net');
const fs = require('fs');
const path = require('path');

const { maskHost } = require('./src/proxy-server');

// 读取网关配置（动态探测，脱敏处理）
const homeDir = process.env.USERPROFILE || process.env.HOME || '';
const candidates = [
  path.join(homeDir, '.browser-gateway', 'deployment.local.json'),
  path.join(homeDir, 'Documents', 'vscode_env', 'deployment.local.json'),
  path.join(__dirname, 'deployment.local.json'),
  path.join(__dirname, '..', 'deployment.local.json')
];

let config = { host: '127.0.0.1', port: 443, username: '', password: '' };
for (const cand of candidates) {
  if (fs.existsSync(cand)) {
    try {
      config = JSON.parse(fs.readFileSync(cand, 'utf8'));
      break;
    } catch (_) {}
  }
}

const authHeader = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');

console.log('\n======================================================');
console.log('       TLS 1.3 / 1.2 分步带硬超时极速诊断');
console.log(`       目标网关: ${maskHost(config.host)}:${config.port}`);
console.log('======================================================\n');

// 严格硬超时执行器：一旦超时，强制销毁底层 Socket，绝不卡住！
function runWithStrictTimeout(stepName, timeoutMs, fn) {
  return new Promise((resolve) => {
    let finished = false;
    let currentSocket = null;

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        if (currentSocket) {
          try { currentSocket.destroy(); } catch (_) {}
        }
        resolve({ success: false, error: `超时 (${timeoutMs / 1000}秒无响应，已强制熔断)` });
      }
    }, timeoutMs);

    try {
      fn((sock) => { currentSocket = sock; }, (err, data) => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          if (err) resolve({ success: false, error: err.message || String(err) });
          else resolve({ success: true, data });
        }
      });
    } catch (e) {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ success: false, error: e.message });
      }
    }
  });
}

async function main() {
  // 步骤 1: 物理 TCP 连接 (限时 2.5 秒)
  process.stdout.write('[步骤 1/4] 测试与网关的物理 TCP 链路 (443 端口)... ');
  const step1 = await runWithStrictTimeout('TCP 连接', 2500, (setSocket, done) => {
    const start = Date.now();
    const sock = net.connect({ host: config.host, port: config.port }, () => {
      const time = Date.now() - start;
      sock.destroy();
      done(null, { time });
    });
    setSocket(sock);
    sock.on('error', done);
  });
  if (step1.success) {
    console.log(`\x1b[32m[成功]\x1b[0m 往返延迟: ${step1.data.time}ms`);
  } else {
    console.log(`\x1b[31m[失败]\x1b[0m ${step1.error}`);
  }

  // 步骤 2: TLS 1.2 握手探测 (限时 3 秒)
  process.stdout.write('[步骤 2/4] 测试 TLS 1.2 加密握手能力... ');
  const step2 = await runWithStrictTimeout('TLS 1.2', 3000, (setSocket, done) => {
    const start = Date.now();
    const sock = tls.connect({
      host: config.host,
      port: config.port,
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
      rejectUnauthorized: false
    }, () => {
      const time = Date.now() - start;
      const proto = sock.getProtocol();
      sock.destroy();
      done(null, { time, proto });
    });
    setSocket(sock);
    sock.on('error', done);
  });
  if (step2.success) {
    console.log(`\x1b[32m[成功]\x1b[0m 协议: ${step2.data.proto}, 握手耗时: ${step2.data.time}ms`);
  } else {
    console.log(`\x1b[31m[未响应/超时]\x1b[0m ${step2.error}`);
  }

  // 步骤 3: TLS 1.3 专属握手探测 (限时 3 秒)
  process.stdout.write('[步骤 3/4] 强制启用 TLS 1.3 专属握手... ');
  const step3 = await runWithStrictTimeout('TLS 1.3', 3000, (setSocket, done) => {
    const start = Date.now();
    const sock = tls.connect({
      host: config.host,
      port: config.port,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      rejectUnauthorized: false
    }, () => {
      const time = Date.now() - start;
      const proto = sock.getProtocol();
      const cipher = sock.getCipher();
      sock.destroy();
      done(null, { time, proto, cipher: cipher?.name });
    });
    setSocket(sock);
    sock.on('error', done);
  });
  if (step3.success) {
    console.log(`\x1b[32m[成功]\x1b[0m 协议: ${step3.data.proto}, 加密套件: ${step3.data.cipher}, 握手耗时: ${step3.data.time}ms`);
  } else {
    console.log(`\x1b[31m[未响应/超时]\x1b[0m ${step3.error}`);
  }

  // 步骤 4: 通过 TLS 隧道发送 CONNECT 代理请求 (限时 3.5 秒)
  process.stdout.write('[步骤 4/4] 验证 TLS 隧道内的 CONNECT 鉴权与建连... ');
  const step4 = await runWithStrictTimeout('CONNECT 代理', 3500, (setSocket, done) => {
    const start = Date.now();
    const sock = tls.connect({
      host: config.host,
      port: config.port,
      rejectUnauthorized: false
    }, () => {
      const req = [
        'CONNECT api.anthropic.com:443 HTTP/1.1',
        'Host: api.anthropic.com:443',
        `Proxy-Authorization: ${authHeader}`,
        'Proxy-Connection: Keep-Alive',
        '',
        ''
      ].join('\r\n');
      sock.write(req);
    });
    setSocket(sock);

    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        const status = buf.split('\r\n')[0];
        sock.destroy();
        done(null, { status, time: Date.now() - start });
      }
    });
    sock.on('error', done);
  });
  if (step4.success) {
    console.log(`\x1b[32m[成功]\x1b[0m 状态: ${step4.data.status}, 耗时: ${step4.data.time}ms`);
  } else {
    console.log(`\x1b[31m[失败]\x1b[0m ${step4.error}`);
  }

  console.log('\n======================================================');
  console.log('诊断完成！全部步骤执行完毕。');
  console.log('======================================================\n');
  process.exit(0);
}

main();
