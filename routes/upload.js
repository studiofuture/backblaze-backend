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

// Memory monitoring utility
const memoryMonitor = require('../utils/memory-monitor');

/**
 * OPTIMIZED: Streaming upload handler with proper field name handling
 * Supports unlimited file sizes with 25MB memory usage
 */
router.post('/video', async (req, res) => {
  let uploadId;
  
  try {
    // Check available memory before starting
    const memInfo = memoryMonitor.getMemoryInfo();
    if (memInfo.rssPercent > 80) {
      return res.status(503).json({ 
        error: 'Server at capacity, please try again in a moment',
        retryAfter: 30 
      });
    }

    uploadId = `upload_${Date.now()}`;
    logger.info(`🎬 Busboy video upload started: ${uploadId}`);
    
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
      message: "Upload started successfully"
    });

    // Process upload with streaming approach
    await handleStreamingUpload(req, uploadId);
    
  } catch (error) {
    logger.error(`❌ Upload failed: ${error.message}`);
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
 * Enhanced streaming upload handler using busboy
 * Handles multiple possible field names from frontend
 */
async function handleStreamingUpload(req, uploadId) {
  return new Promise((resolve, reject) => {
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

    // Initialize upload status
    initUploadStatus(uploadId, {
      status: 'receiving',
      stage: 'starting upload'
    });

    // Handle file uploads - support multiple field names
    bb.on('file', (fieldname, file, info) => {
      try {
        logger.info(`📥 Busboy file detected:`, {
          fieldname,
          filename: info.filename,
          mimeType: info.mimeType,
          encoding: info.encoding
        });
        
        // Accept common field names: 'video', 'file', 'upload', etc.
        const validFieldNames = ['video', 'file', 'upload', 'media'];
        if (!validFieldNames.includes(fieldname)) {
          logger.warn(`⚠️ Unexpected field name: ${fieldname}. Accepting anyway.`);
        }
        
        originalName = info.filename;
        filename = generateUniqueFilename(originalName);
        tempFilePath = getUploadPath('temp', filename);
        
        logger.info(`📁 Processing: ${originalName} -> ${filename}`);
        
        // Validate file type
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
        
        // Create write stream to temp file
        writeStream = fs.createWriteStream(tempFilePath);
        uploadStarted = true;
        
        let uploadedBytes = 0;
        let lastProgressUpdate = 0;
        const contentLength = parseInt(req.headers['content-length'] || '0');
        
        updateUploadStatus(uploadId, {
          status: 'receiving',
          stage: 'receiving file data',
          progress: 5,
          filename: originalName,
          totalBytes: contentLength
        });

        // Stream file data to disk with progress tracking
        file.on('data', (chunk) => {
          uploadedBytes += chunk.length;
          
          // Update progress every 10MB to avoid spam
          if (uploadedBytes - lastProgressUpdate > 10 * 1024 * 1024) {
            const progressPercent = contentLength > 0 ? 
              Math.min(50, Math.floor((uploadedBytes / contentLength) * 50)) : 5;
            
            updateUploadStatus(uploadId, {
              progress: progressPercent,
              stage: `received ${Math.floor(uploadedBytes / 1024 / 1024)}MB`,
              uploadedBytes
            });
            
            lastProgressUpdate = uploadedBytes;
            
            // Log memory usage periodically for large files
            if (uploadedBytes % (100 * 1024 * 1024) === 0) {
              memoryMonitor.logMemoryUsage(`Upload ${uploadId} - ${Math.floor(uploadedBytes / 1024 / 1024)}MB`);
            }
          }
        });

        file.on('end', () => {
          logger.info(`✅ File reception complete: ${filename} (${Math.floor(uploadedBytes / 1024 / 1024)}MB)`);
          updateUploadStatus(uploadId, {
            progress: 50,
            stage: 'file received, starting processing',
            uploadedBytes,
            status: 'processing'
          });
        });

        file.on('error', (error) => {
          logger.error(`❌ File stream error: ${error.message}`);
          if (writeStream) writeStream.destroy();
          reject(error);
        });

        // Handle write stream errors
        writeStream.on('error', (error) => {
          logger.error(`❌ Write stream error: ${error.message}`);
          reject(error);
        });

        // Pipe file to disk
        file.pipe(writeStream);

      } catch (error) {
        logger.error(`❌ Error setting up file stream: ${error.message}`);
        reject(error);
      }
    });

    // Handle form fields (like videoId, metadata, etc.)
    bb.on('field', (fieldname, value) => {
      logger.debug(`📝 Form field: ${fieldname} = ${value}`);
      // Store form fields for later use in processing
      if (!req.formFields) req.formFields = {};
      req.formFields[fieldname] = value;
    });

    bb.on('finish', async () => {
      if (!uploadStarted) {
        const error = new Error('No video file was uploaded. Please select a video file.');
        logger.error(`❌ ${error.message}`);
        return reject(error);
      }

      try {
        // Ensure write stream is closed
        if (writeStream && !writeStream.destroyed) {
          writeStream.end();
          await new Promise((resolve, reject) => {
            writeStream.on('close', resolve);
            writeStream.on('error', reject);
          });
        }

        logger.info(`🔄 Starting background processing for ${uploadId}`);
        
        // Extract any form fields for processing
        const videoId = req.formFields?.videoId;
        const metadata = req.formFields?.metadata;
        
        // Start background processing (don't await)
        processVideoBackground(uploadId, tempFilePath, filename, originalName, videoId, metadata)
          .then(() => {
            logger.info(`✅ Background processing completed for ${uploadId}`);
            resolve();
          })
          .catch((error) => {
            logger.error(`❌ Background processing failed for ${uploadId}:`, error);
            reject(error);
          });
          
      } catch (error) {
        logger.error(`❌ Error finishing upload: ${error.message}`);
        reject(error);
      }
    });

    bb.on('error', (error) => {
      logger.error(`❌ Busboy error: ${error.message}`);
      if (writeStream && !writeStream.destroyed) {
        writeStream.destroy();
      }
      // Clean up temp file
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupError) {
          logger.error(`❌ Error cleaning up temp file: ${cleanupError.message}`);
        }
      }
      reject(error);
    });

    // Handle request stream errors
    req.on('error', (error) => {
      logger.error(`❌ Request stream error: ${error.message}`);
      if (writeStream && !writeStream.destroyed) {
        writeStream.destroy();
      }
      reject(error);
    });

    req.on('aborted', () => {
      logger.warn(`⚠️ Request aborted for ${uploadId}`);
      if (writeStream && !writeStream.destroyed) {
        writeStream.destroy();
      }
      // Clean up temp file
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupError) {
          logger.error(`❌ Error cleaning up temp file: ${cleanupError.message}`);
        }
      }
      reject(new Error('Upload was cancelled'));
    });

    // Pipe request to busboy
    req.pipe(bb);
  });
}

/**
 * Background video processing with memory optimization
 * Supports files up to 100GB with 25MB memory usage
 */
async function processVideoBackground(uploadId, tempFilePath, filename, originalName, videoId, metadata) {
  let thumbnailPath = null;
  let videoMetadata = null;
  
  try {
    // Log memory before processing
    memoryMonitor.logMemoryUsage(`Before processing ${uploadId}`);
    
    // Step 1: Extract metadata (lightweight operation)
    updateUploadStatus(uploadId, {
      stage: 'extracting video metadata',
      progress: 55
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
      progress: 65,
      metadata: videoMetadata
    });
    
    const timestamp = uploadId.split('_')[1];
    const baseName = path.basename(originalName, path.extname(originalName));
    
    try {
      const thumbnailFileName = `${baseName}_${timestamp}.jpg`;
      thumbnailPath = getUploadPath('thumbs', thumbnailFileName);
      
      await ffmpegService.generateThumbnail(tempFilePath, thumbnailPath);
      logger.info(`✅ Thumbnail generated: ${thumbnailPath}`);
      
      updateUploadStatus(uploadId, {
        stage: 'uploading thumbnail',
        progress: 75
      });
      
      // Upload thumbnail to B2
      const thumbnailUrl = await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
      
      // Clean up local thumbnail immediately
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
      
      updateUploadStatus(uploadId, {
        thumbnailUrl,
        progress: 80
      });
      
    } catch (thumbnailError) {
      logger.warn(`⚠️ Thumbnail generation failed: ${thumbnailError.message}`);
      // Continue without thumbnail
    }

    // Step 3: Upload video to B2 with optimized chunking (25MB chunks)
    updateUploadStatus(uploadId, {
      status: 'uploading',
      stage: 'uploading video to cloud storage',
      progress: 85
    });
    
    logger.info(`☁️ Starting optimized B2 upload: ${filename}`);
    
    // Create file object for B2 service
    const fileStats = fs.statSync(tempFilePath);
    const fileObject = {
      path: tempFilePath,
      originalname: filename,
      size: fileStats.size,
      mimetype: 'video/mp4'
    };
    
    // Upload with 25MB chunks for optimal memory usage
    const videoUrl = await b2Service.uploadFileOptimized(fileObject, uploadId);
    
    logger.info(`✅ Video uploaded successfully: ${videoUrl}`);
    
    // Step 4: Clean up temp file immediately after upload
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      logger.info(`🧹 Cleaned up temp file: ${tempFilePath}`);
    }
    
    // Step 5: Update database if videoId provided
    if (videoId && supabaseService) {
      try {
        updateUploadStatus(uploadId, {
          stage: 'updating database',
          progress: 98
        });
        
        await supabaseService.updateVideoMetadata(videoId, {
          url: videoUrl,
          thumbnailUrl: thumbnailPath ? getB2ThumbnailUrl(baseName, timestamp) : null,
          duration: videoMetadata?.duration || 0,
          width: videoMetadata?.width || 0,
          height: videoMetadata?.height || 0
        });
        
        logger.info(`✅ Database updated for video ${videoId}`);
      } catch (supabaseError) {
        logger.error(`⚠️ Database update failed: ${supabaseError.message}`);
      }
    }
    
    // Step 6: Mark as complete
    const finalData = {
      videoUrl,
      thumbnailUrl: thumbnailPath ? getB2ThumbnailUrl(baseName, timestamp) : null,
      metadata: videoMetadata,
      uploadComplete: true,
      publishReady: true,
      completedAt: new Date().toISOString()
    };
    
    completeUploadStatus(uploadId, finalData);
    
    // Log final memory state
    memoryMonitor.logMemoryUsage(`Completed processing ${uploadId}`);
    
    logger.info(`🎉 Upload completed successfully: ${uploadId}`);
    
  } catch (error) {
    logger.error(`❌ Background processing failed for ${uploadId}:`, error);
    
    // Clean up files on error
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupError) {
        logger.error(`❌ Error cleaning up temp file: ${cleanupError.message}`);
      }
    }
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      try {
        fs.unlinkSync(thumbnailPath);
      } catch (cleanupError) {
        logger.error(`❌ Error cleaning up thumbnail: ${cleanupError.message}`);
      }
    }
    
    failUploadStatus(uploadId, error);
  }
}

/**
 * Helper to construct B2 thumbnail URL
 */
function getB2ThumbnailUrl(baseName, timestamp) {
  const thumbnailFileName = `${baseName}_${timestamp}.jpg`;
  const bucketName = config.b2.buckets.thumbnail.name;
  return `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${thumbnailFileName}`;
}

/**
 * Upload status endpoint with enhanced memory info
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
    
    // Add server health info for debugging
    const response = {
      ...status,
      serverHealth: {
        memory: memoryMonitor.getMemoryInfo(),
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
 * Health check endpoint with memory monitoring
 */
router.get('/health', (req, res) => {
  const memInfo = memoryMonitor.getMemoryInfo();
  const health = {
    status: 'healthy',
    service: 'upload-service-busboy',
    ...memInfo,
    activeUploads: Object.keys(require('../utils/status').getAllStatuses()).length,
    timestamp: new Date().toISOString(),
    maxFileSize: '100GB',
    chunkSize: '25MB'
  };
  
  // Return warning if memory usage is high
  if (health.rssPercent > 80) {
    health.status = 'warning';
    health.message = 'High memory usage';
  }
  
  res.json(health);
});

/**
 * CORS test endpoint
 */
router.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'Upload routes CORS working with Busboy',
    origin: req.headers.origin || 'Unknown',
    timestamp: new Date().toISOString(),
    service: 'busboy-upload'
  });
});

module.exports = router;