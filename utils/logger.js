/**
 * Simple logger utility with colorization
 */
const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m'
  };
  
  // Different log levels
  const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
  };
  
  // Current log level (can be set via environment variable)
  const currentLevel = LOG_LEVELS[(process.env.LOG_LEVEL || 'INFO').toUpperCase()] || LOG_LEVELS.INFO;
  
  /**
   * Format objects for console output
   * @param {any} obj - Object to format
   */
  function formatObject(obj) {
    if (typeof obj === 'object' && obj !== null) {
      return JSON.stringify(obj, null, 2);
    }
    return obj;
  }
  
  /**
   * Format the log message with timestamp and level
   */
  function formatLogMessage(level, message, ...args) {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.map(formatObject);
    
    let color;
    switch (level) {
      case 'DEBUG': color = colors.gray; break;
      case 'INFO': color = colors.green; break;
      case 'WARN': color = colors.yellow; break;
      case 'ERROR': color = colors.red; break;
      default: color = colors.reset;
    }
    
    return {
      consoleMessage: `${color}[${timestamp}] [${level}]${colors.reset} ${message}`,
      formattedArgs
    };
  }
  
  /**
   * Debug level log
   */
  function debug(message, ...args) {
    if (currentLevel <= LOG_LEVELS.DEBUG) {
      const { consoleMessage, formattedArgs } = formatLogMessage('DEBUG', message, ...args);
      console.debug(consoleMessage, ...formattedArgs);
    }
  }
  
  /**
   * Info level log
   */
  function info(message, ...args) {
    if (currentLevel <= LOG_LEVELS.INFO) {
      const { consoleMessage, formattedArgs } = formatLogMessage('INFO', message, ...args);
      console.info(consoleMessage, ...formattedArgs);
    }
  }
  
  /**
   * Warning level log
   */
  function warn(message, ...args) {
    if (currentLevel <= LOG_LEVELS.WARN) {
      const { consoleMessage, formattedArgs } = formatLogMessage('WARN', message, ...args);
      console.warn(consoleMessage, ...formattedArgs);
    }
  }
  
  /**
   * Error level log
   */
  function error(message, ...args) {
    if (currentLevel <= LOG_LEVELS.ERROR) {
      const { consoleMessage, formattedArgs } = formatLogMessage('ERROR', message, ...args);
      console.error(consoleMessage, ...formattedArgs);
    }
  }
  
  module.exports = {
    debug,
    info,
    warn,
    error
  };
  