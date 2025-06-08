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

// Import services - FULL FUNCTIONALITY RESTORED
const b2Service = require('../services/b2');
const ffmpegService = require('../services/ffmpeg');
const supabaseService = require('../services/supabase');
const logger = require('../utils/logger');
const { config } = require('../config');

/**
 * COMPLETE FUNCTIONALITY: Full B2 + FFmpeg + Supabase with Delayed Response
 * Uses the working delayed response pattern to avoid QUIC protocol errors
 */
router.post('/video', async (req, res) => {
  let uploadId;
  
  try {
    uploadId = `upload_${Date.now()}`;
    logger.info(`🚀 COMPLETE FUNCTIONALITY upload started: ${uploadId}`);
    
    // Log request details
    logger.info('📋 Request info:', {
      method: req.method,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      origin: req.headers.origin
    });
    
    // DO NOT RESPOND IMMEDIATELY - Wait for complete processing
    logger.info(`⏳ Waiting for COMPLETE processing before responding (B2 + FFmpeg + Supabase)`);

    // Process upload with FULL functionality and wait for completion
    const result = await handleCompleteUploadWithDelayedResponse(req, uploadId);
    
    // Only respond after everything is complete
    logger.info(`✅ Complete processing finished, now sending response: ${uploadId}`);
    res.json({
      status: "success",
      uploadId,
      message: "Upload completed successfully with full functionality",
      url: result.videoUrl, 
      ...result
    });
    
  } catch (error) {
    logger.error(`❌ Complete upload failed: ${error.message}`);
    logger.error(`❌ Stack: ${error.stack}`);
    
    if (uploadId) {
      failUploadStatus(uploadId, error);
    }
    
    // Send error response
    res.status(500).json({ 
      error: error.message,
      uploadId: uploadId || 'unknown'
    });
  }
});

/**
 * Generate thumbnail from video URL (for frontend compatibility)
 * POST /upload/generate-thumbnail
 */
router.post('/generate-thumbnail', async (req, res) => {
  try {
    const { videoUrl, seekTime = 5 } = req.body;
    
    logger.info(`🖼️ Thumbnail generation requested for: ${videoUrl}`);
    
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
    logger.info(`✅ Thumbnail generated from remote URL: ${thumbnailPath}`);
    
    // Upload thumbnail to B2
    const thumbnailUrl = await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
    logger.info(`✅ Thumbnail uploaded to B2: ${thumbnailUrl}`);
    
    // Clean up local thumbnail
    if (fs.existsSync(thumbnailPath)) {
      fs.unlinkSync(thumbnailPath);
      logger.info(`🧹 Local thumbnail cleaned up: ${thumbnailPath}`);
    }
    
    res.json({
      success: true,
      thumbnailUrl,
      message: 'Thumbnail generated successfully',
      seekTime,
      originalVideo: videoUrl
    });
    
  } catch (error) {
    logger.error(`❌ Thumbnail generation failed: ${error.message}`);
    res.status(500).json({
      error: 'Thumbnail generation failed',
      details: error.message,
      message: 'Could not generate thumbnail from video'
    });
  }
});

/**
 * COMPLETE PROCESSING: Full pipeline with delayed response
 * B2 Upload + FFmpeg + Thumbnail + Supabase - all before responding
 */
async function handleCompleteUploadWithDelayedResponse(req, uploadId) {
  return new Promise(async (resolve, reject) => {
    logger.info(`🚀 Starting COMPLETE upload handler for ${uploadId}`);
    
    try {
      // Step 1: Directory creation
      logger.info(`📁 Creating directories...`);
      await ensureDirectory('uploads');
      await ensureDirectory('uploads/temp');
      await ensureDirectory('uploads/thumbs');
      logger.info(`✅ All directories ready`);
      
      // Step 2: Busboy setup
      logger.info(`🔧 Setting up busboy for complete processing...`);
      const bb = busboy({ 
        headers: req.headers,
        limits: {
          fileSize: 100 * 1024 * 1024 * 1024, // 100GB
          files: 1,
          fields: 10,
          fieldSize: 1024 * 1024
        }
      });
      
      // Variables for tracking
      let fileReceived = false;
      let filename;
      let originalName;
      let tempFilePath;
      let writeStream;
      let totalBytesReceived = 0;
      let formFields = {};

      // Initialize status
      initUploadStatus(uploadId, {
        status: 'receiving',
        stage: 'complete processing - receiving file'
      });

      // File handler with full validation
      bb.on('file', (fieldname, file, info) => {
        logger.info(`📥 File handler triggered:`, {
          fieldname,
          filename: info.filename,
          mimeType: info.mimeType,
          encoding: info.encoding
        });
        
        try {
          // Accept common field names
          const validFieldNames = ['video', 'file', 'upload', 'media'];
          if (!validFieldNames.includes(fieldname)) {
            logger.warn(`⚠️ Unexpected field name: ${fieldname}. Accepting anyway.`);
          }
          
          fileReceived = true;
          originalName = info.filename;
          filename = generateUniqueFilename(originalName);
          tempFilePath = getUploadPath('temp', filename);
          
          logger.info(`📁 Processing: ${originalName} -> ${filename}`);
          logger.info(`📁 Target: ${tempFilePath}`);
          
          // FULL FILE TYPE VALIDATION
          const validVideoTypes = [
            'video/mp4', 'video/quicktime', 'video/x-msvideo', 
            'video/x-matroska', 'video/mpeg', 'video/webm',
            'video/x-ms-wmv', 'video/3gpp'
          ];
          
          if (!validVideoTypes.includes(info.mimeType)) {
            const error = new Error(`Invalid file type: ${info.mimeType}. Only video files are allowed.`);
            logger.error(`❌ ${error.message}`);
            return reject(error);
          }
          
          // Verify directory
          const tempDir = path.dirname(tempFilePath);
          if (!fs.existsSync(tempDir)) {
            logger.error(`❌ Directory missing: ${tempDir}`);
            return reject(new Error(`Directory not found: ${tempDir}`));
          }
          
          // Create write stream
          try {
            writeStream = fs.createWriteStream(tempFilePath);
            logger.info(`✅ Write stream created successfully`);
            
            writeStream.on('error', (streamError) => {
              logger.error(`❌ Write stream error: ${streamError.message}`);
              reject(streamError);
            });
            
          } catch (streamCreateError) {
            logger.error(`❌ Write stream creation failed: ${streamCreateError.message}`);
            return reject(streamCreateError);
          }
          
          // File data handling with progress
          file.on('data', (chunk) => {
            try {
              totalBytesReceived += chunk.length;
              
              // Update progress every 10MB
              if (totalBytesReceived % (10 * 1024 * 1024) < chunk.length) {
                const progressPercent = req.headers['content-length'] ? 
                  Math.min(50, Math.floor((totalBytesReceived / req.headers['content-length']) * 50)) : 5;
                
                logger.info(`📊 Received: ${Math.floor(totalBytesReceived / 1024 / 1024)}MB`);
                
                updateUploadStatus(uploadId, {
                  progress: progressPercent,
                  stage: `receiving: ${Math.floor(totalBytesReceived / 1024 / 1024)}MB`,
                  uploadedBytes: totalBytesReceived
                });
              }
            } catch (dataError) {
              logger.error(`❌ Data handler error: ${dataError.message}`);
              reject(dataError);
            }
          });
          
          file.on('end', () => {
            logger.info(`✅ File stream ended: ${Math.floor(totalBytesReceived / 1024 / 1024)}MB total`);
            
            updateUploadStatus(uploadId, {
              progress: 55,
              stage: 'file reception complete, starting processing...',
              status: 'processing',
              uploadedBytes: totalBytesReceived
            });
            
            try {
              writeStream.end();
              logger.info(`✅ Write stream end() called`);
            } catch (endError) {
              logger.error(`❌ Write stream end failed: ${endError.message}`);
              reject(endError);
            }
          });
          
          file.on('error', (fileError) => {
            logger.error(`❌ File stream error: ${fileError.message}`);
            if (writeStream && !writeStream.destroyed) {
              writeStream.destroy();
            }
            reject(fileError);
          });
          
          writeStream.on('close', () => {
            logger.info(`✅ Write stream closed - starting COMPLETE background processing`);
            
            // Extract form fields for processing
            const videoId = formFields.videoId;
            const metadata = formFields.metadata;
            
            // Start COMPLETE background processing
            processVideoComplete(uploadId, tempFilePath, filename, originalName, videoId, metadata)
              .then((result) => {
                logger.info(`✅ COMPLETE processing finished for ${uploadId}`);
                resolve(result);
              })
              .catch((error) => {
                logger.error(`❌ COMPLETE processing failed: ${error.message}`);
                reject(error);
              });
          });
          
          // Pipe file to write stream
          logger.info(`🔗 Piping file to write stream...`);
          file.pipe(writeStream);
          
        } catch (fileHandlerError) {
          logger.error(`❌ File handler error: ${fileHandlerError.message}`);
          reject(fileHandlerError);
        }
      });

      // Handle form fields (videoId, metadata, etc.)
      bb.on('field', (fieldname, value) => {
        logger.debug(`📝 Form field: ${fieldname} = ${value}`);
        formFields[fieldname] = value;
      });

      bb.on('finish', () => {
        logger.info(`🏁 Busboy finished for ${uploadId}`);
        
        if (!fileReceived) {
          const error = new Error('No video file was uploaded. Please select a video file.');
          logger.error(`❌ ${error.message}`);
          reject(error);
        } else {
          logger.info(`✅ Busboy finished successfully, waiting for COMPLETE processing...`);
        }
      });

      bb.on('error', (error) => {
        logger.error(`❌ Busboy error: ${error.message}`);
        
        // Clean up temp file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try {
            fs.unlinkSync(tempFilePath);
            logger.info(`🧹 Cleaned up temp file after busboy error`);
          } catch (cleanupError) {
            logger.error(`❌ Error cleaning up: ${cleanupError.message}`);
          }
        }
        reject(error);
      });

      // Request handlers
      req.on('error', (error) => {
        logger.error(`❌ Request error: ${error.message}`);
        reject(error);
      });

      req.on('aborted', () => {
        logger.warn(`⚠️ Request aborted for ${uploadId}`);
        reject(new Error('Upload was cancelled'));
      });

      // Pipe request to busboy
      logger.info(`🔗 Piping request to busboy...`);
      try {
        req.pipe(bb);
        logger.info(`✅ Request piped successfully`);
      } catch (pipeError) {
        logger.error(`❌ Request pipe failed: ${pipeError.message}`);
        reject(pipeError);
      }
      
      logger.info(`⏳ Waiting for COMPLETE upload and processing...`);
      
    } catch (setupError) {
      logger.error(`❌ Setup error: ${setupError.message}`);
      reject(setupError);
    }
  });
}

/**
 * COMPLETE PROCESSING: Full B2 + FFmpeg + Supabase pipeline
 * Everything that was in the original working version
 */
async function processVideoComplete(uploadId, tempFilePath, filename, originalName, videoId, metadata) {
  let thumbnailPath = null;
  let videoMetadata = null;
  
  try {
    logger.info(`🚀 COMPLETE processing started for ${uploadId}`);
    
    // Step 1: Extract video metadata
    updateUploadStatus(uploadId, {
      stage: 'extracting video metadata',
      progress: 60
    });
    
    try {
      videoMetadata = await ffmpegService.extractVideoMetadata(tempFilePath);
      logger.info(`✅ Metadata extracted for ${uploadId}:`, {
        duration: videoMetadata.duration,
        dimensions: `${videoMetadata.width}x${videoMetadata.height}`,
        size: `${Math.floor(videoMetadata.size / 1024 / 1024)}MB`
      });
    } catch (metadataError) {
      logger.warn(`⚠️ Metadata extraction failed: ${metadataError.message}`);
      videoMetadata = { duration: 0, width: 0, height: 0, size: 0 };
    }

    // Step 2: Generate thumbnail
    updateUploadStatus(uploadId, {
      stage: 'generating thumbnail',
      progress: 70,
      metadata: videoMetadata
    });
    
    const timestamp = uploadId.split('_')[1];
    const baseName = path.basename(originalName, path.extname(originalName));
    let thumbnailUrl = null;
    
    try {
      const thumbnailFileName = `${baseName}_${timestamp}.jpg`;
      thumbnailPath = getUploadPath('thumbs', thumbnailFileName);
      
      await ffmpegService.generateThumbnail(tempFilePath, thumbnailPath);
      logger.info(`✅ Thumbnail generated: ${thumbnailPath}`);
      
      updateUploadStatus(uploadId, {
        stage: 'uploading thumbnail to B2',
        progress: 75
      });
      
      // Upload thumbnail to B2
      thumbnailUrl = await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
      logger.info(`✅ Thumbnail uploaded to B2: ${thumbnailUrl}`);
      
      // Clean up local thumbnail immediately
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
        logger.info(`🧹 Local thumbnail cleaned up`);
      }
      
      updateUploadStatus(uploadId, {
        thumbnailUrl,
        progress: 80
      });
      
    } catch (thumbnailError) {
      logger.warn(`⚠️ Thumbnail generation/upload failed: ${thumbnailError.message}`);
      // Continue without thumbnail
    }

    // Step 3: Upload video to B2 with optimized chunking
    updateUploadStatus(uploadId, {
      status: 'uploading',
      stage: 'uploading video to B2 cloud storage',
      progress: 85
    });
    
    logger.info(`☁️ Starting B2 video upload: ${filename}`);
    
    // Create file object for B2 service
    const fileStats = fs.statSync(tempFilePath);
    const fileObject = {
      path: tempFilePath,
      originalname: filename,
      size: fileStats.size,
      mimetype: 'video/mp4'
    };
    
    // Upload with optimized 25MB chunks
    const videoUrl = await b2Service.uploadFileOptimized(fileObject, uploadId);
    logger.info(`✅ Video uploaded successfully to B2: ${videoUrl}`);
    
    // Step 4: Clean up temp file immediately after B2 upload
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      logger.info(`🧹 Temp file cleaned up: ${tempFilePath}`);
    }
    
    // Step 5: Update Supabase database if videoId provided
    if (videoId && supabaseService) {
      try {
        updateUploadStatus(uploadId, {
          stage: 'updating database',
          progress: 95
        });
        
        await supabaseService.updateVideoMetadata(videoId, {
          url: videoUrl,
          thumbnailUrl: thumbnailUrl,
          duration: videoMetadata?.duration || 0,
          width: videoMetadata?.width || 0,
          height: videoMetadata?.height || 0
        });
        
        logger.info(`✅ Supabase database updated for video ${videoId}`);
      } catch (supabaseError) {
        logger.error(`⚠️ Database update failed: ${supabaseError.message}`);
        // Continue anyway - upload was successful
      }
    }
    
    // Step 6: Complete with full data
    const finalData = {
      videoUrl,
      thumbnailUrl: thumbnailUrl,
      metadata: videoMetadata,
      uploadComplete: true,
      publishReady: true,
      completedAt: new Date().toISOString(),
      fileSizeMB: Math.floor(fileStats.size / 1024 / 1024)
    };
    
    completeUploadStatus(uploadId, finalData);
    
    logger.info(`🎉 COMPLETE processing successful: ${uploadId}`);
    return finalData;
    
  } catch (error) {
    logger.error(`❌ COMPLETE processing failed for ${uploadId}:`, {
      error: error.message,
      stack: error.stack,
      tempFilePath,
      filename
    });
    
    // Clean up files on error
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        logger.info(`🧹 Error cleanup - temp file removed: ${tempFilePath}`);
      } catch (cleanupError) {
        logger.error(`❌ Error cleanup failed: ${cleanupError.message}`);
      }
    }
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      try {
        fs.unlinkSync(thumbnailPath);
        logger.info(`🧹 Error cleanup - thumbnail removed: ${thumbnailPath}`);
      } catch (cleanupError) {
        logger.error(`❌ Thumbnail cleanup failed: ${cleanupError.message}`);
      }
    }
    
    failUploadStatus(uploadId, error);
    throw error;
  }
}

/**
 * Upload status endpoint
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
    logger.error(`❌ Status check error: ${error.message}`);
    res.status(500).json({ 
      error: 'Status check failed',
      details: error.message
    });
  }
});

/**
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  const memInfo = process.memoryUsage();
  const health = {
    status: 'healthy',
    service: 'complete-upload-service-delayed-response',
    memory: {
      rss: `${Math.floor(memInfo.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.floor(memInfo.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.floor(memInfo.heapTotal / 1024 / 1024)}MB`
    },
    timestamp: new Date().toISOString(),
    features: {
      maxFileSize: '100GB',
      chunkSize: '25MB',
      responseStrategy: 'delayed-after-complete-processing',
      b2Upload: 'enabled',
      thumbnailGeneration: 'enabled',
      supabaseIntegration: 'enabled',
      ffmpegMetadata: 'enabled'
    }
  };
  
  res.json(health);
});

/**
 * CORS test endpoint
 */
router.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'Complete Upload routes CORS working with delayed response',
    origin: req.headers.origin || 'Unknown',
    timestamp: new Date().toISOString(),
    service: 'complete-busboy-upload-delayed-response'
  });
});

module.exports = router;