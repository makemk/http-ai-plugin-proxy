#!/usr/bin/env node

const { HttpsForwardProxyServer, maskHost, detectHardwareProfile } = require('./src/proxy-server');
const path = require('path');

const hw = detectHardwareProfile();
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || String(hw.optimalThreadPool);

const configPath = process.argv[2] || process.env.PROXY_CONFIG || '';
const port = parseInt(process.env.PROXY_PORT || '18889', 10);

const proxy = new HttpsForwardProxyServer({
  configPath,
  port,
  logger: console
});

async function main() {
  try {
    const { host, port: listeningPort } = await proxy.start();
    console.log(`=======================================================`);
    console.log(` HTTP AI Plugin Proxy is RUNNING`);
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
    console.error('Fatal error starting proxy server:', err.message);
    process.exit(1);
  }
}

main();
