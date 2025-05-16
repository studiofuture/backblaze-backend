const logger = require('../utils/logger');

/**
 * Global CORS middleware
 * This ensures CORS headers are set consistently across all routes
 */
function corsMiddleware(req, res, next) {
  // Define allowed origins
  const allowedOrigins = [
    "https://c36396e7-7511-4311-b6cd-951c02385844.lovableproject.com",
    "https://id-preview--c36396e7-7511-4311-b6cd-951c02385844.lovable.app",
    "http://localhost:3000",
    "http://localhost:5173"
  ];
  
  // Get origin from request
  const origin = req.headers.origin;
  
  // Set CORS headers - either match the specific origin or use * during development
  // During production, you might want to only allow specific origins
  if (origin && (allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production')) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  
  // Set other CORS headers
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-upload-id, Accept');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // Log the request origin for debugging
  logger.debug(`CORS headers set for request from origin: ${origin || 'unknown'} to ${req.method} ${req.path}`);
  
  // Handle preflight OPTIONS requests immediately
  if (req.method === 'OPTIONS') {
    logger.info(`Handling OPTIONS request for ${req.path} from origin: ${origin || 'unknown'}`);
    return res.status(200).end();
  }
  
  next();
}

module.exports = corsMiddleware;