require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

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

// Store upload statuses in memory
const uploadStatuses = new Map();

// COMPREHENSIVE CORS MIDDLEWARE
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  console.log(`🌐 ${req.method} ${req.url} from ${origin || 'no-origin'}`);
  
  // Super permissive CORS headers
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-upload-id, Cache-Control, Pragma');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  
  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    console.log(`✅ OPTIONS ${req.url} - CORS preflight handled`);
    return res.status(200).end();
  }
  
  next();
});

// Body parsing
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Status utility functions
function initUploadStatus(uploadId, initialData = {}) {
  const status = {
    uploadId,
    status: 'processing',
    progress: 0,
    stage: 'initializing',
    uploadComplete: false,
    error: null,
    createdAt: new Date().toISOString(),
    ...initialData
  };
  
  uploadStatuses.set(uploadId, status);
  console.log(`📊 INIT STATUS: ${uploadId}`, status);
  
  // Emit via socket
  io.to(uploadId).emit('status', status);
  return status;
}

function updateUploadStatus(uploadId, updates) {
  const current = uploadStatuses.get(uploadId);
  if (!current) {
    console.log(`⚠️ UPDATE STATUS: ${uploadId} not found`);
    return null;
  }
  
  const updated = { ...current, ...updates, updatedAt: new Date().toISOString() };
  uploadStatuses.set(uploadId, updated);
  
  console.log(`📊 UPDATE STATUS: ${uploadId}`, {
    status: updated.status,
    progress: updated.progress,
    stage: updated.stage
  });
  
  // Emit via socket
  io.to(uploadId).emit('status', updated);
  return updated;
}

function completeUploadStatus(uploadId, finalData = {}) {
  const current = uploadStatuses.get(uploadId);
  if (!current) return null;
  
  const completed = {
    ...current,
    ...finalData,
    status: 'completed',
    progress: 100,
    uploadComplete: true,
    completedAt: new Date().toISOString()
  };
  
  uploadStatuses.set(uploadId, completed);
  
  console.log(`🎉 COMPLETE STATUS: ${uploadId}`, {
    status: completed.status,
    uploadComplete: completed.uploadComplete
  });
  
  // Emit completion
  io.to(uploadId).emit('status', completed);
  io.to(uploadId).emit('complete', completed);
  
  return completed;
}

function getUploadStatus(uploadId) {
  return uploadStatuses.get(uploadId) || null;
}

// =============================================================================
// ROUTES
// =============================================================================

// Root route
app.get('/', (req, res) => {
  console.log('🏠 ROOT ROUTE HIT');
  res.json({ 
    message: 'Rvshes Backend Server - Running Successfully!',
    port: process.env.PORT,
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    status: 'operational'
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
    port: process.env.PORT
  });
});

// CORS test
app.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'CORS is working perfectly',
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
    uploadStatuses: Array.from(uploadStatuses.keys())
  });
});

// =============================================================================
// UPLOAD STATUS ROUTE - The one that was failing!
// =============================================================================
app.get('/upload/status/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  const origin = req.headers.origin;
  
  console.log(`📊 STATUS REQUEST: ${uploadId} from ${origin || 'unknown'}`);
  
  try {
    const status = getUploadStatus(uploadId);
    
    if (!status) {
      console.log(`❌ STATUS NOT FOUND: ${uploadId}`);
      // Return a mock status for testing if uploadId starts with 'test'
      if (uploadId.startsWith('test') || uploadId.startsWith('upload_test')) {
        const mockStatus = {
          uploadId,
          status: 'completed',
          progress: 100,
          stage: 'completed',
          uploadComplete: true,
          message: 'Mock status for testing',
          videoUrl: 'https://example.com/test-video.mp4',
          thumbnailUrl: 'https://example.com/test-thumb.jpg',
          createdAt: new Date().toISOString()
        };
        console.log(`🧪 RETURNING MOCK STATUS: ${uploadId}`);
        return res.json(mockStatus);
      }
      
      return res.status(404).json({ 
        error: 'Upload not found',
        uploadId,
        message: 'Upload may have expired or completed',
        timestamp: new Date().toISOString()
      });
    }
    
    console.log(`✅ STATUS FOUND: ${uploadId}`, {
      status: status.status,
      progress: status.progress,
      stage: status.stage,
      complete: status.uploadComplete
    });
    
    res.json(status);
    
  } catch (error) {
    console.error(`❌ STATUS ERROR: ${uploadId}:`, error);
    res.status(500).json({ 
      error: 'Status check failed',
      uploadId,
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// =============================================================================
// MOCK UPLOAD ROUTE FOR TESTING
// =============================================================================
app.post('/upload/video', express.raw({ limit: '100mb', type: '*/*' }), (req, res) => {
  const uploadId = `upload_${Date.now()}`;
  
  console.log(`🎬 MOCK VIDEO UPLOAD: ${uploadId}`);
  console.log(`📁 Content-Length: ${req.headers['content-length']} bytes`);
  
  // Initialize status
  initUploadStatus(uploadId, {
    filename: `test-video-${Date.now()}.mp4`,
    videoUrl: `https://rushes-videos.s3.eu-central-003.backblazeb2.com/test-video-${Date.now()}.mp4`
  });
  
  // Return immediate response
  res.json({ 
    status: "processing", 
    uploadId,
    url: `https://rushes-videos.s3.eu-central-003.backblazeb2.com/test-video-${Date.now()}.mp4`
  });
  
  // Simulate background processing
  simulateVideoProcessing(uploadId);
});

// Simulate video processing
function simulateVideoProcessing(uploadId) {
  console.log(`🔄 SIMULATING PROCESSING: ${uploadId}`);
  
  setTimeout(() => {
    updateUploadStatus(uploadId, {
      stage: 'extracting metadata',
      progress: 10
    });
  }, 1000);
  
  setTimeout(() => {
    updateUploadStatus(uploadId, {
      stage: 'generating thumbnail',
      progress: 30
    });
  }, 3000);
  
  setTimeout(() => {
    updateUploadStatus(uploadId, {
      stage: 'uploading to cloud storage',
      progress: 60
    });
  }, 5000);
  
  setTimeout(() => {
    updateUploadStatus(uploadId, {
      stage: 'finalizing upload',
      progress: 90
    });
  }, 8000);
  
  setTimeout(() => {
    completeUploadStatus(uploadId, {
      videoUrl: `https://rushes-videos.s3.eu-central-003.backblazeb2.com/test-video-${Date.now()}.mp4`,
      thumbnailUrl: `https://rushes-thumbnails.s3.eu-central-003.backblazeb2.com/test-thumb-${Date.now()}.jpg`,
      metadata: {
        duration: 120,
        width: 1280,
        height: 720
      }
    });
  }, 10000);
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
        timestamp: Date.now()
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
      'POST /upload/video'
    ]
  });
});

// Start server
const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`🚀 RVSHES BACKEND SERVER STARTED SUCCESSFULLY`);
  console.log(`🔥 Port: ${port}`);
  console.log(`🔥 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔥 Socket.IO: Enabled with comprehensive CORS`);
  console.log(`🔥 READY FOR CONNECTIONS!`);
});

module.exports = { app, server, io };