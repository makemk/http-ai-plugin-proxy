const vscode = require('vscode');
const http = require('http');

const NO_PROXY_LIST = [
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  '*.vscode-cdn.net',
  '*.vscode-webview.net',
  '*.vscode-unpkg.net',
  'vscode-cdn.net',
  'vscode-webview.net',
  'vscode-unpkg.net',
  '*.local'
];
const NO_PROXY_ENV_STR = NO_PROXY_LIST.join(',');

function getExtensionConfig() {
  const config = vscode.workspace.getConfiguration('httpAiProxy');
  return {
    enabled: config.get('enabled', true),
    configPath: config.get('configPath', ''),
    localPort: Number(config.get('localPort', 18889)) || 18889,
    autoConfigureVsCode: config.get('autoConfigureVsCode', true),
    tlsMinVersion: config.get('tlsMinVersion', 'TLSv1.3'),
    enableH2Multiplex: config.get('enableH2Multiplex', true),
    rejectUnauthorized: config.get('rejectUnauthorized', false),
    caCertPath: config.get('caCertPath', ''),
    enableConnectionPool: config.get('enableConnectionPool', true),
    threadPoolSize: Number(config.get('threadPoolSize', 0)) || 0,
    maxWarmSockets: Number(config.get('maxWarmSockets', 0)) || 0,
    bypassDomesticDomains: config.get('bypassDomesticDomains', true),
    customBypassList: config.get('customBypassList', []),
    updateSource: config.get('updateSource', ''),
    updateRepo: config.get('updateRepo', ''),
    customUpdateUrl: config.get('customUpdateUrl', ''),
    autoCheckUpdates: config.get('autoCheckUpdates', true)
  };
}

function applyEnvProxy(port) {
  const proxyUrl = `http://127.0.0.1:${port}`;
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.ALL_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.https_proxy = proxyUrl;
  process.env.all_proxy = proxyUrl;
  process.env.NO_PROXY = NO_PROXY_ENV_STR;
  process.env.no_proxy = NO_PROXY_ENV_STR;
}

function clearEnvProxy() {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.ALL_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.all_proxy;
}

function configureTerminalEnv(context, enable, port = 18889) {
  if (!context || !context.environmentVariableCollection) return;
  if (enable) {
    const proxyUrl = `http://127.0.0.1:${port}`;
    context.environmentVariableCollection.replace('HTTP_PROXY', proxyUrl);
    context.environmentVariableCollection.replace('HTTPS_PROXY', proxyUrl);
    context.environmentVariableCollection.replace('ALL_PROXY', proxyUrl);
    context.environmentVariableCollection.replace('http_proxy', proxyUrl);
    context.environmentVariableCollection.replace('https_proxy', proxyUrl);
    context.environmentVariableCollection.replace('all_proxy', proxyUrl);
    context.environmentVariableCollection.replace('NO_PROXY', NO_PROXY_ENV_STR);
    context.environmentVariableCollection.replace('no_proxy', NO_PROXY_ENV_STR);
    context.environmentVariableCollection.description = 'HTTP AI 插件代理网关已激活';
  } else {
    context.environmentVariableCollection.clear();
  }
}

async function configureVsCodeProxy(enable, port = 18889, context = null, logger = null) {
  const httpConfig = vscode.workspace.getConfiguration('http');
  const proxyUrl = `http://127.0.0.1:${port}`;

  if (enable) {
    await httpConfig.update('proxy', proxyUrl, vscode.ConfigurationTarget.Global);
    await httpConfig.update('proxySupport', 'on', vscode.ConfigurationTarget.Global);
    await httpConfig.update('proxyStrictSSL', false, vscode.ConfigurationTarget.Global);
    await httpConfig.update('noProxy', NO_PROXY_LIST, vscode.ConfigurationTarget.Global);
    applyEnvProxy(port);
    configureTerminalEnv(context, true, port);
    logger?.appendLine?.(`[Config] Configured VS Code http.proxy -> ${proxyUrl}, proxySupport -> on, noProxy updated`);
  } else {
    const currentProxy = httpConfig.get('proxy');
    if (currentProxy === proxyUrl || currentProxy === `http://127.0.0.1:${port}`) {
      await httpConfig.update('proxy', undefined, vscode.ConfigurationTarget.Global);
      await httpConfig.update('noProxy', undefined, vscode.ConfigurationTarget.Global);
      logger?.appendLine?.('[Config] Removed VS Code http.proxy setting');
    }
    clearEnvProxy();
    configureTerminalEnv(context, false, port);
  }
}

function checkProxyHealth(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/health`, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const json = JSON.parse(data);
            resolve({ alive: true, data: json });
          } else {
            resolve({ alive: false, error: `HTTP ${res.statusCode}` });
          }
        } catch (e) {
          resolve({ alive: false, error: e.message });
        }
      });
    });
    req.on('error', (err) => {
      resolve({ alive: false, error: err.message, code: err.code });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ alive: false, error: 'Health check timeout' });
    });
  });
}

module.exports = {
  NO_PROXY_LIST,
  getExtensionConfig,
  applyEnvProxy,
  clearEnvProxy,
  configureTerminalEnv,
  configureVsCodeProxy,
  checkProxyHealth
};

