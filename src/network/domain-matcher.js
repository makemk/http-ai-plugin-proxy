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

function isIpv4Literal(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function ipv4Octets(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

// RFC1918 内网段: 10/8, 172.16/12, 192.168/16 → 直连绕行 (路由器/NAS/开发板)
function isPrivateIpv4(host) {
  const h = cleanHost(host);
  if (!isIpv4Literal(h)) return false;
  const o = ipv4Octets(h);
  if (!o) return false;
  if (o[0] === 10) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  return false;
}

// 不可路由: 169.254/16 (link-local, 含云元数据服务), 0/8 → 本地直接拒绝, 不转发上游
function isNonRoutableIp(host) {
  const h = cleanHost(host);
  if (!isIpv4Literal(h)) return false;
  const o = ipv4Octets(h);
  if (!o) return false;
  if (o[0] === 169 && o[1] === 254) return true;
  if (o[0] === 0) return true;
  return false;
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
    isPrivateIpv4(h) ||
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
  isPrivateIpv4,
  isNonRoutableIp,
  isAiDomain,
  isDomesticBypass,
  isCustomBypass,
  isDirectBypass,
  cleanHost,
  buildRoutingMatcher
};

/**
 * Precompiled routing matcher.
 * Replaces the per-request suffix loops in the hot path with RegExps compiled
 * once at startup (or when bypass options change). Callers must pass hosts
 * already normalized with cleanHost().
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRoutingMatcher(options = {}) {
  const bypassDomestic = options.bypassDomesticDomains !== undefined ? options.bypassDomesticDomains : true;
  const customList = Array.isArray(options.customBypassList) ? options.customBypassList : [];

  const aiRe = new RegExp(`(?:^|\\.)(?:${AI_DOMAINS.map(escapeRegExp).join('|')})$`);

  const domesticBases = bypassDomestic ? DOMESTIC_SUFFIXES.map((s) => s.replace(/^\./, '')) : [];
  const domesticRe = domesticBases.length
    ? new RegExp(`(?:^|\\.)(?:${domesticBases.map(escapeRegExp).join('|')})$`)
    : null;

  const vscodeRe = /(?:^|\.)(?:vscode-cdn\.net|vscode-webview\.net|vscode-unpkg\.net|vscode-resource\.vscode-cdn\.net)$/;

  const customParts = [];
  for (const pattern of customList) {
    const p = String(pattern).toLowerCase().trim();
    if (!p) continue;
    if (p.startsWith('*.')) {
      customParts.push(`(?:^|\\.)${escapeRegExp(p.slice(2))}`);
    } else {
      customParts.push(`^${escapeRegExp(p)}$`);
    }
  }
  const customRe = customParts.length ? new RegExp(customParts.join('|')) : null;

  const isLoop = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';

  return {
    isAi: (h) => aiRe.test(h),
    isDomestic: (h) => (domesticRe ? domesticRe.test(h) : false),
    isCustom: (h) => (customRe ? customRe.test(h) : false),
    isLoopback: isLoop,
    isPrivateIpv4: (h) => isPrivateIpv4(h),
    isNonRoutableIp: (h) => isNonRoutableIp(h),
    isDirectBypass: (h) => {
      if (isLoop(h)) return true;
      if (isPrivateIpv4(h)) return true;
      if (h === 'vscode-file' || h === 'vscode-app') return true;
      if (vscodeRe.test(h)) return true;
      if (domesticRe && domesticRe.test(h)) return true;
      if (customRe && customRe.test(h)) return true;
      return false;
    }
  };
}

