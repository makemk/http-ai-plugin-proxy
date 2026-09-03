/**
 * Sensitive Information Masking Utility
 * Masks raw IP addresses and hostnames for UI, logs, and telemetry.
 */
function maskHost(host) {
  if (!host) return '***';
  const h = String(host).trim();
  const parts = h.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    return `${parts[0]}.***.***.${parts[3]}`;
  }
  if (h.length > 8) {
    return `${h.slice(0, 3)}***${h.slice(-3)}`;
  }
  return '***';
}

module.exports = { maskHost };
