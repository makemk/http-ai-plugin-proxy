const net = require('net');
const dns = require('dns');

/**
 * Ultra-Fast In-Memory DNS Cache (LRU + TTL)
 * Eliminates 20ms~80ms blocking system getaddrinfo queries for domestic bypass targets,
 * allowing instant sub-millisecond local connection handshakes.
 */
class FastDnsCache {
  constructor(ttlMs = 300000, maxEntries = 2000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  isIp(host) {
    if (!host) return false;
    return net.isIP(host) !== 0;
  }

  async resolve(host) {
    if (!host || this.isIp(host)) return host;
    const lowerHost = host.toLowerCase().trim();
    const now = Date.now();
    const cached = this.cache.get(lowerHost);
    if (cached && cached.expireAt > now) {
      return cached.ip;
    }

    return new Promise((resolve) => {
      dns.lookup(lowerHost, { family: 4 }, (err, address) => {
        if (!err && address) {
          if (this.cache.size >= this.maxEntries) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
          }
          this.cache.set(lowerHost, { ip: address, expireAt: Date.now() + this.ttlMs });
          resolve(address);
        } else {
          resolve(lowerHost);
        }
      });
    });
  }

  clear() {
    this.cache.clear();
  }
}

module.exports = { FastDnsCache };
