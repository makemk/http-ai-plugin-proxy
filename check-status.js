const http = require('http');
const https = require('https');
const net = require('net');
const { execSync } = require('child_process');

console.log('\n' + '='.repeat(58));
console.log('   HTTP AI 代理 实时诊断与监控');
console.log('='.repeat(58) + '\n');

async function main() {
  // 1. 检查本地 18889 端口代理
  process.stdout.write('[1/4] 检查本地 18889 代理服务状态... ');
  try {
    const health = await new Promise((resolve, reject) => {
      const req = http.get('http://127.0.0.1:18889/health', { timeout: 2000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
    console.log('\x1b[32m[正常运行中]\x1b[0m');
    console.log(`    - 端口: ${health.localPort}`);
    console.log(`    - 远程网关: ${health.gateway}`);
    console.log(`    - 累计请求: ${health.stats.totalRequests} (成功建立隧道: ${health.stats.connectTunnels})`);
  } catch (err) {
    console.log('\x1b[31m[异常 / 未启动]\x1b[0m');
    console.log(`    - 原因: ${err.message}`);
  }

  // 2. 检查环境变量劫持 (CLOUD_CODE_URL)
  console.log('\n[2/4] 检查系统环境变量与流量重定向...');
  try {
    const userCloudCode = execSync('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'CLOUD_CODE_URL\', \'User\')"', { encoding: 'utf8' }).trim();
    if (userCloudCode) {
      console.log('    \x1b[31m[严重警告] 发现系统劫持变量: CLOUD_CODE_URL\x1b[0m');
      console.log(`    当前值: \x1b[33m${userCloudCode}\x1b[0m`);
      if (userCloudCode.includes('18888')) {
        console.log('    \x1b[31m>>> 根因定位: 此变量强行将 AI 插件流量导向 18888 浏览器借道桥！\x1b[0m');
        console.log('    \x1b[31m>>> 这就是为什么关闭浏览器插件后，VS Code 瞬间断网卡死的根本原因！\x1b[0m');
      }
    } else {
      console.log('    \x1b[32m[正常] CLOUD_CODE_URL 干净无劫持，流量未被浏览器重定向。\x1b[0m');
    }
  } catch (_) {}

  // 3. 检查后台 18888 借道进程
  console.log('\n[3/4] 检查后台占用进程...');
  try {
    const out = execSync('powershell -NoProfile -Command "Get-Process -Name browser-ai-bridge -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"', { encoding: 'utf8' }).trim();
    if (out) {
      console.log(`    \x1b[33m- 发现 18888 借道桥进程仍在后台常驻 (PID: ${out})\x1b[0m`);
    } else {
      console.log('    \x1b[32m- 未发现 18888 借道桥进程 (后台干净)\x1b[0m');
    }
  } catch (_) {}

  // 4. 端到端连通性快速探测
  console.log('\n[4/4] 模拟 18889 独立代理端到端出网能力...');
  const targets = [
    { name: 'Google Cloud Code API', host: 'cloudcode-pa.googleapis.com', port: 443 },
    { name: 'Anthropic Claude API', host: 'api.anthropic.com', port: 443 },
    { name: 'Google Gemini API', host: 'generativelanguage.googleapis.com', port: 443 }
  ];

  for (const t of targets) {
    const start = Date.now();
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: 18889,
          method: 'CONNECT',
          path: `${t.host}:${t.port}`,
          timeout: 4000
        });
        req.on('connect', (res, socket) => {
          socket.destroy();
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
      });
      console.log(`    - [${t.name}] : \x1b[32m正常 (${Date.now() - start}ms)\x1b[0m`);
    } catch (e) {
      console.log(`    - [${t.name}] : \x1b[31m失败 (${e.message})\x1b[0m`);
    }
  }

  console.log('\n' + '='.repeat(58) + '\n');
}

main().catch(console.error);

