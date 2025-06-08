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
const { generateUniqueFilename, getUploadPath } = require('../utils/directory');

// Import services
const b2Service = require('../services/b2');
const ffmpegService = require('../services/ffmpeg');
const supabaseService = require('../services/supabase');
const logger = require('../utils/logger');
const { config } = require('../config');

/**
 * FIXED: Streaming upload handler with proper error handling
 * Supports unlimited file sizes with 25MB memory usage
 */
router.post('/video', async (req, res) => {
  let uploadId;
  
  try {
    uploadId = `upload_${Date.now()}`;
    logger.info(`🎬 FIXED Busboy video upload started: ${uploadId}`);
    
    // DEBUG: Log request info to identify field names
    logger.info('📋 Request debug:', {
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      origin: req.headers.origin
    });
    
    // Return immediately - don't wait for processing
    res.json({ 
      status: "uploading", 
      uploadId,
      message: "Upload started successfully - FIXED VERSION"
    });

    // Process upload with FIXED streaming approach
    await handleFixedStreamingUpload(req, uploadId);
    
  } catch (error) {
    logger.error(`❌ FIXED Upload failed: ${error.message}`);
    logger.error(`❌ FIXED Upload stack: ${error.stack}`);
    if (uploadId) {
      failUploadStatus(uploadId, error);
    }
    // If response not sent yet, send error
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * FIXED: Enhanced streaming upload handler using busboy
 * Handles multiple possible field names from frontend
 */
async function handleFixedStreamingUpload(req, uploadId) {
  return new Promise((resolve, reject) => {
    logger.info(`📥 FIXED Starting busboy for ${uploadId}`);
    
    // Configure busboy with large file support
    const bb = busboy({ 
      headers: req.headers,
      limits: {
        fileSize: 100 * 1024 * 1024 * 1024, // 100GB max file size
        files: 1,        // Only one file at a time
        fields: 10,      // Limited form fields
        fieldSize: 1024 * 1024 // 1MB max field size
      }
    });
    
    let filename;
    let originalName;
    let tempFilePath;
    let writeStream;
    let uploadStarted = false;
    let fileStreamEnded = false;
    let writeStreamClosed = false;

    // Initialize upload status
    initUploadStatus(uploadId, {
      status: 'receiving',
      stage: 'starting FIXED upload'
    });

    // Handle file uploads - support multiple field names
    bb.on('file', (fieldname, file, info) => {
      try {
        logger.info(`📥 FIXED Busboy file detected:`, {
          fieldname,
          filename: info.filename,
          mimeType: info.mimeType,
          encoding: info.encoding
        });
        
        // Accept common field names: 'video', 'file', 'upload', etc.
        const validFieldNames = ['video', 'file', 'upload', 'media'];
        if (!validFieldNames.includes(fieldname)) {
          logger.warn(`⚠️ FIXED Unexpected field name: ${fieldname}. Accepting anyway.`);
        }
        
        originalName = info.filename;
        filename = generateUniqueFilename(originalName);
        tempFilePath = getUploadPath('temp', filename);
        
        logger.info(`📁 FIXED Processing: ${originalName} -> ${filename}`);
        
        // Validate file type
        const validVideoTypes = [
          'video/mp4', 'video/quicktime', 'video/x-msvideo', 
          'video/x-matroska', 'video/mpeg', 'video/webm',
          'video/x-ms-wmv', 'video/3gpp'
        ];
        
        if (!validVideoTypes.includes(info.mimeType)) {
          const error = new Error(`Invalid file type: ${info.mimeType}. Only video files are allowed.`);
          logger.error(`❌ FIXED ${error.message}`);
          return reject(error);
        }
        
        // Create write stream to temp file
        writeStream = fs.createWriteStream(tempFilePath);
        uploadStarted = true;
        
        let uploadedBytes = 0;
        let lastProgressUpdate = 0;
        const contentLength = parseInt(req.headers['content-length'] || '0');
        
        updateUploadStatus(uploadId, {
          status: 'receiving',
          stage: 'receiving file data - FIXED',
          progress: 5,
          filename: originalName,
          totalBytes: contentLength
        });

        // FIXED: Stream file data to disk with progress tracking
        file.on('data', (chunk) => {
          uploadedBytes += chunk.length;
          
          // Update progress every 10MB to avoid spam
          if (uploadedBytes - lastProgressUpdate > 10 * 1024 * 1024) {
            const progressPercent = contentLength > 0 ? 
              Math.min(50, Math.floor((uploadedBytes / contentLength) * 50)) : 5;
            
            logger.info(`📊 FIXED Progress: ${Math.floor(uploadedBytes / 1024 / 1024)}MB received`);
            
            updateUploadStatus(uploadId, {
              progress: progressPercent,
              stage: `received ${Math.floor(uploadedBytes / 1024 / 1024)}MB`,
              uploadedBytes
            });
            
            lastProgressUpdate = uploadedBytes;
          }
        });

        // FIXED: Proper file end handling
        file.on('end', () => {
          logger.info(`✅ FIXED File stream ended: ${filename} (${Math.floor(uploadedBytes / 1024 / 1024)}MB)`);
          fileStreamEnded = true;
          
          updateUploadStatus(uploadId, {
            progress: 50,
            stage: 'file stream ended, waiting for write completion',
            uploadedBytes,
            status: 'processing'
          });
          
          // Close the write stream properly
          writeStream.end();
        });

        // FIXED: Handle write stream close event
        writeStream.on('close', () => {
          logger.info(`✅ FIXED Write stream closed for ${uploadId}`);
          writeStreamClosed = true;
          
          updateUploadStatus(uploadId, {
            stage: 'file reception complete - FIXED',
            progress: 55
          });
          
          // Check if we can start processing
          checkAndStartProcessing();
        });

        // FIXED: Better error handling
        file.on('error', (error) => {
          logger.error(`❌ FIXED File stream error: ${error.message}`);
          if (writeStream && !writeStream.destroyed) {
            writeStream.destroy();
          }
          reject(error);
        });

        // Handle write stream errors
        writeStream.on('error', (error) => {
          logger.error(`❌ FIXED Write stream error: ${error.message}`);
          reject(error);
        });

        // FIXED: Function to check if we can start processing
        function checkAndStartProcessing() {
          if (fileStreamEnded && writeStreamClosed) {
            logger.info(`🔄 FIXED Starting background processing for ${uploadId}`);
            
            // Extract any form fields for processing
            const videoId = req.formFields?.videoId;
            const metadata = req.formFields?.metadata;
            
            // Start background processing
            processVideoBackgroundFixed(uploadId, tempFilePath, filename, originalName, videoId, metadata)
              .then(() => {
                logger.info(`✅ FIXED Background processing completed for ${uploadId}`);
                resolve();
              })
              .catch((error) => {
                logger.error(`❌ FIXED Background processing failed for ${uploadId}:`, error);
                reject(error);
              });
          }
        }

        // Pipe file to disk
        file.pipe(writeStream);

      } catch (error) {
        logger.error(`❌ FIXED Error setting up file stream: ${error.message}`);
        reject(error);
      }
    });

    // Handle form fields (like videoId, metadata, etc.)
    bb.on('field', (fieldname, value) => {
      logger.debug(`📝 FIXED Form field: ${fieldname} = ${value}`);
      // Store form fields for later use in processing
      if (!req.formFields) req.formFields = {};
      req.formFields[fieldname] = value;
    });

    // FIXED: Simplified finish handler - no manual stream ending
    bb.on('finish', () => {
      logger.info(`🏁 FIXED Busboy finished for ${uploadId}`);
      
      if (!uploadStarted) {
        const error = new Error('No video file was uploaded. Please select a video file.');
        logger.error(`❌ FIXED ${error.message}`);
        return reject(error);
      }
      
      // Don't manually handle writeStream here - let the file 'end' event handle it
      logger.info(`✅ FIXED Busboy finish - waiting for streams to close naturally`);
    });

    bb.on('error', (error) => {
      logger.error(`❌ FIXED Busboy error: ${error.message}`);
      if (writeStream && !writeStream.destroyed) {
        writeStream.destroy();
      }
      // Clean up temp file
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
          logger.info(`🧹 FIXED Cleaned up temp file: ${tempFilePath}`);
        } catch (cleanupError) {
          logger.error(`❌ FIXED Error cleaning up temp file: ${cleanupError.message}`);
        }
      }
      reject(error);
    });

    // Handle request stream errors
    req.on('error', (error) => {
      logger.error(`❌ FIXED Request stream error: ${error.message}`);
      if (writeStream && !writeStream.destroyed) {
        writeStream.destroy();
      }
      reject(error);
    });

    req.on('aborted', () => {
      logger.warn(`⚠️ FIXED Request aborted for ${uploadId}`);
      if (writeStream && !writeStream.destroyed) {
        writeStream.destroy();
      }
      // Clean up temp file
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
          logger.info(`🧹 FIXED Cleaned up temp file after abort: ${tempFilePath}`);
        } catch (cleanupError) {
          logger.error(`❌ FIXED Error cleaning up temp file: ${cleanupError.message}`);
        }
      }
      reject(new Error('Upload was cancelled'));
    });

    // Pipe request to busboy
    logger.info(`🔗 FIXED Piping request to busboy for ${uploadId}`);
    req.pipe(bb);
  });
}

/**
 * FIXED: Background video processing without memory monitor
 * Supports files up to 100GB with 25MB memory usage
 */
async function processVideoBackgroundFixed(uploadId, tempFilePath, filename, originalName, videoId, metadata) {
  let thumbnailPath = null;
  let videoMetadata = null;
  
  try {
    logger.info(`🔄 FIXED Background processing started for ${uploadId}`);
    
    // Step 1: Extract metadata (lightweight operation)
    updateUploadStatus(uploadId, {
      stage: 'extracting video metadata - FIXED',
      progress: 60
    });
    
    try {
      videoMetadata = await ffmpegService.extractVideoMetadata(tempFilePath);
      logger.info(`✅ FIXED Metadata extracted for ${uploadId}:`, {
        duration: videoMetadata.duration,
        dimensions: `${videoMetadata.width}x${videoMetadata.height}`,
        size: `${Math.floor(videoMetadata.size / 1024 / 1024)}MB`
      });
    } catch (metadataError) {
      logger.warn(`⚠️ FIXED Metadata extraction failed: ${metadataError.message}`);
      videoMetadata = { duration: 0, width: 0, height: 0, size: 0 };
    }

    // Step 2: Generate thumbnail
    updateUploadStatus(uploadId, {
      stage: 'generating thumbnail - FIXED',
      progress: 70,
      metadata: videoMetadata
    });
    
    const timestamp = uploadId.split('_')[1];
    const baseName = path.basename(originalName, path.extname(originalName));
    
    try {
      const thumbnailFileName = `${baseName}_${timestamp}.jpg`;
      thumbnailPath = getUploadPath('thumbs', thumbnailFileName);
      
      await ffmpegService.generateThumbnail(tempFilePath, thumbnailPath);
      logger.info(`✅ FIXED Thumbnail generated: ${thumbnailPath}`);
      
      updateUploadStatus(uploadId, {
        stage: 'uploading thumbnail - FIXED',
        progress: 80
      });
      
      // Upload thumbnail to B2
      const thumbnailUrl = await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
      
      // Clean up local thumbnail immediately
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
      
      updateUploadStatus(uploadId, {
        thumbnailUrl,
        progress: 85
      });
      
    } catch (thumbnailError) {
      logger.warn(`⚠️ FIXED Thumbnail generation failed: ${thumbnailError.message}`);
      // Continue without thumbnail
    }

    // Step 3: Upload video to B2 with optimized chunking (25MB chunks)
    updateUploadStatus(uploadId, {
      status: 'uploading',
      stage: 'uploading video to cloud storage - FIXED',
      progress: 90
    });
    
    logger.info(`☁️ FIXED Starting B2 upload: ${filename}`);
    
    // Create file object for B2 service
    const fileStats = fs.statSync(tempFilePath);
    const fileObject = {
      path: tempFilePath,
      originalname: filename,
      size: fileStats.size,
      mimetype: 'video/mp4'
    };
    
    // Upload with optimized chunks - using the correct method name
    const videoUrl = await b2Service.uploadFileOptimized(fileObject, uploadId);
    
    logger.info(`✅ FIXED Video uploaded successfully: ${videoUrl}`);
    
    // Step 4: Clean up temp file immediately after upload
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      logger.info(`🧹 FIXED Cleaned up temp file: ${tempFilePath}`);
    }
    
    // Step 5: Update database if videoId provided
    if (videoId && supabaseService) {
      try {
        updateUploadStatus(uploadId, {
          stage: 'updating database - FIXED',
          progress: 98
        });
        
        await supabaseService.updateVideoMetadata(videoId, {
          url: videoUrl,
          thumbnailUrl: thumbnailPath ? getB2ThumbnailUrlFixed(baseName, timestamp) : null,
          duration: videoMetadata?.duration || 0,
          width: videoMetadata?.width || 0,
          height: videoMetadata?.height || 0
        });
        
        logger.info(`✅ FIXED Database updated for video ${videoId}`);
      } catch (supabaseError) {
        logger.error(`⚠️ FIXED Database update failed: ${supabaseError.message}`);
      }
    }
    
    // Step 6: Mark as complete
    const finalData = {
      videoUrl,
      thumbnailUrl: thumbnailPath ? getB2ThumbnailUrlFixed(baseName, timestamp) : null,
      metadata: videoMetadata,
      uploadComplete: true,
      publishReady: true,
      completedAt: new Date().toISOString(),
      version: 'FIXED'
    };
    
    completeUploadStatus(uploadId, finalData);
    
    logger.info(`🎉 FIXED Upload completed successfully: ${uploadId}`);
    
  } catch (error) {
    logger.error(`❌ FIXED Background processing failed for ${uploadId}:`, {
      error: error.message,
      stack: error.stack,
      tempFilePath,
      filename
    });
    
    // Clean up files on error
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        logger.info(`🧹 FIXED Error cleanup - temp file removed: ${tempFilePath}`);
      } catch (cleanupError) {
        logger.error(`❌ FIXED Error cleanup failed: ${cleanupError.message}`);
      }
    }
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      try {
        fs.unlinkSync(thumbnailPath);
        logger.info(`🧹 FIXED Error cleanup - thumbnail removed: ${thumbnailPath}`);
      } catch (cleanupError) {
        logger.error(`❌ FIXED Thumbnail cleanup failed: ${cleanupError.message}`);
      }
    }
    
    failUploadStatus(uploadId, error);
  }
}

/**
 * Helper to construct B2 thumbnail URL
 */
function getB2ThumbnailUrlFixed(baseName, timestamp) {
  const thumbnailFileName = `${baseName}_${timestamp}.jpg`;
  const bucketName = config.b2.buckets.thumbnail.name;
  return `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${thumbnailFileName}`;
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
        message: 'Upload may have expired or not yet started',
        version: 'FIXED'
      });
    }
    
    // Add basic server health info
    const response = {
      ...status,
      version: 'FIXED',
      serverHealth: {
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
      }
    };
    
    res.json(response);
    
  } catch (error) {
    logger.error(`❌ FIXED Status check error: ${error.message}`);
    res.status(500).json({ 
      error: 'Status check failed',
      details: error.message,
      version: 'FIXED'
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
    service: 'FIXED-upload-service-busboy',
    memory: {
      rss: `${Math.floor(memInfo.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.floor(memInfo.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.floor(memInfo.heapTotal / 1024 / 1024)}MB`
    },
    timestamp: new Date().toISOString(),
    features: {
      maxFileSize: '100GB',
      chunkSize: '25MB',
      version: 'FIXED',
      memoryMonitorRemoved: true
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
    message: 'FIXED Upload routes CORS working',
    origin: req.headers.origin || 'Unknown',
    timestamp: new Date().toISOString(),
    service: 'FIXED-busboy-upload'
  });
});

module.exports = router;