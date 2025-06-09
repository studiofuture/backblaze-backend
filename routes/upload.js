const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { 
  initUploadStatus, 
  updateUploadStatus, 
  completeUploadStatus, 
  failUploadStatus,
  getUploadStatus
} = require('../utils/status');
const { generateUniqueFilename, getUploadPath, ensureDirectory } = require('../utils/directory');

// Import refactored services
const formdataHandler = require('../services/formdata-handler');
const chunkAssembler = require('../services/chunk-assembler');
const uploadProcessor = require('../services/upload-processor');
const b2Service = require('../services/b2');
const ffmpegService = require('../services/ffmpeg');

// DEBUG: Check logger configuration
console.log('🔧 DEBUG: LOG_LEVEL =', process.env.LOG_LEVEL);
console.log('🔧 DEBUG: NODE_ENV =', process.env.NODE_ENV);

/**
 * FORMDATA UPLOAD ROUTE
 * POST /upload/video
 * Handles traditional FormData uploads with Busboy
 */
router.post('/video', async (req, res) => {
  let uploadId;
  
  try {
    uploadId = `upload_${Date.now()}`;
    console.log(`🚀 FormData upload started: ${uploadId}`);
    
    // Process upload using FormData handler service
    const result = await formdataHandler.handleFormDataUpload(req, uploadId);
    
    console.log(`✅ FormData upload completed: ${uploadId}`);
    res.json({
      status: "success",
      uploadId,
      message: "Upload completed successfully",
      url: result.videoUrl, 
      ...result
    });
    
  } catch (error) {
    console.error(`❌ FormData upload failed: ${error.message}`);
    
    if (uploadId) {
      failUploadStatus(uploadId, error);
    }
    
    res.status(500).json({ 
      error: error.message,
      uploadId: uploadId || 'unknown'
    });
  }
});

/**
 * RAW CHUNK UPLOAD ROUTE
 * POST /upload/chunk
 * Receives individual raw binary chunks
 */
router.post('/chunk', async (req, res) => {
  try {
    const uploadId = req.headers['x-upload-id'];
    const chunkIndex = parseInt(req.headers['x-chunk-index']);
    const totalChunks = parseInt(req.headers['x-total-chunks']);
    
    console.log(`📦 Receiving chunk ${chunkIndex}/${totalChunks} for upload ${uploadId}`);
    
    // Validate headers
    if (!uploadId || chunkIndex === undefined || !totalChunks) {
      return res.status(400).json({
        error: 'Missing required headers: x-upload-id, x-chunk-index, x-total-chunks'
      });
    }
    
    // Process chunk using chunk assembler service
    await chunkAssembler.saveChunk(req, uploadId, chunkIndex, totalChunks);
    
    console.log(`✅ Chunk ${chunkIndex} saved successfully`);
    res.json({
      success: true,
      chunkIndex,
      message: `Chunk ${chunkIndex} received successfully`
    });
    
  } catch (error) {
    console.error(`❌ Chunk upload error:`, error);
    res.status(500).json({
      error: 'Chunk upload failed',
      details: error.message
    });
  }
});

/**
 * COMPLETE CHUNKED UPLOAD ROUTE
 * POST /upload/complete-chunks
 * Assembles chunks and processes the complete file
 */
router.post('/complete-chunks', async (req, res) => {
  try {
    const { uploadId, totalChunks, originalFilename, videoId } = req.body;
    
    console.log(`🔄 Starting chunk assembly for upload ${uploadId}`);
    
    // Validate request body
    if (!uploadId || !totalChunks || !originalFilename) {
      return res.status(400).json({
        error: 'Missing required fields: uploadId, totalChunks, originalFilename'
      });
    }
    
    // Initialize processing status
    initUploadStatus(uploadId, {
      status: 'assembling',
      stage: 'assembling chunks into final file',
      progress: 55
    });
    
    // Assemble chunks using chunk assembler service
    const finalFilePath = await chunkAssembler.assembleChunks(uploadId, totalChunks, originalFilename);
    console.log(`✅ Chunks assembled into: ${finalFilePath}`);
    
    // Process the assembled file using upload processor service
    const result = await uploadProcessor.processVideo(uploadId, finalFilePath, originalFilename, videoId);
    
    console.log(`✅ Chunked upload processing completed: ${uploadId}`);
    res.json({
      status: "success",
      uploadId,
      message: "Chunked upload completed successfully",
      url: result.videoUrl,
      ...result
    });
    
  } catch (error) {
    console.error(`❌ Complete chunks processing failed:`, error);
    
    if (uploadId) {
      failUploadStatus(uploadId, error);
    }
    
    res.status(500).json({
      error: error.message,
      uploadId: uploadId || 'unknown'
    });
  }
});

/**
 * GENERATE THUMBNAIL ROUTE
 * POST /upload/generate-thumbnail
 * Generates thumbnail from video URL
 */
router.post('/generate-thumbnail', async (req, res) => {
  try {
    const { videoUrl, seekTime = 5 } = req.body;
    
    console.log(`🖼️ Thumbnail generation requested for: ${videoUrl}`);
    
    if (!videoUrl) {
      return res.status(400).json({
        error: 'Video URL is required',
        message: 'Please provide a videoUrl in the request body'
      });
    }
    
    // Extract filename from URL for thumbnail naming
    const urlParts = videoUrl.split('/');
    const filename = urlParts[urlParts.length - 1];
    const baseName = path.basename(filename, path.extname(filename));
    const thumbnailFileName = `${baseName}_${Date.now()}.jpg`;
    const thumbnailPath = getUploadPath('thumbs', thumbnailFileName);
    
    // Ensure thumbs directory exists
    await ensureDirectory('uploads/thumbs');
    
    // Generate thumbnail from remote video URL
    await ffmpegService.extractThumbnailFromRemote(videoUrl, thumbnailPath, seekTime);
    console.log(`✅ Thumbnail generated from remote URL: ${thumbnailPath}`);
    
    // Upload thumbnail to B2
    const thumbnailUrl = await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
    console.log(`✅ Thumbnail uploaded to B2: ${thumbnailUrl}`);
    
    // Clean up local thumbnail
    if (fs.existsSync(thumbnailPath)) {
      fs.unlinkSync(thumbnailPath);
      console.log(`🧹 Local thumbnail cleaned up: ${thumbnailPath}`);
    }
    
    res.json({
      success: true,
      thumbnailUrl,
      message: 'Thumbnail generated successfully',
      seekTime,
      originalVideo: videoUrl
    });
    
  } catch (error) {
    console.error(`❌ Thumbnail generation failed: ${error.message}`);
    res.status(500).json({
      error: 'Thumbnail generation failed',
      details: error.message,
      message: 'Could not generate thumbnail from video'
    });
  }
});

/**
 * UPLOAD STATUS ROUTE
 * GET /upload/status/:uploadId
 * Returns current upload status
 */
router.get('/status/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  
  try {
    const status = getUploadStatus(uploadId);
    
    if (!status) {
      return res.status(404).json({ 
        error: 'Upload not found',
        uploadId,
        message: 'Upload may have expired or not yet started'
      });
    }
    
    // Add server health info
    const response = {
      ...status,
      serverHealth: {
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
      }
    };
    
    res.json(response);
    
  } catch (error) {
    console.error(`❌ Status check error: ${error.message}`);
    res.status(500).json({ 
      error: 'Status check failed',
      details: error.message
    });
  }
});

/**
 * HEALTH CHECK ROUTE
 * GET /upload/health
 * Returns service health status
 */
router.get('/health', (req, res) => {
  const memInfo = process.memoryUsage();
  const health = {
    status: 'healthy',
    service: 'refactored-upload-service',
    memory: {
      rss: `${Math.floor(memInfo.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.floor(memInfo.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.floor(memInfo.heapTotal / 1024 / 1024)}MB`
    },
    timestamp: new Date().toISOString(),
    features: {
      maxFileSize: '100GB',
      chunkSize: '25MB',
      formdataUploads: 'enabled',
      chunkedUploads: 'enabled',
      b2Upload: 'enabled',
      thumbnailGeneration: 'enabled',
      supabaseIntegration: 'enabled',
      ffmpegMetadata: 'enabled'
    }
  };
  
  res.json(health);
});

/**
 * CORS TEST ROUTE
 * GET /upload/cors-test
 * Tests CORS configuration
 */
router.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'Refactored Upload routes CORS working',
    origin: req.headers.origin || 'Unknown',
    timestamp: new Date().toISOString(),
    service: 'refactored-upload-service'
  });
});

module.exports = router;