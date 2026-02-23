const logger = require('../utils/logger');

/**
 * Global CORS middleware
 * This ensures CORS headers are set consistently across all routes
 */
function corsMiddleware(req, res, next) {
  // Define allowed origins - UPDATED to include lovable.dev and rushes.cc
  const allowedOrigins = [
    "https://www.rushes.cc",
    "https://rushes.cc",
    "https://c36396e7-7511-4311-b6cd-951c02385844.lovableproject.com",
    "https://id-preview--c36396e7-7511-4311-b6cd-951c02385844.lovable.app",
    "https://lovable.dev", // ADD THIS LINE
    "http://localhost:3000",
    "http://localhost:5173"
  ];
  
  // Get origin from request
  const origin = req.headers.origin;
  
  // Handle CORS headers
  if (origin && allowedOrigins.includes(origin)) {
    // Known origin - allow it
    res.header('Access-Control-Allow-Origin', origin);
    logger.debug(`✅ CORS allowed for known origin: ${origin}`);
  } else if (!origin) {
    // No origin (direct requests, server-to-server, etc.) - allow all
    res.header('Access-Control-Allow-Origin', '*');
  } else if (process.env.NODE_ENV !== 'production') {
    // Development - allow all and log
    res.header('Access-Control-Allow-Origin', origin);
    logger.info(`🔧 DEV: CORS allowed for unknown origin: ${origin}`);
  } else {
    // Production unknown origin - still allow but log warning
    res.header('Access-Control-Allow-Origin', origin);
    logger.warn(`⚠️ CORS request from unrecognized origin: ${origin}`);
  }
  
  // Set other CORS headers
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-upload-id, x-chunk-index, x-total-chunks, x-chunk-size, x-file-name, x-file-type, x-total-size, Accept');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // Handle preflight OPTIONS requests immediately
  if (req.method === 'OPTIONS') {
    logger.debug(`✅ CORS preflight handled: ${req.path} from ${origin || 'no-origin'}`);
    return res.status(200).end();
  }
  
  next();
}

module.exports = corsMiddleware;
