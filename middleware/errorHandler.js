const logger = require('../utils/logger');

/**
 * Global error handling middleware
 */
function errorHandler(err, req, res, next) {
  // Log the error
  logger.error('Unhandled error:', err);
  
  // Determine if this is a known error type
  let statusCode = 500;
  let errorMessage = 'An unexpected error occurred';
  
  if (err.name === 'ValidationError') {
    statusCode = 400;
    errorMessage = err.message || 'Invalid request data';
  } else if (err.name === 'NotFoundError') {
    statusCode = 404;
    errorMessage = err.message || 'Resource not found';
  } else if (err.name === 'AuthorizationError') {
    statusCode = 403;
    errorMessage = err.message || 'Not authorized';
  }
  
  // Send error response
  res.status(statusCode).json({
    error: errorMessage,
    status: 'error',
    ...(process.env.NODE_ENV !== 'production' ? { details: err.message, stack: err.stack } : {})
  });
}

module.exports = errorHandler;