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

// Configure global HTTP agent settings to prevent EPIPE errors
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;
http.globalAgent.keepAliveMsecs = 60000; // 60 seconds
https.globalAgent.keepAliveMsecs = 60000;

// Validate environment variables
validateEnvironment();

// Create Express app
const app = express();
const server = http.createServer(app);

// Set server timeout and connection limits
server.timeout = config.server.timeoutMs;
server.maxConnections = 100; // Adjust based on your server capacity
server.keepAliveTimeout = 60000; // 60 seconds, adjust as needed

// Define allowed origins
const allowedOrigins = [
  "https://c36396e7-7511-4311-b6cd-951c02385844.lovableproject.com",
  "https://id-preview--c36396e7-7511-4311-b6cd-951c02385844.lovable.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "*"  // Allow all origins during development/debugging
];

// Configure Socket.io with proper CORS settings
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000, // Increase ping timeout for better reliability
  pingInterval: 25000 // How often to ping clients
});

// Make io available to routes
app.set('io', io);

// Make io available to our status utility
const statusUtils = require('./utils/status');
statusUtils.setupSocketIO(io);

// Setup middleware
app.use(cors({
  origin: allowedOrigins,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true
}));

app.use(express.json({ limit: config.server.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.server.bodyLimit }));

// Add headers for better debugging and handle preflight OPTIONS requests
app.use((req, res, next) => {
  // Add server identity header
  res.setHeader('X-Server-ID', 'backblaze-upload-service');
  
  // Add explicit CORS headers to all responses
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-upload-id');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  // Handle OPTIONS method for CORS preflight
  if (req.method === 'OPTIONS') {
    logger.info(`Global OPTIONS request received from origin: ${req.headers.origin || 'unknown'} for path: ${req.path}`);
    return res.sendStatus(200);
  }
  
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

// Add a CORS test endpoint
app.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'CORS is properly configured',
    origin: req.headers.origin || 'Unknown',
    time: new Date().toISOString()
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  const clientId = socket.id;
  logger.info(`Client connected: ${clientId} from ${socket.handshake.headers.origin || 'Unknown origin'}`);
  
  // Client subscribes to an upload
  socket.on('subscribe', (uploadId) => {
    if (!uploadId) {
      logger.warn(`Client ${clientId} attempted to subscribe without an uploadId`);
      return;
    }

    logger.info(`Client ${clientId} subscribed to upload: ${uploadId}`);
    socket.join(uploadId);
    
    // Send current status if available
    let status = statusUtils.getUploadStatus(uploadId);
    
    // Try with normalized ID if original ID not found
    if (!status && uploadId.startsWith('url_')) {
      const timestamp = uploadId.split('_')[1];
      const normalizedId = `upload_${timestamp}`;
      logger.info(`Trying normalized ID: ${normalizedId}`);
      status = statusUtils.getUploadStatus(normalizedId);
    }
    
    if (status) {
      socket.emit('status', status);
      logger.debug(`Sent existing status to client ${clientId} for upload ${uploadId}`);
    } else {
      logger.debug(`No existing status for upload ${uploadId}`);
      
      // Send welcome message to confirm connection works
      socket.emit('welcome', { 
        message: 'Connected to upload service',
        socketId: socket.id,
        timestamp: Date.now()
      });
    }
  });
  
  // Client unsubscribes from an upload
  socket.on('unsubscribe', (uploadId) => {
    if (uploadId) {
      logger.info(`Client ${clientId} unsubscribed from upload: ${uploadId}`);
      socket.leave(uploadId);
    }
  });
  
  // Handle client disconnect
  socket.on('disconnect', (reason) => {
    logger.info(`Client ${clientId} disconnected: ${reason}`);
  });
  
  // Handle errors
  socket.on('error', (error) => {
    logger.error(`Socket error for client ${clientId}:`, error);
  });
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