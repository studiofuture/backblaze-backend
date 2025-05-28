// Here's your server.js with the exact changes marked:

require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const cors = require('cors');
const { setupDirectories } = require('./utils/directory');
const { validateEnvironment, config } = require('./config');
const errorHandler = require('./middleware/errorHandler');
const corsMiddleware = require('./middleware/cors');
const uploadRoutes = require('./routes/upload');
const videoRoutes = require('./routes/video');
const testRoutes = require('./routes/test');
const logger = require('./utils/logger');
const { startHeartbeat } = require('./utils/heartbeat');

// Configure global HTTP agent settings to prevent EPIPE errors
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

// Define allowed origins - UPDATED with Render URL
const allowedOrigins = [
  "https://www.rvshes.com",
  "https://rvshes.com",
  "https://backblaze-backend-p9xu.onrender.com",
  "https://c36396e7-7511-4311-b6cd-951c02385844.lovableproject.com",
  "https://id-preview--c36396e7-7511-4311-b6cd-951c02385844.lovable.app",
  "http://localhost:3000",
  "http://localhost:5173"
];

// Add production origins for Render
if (process.env.NODE_ENV === 'production') {
  // Add your Render backend URL here when you know it
  // allowedOrigins.push("https://your-render-app.onrender.com");
}

// ==================== STEP 1: COMMENT OUT THIS LINE ====================
// Apply CORS middleware FIRST
// app.use(corsMiddleware); // <-- COMMENT OUT OR DELETE THIS LINE

// ==================== STEP 2: ADD THIS NEW CORS MIDDLEWARE HERE ====================
// EMERGENCY CORS FIX - Add this right after the corsMiddleware line above
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Log all requests for debugging
  console.log(`🌐 Request: ${req.method} ${req.path} from origin: ${origin || 'no-origin'}`);
  
  // Be very permissive with CORS for now
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-upload-id, Accept, Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // Handle preflight OPTIONS requests
  if (req.method === 'OPTIONS') {
    console.log(`✅ Handling OPTIONS preflight for ${req.path}`);
    return res.status(200).end();
  }
  
  next();
});

// ==================== STEP 3: REPLACE YOUR SOCKET.IO CONFIGURATION ====================
// Configure Socket.io with proper CORS settings
// FIND THIS SECTION AND REPLACE IT:
/*
const io = new Server(server, {
  cors: {
    origin: function(origin, callback) {
      // Allow requests with no origin (mobile apps, etc.)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-upload-id"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});
*/

// REPLACE WITH THIS SIMPLER VERSION:
const io = new Server(server, {
  cors: {
    origin: true, // Allow all origins for now
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-upload-id"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Make io available to routes
app.set('io', io);

// Make io available to our status utility
const statusUtils = require('./utils/status');
statusUtils.setupSocketIO(io);

// Setup middleware
app.use(express.json({ limit: config.server.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.server.bodyLimit }));

// Add headers for better debugging
app.use((req, res, next) => {
  res.setHeader('X-Server-ID', 'backblaze-upload-service');
  next();
});

// Create required directories
setupDirectories().catch(err => {
  logger.error('Failed to create directories:', err);
  process.exit(1);
});

// Start server heartbeat to prevent idle timeouts
const heartbeat = startHeartbeat();

// Register routes
app.use('/upload', uploadRoutes);
app.use('/video', videoRoutes);
app.use('/test', testRoutes);

// ADD THIS DEBUGGING SECTION
console.log('=== REGISTERED ROUTES ===');
app._router.stack.forEach((middleware) => {
  if (middleware.route) {
    console.log(`${Object.keys(middleware.route.methods).join(', ').toUpperCase()} ${middleware.route.path}`);
  } else if (middleware.name === 'router') {
    middleware.handle.stack.forEach((handler) => {
      if (handler.route) {
        console.log(`${Object.keys(handler.route.methods).join(', ').toUpperCase()} ${middleware.regexp.source.replace('\\/?', '').replace('(?=\\/|$)', '')}${handler.route.path}`);
      }
    });
  }
});
console.log('=== END ROUTES ===');

// Simple health check route
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cors: {
      allowedOrigins
    }
  });
});

app.get('/test-direct', (req, res) => {
  res.json({
    message: 'Direct route works!',
    timestamp: new Date().toISOString()
  });
});

app.get('/cors-test-direct', (req, res) => {
  // Set CORS headers manually
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-upload-id');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  res.json({
    success: true,
    message: 'Direct CORS test works!',
    origin: req.headers.origin || 'Unknown',
    timestamp: new Date().toISOString()
  });
});

// Add a CORS test endpoint
app.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'CORS is properly configured',
    origin: req.headers.origin || 'Unknown',
    time: new Date().toISOString()
  });
});

// ==================== STEP 4: REPLACE YOUR STATUS ROUTE ====================
// FIND THIS SECTION:
/*
// WORKING UPLOAD STATUS ROUTE - ADD THIS
app.get('/upload/status/:uploadId', (req, res) => {
  // Set CORS headers first
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-upload-id');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  const { uploadId } = req.params;
  logger.info(`Status request for upload ${uploadId}`);
  
  try {
    const { getUploadStatus } = require('./utils/status');
    const status = getUploadStatus(uploadId);
    
    if (!status) {
      return res.status(404).json({ error: 'Upload not found' });
    }
    
    res.json(status);
  } catch (error) {
    logger.error('Status route error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
*/

// REPLACE WITH THIS ENHANCED VERSION:
app.get('/upload/status/:uploadId', (req, res) => {
  // Set CORS headers explicitly
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-upload-id, Accept');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  const { uploadId } = req.params;
  console.log(`📊 Status request for upload ${uploadId} from origin: ${origin || 'unknown'}`);
  
  try {
    const { getUploadStatus } = require('./utils/status');
    const status = getUploadStatus(uploadId);
    
    if (!status) {
      console.log(`❌ Upload status not found for ID: ${uploadId}`);
      return res.status(404).json({ 
        error: 'Upload not found',
        message: 'This upload may have expired or completed already',
        uploadId: uploadId
      });
    }
    
    console.log(`✅ Returning status for ${uploadId}:`, status);
    res.json(status);
  } catch (error) {
    console.error('❌ Status route error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to retrieve upload status',
      uploadId: uploadId
    });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  const clientId = socket.id;
  logger.info(`Client connected: ${clientId} from ${socket.handshake.headers.origin || 'Unknown origin'}`);
  
  // ... rest of your socket handling code stays the same ...
});

// Error handling middleware (must be last)
app.use(errorHandler);

// Start the server
const port = process.env.PORT || 3000;
server.listen(port, () => {
  logger.info(`✅ Server running on http://localhost:${port}`);
  logger.info(`🔌 Socket.IO configured with origins: ${allowedOrigins.join(', ')}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  
  // Stop the heartbeat
  if (heartbeat) {
    heartbeat.stop();
  }
  
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

module.exports = { app, server, io };