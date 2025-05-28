const logger = require('../utils/logger');

/**
 * Global CORS middleware
 * This ensures CORS headers are set consistently across all routes
 */
function corsMiddleware(req, res, next) {
  // Define allowed origins - UPDATED with Render backend URL
  const allowedOrigins = [
    "https://www.rvshes.com",
    "https://rvshes.com", 
    "https://backblaze-backend-p9xu.onrender.com", // ADD THIS LINE
    "https://c36396e7-7511-4311-b6cd-951c02385844.lovableproject.com",
    "https://id-preview--c36396e7-7511-4311-b6cd-951c02385844.lovable.app",
    "http://localhost:3000",
    "http://localhost:5173"
  ];
  
  // Get origin from request
  const origin = req.headers.origin;
  
  // SIMPLIFIED CORS LOGIC - be more permissive
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (process.env.NODE_ENV !== 'production') {
    res.header('Access-Control-Allow-Origin', '*');
  } else {
    // Still allow the request but log it
    res.header('Access-Control-Allow-Origin', origin || '*');
    logger.warn(`CORS request from unrecognized origin: ${origin}`);
  }
  
  // Set other CORS headers
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-upload-id, Accept');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // Log the request for debugging
  logger.debug(`CORS: ${req.method} ${req.path} from ${origin || 'unknown'}`);
  
  // Handle preflight OPTIONS requests immediately
  if (req.method === 'OPTIONS') {
    logger.info(`CORS preflight: ${req.path} from ${origin || 'unknown'}`);
    return res.status(200).end();
  }
  
  next();
}

module.exports = corsMiddleware;