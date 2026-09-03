/**
 * Domain Matcher & Intelligent Traffic Routing Engine
 * Identifies AI endpoints, domestic development mirrors, loopback, and custom rules.
 */

const DOMESTIC_SUFFIXES = [
  '.cn',
  '.npmmirror.com',
  '.taobao.org',
  '.gitee.com',
  '.aliyun.com',
  '.aliyuncs.com',
  '.tencent.com',
  '.myqcloud.com',
  '.tsinghua.edu.cn',
  '.ustc.edu.cn',
  '.huaweicloud.com',
  '.baidubce.com',
  '.qq.com',
  '.baidu.com',
  '.163.com'
];

const AI_DOMAINS = [
  'anthropic.com',
  'claude.ai',
  'openai.com',
  'chatgpt.com',
  'oaistatic.com',
  'oaiusercontent.com',
  'generativelanguage.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'aiplatform.googleapis.com',
  'deepseek.com',
  'groq.com',
  'openrouter.ai',
  'perplexity.ai',
  'cursor.com',
  'cursor.sh'
];

function cleanHost(host) {
  if (!host) return '';
  return String(host).toLowerCase().trim().replace(/^\[|\]$/g, '');
}

function isLoopback(host) {
  const h = cleanHost(host);
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

function isAiDomain(host) {
  const h = cleanHost(host);
  if (!h) return false;
  for (const suffix of AI_DOMAINS) {
    if (h === suffix || h.endsWith('.' + suffix)) return true;
  }
  return false;
}

function isDomesticBypass(host, enabled = true) {
  if (!enabled) return false;
  const h = cleanHost(host);
  if (!h) return false;
  for (const suffix of DOMESTIC_SUFFIXES) {
    if (h === suffix.slice(1) || h.endsWith(suffix)) return true;
  }
  return false;
}

function isCustomBypass(host, customBypassList = []) {
  if (!customBypassList || !customBypassList.length) return false;
  const h = cleanHost(host);
  if (!h) return false;
  for (const pattern of customBypassList) {
    const p = String(pattern).toLowerCase().trim();
    if (!p) continue;
    if (p.startsWith('*.')) {
      if (h.endsWith(p.slice(1)) || h === p.slice(2)) return true;
    } else if (h === p) {
      return true;
    }
  }
  return false;
}

function isDirectBypass(host, options = {}) {
  const h = cleanHost(host);
  if (!h) return false;
  const bypassDomestic = options.bypassDomesticDomains !== undefined ? options.bypassDomesticDomains : true;
  const customList = Array.isArray(options.customBypassList) ? options.customBypassList : [];

  return (
    isLoopback(h) ||
    h.endsWith('.vscode-cdn.net') ||
    h.endsWith('.vscode-webview.net') ||
    h.endsWith('.vscode-unpkg.net') ||
    h.endsWith('.vscode-resource.vscode-cdn.net') ||
    h === 'vscode-cdn.net' ||
    h === 'vscode-webview.net' ||
    h === 'vscode-unpkg.net' ||
    h === 'vscode-file' ||
    h === 'vscode-app' ||
    isDomesticBypass(h, bypassDomestic) ||
    isCustomBypass(h, customList)
  );
}

module.exports = {
  isLoopback,
  isAiDomain,
  isDomesticBypass,
  isCustomBypass,
  isDirectBypass,
  cleanHost
};

