const vscode = require('vscode');
const fs = require('fs');

/**
 * SecretStorage Credential Manager
 * Securely stores gateway credentials inside Windows Credential Manager / OS Keychain.
 */
async function getStoredCredentials(context) {
  if (!context || !context.secrets) return null;
  const username = (await context.secrets.get('http_ai_proxy.username')) || (await context.secrets.get('antigravity_proxy.username'));
  const password = (await context.secrets.get('http_ai_proxy.password')) || (await context.secrets.get('antigravity_proxy.password'));
  const usageReportToken = (await context.secrets.get('http_ai_proxy.usageReportToken')) || (await context.secrets.get('antigravity_proxy.usageReportToken'));
  if (username && password) {
    return { username, password, usageReportToken };
  }
  return null;
}

async function storeCredentials(context, { username, password, usageReportToken }) {
  if (!context || !context.secrets) return;
  if (username) await context.secrets.store('http_ai_proxy.username', username);
  if (password) await context.secrets.store('http_ai_proxy.password', password);
  if (usageReportToken) await context.secrets.store('http_ai_proxy.usageReportToken', usageReportToken);
}

async function clearStoredCredentials(context) {
  if (!context || !context.secrets) return;
  await context.secrets.delete('http_ai_proxy.username');
  await context.secrets.delete('http_ai_proxy.password');
  await context.secrets.delete('http_ai_proxy.usageReportToken');
  try {
    await context.secrets.delete('antigravity_proxy.username');
    await context.secrets.delete('antigravity_proxy.password');
    await context.secrets.delete('antigravity_proxy.usageReportToken');
  } catch (_) {}
}

async function migrateSecrets(context, configPath, onMigrated) {
  if (!configPath || !fs.existsSync(configPath)) {
    vscode.window.showErrorMessage(`未找到配置文件: ${configPath}`);
    return;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    const json = JSON.parse(raw);

    if (!json.username || !json.password) {
      vscode.window.showWarningMessage('配置文件中未检测到用户名或密码，无需迁移。');
      return;
    }

    await storeCredentials(context, {
      username: json.username,
      password: json.password,
      usageReportToken: json.usageReportToken
    });

    const choice = await vscode.window.showInformationMessage(
      '凭证已成功安全保存至 VS Code 凭据库（Windows 凭据管理器）。是否立即从 deployment.local.json 中抹除明文密码？',
      '立即抹除明文密码',
      '保留配置文件现状'
    );

    if (choice === '立即抹除明文密码') {
      const sanitized = { ...json };
      delete sanitized.password;
      if (sanitized.usageReportToken) {
        delete sanitized.usageReportToken;
      }
      fs.writeFileSync(configPath, JSON.stringify(sanitized, null, 2), 'utf8');
      vscode.window.showInformationMessage('明文密码已从 deployment.local.json 中安全移除，代理以后将直接从系统凭据库读取。');
    }

    if (typeof onMigrated === 'function') {
      await onMigrated();
    }
  } catch (e) {
    vscode.window.showErrorMessage(`迁移凭据失败: ${e.message}`);
  }
}

module.exports = {
  getStoredCredentials,
  storeCredentials,
  clearStoredCredentials,
  migrateSecrets
};

