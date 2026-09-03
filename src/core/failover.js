const tls = require('tls');
const { bridgeSockets } = require('./tunnel-bridge');

/**
 * Transparent Tunnel Failover & Auto-Healing Engine
 * Automatically recovers from upstream transient network jitter / idle socket drops
 * by seamlessly retrying on a fresh socket before the client ever sees an error.
 */
function handleTunnelWithFailover({
  clientSocket,
  targetHost,
  targetPort,
  head,
  isAi,
  authHeader,
  tlsOptions,
  warmPool,
  activeSockets,
  stats,
  logger
}) {
  const connectPayload = [
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
    `Host: ${targetHost}:${targetPort}`,
    `Proxy-Authorization: ${authHeader}`,
    'Proxy-Connection: Keep-Alive',
    '',
    ''
  ].join('\r\n');

  const connectToUpstream = (attempt = 1) => {
    if (clientSocket.destroyed || !clientSocket.writable) {
      activeSockets.delete(clientSocket);
      stats.activeRequests = Math.max(0, stats.activeRequests - 1);
      return;
    }

    const warmSocket = warmPool.acquireWarmSocket(stats.activeRequests, () => {
      warmPool.replenishWarmPool(tlsOptions, stats.activeRequests);
    });

    let upstreamSocket;

    if (warmSocket) {
      upstreamSocket = warmSocket;
      try { upstreamSocket.write(connectPayload); } catch (_) {}
    } else {
      upstreamSocket = tls.connect(tlsOptions, () => {
        upstreamSocket.setNoDelay(true);
        upstreamSocket.setKeepAlive(true, isAi ? 3000 : 15000);
        try { upstreamSocket.write(connectPayload); } catch (_) {}
      });

      upstreamSocket.on('session', (session) => {
        warmPool.tlsSession = session;
      });

      activeSockets.add(upstreamSocket);
    }

    let headerBuffer = '';
    let tunnelEstablished = false;

    const cleanup = () => {
      activeSockets.delete(clientSocket);
      activeSockets.delete(upstreamSocket);
      stats.activeRequests = Math.max(0, stats.activeRequests - 1);
      try { clientSocket.destroy(); } catch (_) {}
      try { upstreamSocket.destroy(); } catch (_) {}
    };

    const handleFailover = (reason) => {
      if (tunnelEstablished) return;
      activeSockets.delete(upstreamSocket);
      try { upstreamSocket.destroy(); } catch (_) {}

      if (attempt < 3 && !clientSocket.destroyed && clientSocket.writable) {
        stats.autoHeals = (stats.autoHeals || 0) + 1;
        logger.info?.(`[Auto-Heal] Upstream jitter (${reason}) for ${targetHost}. Transparently failing over to fresh connection (attempt ${attempt + 1}/3)...`);
        setImmediate(() => connectToUpstream(attempt + 1));
        return;
      }

      stats.errors++;
      logger.error?.(`[Upstream Tunnel Error] Failed after ${attempt} attempts (${reason}) for ${targetHost}:${targetPort}`);
      if (clientSocket.writable) {
        try {
          clientSocket.resume();
          clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\n\r\n${reason}`);
        } catch (_) {}
      }
      cleanup();
    };

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
            clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: HTTP-AI-Bridge\r\n\r\n');

            const remaining = chunk.subarray(Buffer.byteLength(headerBuffer.slice(0, headerEnd + 4), 'latin1'));
            if (remaining.length > 0) {
              clientSocket.write(remaining);
            }
            if (head && head.length > 0) {
              upstreamSocket.write(head);
            }

            clientSocket.resume();
            bridgeSockets(clientSocket, upstreamSocket, () => {
              stats.activeRequests = Math.max(0, stats.activeRequests - 1);
            }, isAi, activeSockets);
          } else {
            handleFailover(`Upstream Gateway returned ${statusLine}`);
          }
        }
      }
    };

    upstreamSocket.on('data', onUpstreamData);

    upstreamSocket.on('error', (err) => {
      if (!tunnelEstablished) {
        handleFailover(err.message);
      } else {
        cleanup();
      }
    });

    upstreamSocket.on('close', () => {
      if (!tunnelEstablished) {
        handleFailover('Upstream socket closed prematurely');
      } else {
        cleanup();
      }
    });

    upstreamSocket.on('end', () => {
      if (!tunnelEstablished) {
        handleFailover('Upstream socket ended before handshake completion');
      } else {
        cleanup();
      }
    });

    clientSocket.on('error', cleanup);
    clientSocket.on('close', cleanup);
    clientSocket.on('end', cleanup);
  };

  connectToUpstream(1);
}

module.exports = { handleTunnelWithFailover };

