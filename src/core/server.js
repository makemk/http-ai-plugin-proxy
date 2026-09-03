const net = require('net');
const tls = require('tls');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream');

const { maskHost } = require('../utils/mask');
const { detectHardwareProfile } = require('../network/hardware');
const { FastDnsCache } = require('../network/dns-cache');
const { isLoopback, isAiDomain, isDirectBypass } = require('../network/domain-matcher');
const { WarmPoolManager } = require('./warm-pool');
const { bridgeSockets } = require('./tunnel-bridge');
const { handleTunnelWithFailover } = require('./failover');

class HttpsForwardProxyServer {
  constructor(options = {}) {
    this.configPath = options.configPath || null;
    this.upstreamConfig = options.upstreamConfig || null;
    this.port = options.port !== undefined ? options.port : 18889;
    this.host = options.host || '127.0.0.1';
    this.logger = options.logger || console;
    this.tlsMinVersion = options.tlsMinVersion || 'TLSv1.2';
    this.rejectUnauthorized = options.rejectUnauthorized !== undefined ? options.rejectUnauthorized : false;
    this.caCertPath = options.caCertPath || null;
    this.credentialsOverride = options.credentialsOverride || null;
    this.server = null;
    this.activeSockets = new Set();
    this.fileWatcher = null;
    this.onConfigReload = options.onConfigReload || null;
    this.stats = {
      totalRequests: 0,
      activeRequests: 0,
      connectTunnels: 0,
      httpRequests: 0,
      bytesUpstream: 0,
      bytesDownstream: 0,
      errors: 0,
      aiTunnels: 0,
      autoHeals: 0,
      startTime: null
    };

    this.enableConnectionPool = options.enableConnectionPool !== undefined ? options.enableConnectionPool : true;
    this.bypassDomesticDomains = options.bypassDomesticDomains !== undefined ? options.bypassDomesticDomains : true;
    this.customBypassList = Array.isArray(options.customBypassList) ? options.customBypassList : [];

    this.hardwareProfile = detectHardwareProfile();
    const configuredThreads = options.threadPoolSize && options.threadPoolSize > 0
      ? options.threadPoolSize
      : this.hardwareProfile.optimalThreadPool;
    this.effectiveThreadPool = configuredThreads;
    process.env.UV_THREADPOOL_SIZE = String(configuredThreads);

    const configuredMaxWarm = options.maxWarmSockets && options.maxWarmSockets > 0
      ? options.maxWarmSockets
      : this.hardwareProfile.optimalMaxWarmSockets;

    this.maxWarmSockets = configuredMaxWarm;
    this.minWarmSockets = options.minWarmSockets || Math.min(2, configuredMaxWarm);

    this.warmPool = new WarmPoolManager({
      enableConnectionPool: this.enableConnectionPool,
      minWarmSockets: this.minWarmSockets,
      maxWarmSockets: this.maxWarmSockets,
      activeSockets: this.activeSockets,
      logger: this.logger
    });

    this.dnsCache = new FastDnsCache();
    this.isStopping = false;
  }

  get warmSockets() {
    return this.warmPool.warmSockets;
  }

  isAiDomain(host) {
    return isAiDomain(host);
  }

  isLoopback(host) {
    return isLoopback(host);
  }

  isDirectBypass(host) {
    return isDirectBypass(host, {
      bypassDomesticDomains: this.bypassDomesticDomains,
      customBypassList: this.customBypassList
    });
  }

  getTlsOptions() {
    const opts = {
      host: this.upstreamConfig.host,
      port: this.upstreamConfig.port,
      minVersion: this.tlsMinVersion || 'TLSv1.2',
      rejectUnauthorized: Boolean(this.rejectUnauthorized),
      ciphers: [
        'TLS_AES_128_GCM_SHA256',
        'TLS_AES_256_GCM_SHA384',
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384'
      ].join(':'),
      honorCipherOrder: true
    };

    if (this.caCertPath && fs.existsSync(this.caCertPath)) {
      try {
        opts.ca = fs.readFileSync(this.caCertPath);
      } catch (err) {
        this.logger.error?.(`[CA Cert Error] Failed to load CA certificate from ${this.caCertPath}: ${err.message}`);
      }
    }

    if (this.warmPool.tlsSession) {
      opts.session = this.warmPool.tlsSession;
    }

    return opts;
  }

  resolveConfigPath() {
    if (this.configPath && fs.existsSync(this.configPath)) {
      return path.resolve(this.configPath);
    }
    const homeDir = os.homedir();
    const candidatePaths = [
      path.join(homeDir, '.browser-gateway', 'deployment.local.json'),
      path.join(homeDir, 'deployment.local.json'),
      path.join(__dirname, '..', '..', 'deployment.local.json')
    ];
    for (const candidate of candidatePaths) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  loadConfig() {
    if (this.upstreamConfig && !this.configPath) {
      return this.upstreamConfig;
    }
    const resolvedPath = this.resolveConfigPath();
    if (!resolvedPath) {
      throw new Error('Upstream gateway configuration file not found (checked standard locations)');
    }
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = JSON.parse(raw);
      const serverConfig = parsed.server || parsed;
      this.upstreamConfig = {
        host: serverConfig.public_ip || serverConfig.ip || serverConfig.host || '127.0.0.1',
        port: parseInt(serverConfig.https_port || serverConfig.port || 443, 10),
        username: this.credentialsOverride?.username || serverConfig.username || serverConfig.user || 'gateway',
        password: this.credentialsOverride?.password || serverConfig.password || serverConfig.pass || ''
      };
      return this.upstreamConfig;
    } catch (err) {
      throw new Error(`Failed to parse gateway config file: ${err.message}`);
    }
  }

  watchConfigFile() {
    const resolvedPath = this.resolveConfigPath();
    if (!resolvedPath || this.fileWatcher) return;
    try {
      let reloadTimeout = null;
      this.fileWatcher = fs.watch(resolvedPath, (eventType) => {
        if (eventType === 'change' || eventType === 'rename') {
          clearTimeout(reloadTimeout);
          reloadTimeout = setTimeout(() => {
            try {
              const oldConfig = JSON.stringify(this.upstreamConfig);
              this.loadConfig();
              if (JSON.stringify(this.upstreamConfig) !== oldConfig) {
                this.warmPool.clear();
                this.warmPool.isStopping = false;
                this.warmPool.replenishWarmPool(this.getTlsOptions(), this.stats.activeRequests);
                if (typeof this.onConfigReload === 'function') {
                  this.onConfigReload(this.upstreamConfig);
                }
              }
            } catch (_) {}
          }, 500);
        }
      });
    } catch (_) {}
  }

  getAuthHeader() {
    const cfg = this.upstreamConfig || this.loadConfig();
    return 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
  }

  async start() {
    this.loadConfig();
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleHttpRequest(req, res));
      this.server.on('connect', (req, clientSocket, head) => this.handleConnectRequest(req, clientSocket, head));
      this.server.on('upgrade', (req, clientSocket, head) => this.handleUpgradeRequest(req, clientSocket, head));
      this.server.on('error', (err) => {
        this.logger.error?.(`[Proxy Server Listener Error] ${err.message}`);
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        const address = this.server.address();
        this.stats.startTime = new Date();
        this.port = typeof address === 'object' ? address.port : this.port;
        this.logger.info?.(`[Proxy Server] Active on http://${this.host}:${this.port} -> Gateway https://${maskHost(this.upstreamConfig.host)}:${this.upstreamConfig.port}`);
        this.warmPool.replenishWarmPool(this.getTlsOptions(), this.stats.activeRequests);
        this.watchConfigFile();
        resolve({ host: this.host, port: this.port });
      });
    });
  }

  async stop() {
    this.isStopping = true;
    if (this.dnsCache) {
      this.dnsCache.clear();
    }
    if (this.warmPool) {
      this.warmPool.clear();
    }
    return new Promise((resolve) => {
      if (this.fileWatcher) {
        try { this.fileWatcher.close(); } catch (_) {}
        this.fileWatcher = null;
      }
      for (const socket of this.activeSockets) {
        try { socket.destroy(); } catch (_) {}
      }
      this.activeSockets.clear();
      if (this.server) {
        this.server.close(() => {
          this.logger.info?.('[Proxy Server] Successfully stopped.');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  parseDestination(req) {
    let targetHost = '';
    let targetPort = 80;
    let targetPath = req.url;

    if (req.url && (req.url.startsWith('http://') || req.url.startsWith('https://') || req.url.startsWith('ws://') || req.url.startsWith('wss://'))) {
      try {
        const parsed = new URL(req.url);
        targetHost = parsed.hostname;
        targetPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : 80);
        targetPath = parsed.pathname + parsed.search;
      } catch (_) {}
    } else if (req.headers.host) {
      const hostParts = req.headers.host.split(':');
      targetHost = hostParts[0];
      targetPort = hostParts[1] ? parseInt(hostParts[1], 10) : 80;
    }
    return { targetHost, targetPort, targetPath };
  }

  async handleHttpRequest(req, res) {
    this.stats.totalRequests++;
    this.stats.httpRequests++;

    if (
      req.url === '/_health' ||
      req.url === '/health' ||
      req.url === '/ready' ||
      (req.headers.host === 'browser-ai-bridge.local' && req.url === '/ready')
    ) {
      const reqHost = (req.headers.host || '').split(':')[0].toLowerCase();
      const isAllowedHost = this.isLoopback(reqHost) || reqHost === 'browser-ai-bridge.local';
      if (!isAllowedHost) {
        res.writeHead(403, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
        res.end('403 Forbidden: Invalid Host header');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(JSON.stringify({
        status: 'ok',
        uptimeSeconds: Math.floor((Date.now() - (this.stats.startTime || Date.now())) / 1000),
        localPort: this.port,
        gateway: `${maskHost(this.upstreamConfig.host)}:${this.upstreamConfig.port}`,
        gatewayUser: this.upstreamConfig.username ? `${this.upstreamConfig.username.slice(0, 4)}***` : '***',
        tlsMinVersion: this.tlsMinVersion,
        hardware: {
          cpuModel: this.hardwareProfile.cpuModel,
          detectedCores: this.hardwareProfile.cpuCount,
          totalMemoryGb: this.hardwareProfile.totalMemGb,
          threadPoolThreads: this.effectiveThreadPool
        },
        warmPool: {
          enabled: this.enableConnectionPool,
          readySockets: this.warmSockets ? this.warmSockets.length : 0,
          minSockets: this.minWarmSockets,
          maxSockets: this.maxWarmSockets,
          targetSockets: this.warmPool.getDesiredWarmPoolSize(this.stats.activeRequests)
        },
        dnsCache: {
          enabled: true,
          cachedEntries: this.dnsCache ? this.dnsCache.cache.size : 0
        },
        aiStreamOptimization: {
          enabled: true,
          aiTunnelsHandled: this.stats.aiTunnels || 0,
          autoHeals: this.stats.autoHeals || 0,
          keepAliveIntervalSec: 3
        },
        domesticBypass: {
          enabled: this.bypassDomesticDomains,
          customRules: this.customBypassList.length
        },
        stats: this.stats
      }, null, 2));
      return;
    }

    if (req.url === '/gfwlist.txt' || req.url === '/rules.txt' || req.url === '/pac.txt') {
      const rawRules = [
        '[AutoProxy 0.2.9]',
        '! Title: AI & Dev Rules (Built-in)',
        '',
        '||claude.ai',
        '||anthropic.com',
        '||openai.com',
        '||chatgpt.com',
        '||oaistatic.com',
        '||oaiusercontent.com',
        '||googleapis.com',
        '||google.com',
        '||github.com',
        '||githubassets.com',
        '||githubusercontent.com',
        '||copilot.microsoft.com',
        '||cursor.com',
        '||v0.dev',
        '||perplexity.ai',
        '||sentry.io',
        '||gemini.google.com'
      ].join('\n');

      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(Buffer.from(rawRules).toString('base64'));
      return;
    }

    const { targetHost, targetPort, targetPath } = this.parseDestination(req);
    if (!targetHost) {
      res.writeHead(400, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
      res.end('400 Bad Request: Unable to determine target host');
      return;
    }

    if (this.isDirectBypass(targetHost)) {
      req.pause();
      const clientSocket = res.socket;
      this.activeSockets.add(clientSocket);

      const connectHost = this.isLoopback(targetHost) ? targetHost : (await this.dnsCache.resolve(targetHost));

      const localSocket = net.connect({
        host: connectHost,
        port: targetPort
      }, () => {
        localSocket.setNoDelay(true);
        localSocket.setKeepAlive(true, 15000);

        const cleanHeaders = { ...req.headers };
        delete cleanHeaders['proxy-authorization'];
        delete cleanHeaders['proxy-connection'];
        if (!cleanHeaders['host']) {
          cleanHeaders['host'] = targetPort === 80 ? targetHost : `${targetHost}:${targetPort}`;
        }

        let rawHeaders = `${req.method} ${targetPath} HTTP/1.1\r\n`;
        for (const [key, val] of Object.entries(cleanHeaders)) {
          if (Array.isArray(val)) {
            for (const v of val) rawHeaders += `${key}: ${v}\r\n`;
          } else if (val !== undefined) {
            rawHeaders += `${key}: ${val}\r\n`;
          }
        }
        rawHeaders += '\r\n';

        localSocket.write(rawHeaders);
        req.resume();
        pipeline(req, localSocket, () => {});
        pipeline(localSocket, clientSocket, () => {
          this.activeSockets.delete(clientSocket);
          this.activeSockets.delete(localSocket);
          try { clientSocket.destroy(); } catch (_) {}
          try { localSocket.destroy(); } catch (_) {}
        });
      });

      this.activeSockets.add(localSocket);
      localSocket.on('error', () => {
        try { clientSocket.destroy(); } catch (_) {}
        try { localSocket.destroy(); } catch (_) {}
      });
      return;
    }

    // Connect via upstream tunnel
    const auth = this.getAuthHeader();
    const connectPayload = [
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
      `Host: ${targetHost}:${targetPort}`,
      `Proxy-Authorization: ${auth}`,
      'Proxy-Connection: Keep-Alive',
      '',
      ''
    ].join('\r\n');

    req.pause();
    const clientSocket = res.socket;
    this.activeSockets.add(clientSocket);

    const warmSocket = this.warmPool.acquireWarmSocket(this.stats.activeRequests, () => {
      this.warmPool.replenishWarmPool(this.getTlsOptions(), this.stats.activeRequests);
    });

    let upstreamSocket;
    if (warmSocket) {
      upstreamSocket = warmSocket;
      upstreamSocket.write(connectPayload);
    } else {
      upstreamSocket = tls.connect(this.getTlsOptions(), () => {
        upstreamSocket.setNoDelay(true);
        upstreamSocket.setKeepAlive(true, 15000);
        upstreamSocket.write(connectPayload);
      });
      this.activeSockets.add(upstreamSocket);
    }

    let headerBuffer = '';
    let tunnelEstablished = false;

    const onUpstreamData = (chunk) => {
      if (!tunnelEstablished) {
        headerBuffer += chunk.toString('latin1');
        const headerEnd = headerBuffer.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          tunnelEstablished = true;
          upstreamSocket.removeListener('data', onUpstreamData);

          const statusLine = headerBuffer.split('\r\n')[0];
          const statusCode = parseInt(statusLine.split(' ')[1], 10);

          if (statusCode >= 200 && statusCode < 300) {
            const cleanHeaders = { ...req.headers };
            delete cleanHeaders['proxy-authorization'];
            delete cleanHeaders['proxy-connection'];
            if (!cleanHeaders['host']) {
              cleanHeaders['host'] = targetPort === 80 ? targetHost : `${targetHost}:${targetPort}`;
            }

            let rawHeaders = `${req.method} ${targetPath} HTTP/1.1\r\n`;
            for (const [key, val] of Object.entries(cleanHeaders)) {
              if (Array.isArray(val)) {
                for (const v of val) rawHeaders += `${key}: ${v}\r\n`;
              } else if (val !== undefined) {
                rawHeaders += `${key}: ${val}\r\n`;
              }
            }
            rawHeaders += '\r\n';

            upstreamSocket.write(rawHeaders);
            req.resume();

            pipeline(req, upstreamSocket, () => {});
            pipeline(upstreamSocket, clientSocket, () => {
              this.activeSockets.delete(clientSocket);
              this.activeSockets.delete(upstreamSocket);
              try { clientSocket.destroy(); } catch (_) {}
              try { upstreamSocket.destroy(); } catch (_) {}
            });
          } else {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`502 Bad Gateway: Upstream returned ${statusLine}`);
            try { clientSocket.destroy(); } catch (_) {}
            try { upstreamSocket.destroy(); } catch (_) {}
          }
        }
      }
    };

    upstreamSocket.on('data', onUpstreamData);
    upstreamSocket.on('error', () => {
      try { clientSocket.destroy(); } catch (_) {}
      try { upstreamSocket.destroy(); } catch (_) {}
    });
  }

  async handleConnectRequest(req, clientSocket, head) {
    this.stats.totalRequests++;
    this.stats.activeRequests++;
    this.stats.connectTunnels++;
    this.activeSockets.add(clientSocket);

    let targetHost = req.url;
    let targetPort = 443;

    if (req.url.includes(':')) {
      const lastColon = req.url.lastIndexOf(':');
      targetHost = req.url.slice(0, lastColon);
      targetPort = parseInt(req.url.slice(lastColon + 1), 10) || 443;
    }

    // Direct local / domestic bypass
    if (this.isDirectBypass(targetHost)) {
      clientSocket.setNoDelay(true);
      clientSocket.setKeepAlive(true, 15000);
      clientSocket.pause();

      const connectHost = this.isLoopback(targetHost) ? targetHost : (await this.dnsCache.resolve(targetHost));

      const localSocket = net.connect({
        host: connectHost,
        port: targetPort
      }, () => {
        localSocket.setNoDelay(true);
        localSocket.setKeepAlive(true, 15000);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: HTTP-AI-Bridge\r\n\r\n');
        if (head && head.length > 0) {
          localSocket.write(head);
        }
        clientSocket.resume();
        bridgeSockets(clientSocket, localSocket, () => {
          this.stats.activeRequests = Math.max(0, this.stats.activeRequests - 1);
        }, false, this.activeSockets);
      });

      this.activeSockets.add(localSocket);

      localSocket.on('error', (err) => {
        this.stats.errors++;
        if (clientSocket.writable) {
          try {
            clientSocket.resume();
            clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n${err.message}`);
          } catch (_) {}
        }
        this.activeSockets.delete(clientSocket);
        this.activeSockets.delete(localSocket);
        this.stats.activeRequests = Math.max(0, this.stats.activeRequests - 1);
        try { clientSocket.destroy(); } catch (_) {}
        try { localSocket.destroy(); } catch (_) {}
      });
      return;
    }

    // AI & general upstream CONNECT tunnel with transparent failover
    const isAi = this.isAiDomain(targetHost);
    if (isAi) {
      this.stats.aiTunnels = (this.stats.aiTunnels || 0) + 1;
    }

    clientSocket.setNoDelay(true);
    clientSocket.setKeepAlive(true, isAi ? 3000 : 15000);
    clientSocket.pause();

    handleTunnelWithFailover({
      clientSocket,
      targetHost,
      targetPort,
      head,
      isAi,
      authHeader: this.getAuthHeader(),
      tlsOptions: this.getTlsOptions(),
      warmPool: this.warmPool,
      activeSockets: this.activeSockets,
      stats: this.stats,
      logger: this.logger
    });
  }

  handleUpgradeRequest(req, clientSocket, head) {
    this.handleConnectRequest(req, clientSocket, head);
  }

  async testConnectivity(targetHost = 'api.anthropic.com', targetPort = 443, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let finished = false;

      const finish = (result) => {
        if (finished) return;
        finished = true;
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ success: false, status: null, latency: Date.now() - startTime, error: 'Connection timed out', host: targetHost });
      }, timeoutMs);

      try {
        const tlsOpts = this.getTlsOptions();
        const socket = tls.connect(tlsOpts, () => {
          clearTimeout(timer);
          const handshakeTime = Date.now() - startTime;
          const auth = this.getAuthHeader();
          const payload = [
            `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
            `Host: ${targetHost}:${targetPort}`,
            `Proxy-Authorization: ${auth}`,
            'Proxy-Connection: Keep-Alive',
            '',
            ''
          ].join('\r\n');

          socket.write(payload);
        });

        let responseBuffer = '';
        socket.on('data', (chunk) => {
          responseBuffer += chunk.toString('latin1');
          if (responseBuffer.includes('\r\n\r\n')) {
            const status = responseBuffer.split('\r\n')[0];
            const latency = Date.now() - startTime;
            socket.destroy();
            if (status.includes('200')) {
              finish({ success: true, status, latency, error: null, host: targetHost });
            } else {
              finish({ success: false, status, latency, error: status, host: targetHost });
            }
          }
        });

        socket.on('error', (err) => {
          clearTimeout(timer);
          finish({ success: false, status: null, latency: Date.now() - startTime, error: err.message, host: targetHost });
        });
      } catch (err) {
        clearTimeout(timer);
        finish({ success: false, status: null, latency: Date.now() - startTime, error: err.message, host: targetHost });
      }
    });
  }
}

module.exports = { HttpsForwardProxyServer };

