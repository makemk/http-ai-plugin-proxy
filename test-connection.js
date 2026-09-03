const { HttpsForwardProxyServer, maskHost } = require('./src/proxy-server');
const http = require('http');
const path = require('path');

async function testAll() {
  const configPath = process.argv[2] || '';
  console.log(`=======================================================`);
  console.log(`     HTTP AI Plugin Proxy Diagnostic Tool             `);
  console.log(`=======================================================`);

  const proxy = new HttpsForwardProxyServer({
    configPath,
    port: 0 // ephemeral port for testing
  });

  try {
    const info = await proxy.start();
    console.log(`Config file: ${proxy.configPath ? path.basename(proxy.configPath) : 'Auto-detected'}`);
    console.log(`Local test proxy listener active on port ${info.port}`);
    console.log(`Upstream Gateway: ${maskHost(proxy.upstreamConfig.host)}:${proxy.upstreamConfig.port}\n`);

    const targets = [
      { name: 'Google Cloud Code API', host: 'cloudcode-pa.googleapis.com', port: 443 },
      { name: 'Google Gemini AI API', host: 'generativelanguage.googleapis.com', port: 443 },
      { name: 'Google Accounts (OAuth)', host: 'accounts.google.com', port: 443 },
      { name: 'OpenAI API (ChatGPT/Codex)', host: 'api.openai.com', port: 443 },
      { name: 'Anthropic API (Claude Code)', host: 'api.anthropic.com', port: 443 },
      { name: 'VS Code Extension Marketplace', host: 'marketplace.visualstudio.com', port: 443 },
      { name: 'GitHub API', host: 'api.github.com', port: 443 },
      { name: 'Plain HTTP Tunnel (Port 80)', host: 'httpbin.org', port: 80 }
    ];

    let passed = 0;
    for (const target of targets) {
      process.stdout.write(`Testing [${target.name}] (${target.host}:${target.port})... `);
      const res = await proxy.testConnectivity(target.host, target.port, 4000);
      if (res.success) {
        console.log(`✅ SUCCESS (${res.latency}ms)`);
        passed++;
      } else {
        console.log(`❌ FAILED (${res.error})`);
      }
    }

    await proxy.stop();
    console.log(`\n=======================================================`);
    console.log(`Result: ${passed}/${targets.length} endpoints connected successfully.`);
    console.log(`=======================================================\n`);
  } catch (err) {
    console.error('Test error:', err.message);
  }
}

testAll();
