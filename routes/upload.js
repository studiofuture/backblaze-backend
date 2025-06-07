const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const busboy = require('busboy');
const { 
  initUploadStatus, 
  updateUploadStatus, 
  completeUploadStatus, 
  failUploadStatus 
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
 * OPTIMIZED: Streaming upload handler that never loads full file into memory
 * Replaces the previous multer-based approach
 */
router.post('/video', async (req, res) => {
  let uploadId;
  let tempFilePath;
  
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
    logger.info(`🎬 Optimized video upload started: ${uploadId}`);
    
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
 * Streaming upload handler using busboy
 */
async function handleStreamingUpload(req, uploadId) {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers });
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

    bb.on('file', (fieldname, file, info) => {
      try {
        originalName = info.filename;
        filename = generateUniqueFilename(originalName);
        tempFilePath = getUploadPath('temp', filename);
        
        logger.info(`📁 Receiving file: ${originalName} -> ${filename}`);
        
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
          
          // Update progress every 5MB to avoid spam
          if (uploadedBytes - lastProgressUpdate > 5 * 1024 * 1024) {
            const progressPercent = contentLength > 0 ? 
              Math.min(50, Math.floor((uploadedBytes / contentLength) * 50)) : 5;
            
            updateUploadStatus(uploadId, {
              progress: progressPercent,
              stage: `received ${Math.floor(uploadedBytes / 1024 / 1024)}MB`,
              uploadedBytes
            });
            
            lastProgressUpdate = uploadedBytes;
            
            // Log memory usage periodically
            if (uploadedBytes % (50 * 1024 * 1024) === 0) {
              memoryMonitor.logMemoryUsage(`Upload ${uploadId} - ${Math.floor(uploadedBytes / 1024 / 1024)}MB`);
            }
          }
        });

        file.on('end', () => {
          logger.info(`✅ File reception complete: ${filename} (${uploadedBytes} bytes)`);
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

        // Pipe file to disk
        file.pipe(writeStream);

      } catch (error) {
        logger.error(`❌ Error setting up file stream: ${error.message}`);
        reject(error);
      }
    });

    bb.on('finish', async () => {
      if (!uploadStarted) {
        return reject(new Error('No file was uploaded'));
      }

      try {
        // Ensure write stream is closed
        if (writeStream) {
          writeStream.end();
          await new Promise(resolve => writeStream.on('close', resolve));
        }

        logger.info(`🔄 Starting background processing for ${uploadId}`);
        
        // Start background processing (don't await)
        processVideoBackground(uploadId, tempFilePath, filename, originalName)
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
      if (writeStream) writeStream.destroy();
      // Clean up temp file
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
      reject(error);
    });

    // Handle request stream
    req.pipe(bb);
    
    req.on('error', (error) => {
      logger.error(`❌ Request stream error: ${error.message}`);
      if (writeStream) writeStream.destroy();
      reject(error);
    });
  });
}

/**
 * Background video processing with memory optimization
 */
async function processVideoBackground(uploadId, tempFilePath, filename, originalName) {
  let thumbnailPath = null;
  let metadata = null;
  
  try {
    // Log memory before processing
    memoryMonitor.logMemoryUsage(`Before processing ${uploadId}`);
    
    // Step 1: Extract metadata (lightweight operation)
    updateUploadStatus(uploadId, {
      stage: 'extracting video metadata',
      progress: 55
    });
    
    try {
      metadata = await ffmpegService.extractVideoMetadata(tempFilePath);
      logger.info(`✅ Metadata extracted for ${uploadId}:`, {
        duration: metadata.duration,
        dimensions: `${metadata.width}x${metadata.height}`
      });
    } catch (metadataError) {
      logger.warn(`⚠️ Metadata extraction failed: ${metadataError.message}`);
      metadata = { duration: 0, width: 0, height: 0 };
    }

    // Step 2: Generate thumbnail
    updateUploadStatus(uploadId, {
      stage: 'generating thumbnail',
      progress: 65,
      metadata
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

    // Step 3: Upload video to B2 with chunked streaming
    updateUploadStatus(uploadId, {
      status: 'uploading',
      stage: 'uploading video to cloud storage',
      progress: 85
    });
    
    logger.info(`☁️ Starting chunked upload to B2: ${filename}`);
    
    // Create file object for B2 service
    const fileStats = fs.statSync(tempFilePath);
    const fileObject = {
      path: tempFilePath,
      originalname: filename,
      size: fileStats.size,
      mimetype: 'video/mp4'
    };
    
    // Upload with optimized chunking
    const videoUrl = await b2Service.uploadFileOptimized(fileObject, uploadId);
    
    logger.info(`✅ Video uploaded successfully: ${videoUrl}`);
    
    // Step 4: Clean up temp file immediately after upload
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      logger.info(`🧹 Cleaned up temp file: ${tempFilePath}`);
    }
    
    // Step 5: Mark as complete
    const finalData = {
      videoUrl,
      thumbnailUrl: thumbnailPath ? await getB2ThumbnailUrl(baseName, timestamp) : null,
      metadata,
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
      fs.unlinkSync(tempFilePath);
    }
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      fs.unlinkSync(thumbnailPath);
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
 * OPTIMIZED: Get upload status with memory info
 */
router.get('/status/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  
  try {
    const status = getUploadStatus(uploadId);
    
    if (!status) {
      return res.status(404).json({ 
        error: 'Upload not found',
        uploadId 
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
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    service: 'upload-service',
    ...memoryMonitor.getMemoryInfo(),
    activeUploads: Object.keys(require('../utils/status').getAllStatuses()).length,
    timestamp: new Date().toISOString()
  };
  
  // Return warning if memory usage is high
  if (health.rssPercent > 80) {
    health.status = 'warning';
    health.message = 'High memory usage';
  }
  
  res.json(health);
});

module.exports = router;