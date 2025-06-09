require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

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

// Configure Socket.io
const io = new Server(server, {
  cors: {
    origin: "*", // Very permissive for debugging
    methods: ["GET", "POST"],
    credentials: true
  },
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Initialize socket.io in the status utility
setupSocketIO(io);

// COMPREHENSIVE CORS MIDDLEWARE
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  console.log(`🌐 ${req.method} ${req.url} from ${origin || 'no-origin'}`);
  
  // Super permissive CORS headers
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-upload-id, x-chunk-index, x-total-chunks, x-chunk-size, x-file-name, x-file-type, x-total-size, Cache-Control, Pragma');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  
  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    console.log(`✅ OPTIONS ${req.url} - CORS preflight handled`);
    return res.status(200).end();
  }
  
  next();
});

// UPDATED: Body parsing - reduced limits since we're using streaming uploads for files
app.use(express.json({ limit: '5mb' }));      // Only for API calls, not file uploads
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// =============================================================================
// ROUTES
// =============================================================================

// Root route
app.get('/', (req, res) => {
  console.log('🏠 ROOT ROUTE HIT');
  res.json({ 
    message: 'Rvshes Backend Server - Running Successfully with Busboy!',
    port: process.env.PORT,
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    status: 'operational',
    uploadMethod: 'busboy-streaming',
    maxFileSize: '100GB'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    service: 'rvshes-backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    port: process.env.PORT,
    uploadMethod: 'busboy-streaming'
  });
});

// CORS test
app.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'CORS is working perfectly with Busboy',
    origin: req.headers.origin || 'Unknown',
    timestamp: new Date().toISOString(),
    headers: Object.keys(req.headers)
  });
});

// Debug routes
app.get('/debug-routes', (req, res) => {
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
    uploadMethod: 'busboy-streaming'
  });
});

// =============================================================================  
// UPLOAD ROUTES - Import the busboy upload routes
// =============================================================================
try {
  const uploadRoutes = require('./routes/upload');
  app.use('/upload', uploadRoutes);
  console.log('✅ Busboy upload routes loaded successfully');
} catch (error) {
  console.error('❌ Failed to load upload routes:', error.message);
  console.log('📝 Make sure ./routes/upload.js exists and exports properly');
  console.error('Full error:', error);
}

// =============================================================================
// TEST ROUTES (Optional - for debugging)
// =============================================================================
try {
  const testRoutes = require('./routes/test');
  app.use('/test', testRoutes);
  console.log('✅ Test routes loaded successfully');
} catch (error) {
  console.log('📝 Test routes not found (optional)');
}

// =============================================================================
// VIDEO ROUTES (Optional - for video management)
// =============================================================================
try {
  const videoRoutes = require('./routes/video');
  app.use('/video', videoRoutes);
  console.log('✅ Video routes loaded successfully');
} catch (error) {
  console.log('📝 Video routes not found (optional)');
}

// =============================================================================
// SOCKET.IO HANDLING
// =============================================================================
io.on('connection', (socket) => {
  const clientId = socket.id;
  const origin = socket.handshake.headers.origin;
  
  console.log(`🔌 CLIENT CONNECTED: ${clientId} from ${origin || 'unknown'}`);
  
  socket.on('subscribe', (uploadId) => {
    if (!uploadId) {
      console.log(`❌ Subscribe without uploadId from ${clientId}`);
      return;
    }
    
    console.log(`📺 CLIENT SUBSCRIBED: ${clientId} to ${uploadId}`);
    socket.join(uploadId);
    
    // Send current status immediately
    const status = getUploadStatus(uploadId);
    if (status) {
      socket.emit('status', status);
      console.log(`📤 Sent current status to ${clientId}:`, {
        status: status.status,
        progress: status.progress,
        complete: status.uploadComplete
      });
    } else {
      socket.emit('welcome', {
        message: 'Connected to upload service',
        socketId: clientId,
        uploadId,
        timestamp: Date.now(),
        service: 'busboy-streaming'
      });
      console.log(`👋 Sent welcome to ${clientId} for ${uploadId}`);
    }
  });
  
  socket.on('unsubscribe', (uploadId) => {
    if (uploadId) {
      console.log(`📺 CLIENT UNSUBSCRIBED: ${clientId} from ${uploadId}`);
      socket.leave(uploadId);
    }
  });
  
  socket.on('disconnect', (reason) => {
    console.log(`🔌 CLIENT DISCONNECTED: ${clientId} - ${reason}`);
  });
  
  socket.on('error', (error) => {
    console.log(`❌ Socket error for ${clientId}:`, error);
  });
});

// =============================================================================
// CATCH ALL - Should be last
// =============================================================================
app.use('*', (req, res) => {
  console.log(`🔍 CATCH ALL: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ 
    error: 'Route not found',
    path: req.originalUrl,
    method: req.method,
    availableRoutes: [
      'GET /',
      'GET /health',
      'GET /cors-test',
      'GET /debug-routes',
      'GET /upload/status/:uploadId',
      'POST /upload/video (Busboy streaming)',
      'POST /upload/generate-thumbnail',
      'GET /upload/health'
    ]
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
    server.listen(port, '0.0.0.0', () => {
      console.log(`🚀 RVSHES BACKEND SERVER STARTED SUCCESSFULLY`);
      console.log(`🔥 Port: ${port}`);
      console.log(`🔥 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔥 Upload Method: Busboy Streaming (100GB support)`);
      console.log(`🔥 Memory Usage: Optimized (25MB chunks)`);
      console.log(`🔥 Socket.IO: Enabled with comprehensive CORS`);
      console.log(`🔥 Directories: Created successfully`);
      console.log(`🔥 READY FOR LARGE FILE UPLOADS!`);
    });
  } catch (error) {
    console.error('❌ Server initialization failed:', error.message);
    process.exit(1);
  }
}

// Initialize the server
initializeServer();

module.exports = { app, server, io };