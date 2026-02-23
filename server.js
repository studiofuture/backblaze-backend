require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet'); // Security headers
const rateLimit = require('express-rate-limit');

// Import status functions from utils
const { 
  setupSocketIO,
  getUploadStatus, 
  initUploadStatus, 
  updateUploadStatus, 
  completeUploadStatus, 
  failUploadStatus 
} = require('./utils/status');

// Import config validation and directory setup
const { validateEnvironment } = require('./config');
const { setupDirectories } = require('./utils/directory');

// Create Express app
const app = express();
const server = http.createServer(app);

// Security: Trust proxy for accurate IP addresses (if behind load balancer)
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Security: Global rate limiting
const globalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Security: Apply global rate limiting
app.use(globalRateLimit);

// Security: Apply helmet for basic security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for now (can be configured later)
  crossOriginEmbedderPolicy: false // Allow embedding for uploads
}));

// Configure Socket.io with security settings
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  // Security: Limit connection attempts
  maxHttpBufferSize: 1e6, // 1MB max per message
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  }
});

// Initialize socket.io in the status utility
setupSocketIO(io);

// Enhanced CORS middleware with security
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  console.log(`Ã°Å¸Å’Â ${req.method} ${req.url} from ${origin || 'no-origin'} [IP: ${req.ip}]`);
  
  // Security: Define allowed origins
  const allowedOrigins = [
    "https://www.rushes.cc",
    "https://rushes.cc",
    "https://c36396e7-7511-4311-b6cd-951c02385844.lovableproject.com",
    "https://id-preview--c36396e7-7511-4311-b6cd-951c02385844.lovable.app",
    "https://lovable.dev",
    "http://localhost:3000",
    "http://localhost:5173"
  ];
  
  // Add environment-specific origins
  if (process.env.ALLOWED_ORIGINS) {
    allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(','));
  }
  
  // Handle CORS with security
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // No origin (direct requests, server-to-server, etc.)
    res.header('Access-Control-Allow-Origin', '*');
  } else if (process.env.NODE_ENV !== 'production') {
    // Development - allow all but log
    res.header('Access-Control-Allow-Origin', origin);
    console.log(`Ã°Å¸â€Â§ DEV: CORS allowed for unknown origin: ${origin}`);
  } else {
    // Production - reject unknown origins for sensitive endpoints
    if (req.path.startsWith('/upload/multipart') || req.path.startsWith('/upload/chunk')) {
      console.log(`Ã°Å¸Å¡Â« CORS rejected for unknown origin: ${origin} on sensitive endpoint: ${req.path}`);
      return res.status(403).json({
        error: 'Origin not allowed',
        message: 'This origin is not authorized to make requests to this endpoint'
      });
    }
    // Allow for non-sensitive endpoints
    res.header('Access-Control-Allow-Origin', origin);
    console.log(`Ã¢Å¡Â Ã¯Â¸Â CORS allowed for unknown origin on non-sensitive endpoint: ${origin}`);
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-upload-id, x-chunk-index, x-total-chunks, x-chunk-size, x-file-name, x-file-type, x-total-size, x-b2-file-id, x-part-number, Cache-Control, Pragma');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  
  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    console.log(`Ã¢Å“â€¦ OPTIONS ${req.url} - CORS preflight handled`);
    return res.status(200).end();
  }
  
  next();
});

// Security: Request size limits (only for API calls, not file uploads)
app.use(express.json({ 
  limit: '5mb',
  verify: (req, res, buf) => {
    // Security: Validate JSON content
    if (buf.length > 5 * 1024 * 1024) {
      const error = new Error('Request too large');
      error.status = 413;
      throw error;
    }
  }
}));

app.use(express.urlencoded({ 
  extended: true, 
  limit: '5mb',
  verify: (req, res, buf) => {
    // Security: Validate URL-encoded content
    if (buf.length > 5 * 1024 * 1024) {
      const error = new Error('Request too large');
      error.status = 413;
      throw error;
    }
  }
}));

// Security: Input validation middleware
const validateInput = (req, res, next) => {
  // Security: Basic input validation
  for (const [key, value] of Object.entries(req.body || {})) {
    if (typeof value === 'string' && value.length > 10000) {
      return res.status(400).json({
        error: 'Input field too long',
        field: key
      });
    }
  }
  next();
};

app.use(validateInput);

// =============================================================================
// FEATURE FLAGS & CONFIGURATION
// =============================================================================

// Feature flags (can be controlled via environment variables)
const FEATURE_FLAGS = {
  multipartUploads: process.env.ENABLE_MULTIPART_UPLOADS !== 'false',
  backgroundProcessing: process.env.ENABLE_BACKGROUND_PROCESSING !== 'false',
  legacyChunkedUploads: process.env.ENABLE_LEGACY_CHUNKED !== 'false',
  formdataUploads: process.env.ENABLE_FORMDATA_UPLOADS !== 'false'
};

console.log('Ã°Å¸ÂÂ Feature Flags:', FEATURE_FLAGS);
console.log('Ã°Å¸â€â€™ Security Features: Rate Limiting, CORS Filtering, Input Validation, Helmet Headers');

// =============================================================================
// BACKGROUND PROCESSING INITIALIZATION
// =============================================================================

let backgroundProcessor = null;

if (FEATURE_FLAGS.backgroundProcessing) {
  try {
    const { initializeQueue } = require('./utils/upload-queue');
    backgroundProcessor = initializeQueue();
    console.log('Ã¢Å“â€¦ Background processing queue initialized');
  } catch (error) {
    console.error('Ã¢ÂÅ’ Failed to initialize background processing:', error.message);
    console.log('Ã°Å¸â€œÂ Background processing will be disabled');
  }
}

// =============================================================================
// ROUTES
// =============================================================================

// Root route with security info
app.get('/', (req, res) => {
  console.log('Ã°Å¸ÂÂ  ROOT ROUTE HIT');
  res.json({ 
    message: 'Rushes Backend Server - Enhanced with Secure Direct B2 Multipart Uploads!',
    port: process.env.PORT,
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    status: 'operational',
    security: {
      rateLimiting: 'enabled',
      corsFiltering: 'enabled',
      inputValidation: 'enabled',
      securityHeaders: 'enabled'
    },
    features: {
      uploadMethods: {
        formdata: FEATURE_FLAGS.formdataUploads ? 'enabled' : 'disabled',
        chunked: FEATURE_FLAGS.legacyChunkedUploads ? 'enabled' : 'disabled',
        directMultipart: FEATURE_FLAGS.multipartUploads ? 'enabled' : 'disabled'
      },
      backgroundProcessing: FEATURE_FLAGS.backgroundProcessing ? 'enabled' : 'disabled',
      maxFileSize: '100GB',
      architecture: 'secure-hybrid-upload-system'
    }
  });
});

// Health check with security info
app.get('/health', (req, res) => {
  const memInfo = process.memoryUsage();
  
  res.json({ 
    status: 'ok',
    service: 'rushes-backend-enhanced-secure',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      rss: `${Math.floor(memInfo.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.floor(memInfo.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.floor(memInfo.heapTotal / 1024 / 1024)}MB`
    },
    port: process.env.PORT,
    features: FEATURE_FLAGS,
    security: {
      rateLimiting: 'active',
      corsFiltering: 'active',
      inputValidation: 'active',
      securityHeaders: 'active'
    },
    backgroundProcessor: backgroundProcessor ? 'active' : 'inactive'
  });
});

// CORS test with security validation
app.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'CORS working with Enhanced Secure Upload System',
    origin: req.headers.origin || 'Unknown',
    timestamp: new Date().toISOString(),
    headers: Object.keys(req.headers),
    ip: req.ip,
    features: FEATURE_FLAGS,
    security: 'enabled'
  });
});

// Debug routes (limited in production)
app.get('/debug-routes', (req, res) => {
  // Security: Limit debug info in production
  if (process.env.NODE_ENV === 'production' && !req.headers['x-debug-token']) {
    return res.status(403).json({
      error: 'Debug information not available in production'
    });
  }
  
  const routes = [];
  app._router.stack.forEach((middleware) => {
    if (middleware.route) {
      const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
      routes.push(`${methods} ${middleware.route.path}`);
    }
  });
  
  res.json({ 
    message: 'All registered routes',
    routes,
    totalRoutes: routes.length,
    port: process.env.PORT,
    architecture: 'enhanced-secure-hybrid-upload-system',
    features: FEATURE_FLAGS
  });
});

// =============================================================================  
// UPLOAD ROUTES - Enhanced with security
// =============================================================================
try {
  const uploadRoutes = require('./routes/upload'); // This should be the secure enhanced version
  app.use('/upload', uploadRoutes);
  console.log('Ã¢Å“â€¦ Enhanced secure upload routes loaded successfully');
} catch (error) {
  console.error('Ã¢ÂÅ’ Failed to load upload routes:', error.message);
  console.log('Ã°Å¸â€œÂ Make sure ./routes/upload.js exists and exports properly');
  console.error('Full error:', error);
}

// =============================================================================
// NEW MULTIPART UPLOAD ROUTES (if enabled)
// =============================================================================
if (FEATURE_FLAGS.multipartUploads) {
  try {
    // Try to load standalone multipart routes if they exist
    const multipartRoutes = require('./routes/multipart-upload');
    app.use('/multipart', multipartRoutes);
    console.log('Ã¢Å“â€¦ Standalone multipart upload routes loaded successfully');
  } catch (error) {
    console.log('Ã°Å¸â€œÂ Standalone multipart routes not found - using integrated routes in /upload');
  }
}

// =============================================================================
// TEST ROUTES (Optional - limited in production)
// =============================================================================
if (process.env.NODE_ENV !== 'production') {
  try {
    const testRoutes = require('./routes/test');
    app.use('/test', testRoutes);
    console.log('Ã¢Å“â€¦ Test routes loaded successfully (development only)');
  } catch (error) {
    console.log('Ã°Å¸â€œÂ Test routes not found (optional)');
  }
}

// =============================================================================
// VIDEO ROUTES (Optional - for video management)
// =============================================================================
try {
  const videoRoutes = require('./routes/video');
  app.use('/video', videoRoutes);
  console.log('Ã¢Å“â€¦ Video routes loaded successfully');
} catch (error) {
  console.log('Ã°Å¸â€œÂ Video routes not found (optional)');
}

// =============================================================================
// COCONUT HLS WEBHOOK ROUTE
// =============================================================================
{
  const { updateHlsStatus } = require('./services/supabase');
  const coconutWebhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 60,
    message: { error: 'Too many webhook requests' }
  });

  app.post('/api/coconut/webhook', coconutWebhookLimiter, express.json(), async (req, res) => {
    try {
      const videoId = req.query.videoId;
      const payload = req.body;

      // Coconut wraps data in: { job_id, event, data: { status, progress, outputs, ... } }
      const eventType = payload.event;
      const jobData = payload.data || {};
      const jobId = payload.job_id || jobData.id;

      console.log(`[Coconut Webhook] Received for video ${videoId}: event=${eventType}, job_id=${jobId}, progress=${jobData.progress || 'n/a'}`);

      if (!videoId) {
        console.error('[Coconut Webhook] Missing videoId query param');
        return res.status(400).json({ error: 'Missing videoId' });
      }

      if (eventType === 'job.completed') {
        // Extract HLS URL from outputs inside data
        let hlsUrl = null;
        if (jobData.outputs && Array.isArray(jobData.outputs)) {
          const httpstreamOutput = jobData.outputs.find(o => o.type === 'httpstream');
          if (httpstreamOutput && httpstreamOutput.urls) {
            const hlsEntry = httpstreamOutput.urls.find(u => u.format === 'hls');
            if (hlsEntry) hlsUrl = hlsEntry.url;
          }
        }

        // Fallback: construct URL from config
        if (!hlsUrl) {
          const hlsBucketName = process.env.B2_HLS_BUCKET_NAME || 'rushes-hls';
          hlsUrl = `https://${hlsBucketName}.s3.eu-central-003.backblazeb2.com/${videoId}/hls/master.m3u8`;
        }

        console.log(`[Coconut Webhook] HLS READY for video ${videoId}: ${hlsUrl}`);
        await updateHlsStatus(videoId, {
          hls_status: 'ready',
          hls_url: hlsUrl,
          transcode_job_id: jobId
        });

      } else if (eventType === 'job.failed' || eventType === 'job.error') {
        console.error(`[Coconut Webhook] HLS FAILED for video ${videoId}:`, JSON.stringify(payload));
        await updateHlsStatus(videoId, {
          hls_status: 'failed',
          transcode_job_id: jobId
        });

      } else {
        // In-progress events like input.transferred, output.completed, etc.
        console.log(`[Coconut Webhook] Event: ${eventType} for video ${videoId}`);
      }

      res.status(200).json({ received: true });

    } catch (error) {
      console.error('[Coconut Webhook] Error:', error);
      res.status(200).json({ received: true, error: error.message });
    }
  });

  console.log('Coconut HLS webhook route loaded at POST /api/coconut/webhook');
}

// =============================================================================
// SWAGGER DOCUMENTATION ROUTES
// =============================================================================
try {
  const swaggerRoutes = require('./routes/swagger');
  app.use('/swagger', swaggerRoutes);
  console.log('Ã¢Å“â€¦ Swagger documentation routes loaded successfully');
  console.log('Ã°Å¸â€œÅ¡ API Documentation available at: /swagger');
} catch (error) {
  console.log('Ã°Å¸â€œÂ Swagger routes not found (optional)');
}

// =============================================================================
// BACKGROUND QUEUE MONITORING ROUTES (secured)
// =============================================================================
if (FEATURE_FLAGS.backgroundProcessing) {
  // Security: Rate limit for monitoring endpoints
  const monitoringRateLimit = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute per IP
    message: {
      error: 'Too many monitoring requests'
    }
  });
  
  // Queue status endpoint
  app.get('/queue/status', monitoringRateLimit, (req, res) => {
    try {
      const { getQueueStats } = require('./utils/upload-queue');
      const stats = getQueueStats();
      
      // Security: Remove sensitive information
      const sanitizedStats = {
        ...stats,
        queuedJobs: stats.queuedJobs?.map(job => ({
          jobId: job.jobId,
          uploadId: job.uploadId,
          queuedAt: job.queuedAt,
          attempts: job.attempts
        })),
        activeJobs: stats.activeJobs?.map(job => ({
          jobId: job.jobId,
          uploadId: job.uploadId,
          startedAt: job.startedAt,
          attempts: job.attempts
        }))
      };
      
      res.json({
        success: true,
        ...sanitizedStats,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get queue status'
      });
    }
  });
  
  // Job status endpoint
  app.get('/queue/job/:jobId', monitoringRateLimit, (req, res) => {
    try {
      const jobId = req.params.jobId;
      
      // Security: Validate jobId format
      if (!jobId || jobId.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
        return res.status(400).json({
          error: 'Invalid job ID format'
        });
      }
      
      const { getJobStatus } = require('./utils/upload-queue');
      const job = getJobStatus(jobId);
      
      if (!job) {
        return res.status(404).json({
          error: 'Job not found',
          jobId: jobId
        });
      }
      
      // Security: Remove sensitive information
      const sanitizedJob = {
        jobId: job.jobId,
        type: job.type,
        status: job.status,
        progress_percent: job.progress_percent,
        attempts: job.attempts,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        uploadId: job.data?.uploadId
      };
      
      res.json({
        success: true,
        job: sanitizedJob
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get job status'
      });
    }
  });
}

// =============================================================================
// SOCKET.IO HANDLING - Enhanced with security
// =============================================================================

// Security: Rate limiting for socket connections
const socketConnectionLimiter = new Map();

io.use((socket, next) => {
  const ip = socket.handshake.address;
  const now = Date.now();
  
  // Security: Limit connections per IP
  if (!socketConnectionLimiter.has(ip)) {
    socketConnectionLimiter.set(ip, []);
  }
  
  const connections = socketConnectionLimiter.get(ip);
  const recentConnections = connections.filter(time => now - time < 60000); // Last minute
  
  if (recentConnections.length > 10) { // Max 10 connections per minute per IP
    console.log(`Ã°Å¸Å¡Â« Socket connection rate limited for IP: ${ip}`);
    return next(new Error('Too many connections'));
  }
  
  connections.push(now);
  socketConnectionLimiter.set(ip, recentConnections);
  
  next();
});

io.on('connection', (socket) => {
  const clientId = socket.id;
  const origin = socket.handshake.headers.origin;
  const ip = socket.handshake.address;
  
  console.log(`Ã°Å¸â€Å’ SECURE CLIENT CONNECTED: ${clientId} from ${origin || 'unknown'} [IP: ${ip}]`);
  
  socket.on('subscribe', (uploadId) => {
    // Security: Validate uploadId
    if (!uploadId || typeof uploadId !== 'string' || uploadId.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(uploadId)) {
      console.log(`Ã¢ÂÅ’ Invalid uploadId from ${clientId}: ${uploadId}`);
      socket.emit('error', { message: 'Invalid upload ID' });
      return;
    }
    
    console.log(`Ã°Å¸â€œÂº CLIENT SUBSCRIBED: ${clientId} to ${uploadId}`);
    socket.join(uploadId);
    
    // Send current status immediately
    const status = getUploadStatus(uploadId);
    if (status) {
      socket.emit('status', status);
      console.log(`Ã°Å¸â€œÂ¤ Sent current status to ${clientId}:`, {
        status: status.status,
        progress: status.progress,
        uploadMethod: status.uploadMethod || 'unknown',
        complete: status.uploadComplete
      });
    } else {
      socket.emit('welcome', {
        message: 'Connected to secure enhanced upload service',
        socketId: clientId,
        uploadId,
        timestamp: Date.now(),
        service: 'enhanced-secure-hybrid-upload-system',
        capabilities: FEATURE_FLAGS
      });
      console.log(`Ã°Å¸â€˜â€¹ Sent welcome to ${clientId} for ${uploadId}`);
    }
  });
  
  // Enhanced event for multipart upload progress with security
  socket.on('multipart_progress', (data) => {
    // Security: Validate progress data
    if (!data || typeof data !== 'object' || !data.uploadId || !data.partNumber || typeof data.progress !== 'number') {
      console.log(`Ã¢ÂÅ’ Invalid multipart progress data from ${clientId}`);
      return;
    }
    
    const { uploadId, partNumber, progress } = data;
    
    // Security: Additional validation
    if (uploadId.length > 100 || partNumber < 1 || partNumber > 10000 || progress < 0 || progress > 100) {
      console.log(`Ã¢ÂÅ’ Invalid multipart progress values from ${clientId}`);
      return;
    }
    
    console.log(`Ã°Å¸â€œÅ  Multipart progress update: ${uploadId} part ${partNumber} - ${progress}%`);
    
    // Broadcast to other clients subscribed to this upload
    socket.to(uploadId).emit('multipart_progress', {
      uploadId,
      partNumber,
      progress,
      timestamp: Date.now()
    });
  });
  
  socket.on('unsubscribe', (uploadId) => {
    // Security: Validate uploadId
    if (uploadId && typeof uploadId === 'string' && uploadId.length <= 100) {
      console.log(`Ã°Å¸â€œÂº CLIENT UNSUBSCRIBED: ${clientId} from ${uploadId}`);
      socket.leave(uploadId);
    }
  });
  
  socket.on('disconnect', (reason) => {
    console.log(`Ã°Å¸â€Å’ CLIENT DISCONNECTED: ${clientId} - ${reason}`);
  });
  
  socket.on('error', (error) => {
    console.log(`Ã¢ÂÅ’ Socket error for ${clientId}:`, error.message || error);
  });
  
  // Security: Handle potential abuse
  socket.on('*', (event, data) => {
    console.log(`Ã¢Å¡Â Ã¯Â¸Â Unknown socket event '${event}' from ${clientId}`);
  });
});

// =============================================================================
// ERROR HANDLING MIDDLEWARE
// =============================================================================

// Security: Error handling middleware that doesn't leak information
app.use((error, req, res, next) => {
  console.error('Ã¢ÂÅ’ Unhandled error:', error);
  
  // Preserve CORS headers
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  
  // Don't leak error details in production
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  let statusCode = 500;
  let message = 'Internal server error';
  
  if (error.status) {
    statusCode = error.status;
  }
  
  if (error.message && (isDevelopment || statusCode < 500)) {
    message = error.message;
  }
  
  res.status(statusCode).json({
    error: message,
    ...(isDevelopment ? { 
      stack: error.stack,
      details: error.toString()
    } : {})
  });
});

// =============================================================================
// GRACEFUL SHUTDOWN HANDLING
// =============================================================================

process.on('SIGTERM', () => {
  console.log('Ã°Å¸â€ºâ€˜ SIGTERM received, shutting down gracefully...');
  
  // Stop accepting new connections
  server.close(() => {
    console.log('Ã¢Å“â€¦ HTTP server closed');
    
    // Stop background processor
    if (backgroundProcessor) {
      backgroundProcessor.stop();
      console.log('Ã¢Å“â€¦ Background processor stopped');
    }
    
    // Close socket.io
    io.close(() => {
      console.log('Ã¢Å“â€¦ Socket.io closed');
      process.exit(0);
    });
  });
  
  // Force close after 30 seconds
  setTimeout(() => {
    console.error('Ã¢ÂÅ’ Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
});

process.on('SIGINT', () => {
  console.log('Ã°Å¸â€ºâ€˜ SIGINT received, shutting down gracefully...');
  
  // Stop accepting new connections
  server.close(() => {
    console.log('Ã¢Å“â€¦ HTTP server closed');
    
    // Stop background processor
    if (backgroundProcessor) {
      backgroundProcessor.stop();
      console.log('Ã¢Å“â€¦ Background processor stopped');
    }
    
    // Close socket.io
    io.close(() => {
      console.log('Ã¢Å“â€¦ Socket.io closed');
      process.exit(0);
    });
  });
  
  // Force close after 30 seconds
  setTimeout(() => {
    console.error('Ã¢ÂÅ’ Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
});

// =============================================================================
// CATCH ALL - Should be last
// =============================================================================
app.use('*', (req, res) => {
  console.log(`Ã°Å¸â€Â CATCH ALL: ${req.method} ${req.originalUrl} [IP: ${req.ip}]`);
  res.status(404).json({ 
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method,
    availableRoutes: [
      'GET /',
      'GET /health',
      'GET /cors-test',
      'GET /upload/status/:uploadId',
      'POST /upload/video (FormData uploads)',
      'POST /upload/chunk (Legacy chunked uploads)',
      'POST /upload/complete-chunks (Legacy chunked completion)',
      'POST /upload/multipart/initialize (Direct B2 multipart)',
      'POST /upload/multipart/get-urls (Additional part URLs)',
      'POST /upload/multipart/complete (Complete multipart upload)',
      'POST /upload/multipart/cancel (Cancel multipart upload)',
      'POST /upload/thumbnail (Custom thumbnail upload)',
      'POST /upload/subtitle (Subtitle upload .srt/.vtt)',
      'POST /upload/generate-thumbnail',
      'GET /upload/health',
      'GET /queue/status (Background processing)',
      'GET /queue/job/:jobId (Job status)'
    ],
    features: FEATURE_FLAGS
  });
});

// Validate environment and setup directories before starting
async function initializeServer() {
  try {
    // Validate environment variables
    validateEnvironment();
    
    // Setup required directories
    await setupDirectories();
    
    // Start server
    const port = process.env.PORT || 3000;
    const env = (process.env.NODE_ENV || 'development').toUpperCase();
    const baseUrl = `http://localhost:${port}`;
    const apiBase = `${baseUrl}/upload`;
    const apiDocs = `${baseUrl}/swagger`;
    
    server.listen(port, '0.0.0.0', () => {
      // Clear console for clean startup
      console.clear();
      
      // Format strings with proper padding (total width: 59 chars inside box)
      const formatLine = (label, value) => {
        const line = `Ã¢â€¢â€˜  Ã¢Å¾Å“ ${label.padEnd(12)} ${value.padEnd(43)}Ã¢â€¢â€˜`;
        return line;
      };
      
      // Create formatted startup box
      console.log('');
      console.log('Ã¢â€¢â€Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢â€”');
      console.log('Ã¢â€¢â€˜                    Ã°Å¸Å¡â‚¬ SERVER STARTED Ã°Å¸Å¡â‚¬                       Ã¢â€¢â€˜');
      console.log('Ã¢â€¢Â Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â£');
      console.log(formatLine('Local:', baseUrl));
      console.log(formatLine('API Base:', apiBase));
      console.log(formatLine('API Docs:', apiDocs));
      console.log(`Ã¢â€¢â€˜  Ã¢Å¾Å“ Environment:  ${env.padEnd(43)}Ã¢â€¢â€˜`);
      console.log('Ã¢â€¢Â Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â£');
      console.log('Ã¢â€¢â€˜  Ã°Å¸â€â€™ Security Features:                                        Ã¢â€¢â€˜');
      console.log('Ã¢â€¢â€˜     Ã¢â‚¬Â¢ Rate Limiting: Ã¢Å“â€¦ Enabled                               Ã¢â€¢â€˜');
      console.log('Ã¢â€¢â€˜     Ã¢â‚¬Â¢ CORS Filtering: Ã¢Å“â€¦ Enabled                              Ã¢â€¢â€˜');
      console.log('Ã¢â€¢â€˜     Ã¢â‚¬Â¢ Input Validation: Ã¢Å“â€¦ Enabled                            Ã¢â€¢â€˜');
      console.log('Ã¢â€¢â€˜     Ã¢â‚¬Â¢ Security Headers: Ã¢Å“â€¦ Enabled                            Ã¢â€¢â€˜');
      console.log('Ã¢â€¢â€˜     Ã¢â‚¬Â¢ Socket Security: Ã¢Å“â€¦ Enabled                              Ã¢â€¢â€˜');
      console.log('Ã¢â€¢Â Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â£');
      console.log('Ã¢â€¢â€˜  Ã°Å¸â€œÂ¤ Upload Methods:                                           Ã¢â€¢â€˜');
      const formDataStatus = FEATURE_FLAGS.formdataUploads ? 'Ã¢Å“â€¦ Enabled' : 'Ã¢ÂÅ’ Disabled';
      const chunkedStatus = FEATURE_FLAGS.legacyChunkedUploads ? 'Ã¢Å“â€¦ Enabled' : 'Ã¢ÂÅ’ Disabled';
      const multipartStatus = FEATURE_FLAGS.multipartUploads ? 'Ã¢Å“â€¦ Enabled' : 'Ã¢ÂÅ’ Disabled';
      const bgProcessingStatus = FEATURE_FLAGS.backgroundProcessing ? 'Ã¢Å“â€¦ Enabled' : 'Ã¢ÂÅ’ Disabled';
      console.log(`Ã¢â€¢â€˜     Ã¢â‚¬Â¢ FormData: ${formDataStatus.padEnd(47)}Ã¢â€¢â€˜`);
      console.log(`Ã¢â€¢â€˜     Ã¢â‚¬Â¢ Legacy Chunked: ${chunkedStatus.padEnd(44)}Ã¢â€¢â€˜`);
      console.log(`Ã¢â€¢â€˜     Ã¢â‚¬Â¢ Direct B2 Multipart: ${multipartStatus.padEnd(40)}Ã¢â€¢â€˜`);
      console.log('Ã¢â€¢â€˜     Ã¢â‚¬Â¢ Custom Thumbnails: Ã¢Å“â€¦ Enabled                           Ã¢â€¢â€˜');
      console.log('Ã¢â€¢Â Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â£');
      console.log('Ã¢â€¢â€˜  Ã¢Å¡â„¢Ã¯Â¸Â  Configuration:                                           Ã¢â€¢â€˜');
      console.log(`Ã¢â€¢â€˜     Ã¢â‚¬Â¢ Background Processing: ${bgProcessingStatus.padEnd(40)}Ã¢â€¢â€˜`);
      console.log('Ã¢â€¢â€˜     Ã¢â‚¬Â¢ Memory Usage: Optimized (25MB chunks max)               Ã¢â€¢â€˜');
      console.log('Ã¢â€¢â€˜     Ã¢â‚¬Â¢ Max File Size: 100GB                                    Ã¢â€¢â€˜');
      console.log('Ã¢â€¢â€˜     Ã¢â‚¬Â¢ Socket.IO: Enhanced with security                        Ã¢â€¢â€˜');
      console.log('Ã¢â€¢Å¡Ã¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢ÂÃ¢â€¢Â');
      console.log('');
      console.log('Ã¢Å“â€¦ READY FOR SECURE UPLOADS!');
      console.log('');
    });
  } catch (error) {
    console.error('Ã¢ÂÅ’ Server initialization failed:', error.message);
    process.exit(1);
  }
}

// Initialize the server
initializeServer();

module.exports = { app, server, io };