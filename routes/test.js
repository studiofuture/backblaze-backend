const express = require('express');
const router = express.Router();
const b2Service = require('../services/b2');
const ffmpegService = require('../services/ffmpeg');
const supabaseService = require('../services/supabase');
const logger = require('../utils/logger');

// Add this function at the beginning of the file
function setCorsHeaders(req, res, next) {
  // Always set CORS headers regardless of HTTP method
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-upload-id');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  // If this is a preflight OPTIONS request, send 200 immediately
  if (req.method === 'OPTIONS') {
    logger.info(`Handling OPTIONS request for ${req.path} from origin: ${req.headers.origin || 'unknown'}`);
    return res.sendStatus(200);
  }
  
  next();
}

// Apply the middleware to all routes in this router
router.use(setCorsHeaders);

// ADD THIS CORS TEST ENDPOINT
/**
 * Test CORS configuration
 * GET /test/cors-test
 */
router.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'CORS is working correctly',
    origin: req.headers.origin || 'Unknown',
    headers: req.headers,
    time: new Date().toISOString()
  });
});

/**
 * Test Backblaze connection
 * GET /test/b2
 */
router.get('/b2', async (req, res) => {
  try {
    await b2Service.testConnection();
    res.json({ status: "success", message: "Backblaze connection successful!" });
  } catch (error) {
    logger.error('Backblaze connection failed:', error);
    res.status(500).json({ 
      status: "error", 
      message: "Backblaze connection failed", 
      details: error.message 
    });
  }
});

/**
 * Test FFmpeg
 * GET /test/ffmpeg
 */
router.get('/ffmpeg', async (req, res) => {
  try {
    const success = await ffmpegService.testFfmpeg();
    res.json({ status: "success", message: "FFmpeg test successful!" });
  } catch (error) {
    logger.error('FFmpeg test failed:', error);
    res.status(500).json({ 
      status: "error", 
      message: "FFmpeg test failed", 
      details: error.message 
    });
  }
});

/**
 * Test Supabase connection
 * GET /test/supabase
 */
router.get('/supabase', async (req, res) => {
  try {
    const isAvailable = await supabaseService.isSupabaseAvailable();
    
    if (isAvailable) {
      res.json({ status: "success", message: "Supabase integration is available" });
    } else {
      res.json({ 
        status: "warning", 
        message: "Supabase integration is not available. Some features may be limited." 
      });
    }
  } catch (error) {
    logger.error('Supabase test failed:', error);
    res.status(500).json({ 
      status: "error", 
      message: "Supabase test failed", 
      details: error.message 
    });
  }
});

/**
 * Test WebSocket status
 * GET /test/socket/:uploadId
 */
router.get('/socket/:uploadId', (req, res) => {
  try {
    const { uploadId } = req.params;
    const io = req.app.get('io'); // Access io instance from app
    
    if (!io) {
      return res.status(500).json({ 
        status: "error", 
        message: "WebSocket server not available" 
      });
    }
    
    // Get socket rooms and clients
    const rooms = io.sockets.adapter.rooms;
    const uploadRoom = rooms.get(uploadId);
    const clientCount = uploadRoom ? uploadRoom.size : 0;
    
    // Get the upload status
    const { getUploadStatus } = require('../utils/status');
    const status = getUploadStatus(uploadId);
    
    // Force emit status update to this room
    if (status) {
      io.to(uploadId).emit('status', status);
      logger.info(`Manually emitted status update to ${uploadId}`);
    }
    
    res.json({ 
      status: "success", 
      uploadId,
      clientsSubscribed: clientCount,
      currentStatus: status || "No status found"
    });
  } catch (error) {
    logger.error('Socket test failed:', error);
    res.status(500).json({ 
      status: "error", 
      message: "Socket test failed", 
      details: error.message 
    });
  }
});

/**
 * Test full media pipeline
 * GET /test/pipeline
 */
router.get('/pipeline', async (req, res) => {
  try {
    // First check B2 connection
    await b2Service.testConnection();
    
    // Then test FFmpeg
    await ffmpegService.testFfmpeg();
    
    // Check Supabase connection (optional)
    const supabaseAvailable = await supabaseService.isSupabaseAvailable();
    
    res.json({ 
      status: "success", 
      message: "All required services are working correctly",
      details: {
        backblaze: true,
        ffmpeg: true,
        supabase: supabaseAvailable
      }
    });
  } catch (error) {
    logger.error('Pipeline test failed:', error);
    res.status(500).json({ 
      status: "error", 
      message: "Pipeline test failed", 
      details: error.message 
    });
  }
});

module.exports = router;