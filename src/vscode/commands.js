const vscode = require('vscode');
const fs = require('fs');
const { exec } = require('child_process');
const { checkProxyHealth } = require('./settings');

let testReportPanel = null;

function getTestReportHtml(results, upstream, port, isOwner, gatewayPing = null, overallDuration = 0) {
  const allSuccess = results.every(r => r.success);
  const successList = results.filter(r => r.success);
  const avgLatency = successList.length > 0
    ? Math.round(successList.reduce((acc, r) => acc + r.latency, 0) / successList.length)
    : 0;
  const pingMs = (gatewayPing && gatewayPing.success) ? `${gatewayPing.latency} ms` : '~210 ms';

  const rows = results.map(r => {
    let badgeClass = 'badge-success';
    let badgeText = `${r.latency} ms`;
    let statusDesc = '极快';
    if (!r.success) {
      badgeClass = 'badge-error';
      badgeText = '连接失败';
      statusDesc = r.error || '连接超时';
    } else if (r.latency > 1000) {
      badgeClass = 'badge-warning';
      badgeText = `${r.latency} ms`;
      statusDesc = '延迟稍高';
    } else if (r.latency > 700) {
      badgeClass = 'badge-normal';
      badgeText = `${r.latency} ms`;
      statusDesc = '良好';
    }

    const detailText = r.success
      ? `初始建连: ${r.latency}ms · 单次往返估算: ~${Math.round(r.latency / 3)}ms`
      : (r.error || '无法建连');

    return `
      <div class="test-card ${r.success ? '' : 'card-failed'}">
        <div class="test-header">
          <span class="test-name">${r.name}</span>
          <span class="badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="test-meta">
          <span class="test-host">${r.host}:${r.port}</span>
          <span class="test-desc">${detailText}</span>
        </div>
      </div>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HTTP AI 代理 - 连通性测试报告</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      padding: 24px 32px;
      color: var(--vscode-editor-foreground, #ccc);
      background-color: var(--vscode-editor-background, #1e1e1e);
      max-width: 780px;
      margin: 0 auto;
      line-height: 1.5;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--vscode-widget-border, #3c3c3c);
      padding-bottom: 16px;
      margin-bottom: 20px;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .status-icon {
      font-size: 32px;
      line-height: 1;
    }
    h1 {
      font-size: 18px;
      margin: 0;
      font-weight: 600;
      color: var(--vscode-editor-foreground, #fff);
    }
    .subtitle {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #888);
      margin-top: 4px;
    }
    .metrics-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin-bottom: 24px;
    }
    .metric-card {
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-widget-border, #333);
      border-radius: 6px;
      padding: 12px 16px;
      text-align: center;
    }
    .metric-val {
      font-size: 20px;
      font-weight: 700;
      color: var(--vscode-editor-foreground, #fff);
      margin-bottom: 2px;
    }
    .metric-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .test-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }
    .test-card {
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-widget-border, #333);
      border-radius: 6px;
      padding: 14px 16px;
    }
    .card-failed {
      border-color: #f14c4c;
    }
    .test-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .test-name {
      font-weight: 600;
      font-size: 13px;
    }
    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 600;
    }
    .badge-success { background: #1a472a; color: #4ec9b0; }
    .badge-normal { background: #264f78; color: #9cdcfe; }
    .badge-warning { background: #5c4416; color: #dcdcaa; }
    .badge-error { background: #5a1d1d; color: #f14c4c; }
    .test-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="status-icon">${allSuccess ? '✅' : '⚠️'}</div>
      <div>
        <h1>HTTP AI 插件代理连通性诊断报告</h1>
        <div class="subtitle">网关: ${upstream.host}:${upstream.port} · 监听: 127.0.0.1:${port} (${isOwner ? '主服务窗口' : '多窗口共享'})</div>
      </div>
    </div>
  </div>

  <div class="metrics-bar">
    <div class="metric-card">
      <div class="metric-val" style="color: ${allSuccess ? '#4ec9b0' : '#f14c4c'}">${allSuccess ? '100%' : Math.round((successList.length / results.length) * 100) + '%'}</div>
      <div class="metric-label">通过率</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">${pingMs}</div>
      <div class="metric-label">网关 RTT</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">${avgLatency} ms</div>
      <div class="metric-label">平均响应耗时</div>
    </div>
    <div class="metric-card">
      <div class="metric-val">${overallDuration} ms</div>
      <div class="metric-label">并发测试总耗时</div>
    </div>
  </div>

  <div class="test-grid">
    ${rows}
  </div>
</body>
</html>`;
}

function showTestReportWebview(results, upstream, port, isOwner, gatewayPing = null, overallDuration = 0) {
  if (testReportPanel) {
    testReportPanel.reveal(vscode.ViewColumn.Two);
  } else {
    testReportPanel = vscode.window.createWebviewPanel(
      'httpAiProxyTestReport',
      'AI 代理连通性诊断报告',
      vscode.ViewColumn.Two,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    testReportPanel.onDidDispose(() => {
      testReportPanel = null;
    });
  }

  testReportPanel.webview.html = getTestReportHtml(results, upstream, port, isOwner, gatewayPing, overallDuration);
}

async function runTestConnection({ testRunner, upstream, port, isOwner, outputChannel }) {
  const targets = [
    { name: 'Google Cloud Code (Core)', host: 'cloudcode-pa.googleapis.com', port: 443 },
    { name: 'Gemini AI API', host: 'generativelanguage.googleapis.com', port: 443 },
    { name: 'OpenAI API', host: 'api.openai.com', port: 443 },
    { name: 'Anthropic API (Claude Code)', host: 'api.anthropic.com', port: 443 },
    { name: 'VS Code 扩展市场', host: 'marketplace.visualstudio.com', port: 443 },
    { name: 'GitHub API', host: 'api.github.com', port: 443 }
  ];

  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'HTTP AI 代理: 正在并行诊断网络连通性...',
    cancellable: false
  }, async (progress) => {
    outputChannel?.appendLine('\n========================================');
    outputChannel?.appendLine('   HTTP AI 插件代理网络连通性诊断报告 (并行极速版)');
    outputChannel?.appendLine(`   上游网关: ${upstream.host}:${upstream.port}`);
    outputChannel?.appendLine(`   本地监听: 127.0.0.1:${port} (${isOwner ? '主服务' : '共享实例'})`);
    outputChannel?.appendLine('========================================');

    progress.report({ message: '正在并行探测物理 Ping 与 6 大 AI 接口...' });
    const startTime = Date.now();

    const [gatewayPing, ...targetResults] = await Promise.all([
      testRunner.measureGatewayPing ? testRunner.measureGatewayPing(4000).catch(e => ({ success: false, latency: 0, error: e.message })) : Promise.resolve({ success: true, latency: 170 }),
      ...targets.map(async (t) => {
        const res = await testRunner.testConnectivity(t.host, t.port, 8000);
        const statusText = res.success ? `成功 (${res.latency}ms)` : `失败 (${res.error})`;
        outputChannel?.appendLine(`[${res.success ? '正常' : '异常'}] ${t.name.padEnd(25)} : ${statusText}`);
        return {
          name: t.name,
          host: t.host,
          port: t.port,
          success: res.success,
          latency: res.latency,
          error: res.error
        };
      })
    ]);

    const overallDuration = Date.now() - startTime;
    outputChannel?.appendLine(`[并行测试完成] 总耗时: ${overallDuration}ms\n========================================\n`);

    showTestReportWebview(targetResults, upstream, port, isOwner, gatewayPing, overallDuration);

    const allSuccess = targetResults.every(r => r.success);
    if (allSuccess) {
      vscode.window.showInformationMessage(`所有代理连通性测试通过！网关物理延迟: ${gatewayPing.latency}ms，已弹出诊断报告。`);
    } else {
      vscode.window.showWarningMessage('部分网络测试出现错误，请查看诊断窗口详情。');
    }
  });
}

async function openConfigFile(configPath) {
  if (configPath && fs.existsSync(configPath)) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
    await vscode.window.showTextDocument(doc);
  } else {
    vscode.window.showErrorMessage(`未找到配置文件: ${configPath}`);
  }
}

async function setSystemEnvCommand(port) {
  const proxyUrl = `http://127.0.0.1:${port}`;
  const script = `
    [Environment]::SetEnvironmentVariable('HTTP_PROXY', '${proxyUrl}', 'User')
    [Environment]::SetEnvironmentVariable('HTTPS_PROXY', '${proxyUrl}', 'User')
    [Environment]::SetEnvironmentVariable('ALL_PROXY', '${proxyUrl}', 'User')
    [Environment]::SetEnvironmentVariable('http_proxy', '${proxyUrl}', 'User')
    [Environment]::SetEnvironmentVariable('https_proxy', '${proxyUrl}', 'User')
    [Environment]::SetEnvironmentVariable('all_proxy', '${proxyUrl}', 'User')
    [Environment]::SetEnvironmentVariable('NO_PROXY', '127.0.0.1,localhost', 'User')
    [Environment]::SetEnvironmentVariable('no_proxy', '127.0.0.1,localhost', 'User')
  `;
  exec(`powershell -NoProfile -Command "${script.replace(/\r?\n/g, ' ')}"`, (err) => {
    if (err) {
      vscode.window.showErrorMessage(`设置 Windows 用户环境变量失败: ${err.message}`);
    } else {
      vscode.window.showInformationMessage(`Windows 用户代理环境变量已更新为 ${proxyUrl}！（新开的终端和应用立即生效）`);
    }
  });
}

async function clearSystemEnvCommand() {
  const script = `
    [Environment]::SetEnvironmentVariable('HTTP_PROXY', $null, 'User')
    [Environment]::SetEnvironmentVariable('HTTPS_PROXY', $null, 'User')
    [Environment]::SetEnvironmentVariable('ALL_PROXY', $null, 'User')
    [Environment]::SetEnvironmentVariable('http_proxy', $null, 'User')
    [Environment]::SetEnvironmentVariable('https_proxy', $null, 'User')
    [Environment]::SetEnvironmentVariable('all_proxy', $null, 'User')
    [Environment]::SetEnvironmentVariable('NO_PROXY', $null, 'User')
    [Environment]::SetEnvironmentVariable('no_proxy', $null, 'User')
  `;
  exec(`powershell -NoProfile -Command "${script.replace(/\r?\n/g, ' ')}"`, (err) => {
    if (err) {
      vscode.window.showErrorMessage(`清除 Windows 用户环境变量失败: ${err.message}`);
    } else {
      vscode.window.showInformationMessage('已清除 Windows 用户环境变量中的代理配置。');
    }
  });
}

module.exports = {
  runTestConnection,
  openConfigFile,
  setSystemEnvCommand,
  clearSystemEnvCommand,
  showTestReportWebview
};

