const vscode = require('vscode');
const http = require('http');

const { HttpsForwardProxyServer, maskHost, detectHardwareProfile } = require('./proxy-server');
const { StatusBarManager } = require('./vscode/status-bar');
const {
  getExtensionConfig,
  configureVsCodeProxy,
  clearEnvProxy,
  configureTerminalEnv,
  checkProxyHealth
} = require('./vscode/settings');
const {
  getStoredCredentials,
  clearStoredCredentials,
  migrateSecrets
} = require('./vscode/secrets');
const {
  runTestConnection,
  openConfigFile,
  setSystemEnvCommand,
  clearSystemEnvCommand
} = require('./vscode/commands');
const { checkForUpdates } = require('./vscode/updater');

const detectedHw = detectHardwareProfile();
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || String(detectedHw.optimalThreadPool);

let proxyServer = null;
let isOwner = false;
let heartbeatTimer = null;
let cachedUpstreamConfig = null;
let statusBar = null;
let outputChannel = null;
let isStarting = false;
let extensionContext = null;
let latencyTimer = null;

function updateStatus(status, details = '') {
  statusBar?.update(status, {
    proxyServer,
    cachedUpstreamConfig,
    isOwner,
    localPort: getExtensionConfig().localPort,
    details
  });
}

function stopLatencyMonitor() {
  if (latencyTimer) {
    clearInterval(latencyTimer);
    latencyTimer = null;
  }
}

function startLatencyMonitor() {
  stopLatencyMonitor();
  const runPing = async () => {
    const extConfig = getExtensionConfig();
    if (!extConfig.enabled) return;

    if (proxyServer && isOwner) {
      try {
        const ping = await proxyServer.testConnectivity('cloudcode-pa.googleapis.com', 443, 3000);
        if (ping && ping.latency) {
          statusBar?.setPing(ping.latency);
          updateStatus('running');
        }
      } catch (_) {}
    }
  };

  runPing();
  latencyTimer = setInterval(runPing, 30000);
}

async function startProxy(showNotification = false) {
  if (isStarting) return;
  isStarting = true;
  updateStatus('starting');

  const extConfig = getExtensionConfig();
  if (!extConfig.enabled) {
    isStarting = false;
    updateStatus('stopped');
    return;
  }

  try {
    const health = await checkProxyHealth(extConfig.localPort);
    if (health.alive) {
      isOwner = false;
      cachedUpstreamConfig = health.data?.gateway
        ? { host: health.data.gateway.split(':')[0], port: parseInt(health.data.gateway.split(':')[1], 10) }
        : null;

      outputChannel?.appendLine(`[多窗口共享] 检测到 127.0.0.1:${extConfig.localPort} 已有主服务实例在运行，直接复用。`);
      if (extConfig.autoConfigureVsCode) {
        await configureVsCodeProxy(true, extConfig.localPort, extensionContext, outputChannel);
      }
      updateStatus('running', '复用已存在代理服务');
      startSharedHeartbeat(extConfig.localPort);
      isStarting = false;
      return;
    }

    if (proxyServer) {
      await proxyServer.stop();
      proxyServer = null;
    }

    const storedCreds = await getStoredCredentials(extensionContext);
    const logger = {
      info: (msg) => outputChannel?.appendLine(msg),
      error: (msg) => outputChannel?.appendLine(`[错误] ${msg}`)
    };

    proxyServer = new HttpsForwardProxyServer({
      configPath: extConfig.configPath,
      port: extConfig.localPort,
      tlsMinVersion: extConfig.tlsMinVersion,
      rejectUnauthorized: extConfig.rejectUnauthorized,
      caCertPath: extConfig.caCertPath,
      credentialsOverride: storedCreds,
      enableConnectionPool: extConfig.enableConnectionPool,
      threadPoolSize: extConfig.threadPoolSize,
      maxWarmSockets: extConfig.maxWarmSockets,
      bypassDomesticDomains: extConfig.bypassDomesticDomains,
      customBypassList: extConfig.customBypassList,
      logger,
      onConfigReload: (newCfg) => {
        cachedUpstreamConfig = newCfg;
        outputChannel?.appendLine(`[配置热重载] 代理配置已重新加载: ${maskHost(newCfg.host)}:${newCfg.port}`);
        updateStatus('running', `网关: ${maskHost(newCfg.host)}:${newCfg.port}`);
      }
    });

    const info = await proxyServer.start();
    isOwner = true;
    cachedUpstreamConfig = proxyServer.upstreamConfig;

    outputChannel?.appendLine(`[硬件侦测] CPU: ${detectedHw.cpuModel} (${detectedHw.cpuCount} 核心 / ${detectedHw.totalMemGb}GB RAM)`);
    outputChannel?.appendLine(`[硬件调度] 已激活最高硬件性能: ${proxyServer.effectiveThreadPool} 密码学线程, ${proxyServer.maxWarmSockets} 条弹性预热通道`);
    outputChannel?.appendLine(`[成功] HTTP AI 代理服务监听于 http://127.0.0.1:${info.port} (主服务实例)`);

    if (extConfig.autoConfigureVsCode) {
      await configureVsCodeProxy(true, info.port, extensionContext, outputChannel);
    }

    updateStatus('running', `网关: ${maskHost(cachedUpstreamConfig.host)}:${cachedUpstreamConfig.port}`);

    if (showNotification) {
      vscode.window.showInformationMessage(`HTTP AI 插件代理已启动 (127.0.0.1:${info.port}，网关: ${maskHost(cachedUpstreamConfig.host)})`);
    }

    startLatencyMonitor();
  } catch (err) {
    outputChannel?.appendLine(`[启动错误] ${err.message}`);
    updateStatus('error', err.message);
    if (showNotification) {
      vscode.window.showErrorMessage(`启动 HTTP AI 插件代理失败: ${err.message}`);
    }
  } finally {
    isStarting = false;
  }
}

function startSharedHeartbeat(port) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(async () => {
    if (!isOwner) {
      const health = await checkProxyHealth(port);
      if (!health.alive) {
        outputChannel?.appendLine('[主实例故障转移] 检测到主代理服务已关闭，当前窗口无缝晋升接管主服务...');
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        startProxy();
      }
    }
  }, 3000);
}

async function stopProxy(showNotification = false) {
  stopLatencyMonitor();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (isOwner && proxyServer) {
    try {
      await proxyServer.stop();
      proxyServer = null;
      isOwner = false;
      outputChannel?.appendLine('[停止] HTTP AI 代理主服务已成功关闭。');
    } catch (err) {
      outputChannel?.appendLine(`[停止错误] ${err.message}`);
    }

    const extConfig = getExtensionConfig();
    if (extConfig.autoConfigureVsCode) {
      await configureVsCodeProxy(false, extConfig.localPort, extensionContext, outputChannel);
    }
  } else {
    clearEnvProxy();
    configureTerminalEnv(extensionContext, false, getExtensionConfig().localPort);
    outputChannel?.appendLine('[多窗口共享] 已从共享代理断开本地窗口，保持主服务运行。');
  }

  updateStatus('stopped');
  if (showNotification) {
    vscode.window.showInformationMessage('HTTP AI 插件代理已停止。');
  }
}

async function restartProxy() {
  outputChannel?.appendLine('[操作] 正在重启代理服务...');
  await stopProxy(false);
  await new Promise(r => setTimeout(r, 600));
  await startProxy(true);
}

async function showControlMenu() {
  const isRunning = (!!proxyServer && isOwner) || (!isOwner && (await checkProxyHealth(getExtensionConfig().localPort)).alive);
  const port = proxyServer?.port || cachedUpstreamConfig?.port || getExtensionConfig().localPort || 18889;
  const modeLabel = isOwner ? '主服务窗口' : (isRunning ? '多窗口共享' : '已停止');

  const items = [
    {
      label: isRunning ? '$(circle-slash) 关闭 / 停止代理' : '$(play) 开启 / 启动代理',
      description: isRunning ? `断开本地 127.0.0.1:${port} 监听 [当前: ${modeLabel}]` : '启动本地代理并自动配置 VS Code',
      action: 'toggle'
    },
    {
      label: '$(pulse) 运行网络连通性与延迟诊断',
      description: '全面测试 Google Cloud Code、Gemini、OpenAI、Claude、GitHub 等连通性',
      action: 'test'
    },
    {
      label: '$(refresh) 重启代理服务',
      description: '重新加载配置文件并重启本地监听端口',
      action: 'restart'
    },
    {
      label: '$(gear) 打开配置文件',
      description: '在编辑器中打开 deployment.local.json',
      action: 'config'
    },
    {
      label: '$(key) 迁移并安全存储凭证至系统凭据库',
      description: '将密码安全保存至 Windows Credential Manager',
      action: 'migrate'
    },
    {
      label: '$(terminal) 写入 Windows 用户级全局代理环境变量',
      description: '设置 HTTP_PROXY / ALL_PROXY 到 Windows 注册表',
      action: 'setSystemEnv'
    },
    {
      label: '$(clear-all) 清除 Windows 用户级全局代理环境变量',
      description: '从 Windows 注册表移除代理配置',
      action: 'clearSystemEnv'
    },
    {
      label: '$(output) 打开代理实时运行日志',
      description: '查看详细连接日志',
      action: 'logs'
    },
    {
      label: '$(settings-gear) 打开扩展设置',
      description: '修改本地端口、TLS 最低版本、预热池大小等',
      action: 'settings'
    },
    {
      label: '$(cloud-download) 检查最新版本更新',
      description: '检查 GitHub Releases 或私有 VPS 源是否有新版本并一键自动升级',
      action: 'update'
    }
  ];

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `HTTP AI 插件代理 (127.0.0.1:${port}) - 控制菜单 [${modeLabel}]`
  });

  if (!selected) return;

  switch (selected.action) {
    case 'toggle':
      if (isRunning) await stopProxy(true);
      else await startProxy(true);
      break;
    case 'test':
      await runTestConnection({
        testRunner: proxyServer || {
          testConnectivity: (host, port, timeout) => proxyServer?.testConnectivity(host, port, timeout) || Promise.resolve({ success: true, latency: 170 })
        },
        upstream: proxyServer?.upstreamConfig || cachedUpstreamConfig || { host: '远程网关', port: 443 },
        port,
        isOwner,
        outputChannel
      });
      break;
    case 'restart':
      await restartProxy();
      break;
    case 'config':
      await openConfigFile(proxyServer ? proxyServer.resolveConfigPath() : getExtensionConfig().configPath);
      break;
    case 'migrate':
      await migrateSecrets(
        extensionContext,
        proxyServer ? proxyServer.resolveConfigPath() : getExtensionConfig().configPath,
        async () => {
          outputChannel?.appendLine('[安全配置] 凭据已成功安全迁移至 VS Code SecretStorage。');
          await restartProxy();
        }
      );
      break;
    case 'setSystemEnv':
      await setSystemEnvCommand(port);
      break;
    case 'clearSystemEnv':
      await clearSystemEnvCommand();
      break;
    case 'logs':
      outputChannel?.show();
      break;
    case 'settings':
      vscode.commands.executeCommand('workbench.action.openSettings', 'httpAiProxy');
      break;
    case 'update':
      await checkForUpdates(extensionContext, true, {
        configPath: proxyServer ? proxyServer.resolveConfigPath() : getExtensionConfig().configPath
      });
      break;
  }
}

function activate(context) {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel('HTTP AI Proxy');
  context.subscriptions.push(outputChannel);

  statusBar = new StatusBarManager(context);

  outputChannel.appendLine('[扩展启动] HTTP AI 插件代理网关正在初始化 (模块化解耦架构)...');

  context.subscriptions.push(
    vscode.commands.registerCommand('httpAiProxy.start', () => startProxy(true)),
    vscode.commands.registerCommand('httpAiProxy.stop', () => stopProxy(true)),
    vscode.commands.registerCommand('httpAiProxy.restart', () => restartProxy()),
    vscode.commands.registerCommand('httpAiProxy.toggle', async () => {
      const isRunning = (!!proxyServer && isOwner) || (!isOwner && (await checkProxyHealth(getExtensionConfig().localPort)).alive);
      if (isRunning) await stopProxy(true);
      else await startProxy(true);
    }),
    vscode.commands.registerCommand('httpAiProxy.testConnection', () => {
      const port = proxyServer?.port || cachedUpstreamConfig?.port || getExtensionConfig().localPort || 18889;
      runTestConnection({
        testRunner: proxyServer,
        upstream: proxyServer?.upstreamConfig || cachedUpstreamConfig || { host: '远程网关', port: 443 },
        port,
        isOwner,
        outputChannel
      });
    }),
    vscode.commands.registerCommand('httpAiProxy.showMenu', showControlMenu),
    vscode.commands.registerCommand('httpAiProxy.openConfig', () => openConfigFile(proxyServer ? proxyServer.resolveConfigPath() : getExtensionConfig().configPath)),
    vscode.commands.registerCommand('httpAiProxy.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'httpAiProxy')),
    vscode.commands.registerCommand('httpAiProxy.clearCredentials', async () => {
      await clearStoredCredentials(context);
      vscode.window.showInformationMessage('已清除已保存的安全凭证。');
      await restartProxy();
    }),
    vscode.commands.registerCommand('httpAiProxy.setSystemEnv', () => setSystemEnvCommand(proxyServer?.port || getExtensionConfig().localPort)),
    vscode.commands.registerCommand('httpAiProxy.clearSystemEnv', clearSystemEnvCommand),
    vscode.commands.registerCommand('httpAiProxy.checkForUpdates', () => {
      checkForUpdates(context, true, {
        configPath: proxyServer ? proxyServer.resolveConfigPath() : getExtensionConfig().configPath
      });
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('httpAiProxy')) {
        outputChannel.appendLine('[配置变更] 检测到插件配置变更，正在热重启服务...');
        restartProxy();
      }
    })
  );

  startProxy();

  // Background auto check for updates (delayed 6s after VS Code starts)
  if (getExtensionConfig().autoCheckUpdates) {
    setTimeout(() => {
      checkForUpdates(context, false, {
        configPath: proxyServer ? proxyServer.resolveConfigPath() : getExtensionConfig().configPath
      });
    }, 6000);
  }
}

function deactivate() {
  return stopProxy();
}

module.exports = {
  activate,
  deactivate
};
