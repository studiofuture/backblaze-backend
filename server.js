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

// Set server timeout
server.timeout = config.server.timeoutMs;

// Configure Socket.io with proper CORS settings
const io = new Server(server, {
  cors: {
    origin: "*", // In production, restrict this to your specific domains
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
app.use(cors());
app.use(express.json({ limit: config.server.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.server.bodyLimit }));

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
    memory: process.memoryUsage()
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  const clientId = socket.id;
  logger.info(`Client connected: ${clientId}`);
  
  // Client subscribes to an upload
  socket.on('subscribe', (uploadId) => {
    if (!uploadId) {
      logger.warn(`Client ${clientId} attempted to subscribe without an uploadId`);
      return;
    }

    logger.info(`Client ${clientId} subscribed to upload: ${uploadId}`);
    socket.join(uploadId);
    
    // Send current status if available
    const status = statusUtils.getUploadStatus(uploadId);
    if (status) {
      socket.emit('status', status);
      logger.debug(`Sent existing status to client ${clientId} for upload ${uploadId}`);
    } else {
      logger.debug(`No existing status for upload ${uploadId}`);
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