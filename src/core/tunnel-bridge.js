const { pipeline } = require('stream');

/**
 * High-Throughput Bidirectional Socket Bridging
 * Implements 256KB stream buffering (BDP optimization) and 3-second keep-alive for AI reasoning.
 */
function bridgeSockets(clientSocket, remoteSocket, onClosed, isAi = false, activeSockets = null) {
  try {
    // Feature-check: H2 CONNECT streams are Duplex streams without socket
    // tuning methods — the try/catch + guards keep both paths working.
    if (typeof clientSocket.setNoDelay === 'function') clientSocket.setNoDelay(true);
    if (typeof remoteSocket.setNoDelay === 'function') remoteSocket.setNoDelay(true);

    // AI Streaming Optimization: 3-second aggressive keep-alive protects Claude/o3 deep thinking pauses
    const keepAliveInterval = isAi ? 3000 : 15000;
    if (typeof clientSocket.setKeepAlive === 'function') clientSocket.setKeepAlive(true, keepAliveInterval);
    if (typeof remoteSocket.setKeepAlive === 'function') remoteSocket.setKeepAlive(true, keepAliveInterval);

    // Hardware Optimization: Align stream buffer with 200ms BDP & 30MB L3 cache (256KB buffer)
    if (clientSocket._readableState) clientSocket._readableState.highWaterMark = 256 * 1024;
    if (remoteSocket._readableState) remoteSocket._readableState.highWaterMark = 256 * 1024;
    if (clientSocket._writableState) clientSocket._writableState.highWaterMark = 256 * 1024;
    if (remoteSocket._writableState) remoteSocket._writableState.highWaterMark = 256 * 1024;
  } catch (_) {}

  let closed = false;
  const cleanup = (err) => {
    if (closed) return;
    closed = true;
    if (activeSockets) {
      activeSockets.delete(clientSocket);
      activeSockets.delete(remoteSocket);
    }
    try { clientSocket.destroy(); } catch (_) {}
    try { remoteSocket.destroy(); } catch (_) {}
    if (typeof onClosed === 'function') {
      onClosed(err);
    }
  };

  pipeline(clientSocket, remoteSocket, (err) => {
    cleanup(err);
  });

  pipeline(remoteSocket, clientSocket, (err) => {
    cleanup(err);
  });
}

module.exports = { bridgeSockets };

