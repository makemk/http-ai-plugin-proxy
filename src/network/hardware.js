const os = require('os');

/**
 * Dynamic Hardware Profile Detection
 * Automatically senses CPU cores, total memory, and optimizes threadpools and connection capacity to the physical limit.
 */
function detectHardwareProfile() {
  const cpus = os.cpus() || [];
  const cpuCount = Math.max(4, cpus.length);
  const totalMemGb = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  const cpuModel = cpus[0]?.model ? cpus[0].model.trim() : 'Multi-Core Processor';

  // Saturated threadpool: 1:1 mapping with detected cores (e.g. 20 on Core Ultra 7 265)
  const optimalThreadPool = cpuCount;

  // Scale warm connection pool dynamically based on CPU core class
  let optimalMaxWarmSockets = 4;
  if (cpuCount >= 16) {
    optimalMaxWarmSockets = 6;
  } else if (cpuCount >= 8) {
    optimalMaxWarmSockets = 4;
  } else {
    optimalMaxWarmSockets = 2;
  }

  return {
    cpuCount,
    totalMemGb,
    cpuModel,
    optimalThreadPool,
    optimalMaxWarmSockets
  };
}

module.exports = { detectHardwareProfile };
