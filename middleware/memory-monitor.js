const logger = require('./logger');

/**
 * Minimal memory monitoring utility 
 * Designed to work with existing utils/status.js and services/b2.js
 */

/**
 * Get current memory information
 * Used by: utils/status.js (for monitoring), services/b2.js (for upload optimization)
 */
function getMemoryInfo() {
  const usage = process.memoryUsage();
  
  return {
    // Raw values (bytes)
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    
    // Formatted for humans
    rssMB: Math.floor(usage.rss / 1024 / 1024),
    heapUsedMB: Math.floor(usage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.floor(usage.heapTotal / 1024 / 1024),
    
    // Percentage calculations (assume 512MB limit for starter plan)
    rssPercent: Math.round((usage.rss / (512 * 1024 * 1024)) * 100),
    
    timestamp: new Date().toISOString()
  };
}

/**
 * Log memory usage with context
 * Used by: services/b2.js during upload processing
 */
function logMemoryUsage(context = 'Memory Check') {
  const memInfo = getMemoryInfo();
  
  // Simple status indicator
  let status = '✅';
  if (memInfo.rssPercent > 80) status = '⚠️';
  if (memInfo.rssPercent > 90) status = '🚨';
  
  logger.info(`${status} ${context}:`, {
    RSS: `${memInfo.rssMB}MB`,
    Heap: `${memInfo.heapUsedMB}/${memInfo.heapTotalMB}MB`,
    Usage: `${memInfo.rssPercent}%`
  });
}

/**
 * Check if memory usage is safe for uploads
 * Used by: routes/upload.js (removed but keeping for compatibility)
 */
function isMemorySafe(maxRSSPercent = 80) {
  const memInfo = getMemoryInfo();
  return memInfo.rssPercent <= maxRSSPercent;
}

/**
 * Force garbage collection if available
 * Used by: services/b2.js during chunked uploads
 */
function forceGarbageCollection() {
  if (global.gc) {
    logger.debug('🗑️ Forcing garbage collection');
    global.gc();
    return true;
  }
  return false;
}

module.exports = {
  getMemoryInfo,
  logMemoryUsage,
  isMemorySafe,
  forceGarbageCollection
};