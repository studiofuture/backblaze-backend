const logger = require('./logger');

/**
 * Starts a heartbeat to keep the server alive during long operations
 */
function startHeartbeat() {
  let count = 0;
  const interval = setInterval(() => {
    count++;
    // Log every 5 minutes to keep the process alive
    if (count % 60 === 0) {
      logger.info(`💓 Server heartbeat: ${count/12} minutes uptime`);
    }
  }, 5000); // Every 5 seconds
  
  return {
    stop: () => clearInterval(interval),
    interval
  };
}

module.exports = {
  startHeartbeat
};