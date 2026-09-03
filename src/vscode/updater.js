const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const url = require('url');

/**
 * Compare two semver strings: '1.0.1' vs '1.0.0'
 * Returns: 1 if vA > vB, -1 if vA < vB, 0 if equal
 */
function compareVersions(vA, vB) {
  const clean = (v) => String(v).replace(/^[vV]/, '').trim().split('.').map(n => parseInt(n, 10) || 0);
  const pA = clean(vA);
  const pB = clean(vB);
  const len = Math.max(pA.length, pB.length);
  for (let i = 0; i < len; i++) {
    const a = pA[i] || 0;
    const b = pB[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/**
 * Smart Update Source Parser
 * Supports:
 * - Full GitHub URL: https://github.com/username/repo
 * - Short GitHub repo: username/repo
 * - Custom VPS URL: http://your-ip:port/version.json or https://domain.com/version.json
 */
function parseUpdateSource(rawSource) {
  if (!rawSource) return { type: null };
  const s = String(rawSource).trim();

  // GitHub full URL or git URL
  if (s.includes('github.com')) {
    const match = s.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) {
      return { type: 'github', repo: `${match[1]}/${match[2]}` };
    }
  }

  // Short GitHub format: owner/repo
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(s)) {
    return { type: 'github', repo: s };
  }

  // Custom HTTP/HTTPS endpoint
  if (s.startsWith('http://') || s.startsWith('https://')) {
    return { type: 'custom', url: s };
  }

  return { type: null };
}

/**
 * Fetch JSON with HTTP redirect and proxy support
 */
function fetchJson(targetUrl, proxyPort = 18889, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error('Too many HTTP redirects'));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';

    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'HTTP-AI-Proxy-Updater/1.0.0',
        'Accept': 'application/json, text/plain, */*'
      }
    };

    const client = isHttps ? https : http;
    const req = client.request(options, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, targetUrl).toString();
        return fetchJson(redirectUrl, proxyPort, redirectCount + 1).then(resolve).catch(reject);
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Failed to parse JSON response: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

/**
 * Download a remote binary file (e.g. .vsix) following all redirects
 */
function downloadBinary(fileUrl, destPath, progressCb = null, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error('Too many redirects while downloading'));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(fileUrl);
    const isHttps = parsed.protocol === 'https:';

    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'HTTP-AI-Proxy-Updater/1.0.0',
        'Accept': 'application/octet-stream, */*'
      }
    };

    const client = isHttps ? https : http;
    const req = client.request(options, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, fileUrl).toString();
        return downloadBinary(redirectUrl, destPath, progressCb, redirectCount + 1).then(resolve).catch(reject);
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Download failed with status ${res.statusCode}`));
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      const fileStream = fs.createWriteStream(destPath);

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0 && typeof progressCb === 'function') {
          const percent = Math.round((downloadedBytes / totalBytes) * 100);
          progressCb(percent, downloadedBytes, totalBytes);
        }
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => resolve(destPath));
      });

      fileStream.on('error', (err) => {
        try { fs.unlinkSync(destPath); } catch (_) {}
        reject(err);
      });
    });

    req.on('error', (err) => {
      try { fs.unlinkSync(destPath); } catch (_) {}
      reject(err);
    });

    req.setTimeout(30000, () => {
      req.destroy(new Error('Download timeout'));
    });

    req.end();
  });
}

/**
 * Main Check & Update Handler
 */
async function checkForUpdates(context, isManual = false, options = {}) {
  const currentVersion = context.extension?.packageJSON?.version || '1.0.0';
  const config = vscode.workspace.getConfiguration('httpAiProxy');

  let rawSource = (
    config.get('updateSource', '') ||
    config.get('updateRepo', '') ||
    config.get('customUpdateUrl', '') ||
    ''
  ).trim();

  // Also fallback to deployment.local.json
  if (!rawSource && options.configPath && fs.existsSync(options.configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(options.configPath, 'utf8'));
      if (raw.update?.source) rawSource = raw.update.source;
      else if (raw.update?.github_repo) rawSource = raw.update.github_repo;
      else if (raw.update?.custom_url) rawSource = raw.update.custom_url;
    } catch (_) {}
  }

  let parsed = parseUpdateSource(rawSource);

  // If not configured and manually clicked, pop up convenient input dialog
  if (!parsed.type) {
    if (isManual) {
      const input = await vscode.window.showInputBox({
        title: '配置 HTTP AI 插件代理更新源',
        prompt: '直接粘贴完整 GitHub 链接或自定义服务器链接（下次自动检测）',
        placeHolder: '例如: https://github.com/用户名/仓库名  或者  http://107.xxx.xxx.xxx/version.json',
        ignoreFocusOut: true
      });

      if (input && input.trim()) {
        const cleanInput = input.trim();
        await config.update('updateSource', cleanInput, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`更新源已保存为: ${cleanInput}，正在开始检测更新...`);
        parsed = parseUpdateSource(cleanInput);
        if (!parsed.type) {
          vscode.window.showErrorMessage('输入的地址格式无法识别，请确保为完整 GitHub 链接或 http/https 链接。');
          return;
        }
      } else {
        return;
      }
    } else {
      return;
    }
  }

  const localPort = Number(config.get('localPort', 18889)) || 18889;
  let updateInfo = null;

  try {
    if (parsed.type === 'custom') {
      // Mode 1: Custom JSON endpoint
      const res = await fetchJson(parsed.url, localPort);
      if (res && res.version && res.vsixUrl) {
        updateInfo = {
          version: res.version,
          downloadUrl: res.vsixUrl,
          changelog: res.changelog || '常规性能提升与稳定性修复',
          source: '自定义服务器源'
        };
      }
    } else if (parsed.type === 'github') {
      // Mode 2: GitHub Releases
      const apiUrl = `https://api.github.com/repos/${parsed.repo}/releases/latest`;
      const res = await fetchJson(apiUrl, localPort);

      if (res && res.tag_name) {
        const latestTag = res.tag_name;
        const vsixAsset = (res.assets || []).find(a => a.name.endsWith('.vsix'));

        if (vsixAsset && vsixAsset.browser_download_url) {
          updateInfo = {
            version: latestTag.replace(/^[vV]/, ''),
            downloadUrl: vsixAsset.browser_download_url,
            changelog: res.body || '常规性能提升与稳定性修复',
            source: `GitHub (${parsed.repo})`
          };
        }
      }
    }
  } catch (err) {
    if (isManual) {
      vscode.window.showErrorMessage(`检查更新失败: ${err.message}`);
    }
    return;
  }

  if (!updateInfo) {
    if (isManual) {
      vscode.window.showInformationMessage('未在更新源中检测到有效的 Release 版本或未上传 .vsix 安装包。');
    }
    return;
  }

  // Version Comparison
  const hasNewer = compareVersions(updateInfo.version, currentVersion) > 0;

  if (!hasNewer) {
    if (isManual) {
      vscode.window.showInformationMessage(`当前已是最新版本 (v${currentVersion})，无需更新！`);
    }
    return;
  }

  // Prompt user to update
  const confirm = await vscode.window.showInformationMessage(
    `发现新版本 v${updateInfo.version} (${updateInfo.source})！\n更新日志: ${updateInfo.changelog.slice(0, 100)}...\n是否立即自动下载并安装？`,
    '立即自动更新',
    '稍后再说'
  );

  if (confirm !== '立即自动更新') return;

  // Execute download and silent installation
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `正在下载 HTTP AI 插件代理 v${updateInfo.version}...`,
    cancellable: false
  }, async (progress) => {
    const tempFile = path.join(os.tmpdir(), `http-ai-plugin-proxy-${updateInfo.version}-${Date.now()}.vsix`);

    try {
      progress.report({ message: '正在从更新源下载 .vsix 安装包...' });
      await downloadBinary(updateInfo.downloadUrl, tempFile, (percent) => {
        progress.report({ message: `下载进度: ${percent}%` });
      });

      progress.report({ message: '下载完成，正在静默安装至 VS Code...' });
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(tempFile));

      try { fs.unlinkSync(tempFile); } catch (_) {}

      const reloadAction = await vscode.window.showInformationMessage(
        `🎉 HTTP AI 插件代理已成功更新至 v${updateInfo.version}！请重载窗口以应用最新版本。`,
        '立即重载窗口',
        '稍后手动重载'
      );

      if (reloadAction === '立即重载窗口') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    } catch (err) {
      try { fs.unlinkSync(tempFile); } catch (_) {}
      vscode.window.showErrorMessage(`自动更新失败: ${err.message}`);
    }
  });
}

module.exports = {
  checkForUpdates,
  compareVersions,
  parseUpdateSource
};
