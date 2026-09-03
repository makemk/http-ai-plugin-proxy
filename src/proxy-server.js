/**
 * High-Performance Local HTTP-to-HTTPS Forwarding Proxy Core (Facade)
 * Re-exports modularized components to maintain 100% backward compatibility
 * with existing CLI tools, test scripts, and external runners.
 */

const { HttpsForwardProxyServer } = require('./core/server');
const { maskHost } = require('./utils/mask');
const { detectHardwareProfile } = require('./network/hardware');
const { FastDnsCache } = require('./network/dns-cache');
const {
  isLoopback,
  isAiDomain,
  isDomesticBypass,
  isCustomBypass,
  isDirectBypass
} = require('./network/domain-matcher');

// Hardware Multi-Core Optimization: Auto-detect CPU cores & set threadpool
const hw = detectHardwareProfile();
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || String(hw.optimalThreadPool);

module.exports = {
  HttpsForwardProxyServer,
  maskHost,
  detectHardwareProfile,
  FastDnsCache,
  isLoopback,
  isAiDomain,
  isDomesticBypass,
  isCustomBypass,
  isDirectBypass
};
