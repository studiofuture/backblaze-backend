/**
 * Memory monitoring utility for tracking and optimizing memory usage
 */
const logger = require('./logger');

// Memory thresholds for different instance sizes
const MEMORY_LIMITS = {
  FREE: 512 * 1024 * 1024,      // 512MB
  STARTER: 512 * 1024 * 1024,   // 512MB  
  STANDARD: 2 * 1024 * 1024 * 1024,    // 2GB
  PRO: 4 * 1024 * 1024 * 1024,         // 4GB
  PRO_MAX: 16 * 1024 * 1024 * 1024,    // 16GB
  PRO_ULTRA: 32 * 1024 * 1024 * 1024   // 32GB
};

// Auto-detect instance type based on available memory
function detectInstanceType() {
  const totalMem = require('os').totalmem();
  
  if (totalMem <= MEMORY_LIMITS.STARTER) return 'STARTER';
  if (totalMem <= MEMORY_LIMITS.STANDARD) return 'STANDARD';
  if (totalMem <= MEMORY_LIMITS.PRO) return 'PRO';
  if (totalMem <= MEMORY_LIMITS.PRO_MAX) return 'PRO_MAX';
  return 'PRO_ULTRA';
}

const INSTANCE_TYPE = process.env.RENDER_INSTANCE_TYPE || detectInstanceType();
const MEMORY_LIMIT = MEMORY_LIMITS[INSTANCE_TYPE];

/**
 * Get current memory information
 */
function getMemoryInfo() {
  const usage = process.memoryUsage();
  const totalMem = require('os').totalmem();
  const freeMem = require('os').freemem();
  
  return {
    // Process memory
    rss: usage.rss,                    // Resident Set Size
    heapUsed: usage.heapUsed,          // Used heap
    heapTotal: usage.heapTotal,        // Total heap
    external: usage.external,          // External memory
    
    // Formatted for humans
    rssFormatted: formatBytes(usage.rss),
    heapUsedFormatted: formatBytes(usage.heapUsed),
    heapTotalFormatted: formatBytes(usage.heapTotal),
    
    // System memory
    totalSystem: totalMem,
    freeSystem: freeMem,
    totalSystemFormatted: formatBytes(totalMem),
    freeSystemFormatted: formatBytes(freeMem),
    
    // Percentages
    rssPercent: Math.round((usage.rss / MEMORY_LIMIT) * 100),
    heapPercent: Math.round((usage.heapUsed / usage.heapTotal) * 100),
    systemUsedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    
    // Instance info
    instanceType: INSTANCE_TYPE,
    memoryLimit: MEMORY_LIMIT,
    memoryLimitFormatted: formatBytes(MEMORY_LIMIT)
  };
}

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Log memory usage with context
 */
function logMemoryUsage(context = 'Memory Check') {
  const memInfo = getMemoryInfo();
  
  // Create status indicator
  let status = '✅';
  if (memInfo.rssPercent > 90) status = '🚨';
  else if (memInfo.rssPercent > 80) status = '⚠️';
  else if (memInfo.rssPercent > 70) status = '🟡';
  
  logger.info(`${status} Memory Usage [${context}]:`, {
    instance: memInfo.instanceType,
    rss: memInfo.rssFormatted,
    heap: `${memInfo.heapUsedFormatted}/${memInfo.heapTotalFormatted}`,
    rssPercent: `${memInfo.rssPercent}%`,
    heapPercent: `${memInfo.heapPercent}%`,
    systemUsed: `${memInfo.systemUsedPercent}%`
  });
}

/**
 * Check if memory usage is approaching dangerous levels
 */
function checkMemoryPressure() {
  const memInfo = getMemoryInfo();
  
  if (memInfo.rssPercent > 90) {
    logger.error('🚨 CRITICAL: Memory usage above 90%', {
      rss: memInfo.rssFormatted,
      limit: memInfo.memoryLimitFormatted,
      percent: `${memInfo.rssPercent}%`
    });
    return 'critical';
  } else if (memInfo.rssPercent > 80) {
    logger.warn('⚠️ WARNING: Memory usage above 80%', {
      rss: memInfo.rssFormatted,
      limit: memInfo.memoryLimitFormatted,
      percent: `${memInfo.rssPercent}%`
    });
    return 'warning';
  } else if (memInfo.rssPercent > 70) {
    logger.info('🟡 NOTICE: Memory usage above 70%', {
      rss: memInfo.rssFormatted,
      limit: memInfo.memoryLimitFormatted,
      percent: `${memInfo.rssPercent}%`
    });
    return 'notice';
  }
  
  return 'ok';
}

/**
 * Force garbage collection if available
 */
function forceGarbageCollection() {
  if (global.gc) {
    logger.info('🗑️ Forcing garbage collection');
    global.gc();
    return true;
  } else {
    logger.warn('⚠️ Garbage collection not available (start with --expose-gc)');
    return false;
  }
}

module.exports = {
  getMemoryInfo,
  logMemoryUsage,
  checkMemoryPressure,
  forceGarbageCollection,
  formatBytes,
  MEMORY_LIMITS,
  INSTANCE_TYPE
};