require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const cors = require('cors');
const { setupDirectories } = require('./utils/directory');
const { validateEnvironment, config } = require('./config');
const errorHandler = require('./middleware/errorHandler');
const uploadRoutes = require('./routes/upload');
const videoRoutes = require('./routes/video');
const testRoutes = require('./routes/test');
const logger = require('./utils/logger');
const { startHeartbeat } = require('./utils/heartbeat');

// Configure global HTTP agent settings
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;
http.globalAgent.keepAliveMsecs = 60000;
https.globalAgent.keepAliveMsecs = 60000;

// Validate environment variables
validateEnvironment();

// Create Express app
const app = express();
const server = http.createServer(app);

// Set server timeout and connection limits
server.timeout = config.server.timeoutMs;
server.maxConnections = 200;
server.keepAliveTimeout = 120000;

// Define allowed origins
const allowedOrigins = [
  "https://www.rvshes.com",
  "https://rvshes.com", 
  "https://backblaze-backend-p9xu.onrender.com",
  "https://c36396e7-7511-4311-b6cd-951c02385844.lovableproject.com",
  "https://id-preview--c36396e7-7511-4311-b6cd-951c02385844.lovable.app",
  "http://localhost:3000",
  "http://localhost:5173"
];

// COMPREHENSIVE CORS MIDDLEWARE - handles all CORS needs
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Log requests for debugging
  console.log(`🌐 ${req.method} ${req.path} from ${origin || 'no-origin'}`);
  
  // Set CORS headers - be permissive for debugging
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-upload-id, Cache-Control, Pragma');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  
  // Handle OPTIONS preflight immediately
  if (req.method === 'OPTIONS') {
    console.log(`✅ OPTIONS ${req.path}`);
    return res.status(200).end();
  }
  
  next();
});

// Body parsing middleware
app.use(express.json({ limit: config.server.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.server.bodyLimit }));

// Server identification header
app.use((req, res, next) => {
  res.setHeader('X-Server-ID', 'rvshes-backend');
  res.setHeader('X-Powered-By', 'Rvshes Video Platform');
  next();
});

// Create required directories
setupDirectories().catch(err => {
  logger.error('Failed to create directories:', err);
  process.exit(1);
});

// Configure Socket.io with comprehensive CORS
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // Allow all origins for debugging
      callback(null, true);
    },
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-upload-id", "Origin"]
  },
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Make io available to routes and status utility
app.set('io', io);
const statusUtils = require('./utils/status');
statusUtils.setupSocketIO(io);

// Start server heartbeat
const heartbeat = startHeartbeat();

// Health check route (before other routes)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'rvshes-backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cors: { allowedOrigins },
    environment: process.env.NODE_ENV || 'development'
  });
});

// CORS test endpoints
app.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'CORS is working',
    origin: req.headers.origin || 'Unknown',
    timestamp: new Date().toISOString(),
    headers: Object.keys(req.headers)
  });
});

// Direct status endpoint (handles the upload status polling)
app.get('/upload/status/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  const origin = req.headers.origin;
  
  console.log(`📊 Status check: ${uploadId} from ${origin || 'unknown'}`);
  
  try {
    const status = statusUtils.getUploadStatus(uploadId);
    
    if (!status) {
      console.log(`❌ No status found for: ${uploadId}`);
      return res.status(404).json({ 
        error: 'Upload not found',
        uploadId,
        message: 'Upload may have expired or completed'
      });
    }
    
    console.log(`✅ Status found for ${uploadId}:`, {
      status: status.status,
      progress: status.progress,
      stage: status.stage,
      complete: status.uploadComplete
    });
    
    res.json(status);
  } catch (error) {
    console.error(`❌ Status error for ${uploadId}:`, error);
    res.status(500).json({ 
      error: 'Status check failed',
      uploadId,
      details: error.message
    });
  }
});

// Register route modules
app.use('/upload', uploadRoutes);
app.use('/video', videoRoutes);
app.use('/test', testRoutes);

// Socket.io connection handling
io.on('connection', (socket) => {
  const clientId = socket.id;
  const origin = socket.handshake.headers.origin;
  
  logger.info(`🔌 Client connected: ${clientId} from ${origin || 'unknown'}`);
  
  socket.on('subscribe', (uploadId) => {
    if (!uploadId) {
      logger.warn(`❌ Subscribe without uploadId from ${clientId}`);
      return;
    }
    
    logger.info(`📺 Client ${clientId} subscribed to ${uploadId}`);
    socket.join(uploadId);
    
    // Send current status immediately
    const status = statusUtils.getUploadStatus(uploadId);
    if (status) {
      socket.emit('status', status);
      logger.info(`📤 Sent current status to ${clientId}:`, {
        status: status.status,
        progress: status.progress,
        complete: status.uploadComplete
      });
    } else {
      // Send welcome message to confirm connection
      socket.emit('welcome', {
        message: 'Connected to upload service',
        socketId: clientId,
        timestamp: Date.now()
      });
      logger.info(`👋 Sent welcome to ${clientId}`);
    }
  });
  
  socket.on('unsubscribe', (uploadId) => {
    if (uploadId) {
      logger.info(`📺 Client ${clientId} unsubscribed from ${uploadId}`);
      socket.leave(uploadId);
    }
  });
  
  socket.on('disconnect', (reason) => {
    logger.info(`🔌 Client ${clientId} disconnected: ${reason}`);
  });
  
  socket.on('error', (error) => {
    logger.error(`❌ Socket error for ${clientId}:`, error);
  });
});

// Debug route registration
console.log('=== ROUTE REGISTRATION ===');
app._router.stack.forEach((middleware) => {
  if (middleware.route) {
    const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
    console.log(`${methods} ${middleware.route.path}`);
  } else if (middleware.name === 'router') {
    const routerBasePath = middleware.regexp.source
      .replace('\\/?', '')
      .replace('(?=\\/|$)', '');
    
    middleware.handle.stack.forEach((handler) => {
      if (handler.route) {
        const methods = Object.keys(handler.route.methods).join(', ').toUpperCase();
        console.log(`${methods} ${routerBasePath}${handler.route.path}`);
      }
    });
  }
});
console.log('=== END ROUTES ===');

// Error handling middleware (must be last)
app.use(errorHandler);

// Start the server
const port = process.env.PORT || 3000;
server.listen(port, () => {
  logger.info(`✅ Rvshes Backend Server running on http://localhost:${port}`);
  logger.info(`🔌 Socket.IO configured with comprehensive CORS`);
  logger.info(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('🛑 SIGTERM received - shutting down gracefully');
  
  if (heartbeat) {
    heartbeat.stop();
  }
  
  server.close(() => {
    logger.info('✅ Server closed');
    process.exit(0);
  });
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('💥 Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

module.exports = { app, server, io };