#!/usr/bin/env node

const { HttpsForwardProxyServer, maskHost, detectHardwareProfile } = require('./src/proxy-server');
const path = require('path');

const hw = detectHardwareProfile();
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || String(hw.optimalThreadPool);

const configPath = process.argv[2] || process.env.PROXY_CONFIG || '';
const port = parseInt(process.env.PROXY_PORT || '18889', 10);

const http = require('http');

function checkExistingProxy(targetPort) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${targetPort}/health`, { timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ alive: json.status === 'ok', data: json });
        } catch (_) {
          resolve({ alive: false });
        }
      });
    });
    req.on('error', () => resolve({ alive: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ alive: false });
    });
  });
}

async function main() {
  // 1. Probe if proxy is already running (e.g. inside VS Code or another window)
  const existing = await checkExistingProxy(port);
  if (existing.alive) {
    const info = existing.data;
    console.log(`=======================================================`);
    console.log(` 🚀 HTTP AI Plugin Proxy is ALREADY RUNNING (Master Mode)`);
    console.log(` Local HTTP Proxy:  http://127.0.0.1:${port}`);
    console.log(` Upstream Gateway:  https://${info.gateway || 'Active'}`);
    console.log(` Service Uptime:    ${info.uptimeSeconds || 0} seconds`);
    console.log(` Hardware Profile:  ${info.hardware?.cpuModel || 'Detected'} (${info.hardware?.threadPoolThreads || 20} Threads)`);
    console.log(` Warm Pool:         ${info.warmPool?.readySockets || 0}/${info.warmPool?.maxSockets || 6} Ready Sockets`);
    console.log(` Management:        Actively managed by VS Code / Master Host`);
    console.log(`=======================================================`);
    console.log(`\nTesting connection to Google Cloud Code...`);

    const t0 = Date.now();
    const probe = http.request({
      host: '127.0.0.1',
      port,
      method: 'CONNECT',
      path: 'cloudcode-pa.googleapis.com:443',
      timeout: 5000
    });
    probe.on('connect', (res, socket) => {
      const lat = Date.now() - t0;
      console.log(`[PASS] Google Cloud Code is REACHABLE (Warm Pool Latency: ${lat}ms)`);
      socket.destroy();
    });
    probe.on('timeout', () => {
      probe.destroy();
      console.log(`[WARN] Connection check: Connection timed out`);
    });
    probe.on('error', (err) => {
      console.log(`[WARN] Connection check: ${err.message}`);
    });
    probe.end();

    console.log(`\n[Tip] Your proxy is already working in the background. Press Ctrl+C to exit.`);
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
    // Keep alive as monitor
    setInterval(() => {}, 60000);
    return;
  }

  // 2. Start standalone proxy server
  const proxy = new HttpsForwardProxyServer({
    configPath,
    port,
    logger: console
  });

  try {
    const { host, port: listeningPort } = await proxy.start();
    console.log(`=======================================================`);
    console.log(` HTTP AI Plugin Proxy is RUNNING (Standalone Mode)`);
    console.log(` Local HTTP Proxy:  http://${host}:${listeningPort}`);
    console.log(` Upstream Gateway:  https://${maskHost(proxy.upstreamConfig.host)}:${proxy.upstreamConfig.port}`);
    console.log(` Config File:       ${proxy.configPath ? path.basename(proxy.configPath) : 'Auto-detected'}`);
    console.log(`=======================================================`);
    console.log(`\nTesting connection to Google Cloud Code...`);

    const result = await proxy.testConnectivity('cloudcode-pa.googleapis.com', 443);
    if (result.success) {
      console.log(`[PASS] Google Cloud Code is REACHABLE (Latency: ${result.latency}ms)`);
    } else {
      console.log(`[FAIL] Connection test failed: ${result.error}`);
    }

    console.log(`\nPress Ctrl+C to stop.`);

    process.on('SIGINT', async () => {
      console.log('\nStopping proxy server...');
      await proxy.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await proxy.stop();
      process.exit(0);
    });

  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Conflict] Port ${port} is already in use by another application.`);
      console.error(`If VS Code is open, the proxy is already running automatically in the background.`);
    } else {
      console.error('Fatal error starting proxy server:', err.message);
    }
    process.exit(1);
  }
}

main();
