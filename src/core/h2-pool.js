const tls = require('tls');
const http2 = require('http2');

/**
 * HTTP/2 Multiplexed CONNECT Tunnel Pool
 *
 * Maintains 1-2 persistent HTTP/2 sessions (ALPN h2) to the upstream gateway
 * and multiplexes every proxied connection as an extended-CONNECT stream on
 * them (RFC 8441 style: `:method: CONNECT` + `:authority: host:port`).
 *
 * Why: the gateway already speaks HTTP/2. One warm H2 session replaces the
 * entire per-request CONNECT round trip AND the TLS handshake cliff under
 * burst load (H1 warm pool is capped at 6-16 sockets). The HTTP/1.1 warm
 * pool stays untouched as transparent fallback.
 *
 * Session lifecycle: PING keep-alive (15s), 10-minute max age with graceful
 * drain, GOAWAY/error/close handling, and a circuit breaker (5 consecutive
 * failures -> 60s cooldown) so a broken H2 path never adds latency.
 */
class H2SessionPool {
  constructor(options = {}) {
    if (typeof options.tlsOptionsFactory !== 'function') {
      throw new Error('H2SessionPool requires tlsOptionsFactory');
    }
    if (typeof options.authHeaderFactory !== 'function') {
      throw new Error('H2SessionPool requires authHeaderFactory');
    }
    this.tlsOptionsFactory = options.tlsOptionsFactory;
    this.authHeaderFactory = options.authHeaderFactory;
    this.createSocket = options.createSocket || null; // (host, port) => Promise<net.Socket>, test injection
    this.logger = options.logger || console;
    this.maxSessions = options.maxSessions || 2;
    this.pingIntervalMs = options.pingIntervalMs || 15000;
    this.maxSessionAgeMs = options.maxSessionAgeMs || 10 * 60 * 1000;
    this.connectTimeoutMs = options.connectTimeoutMs || 10000;
    this.sessions = [];
    this.creatingCount = 0;
    this.isStopping = false;
    this.tlsSession = null; // cached session ticket for faster re-handshakes
    this.consecFailures = 0;
    this.circuitOpenUntil = 0;
    this.stats = { tunnels: 0, sessionCreations: 0, sessionFailures: 0 };
  }

  getStatus() {
    return {
      enabled: true,
      sessions: this.sessions.map((e) => ({
        streams: e.streams,
        draining: !!e.draining,
        ageSec: Math.floor((Date.now() - e.createdAt) / 1000),
      })),
      circuitOpen: Date.now() < this.circuitOpenUntil,
      stats: this.stats,
    };
  }

  _circuitOpen() {
    return Date.now() < this.circuitOpenUntil;
  }

  _recordSuccess() {
    this.consecFailures = 0;
  }

  _recordFailure() {
    this.consecFailures++;
    if (this.consecFailures >= 5) {
      this.circuitOpenUntil = Date.now() + 60000;
      this.logger.error?.(`[H2] Circuit opened for 60s after ${this.consecFailures} consecutive failures`);
    }
  }

  /**
   * Open a CONNECT tunnel to host:port over a multiplexed H2 session.
   * Resolves with a Duplex stream once the upstream answers 200.
   *
   * `preamble` (Buffer, optional) is written optimistically right after the
   * CONNECT HEADERS. No client data is consumed before this point, so a
   * rejection can still fall back to the HTTP/1.1 path losslessly.
   */
  async openTunnel(host, port, preamble) {
    if (this.isStopping) throw new Error('h2 pool stopping');
    if (this._circuitOpen()) throw new Error('h2 circuit open');
    try {
      return await this._openTunnelOnce(host, port, preamble);
    } catch (err) {
      // One retry on a fresh session for session-level failures; the
      // circuit breaker guards pathological cases.
      if (!this.isStopping && !this._circuitOpen()) {
        return await this._openTunnelOnce(host, port, preamble);
      }
      throw err;
    }
  }

  _openTunnelOnce(host, port, preamble) {
    const self = this;
    return self._getSession().then(
      (entry) => new Promise((resolve, reject) => {
        let settled = false;
        let stream;
        try {
          stream = entry.session.request({
            ':method': 'CONNECT',
            ':authority': `${host}:${port}`,
            'proxy-authorization': self.authHeaderFactory(),
          });
        } catch (err) {
          self._recordFailure();
          reject(err);
          return;
        }
        entry.streams++;
        const release = () => { entry.streams = Math.max(0, entry.streams - 1); };
        const destroyQuiet = (s) => { try { s.destroy(); } catch (_) {} };

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          release();
          destroyQuiet(stream);
          self._recordFailure();
          reject(new Error('h2 connect timeout'));
        }, self.connectTimeoutMs);

        const onEarlyClose = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          release();
          self._recordFailure();
          reject(new Error('h2 stream closed before 200'));
        };
        const onError = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          release();
          self._recordFailure();
          reject(err);
        };
        const onResponse = (headers) => {
          if (settled) return;
          if (headers[':status'] === 200) {
            settled = true;
            clearTimeout(timer);
            stream.removeListener('close', onEarlyClose);
            stream.removeListener('error', onError);
            stream.on('close', release);
            stream.on('error', () => {});
            self._recordSuccess();
            self.stats.tunnels++;
            resolve(stream);
          } else {
            settled = true;
            clearTimeout(timer);
            release();
            destroyQuiet(stream);
            self._recordFailure();
            reject(new Error(`h2 upstream status ${headers[':status']}`));
          }
        };
        stream.on('response', onResponse);
        stream.on('close', onEarlyClose);
        stream.on('error', onError);
        if (preamble && preamble.length) {
          try { stream.write(preamble); } catch (_) { /* error handler rejects */ }
        }
      }),
      (err) => {
        self._recordFailure();
        throw err;
      }
    );
  }

  async _getSession() {
    this.sessions = this.sessions.filter((e) => !e.dead);
    let best = null;
    for (const e of this.sessions) {
      if (e.draining || e.dead) continue;
      if (!best || e.streams < best.streams) best = e;
    }
    if (best) return best;
    if (this.creatingCount > 0) {
      await new Promise((r) => setTimeout(r, 100));
      return this._getSession();
    }
    return this._createSession();
  }

  async _createSession() {
    if (this.isStopping) throw new Error('h2 pool stopping');
    this.creatingCount++;
    try {
      const opts = this.tlsOptionsFactory();
      let tlsSocket;
      if (this.createSocket) {
        const raw = await this.createSocket(opts.host, opts.port);
        tlsSocket = tls.connect({ ...opts, socket: raw });
      } else {
        tlsSocket = tls.connect(opts);
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('h2 tls timeout')), this.connectTimeoutMs);
        tlsSocket.on('secureConnect', () => { clearTimeout(timer); resolve(); });
        tlsSocket.on('error', (err) => { clearTimeout(timer); reject(err); });
      });
      if (tlsSocket.alpnProtocol !== 'h2') {
        try { tlsSocket.destroy(); } catch (_) {}
        throw new Error(`ALPN negotiated ${tlsSocket.alpnProtocol || 'none'}, need h2`);
      }
      tlsSocket.on('session', (s) => { this.tlsSession = s; });
      tlsSocket.setNoDelay(true);
      tlsSocket.setKeepAlive(true, 10000);

      const session = http2.connect(`https://${opts.host}`, {
        createConnection: () => tlsSocket,
        // Align per-stream flow-control window with the 256KB forwarding buffers
        settings: { initialWindowSize: 256 * 1024 },
      });
      const entry = {
        session, tlsSocket, streams: 0,
        createdAt: Date.now(), draining: false, dead: false,
        pingTimer: null, ageTimer: null, drainTimer: null,
      };
      session.on('error', () => this._killSession(entry, 'error'));
      session.on('close', () => this._killSession(entry, 'close'));
      session.on('goaway', () => this._drainSession(entry, 'goaway'));

      entry.pingTimer = setInterval(() => {
        if (entry.dead || this.isStopping) return;
        try {
          session.ping((err) => { if (err) this._killSession(entry, 'ping-failed'); });
        } catch (_) { this._killSession(entry, 'ping-throw'); }
      }, this.pingIntervalMs);
      if (entry.pingTimer.unref) entry.pingTimer.unref();

      entry.ageTimer = setTimeout(() => this._drainSession(entry, 'max-age'), this.maxSessionAgeMs);
      if (entry.ageTimer.unref) entry.ageTimer.unref();

      this.sessions.push(entry);
      this.stats.sessionCreations++;
      // Top up to maxSessions for redundancy (creatingCount includes this call)
      if (!this.isStopping) {
        const active = this.sessions.filter((e) => !e.dead && !e.draining).length + this.creatingCount - 1;
        if (active < this.maxSessions) {
          this._createSession().catch(() => {});
        }
      }
      return entry;
    } finally {
      this.creatingCount = Math.max(0, this.creatingCount - 1);
    }
  }

  _clearTimers(entry) {
    if (entry.pingTimer) clearInterval(entry.pingTimer);
    if (entry.ageTimer) clearTimeout(entry.ageTimer);
    if (entry.drainTimer) clearTimeout(entry.drainTimer);
    entry.pingTimer = entry.ageTimer = entry.drainTimer = null;
  }

  _killSession(entry, reason) {
    if (entry.dead) return;
    entry.dead = true;
    this._clearTimers(entry);
    this.sessions = this.sessions.filter((e) => e !== entry);
    try { entry.session.destroy(); } catch (_) {}
    try { entry.tlsSocket.destroy(); } catch (_) {}
    this.stats.sessionFailures++;
    if (!this.isStopping) {
      this.logger.error?.(`[H2] session ${reason}, remaining: ${this.sessions.length}`);
      this._createSession().catch(() => {});
    }
  }

  _drainSession(entry, reason) {
    if (entry.dead || entry.draining || this.isStopping) return;
    entry.draining = true;
    this.logger.info?.(`[H2] session draining (${reason}), replacing capacity`);
    this._createSession().catch(() => {});
    const check = () => {
      if (entry.dead) return;
      if (entry.streams === 0) {
        this._killSession(entry, `${reason}-drained`);
      } else {
        entry.drainTimer = setTimeout(check, 5000);
        if (entry.drainTimer.unref) entry.drainTimer.unref();
      }
    };
    entry.drainTimer = setTimeout(check, 5000);
    if (entry.drainTimer.unref) entry.drainTimer.unref();
    // Hard cap: never let a draining session linger forever
    const hardKill = setTimeout(() => this._killSession(entry, `${reason}-expired`), 60000);
    if (hardKill.unref) hardKill.unref();
  }

  /** Drop all sessions (upstream config changed). Sessions rebuild lazily. */
  reset() {
    for (const e of this.sessions) this._killSession(e, 'reset');
    this.sessions = [];
    this.consecFailures = 0;
    this.circuitOpenUntil = 0;
  }

  close() {
    this.isStopping = true;
    for (const e of [...this.sessions]) this._killSession(e, 'shutdown');
    this.sessions = [];
  }
}

module.exports = { H2SessionPool };
