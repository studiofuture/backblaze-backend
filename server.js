require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { upload } = require('./middleware/upload');
const { setupDirectories } = require('./utils/directory');
const { validateEnvironment, config } = require('./config');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./utils/logger');
const { startHeartbeat } = require('./utils/heartbeat');

// Import utilities and services
const { 
  initUploadStatus, 
  getUploadStatus, 
  updateUploadStatus, 
  completeUploadStatus, 
  failUploadStatus 
} = require('./utils/status');
const { generateUniqueFilename, getUploadPath } = require('./utils/directory');

// Try to import services from multiple possible locations
let b2Service, ffmpegService, supabaseService;
try {
  b2Service = require('./services/b2');
  ffmpegService = require('./services/ffmpeg');
  supabaseService = require('./services/supabase');
  console.log('✅ Loaded services from ./services/');
} catch (error) {
  try {
    b2Service = require('./utils/b2');
    ffmpegService = require('./utils/ffmpeg');
    supabaseService = require('./utils/supabase');
    console.log('✅ Loaded services from ./utils/');
  } catch (error2) {
    console.error('❌ Could not load services:', error2.message);
    process.exit(1);
  }
}

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

// COMPREHENSIVE CORS MIDDLEWARE
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Log requests for debugging
  console.log(`🌐 ${req.method} ${req.path} from ${origin || 'no-origin'}`);
  
  // Set CORS headers - be very permissive for debugging
  res.header('Access-Control-Allow-Origin', origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-upload-id, Cache-Control, Pragma');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400');
  
  // Handle OPTIONS preflight immediately
  if (req.method === 'OPTIONS') {
    console.log(`✅ OPTIONS ${req.path} - responding immediately`);
    return res.status(200).end();
  }
  
  next();
});

// Body parsing middleware
app.use(express.json({ limit: config.server.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.server.bodyLimit }));

// Server identification headers
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

// Configure Socket.io
const io = new Server(server, {
  cors: {
    origin: true, // Allow all origins for debugging
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "x-upload-id", "Origin"]
  },
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// Make io available to status utility
app.set('io', io);
const statusUtils = require('./utils/status');
statusUtils.setupSocketIO(io);

// Start server heartbeat
const heartbeat = startHeartbeat();

// =============================================================================
// CORE ROUTES - All routes defined here to avoid conflicts
// =============================================================================

// Health check
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

// Simple test
app.get('/simple-test', (req, res) => {
  res.json({
    message: 'Simple test route works!',
    timestamp: new Date().toISOString(),
    origin: req.headers.origin || 'Unknown'
  });
});

// =============================================================================
// UPLOAD STATUS ROUTE
// =============================================================================
app.get('/upload/status/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  const origin = req.headers.origin;
  
  console.log(`📊 STATUS REQUEST: ${uploadId} from ${origin || 'unknown'}`);
  
  try {
    const status = getUploadStatus(uploadId);
    
    if (!status) {
      console.log(`❌ No status found for: ${uploadId}`);
      return res.status(404).json({ 
        error: 'Upload not found',
        uploadId,
        message: 'Upload may have expired or completed',
        timestamp: new Date().toISOString()
      });
    }
    
    console.log(`✅ STATUS FOUND for ${uploadId}:`, {
      status: status.status,
      progress: status.progress,
      stage: status.stage,
      complete: status.uploadComplete
    });
    
    res.json(status);
    
  } catch (error) {
    console.error(`❌ STATUS ERROR for ${uploadId}:`, error);
    res.status(500).json({ 
      error: 'Status check failed',
      uploadId,
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// =============================================================================
// VIDEO UPLOAD ROUTE
// =============================================================================
app.post('/upload/video', upload.single('file'), async (req, res) => {
  let uploadId;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    uploadId = `upload_${Date.now()}`;
    console.log(`🎬 VIDEO UPLOAD STARTED: ${uploadId}`);
    console.log(`📁 File: ${req.file.originalname} (${req.file.size} bytes)`);

    // Generate unique filename
    const originalExt = path.extname(req.file.originalname);
    const baseName = path.basename(req.file.originalname, originalExt);
    const uniqueFilename = `${baseName}_${Date.now()}${originalExt}`;
    req.file.originalname = uniqueFilename;
    
    // Prepare video URL
    const bucketName = config.b2.buckets.video.name;
    const videoUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${uniqueFilename}`;
    
    // Initialize upload status
    initUploadStatus(uploadId, {
      videoUrl,
      filename: uniqueFilename,
      originalName: baseName
    });
    
    // Return immediately to client
    res.json({ 
      status: "processing", 
      uploadId,
      url: videoUrl
    });
    
    // Start background processing
    processVideoUpload(uploadId, req.file, videoUrl, baseName, req.body?.videoId);
    
  } catch (error) {
    logger.error(`❌ Video upload failed: ${error.message}`);
    if (uploadId) {
      failUploadStatus(uploadId, error);
    }
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// BACKGROUND VIDEO PROCESSING FUNCTION
// =============================================================================
async function processVideoUpload(uploadId, file, videoUrl, baseName, videoId) {
  let thumbnailUrl = null;
  let metadata = null;
  
  try {
    console.log(`🔄 BACKGROUND PROCESSING STARTED: ${uploadId}`);
    
    // Step 1: Extract metadata and thumbnail
    updateUploadStatus(uploadId, {
      status: 'processing',
      stage: 'extracting metadata',
      progress: 5
    });
    
    try {
      console.log(`📊 Extracting metadata from: ${file.path}`);
      metadata = await ffmpegService.extractVideoMetadata(file.path);
      console.log(`✅ Metadata extracted:`, {
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height
      });
      
      updateUploadStatus(uploadId, {
        stage: 'generating thumbnail',
        progress: 15,
        metadata
      });
      
      // Generate thumbnail
      const thumbnailFileName = `${baseName}_${Date.now()}.jpg`;
      const thumbnailPath = getUploadPath('thumbs', thumbnailFileName);
      
      console.log(`🖼️ Generating thumbnail: ${thumbnailPath}`);
      await ffmpegService.generateThumbnail(file.path, thumbnailPath);
      
      // Upload thumbnail to B2
      updateUploadStatus(uploadId, {
        stage: 'uploading thumbnail',
        progress: 25
      });
      
      const thumbBucketName = config.b2.buckets.thumbnail.name;
      thumbnailUrl = `https://${thumbBucketName}.s3.eu-central-003.backblazeb2.com/${thumbnailFileName}`;
      
      await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
      console.log(`✅ Thumbnail uploaded: ${thumbnailUrl}`);
      
      // Clean up local thumbnail
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
      
      updateUploadStatus(uploadId, {
        thumbnailUrl,
        progress: 35
      });
      
    } catch (thumbnailError) {
      console.log(`⚠️ Thumbnail extraction failed: ${thumbnailError.message}`);
      // Continue with upload, will create placeholder later
    }
    
    // Step 2: Upload video to B2
    updateUploadStatus(uploadId, {
      status: 'uploading',
      stage: 'uploading video to cloud storage',
      progress: 40
    });
    
    console.log(`☁️ Uploading video to B2: ${file.originalname}`);
    await b2Service.uploadFile(file, uploadId);
    console.log(`✅ Video uploaded successfully`);
    
    // Step 3: Create placeholder thumbnail if none exists
    if (!thumbnailUrl) {
      try {
        updateUploadStatus(uploadId, {
          stage: 'creating placeholder thumbnail',
          progress: 95
        });
        
        const placeholderFileName = `placeholder_${baseName}_${Date.now()}.jpg`;
        const placeholderPath = getUploadPath('thumbs', placeholderFileName);
        
        await ffmpegService.createPlaceholderThumbnail(placeholderPath);
        
        const thumbBucketName = config.b2.buckets.thumbnail.name;
        thumbnailUrl = `https://${thumbBucketName}.s3.eu-central-003.backblazeb2.com/${placeholderFileName}`;
        
        await b2Service.uploadThumbnail(placeholderPath, placeholderFileName);
        
        if (fs.existsSync(placeholderPath)) {
          fs.unlinkSync(placeholderPath);
        }
        
        console.log(`✅ Placeholder thumbnail created: ${thumbnailUrl}`);
      } catch (placeholderError) {
        console.log(`❌ Placeholder creation failed: ${placeholderError.message}`);
      }
    }
    
    // Step 4: Update database if videoId provided
    if (videoId && thumbnailUrl) {
      try {
        updateUploadStatus(uploadId, {
          stage: 'updating database',
          progress: 98
        });
        
        await supabaseService.updateVideoMetadata(videoId, {
          url: videoUrl,
          thumbnailUrl,
          duration: metadata?.duration || 0,
          width: metadata?.width || 0,
          height: metadata?.height || 0
        });
        
        console.log(`✅ Database updated for video ${videoId}`);
      } catch (supabaseError) {
        console.log(`⚠️ Database update failed: ${supabaseError.message}`);
      }
    }
    
    // Step 5: Mark as complete
    completeUploadStatus(uploadId, {
      videoUrl,
      thumbnailUrl,
      metadata,
      uploadComplete: true,
      publishReady: true,
      completedAt: new Date().toISOString()
    });
    
    console.log(`🎉 UPLOAD COMPLETED SUCCESSFULLY: ${uploadId}`);
    
  } catch (error) {
    console.log(`❌ Background processing failed for ${uploadId}:`, error);
    failUploadStatus(uploadId, error);
  }
}

// =============================================================================
// OTHER UPLOAD ROUTES
// =============================================================================

// Upload thumbnail
app.post('/upload/thumbnail', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    console.log(`🖼️ Thumbnail upload: ${req.file.originalname}`);

    const uniqueFilename = generateUniqueFilename(req.file.originalname);
    const thumbnailUrl = await b2Service.uploadThumbnail(req.file.path, uniqueFilename);
    
    console.log(`✅ Thumbnail uploaded: ${thumbnailUrl}`);
    
    res.json({ 
      status: "success", 
      url: thumbnailUrl
    });
      
  } catch (error) {
    console.log(`❌ Thumbnail upload failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// Upload profile picture
app.post('/upload/profile-pic', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const uploadId = `profile_${Date.now()}`;
    console.log(`👤 Profile picture upload: ${uploadId}`);

    const uniqueFilename = generateUniqueFilename(req.file.originalname);
    req.file.originalname = uniqueFilename;
    
    const bucketName = config.b2.buckets.profile.name;
    const profilePicUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${uniqueFilename}`;
    
    await b2Service.uploadFile(req.file, uploadId, {
      bucketId: config.b2.buckets.profile.id,
      bucketName,
      contentType: req.file.mimetype || 'image/jpeg'
    });
    
    console.log(`✅ Profile picture uploaded: ${profilePicUrl}`);
    
    res.json({ 
      status: "success", 
      url: profilePicUrl
    });
    
  } catch (error) {
    console.log(`❌ Profile picture upload failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// SOCKET.IO CONNECTION HANDLING
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
        timestamp: Date.now()
      });
      console.log(`👋 Sent welcome to ${clientId}`);
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
// ERROR HANDLING AND SERVER STARTUP
// =============================================================================

// Error handling middleware (must be last)
app.use(errorHandler);

// Debug route registration
console.log('=== REGISTERED ROUTES ===');
app._router.stack.forEach((middleware) => {
  if (middleware.route) {
    const methods = Object.keys(middleware.route.methods).join(', ').toUpperCase();
    console.log(`${methods} ${middleware.route.path}`);
  }
});
console.log('=== END ROUTES ===');

// Start the server
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`✅ RVSHES BACKEND SERVER RUNNING ON PORT ${port}`);
  console.log(`🔌 Socket.IO configured with comprehensive CORS`);
  console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌍 Allowed origins:`, allowedOrigins);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received - shutting down gracefully');
  
  if (heartbeat) {
    heartbeat.stop();
  }
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.log('💥 Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.log('💥 Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

module.exports = { app, server, io };