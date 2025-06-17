const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const busboy = require('busboy');
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

router.post('/complete-chunks', async (req, res) => {
  let uploadId; // Declare here so it's available in catch block

  try {
    // ADD DEBUGGING HERE:
    console.log('📋 Complete chunks request body:', req.body);
    console.log('📋 Content-Type:', req.headers['content-type']);
    console.log('📋 Request headers:', Object.keys(req.headers));

    const { uploadId: reqUploadId, totalChunks, originalFilename, videoId } = req.body;
    uploadId = reqUploadId; // Assign to outer scope

    console.log('📋 Extracted fields:', {
      uploadId,
      totalChunks,
      originalFilename,
      videoId
    });

    console.log(`🔄 Starting chunk assembly for upload ${uploadId}`);

    // Validate request body
    if (!uploadId || !totalChunks || !originalFilename) {
      console.error('❌ Missing required fields:', {
        uploadId: !!uploadId,
        totalChunks: !!totalChunks,
        originalFilename: !!originalFilename
      });

      return res.status(400).json({
        error: 'Missing required fields: uploadId, totalChunks, originalFilename',
        received: { uploadId, totalChunks, originalFilename },
        expectedFormat: {
          uploadId: 'string',
          totalChunks: 'number',
          originalFilename: 'string',
          videoId: 'string (optional)'
        }
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
    console.error(`❌ Error stack:`, error.stack);

    if (uploadId) {
      failUploadStatus(uploadId, error);
    }

    res.status(500).json({
      error: error.message,
      uploadId: uploadId || 'unknown',
      details: process.env.NODE_ENV !== 'production' ? error.stack : undefined
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
 * CUSTOM THUMBNAIL UPLOAD ROUTE
 * POST /upload/thumbnail
 * Handles user-uploaded custom thumbnail images
 */
router.post('/thumbnail', async (req, res) => {
  let uploadId;

  try {
    uploadId = `thumbnail_${Date.now()}`;
    console.log(`🖼️ Custom thumbnail upload started: ${uploadId}`);

    // Directory setup
    await ensureDirectory('uploads');
    await ensureDirectory('uploads/thumbs');

    // Busboy setup for image uploads
    const bb = busboy({
      headers: req.headers,
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max for images
        files: 1,
        fields: 10,
        fieldSize: 1024 * 1024
      }
    });

    let fileReceived = false;
    let filename;
    let originalName;
    let tempFilePath;
    let writeStream;
    let formFields = {};

    // File handler
    bb.on('file', (fieldname, file, info) => {
      console.log(`📥 Thumbnail file handler triggered:`, {
        fieldname,
        filename: info.filename,
        mimeType: info.mimeType,
        encoding: info.encoding
      });

      try {
        // Accept common field names for thumbnails
        const validFieldNames = ['thumbnail', 'image', 'file', 'upload'];
        if (!validFieldNames.includes(fieldname)) {
          console.warn(`⚠️ Unexpected field name: ${fieldname}. Accepting anyway.`);
        }

        fileReceived = true;
        originalName = info.filename;
        filename = generateUniqueFilename(originalName);
        tempFilePath = getUploadPath('thumbs', filename);

        console.log(`📁 Processing thumbnail: ${originalName} -> ${filename}`);

        // Image type validation
        const validImageTypes = [
          'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'
        ];

        if (!validImageTypes.includes(info.mimeType)) {
          const error = new Error(`Invalid image type: ${info.mimeType}. Only JPEG, PNG, WebP, and GIF images are allowed.`);
          console.error(`❌ ${error.message}`);
          return file.resume(); // Drain the file stream
        }

        // Create write stream
        writeStream = fs.createWriteStream(tempFilePath);

        writeStream.on('error', (streamError) => {
          console.error(`❌ Thumbnail write stream error: ${streamError.message}`);
        });

        // File data handling
        file.on('data', (chunk) => {
          // No progress tracking needed for small images
        });

        file.on('end', () => {
          console.log(`✅ Thumbnail file stream ended`);
          writeStream.end();
        });

        file.on('error', (fileError) => {
          console.error(`❌ Thumbnail file stream error: ${fileError.message}`);
          if (writeStream && !writeStream.destroyed) {
            writeStream.destroy();
          }
        });

        writeStream.on('close', async () => {
          console.log(`✅ Thumbnail write stream closed - processing`);

          try {
            // Upload thumbnail directly to B2
            const thumbnailUrl = await b2Service.uploadThumbnail(tempFilePath, filename);
            console.log(`✅ Custom thumbnail uploaded to B2: ${thumbnailUrl}`);

            // Clean up local file
            if (fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
              console.log(`🧹 Local thumbnail cleaned up: ${tempFilePath}`);
            }

            // Get video ID from form fields if provided
            const videoId = formFields.videoId;

            // Update database if videoId provided
            if (videoId) {
              try {
                const supabaseService = require('../services/supabase');
                await supabaseService.updateThumbnail(videoId, thumbnailUrl);
                console.log(`✅ Database updated with custom thumbnail for video ${videoId}`);
              } catch (dbError) {
                console.warn(`⚠️ Database update failed: ${dbError.message}`);
                // Continue anyway - upload was successful
              }
            }

            res.json({
              success: true,
              url: thumbnailUrl,  // Frontend expects 'url' property
              thumbnailUrl,       // Keep for backward compatibility
              message: 'Custom thumbnail uploaded successfully',
              uploadId,
              videoId: videoId || null
            });

          } catch (uploadError) {
            console.error(`❌ Custom thumbnail upload failed: ${uploadError.message}`);

            // Clean up temp file on error
            if (fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
            }

            res.status(500).json({
              error: 'Custom thumbnail upload failed',
              details: uploadError.message,
              uploadId
            });
          }
        });

        // Pipe file to write stream
        file.pipe(writeStream);

      } catch (fileHandlerError) {
        console.error(`❌ Thumbnail file handler error: ${fileHandlerError.message}`);
        file.resume(); // Drain the stream
      }
    });

    // Handle form fields (videoId, etc.)
    bb.on('field', (fieldname, value) => {
      console.log(`📝 Thumbnail form field: ${fieldname} = ${value}`);
      formFields[fieldname] = value;
    });

    bb.on('finish', () => {
      console.log(`🏁 Thumbnail busboy finished for ${uploadId}`);

      if (!fileReceived) {
        return res.status(400).json({
          error: 'No thumbnail image was uploaded',
          message: 'Please select an image file (JPEG, PNG, WebP, or GIF)',
          uploadId
        });
      }
    });

    bb.on('error', (error) => {
      console.error(`❌ Thumbnail busboy error: ${error.message}`);

      // Clean up temp file
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupError) {
          console.error(`❌ Thumbnail cleanup error: ${cleanupError.message}`);
        }
      }

      res.status(500).json({
        error: 'Thumbnail upload failed',
        details: error.message,
        uploadId
      });
    });

    // Request handlers
    req.on('error', (error) => {
      console.error(`❌ Thumbnail request error: ${error.message}`);
      res.status(500).json({
        error: 'Thumbnail upload request failed',
        details: error.message,
        uploadId
      });
    });

    req.on('aborted', () => {
      console.warn(`⚠️ Thumbnail request aborted for ${uploadId}`);
      if (!res.headersSent) {
        res.status(400).json({
          error: 'Thumbnail upload was cancelled',
          uploadId
        });
      }
    });

    // Pipe request to busboy
    req.pipe(bb);

  } catch (error) {
    console.error(`❌ Custom thumbnail upload setup error: ${error.message}`);
    res.status(500).json({
      error: 'Thumbnail upload setup failed',
      details: error.message,
      uploadId: uploadId || 'unknown'
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