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

// Import services
const b2Service = require('../services/b2');
const ffmpegService = require('../services/ffmpeg');
const supabaseService = require('../services/supabase');
const logger = require('../utils/logger');
const { config } = require('../config');

/**
 * COMPLETE: Streaming upload handler with proper directory creation
 * Supports unlimited file sizes with 25MB memory usage
 */
router.post('/video', async (req, res) => {
  let uploadId;
  
  try {
    uploadId = `upload_${Date.now()}`;
    logger.info(`🎬 Complete busboy video upload started: ${uploadId}`);
    
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
      message: "Upload started successfully - Complete version with directory fix"
    });

    // Process upload with COMPLETE streaming approach including directory creation
    await handleCompleteStreamingUpload(req, uploadId);
    
  } catch (error) {
    logger.error(`❌ Upload failed: ${error.message}`);
    logger.error(`❌ Upload stack: ${error.stack}`);
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
 * COMPLETE: Enhanced streaming upload handler using busboy with directory creation
 * Handles multiple possible field names from frontend + full processing pipeline
 */
async function handleCompleteStreamingUpload(req, uploadId) {
  return new Promise(async (resolve, reject) => {
    try {
      logger.info(`📥 Starting busboy with complete processing for ${uploadId}`);
      
      // CRITICAL FIX: Ensure directories exist BEFORE starting upload
      try {
        await ensureDirectory('uploads');
        await ensureDirectory('uploads/temp');
        await ensureDirectory('uploads/thumbs');
        logger.info(`✅ All required directories verified for ${uploadId}`);
      } catch (dirError) {
        logger.error(`❌ Failed to create directories: ${dirError.message}`);
        return reject(dirError);
      }
      
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
        stage: 'starting complete upload with directory creation'
      });

      // Handle file uploads - support multiple field names
      bb.on('file', async (fieldname, file, info) => {
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
          logger.info(`📁 Target path: ${tempFilePath}`);
          
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
          
          // CRITICAL FIX: Verify directory exists before creating write stream
          const tempDir = path.dirname(tempFilePath);
          if (!fs.existsSync(tempDir)) {
            logger.error(`❌ Directory missing: ${tempDir}`);
            try {
              await ensureDirectory(tempDir);
              logger.info(`✅ Created missing directory: ${tempDir}`);
            } catch (createError) {
              logger.error(`❌ Failed to create directory: ${createError.message}`);
              return reject(createError);
            }
          } else {
            logger.info(`✅ Directory exists: ${tempDir}`);
          }
          
          // Create write stream to temp file with error handling
          try {
            writeStream = fs.createWriteStream(tempFilePath);
            uploadStarted = true;
            logger.info(`✅ Write stream created successfully: ${tempFilePath}`);
          } catch (streamError) {
            logger.error(`❌ Failed to create write stream: ${streamError.message}`);
            return reject(streamError);
          }
          
          let uploadedBytes = 0;
          let lastProgressUpdate = 0;
          const contentLength = parseInt(req.headers['content-length'] || '0');
          
          updateUploadStatus(uploadId, {
            status: 'receiving',
            stage: 'receiving file data - complete version',
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
              
              logger.info(`📊 Progress: ${Math.floor(uploadedBytes / 1024 / 1024)}MB received`);
              
              updateUploadStatus(uploadId, {
                progress: progressPercent,
                stage: `received ${Math.floor(uploadedBytes / 1024 / 1024)}MB`,
                uploadedBytes
              });
              
              lastProgressUpdate = uploadedBytes;
            }
          });

          // Proper file end handling
          file.on('end', () => {
            logger.info(`✅ File stream ended: ${filename} (${Math.floor(uploadedBytes / 1024 / 1024)}MB)`);
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

          // Handle write stream close event
          writeStream.on('close', () => {
            logger.info(`✅ Write stream closed for ${uploadId}`);
            writeStreamClosed = true;
            
            updateUploadStatus(uploadId, {
              stage: 'file reception complete',
              progress: 55
            });
            
            // Check if we can start processing
            checkAndStartProcessing();
          });

          // Better error handling
          file.on('error', (error) => {
            logger.error(`❌ File stream error: ${error.message}`);
            if (writeStream && !writeStream.destroyed) {
              writeStream.destroy();
            }
            reject(error);
          });

          // Handle write stream errors
          writeStream.on('error', (error) => {
            logger.error(`❌ Write stream error: ${error.message}`);
            reject(error);
          });

          // Function to check if we can start processing
          function checkAndStartProcessing() {
            if (fileStreamEnded && writeStreamClosed) {
              logger.info(`🔄 Starting background processing for ${uploadId}`);
              
              // Extract any form fields for processing
              const videoId = req.formFields?.videoId;
              const metadata = req.formFields?.metadata;
              
              // Start background processing with COMPLETE pipeline
              processVideoBackgroundComplete(uploadId, tempFilePath, filename, originalName, videoId, metadata)
                .then(() => {
                  logger.info(`✅ Background processing completed for ${uploadId}`);
                  resolve();
                })
                .catch((error) => {
                  logger.error(`❌ Background processing failed for ${uploadId}:`, error);
                  reject(error);
                });
            }
          }

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

      // Simplified finish handler - no manual stream ending
      bb.on('finish', () => {
        logger.info(`🏁 Busboy finished for ${uploadId}`);
        
        if (!uploadStarted) {
          const error = new Error('No video file was uploaded. Please select a video file.');
          logger.error(`❌ ${error.message}`);
          return reject(error);
        }
        
        // Don't manually handle writeStream here - let the file 'end' event handle it
        logger.info(`✅ Busboy finish - waiting for streams to close naturally`);
      });

      bb.on('error', (error) => {
        logger.error(`❌ Busboy error: ${error.message}`);
        if (writeStream && !writeStream.destroyed) {
          writeStream.destroy();
        }
        // Clean up temp file
        cleanupTempFile();
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
        cleanupTempFile();
        reject(new Error('Upload was cancelled'));
      });

      // Cleanup function
      function cleanupTempFile() {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try {
            fs.unlinkSync(tempFilePath);
            logger.info(`🧹 Cleaned up temp file after error: ${tempFilePath}`);
          } catch (cleanupError) {
            logger.error(`❌ Error cleaning up temp file: ${cleanupError.message}`);
          }
        }
      }

      // Pipe request to busboy
      logger.info(`🔗 Piping request to busboy for ${uploadId}`);
      req.pipe(bb);
      
    } catch (setupError) {
      logger.error(`❌ Setup error for ${uploadId}: ${setupError.message}`);
      reject(setupError);
    }
  });
}

/**
 * COMPLETE: Background video processing with full B2 upload pipeline
 * Supports files up to 100GB with 25MB memory usage
 */
async function processVideoBackgroundComplete(uploadId, tempFilePath, filename, originalName, videoId, metadata) {
  let thumbnailPath = null;
  let videoMetadata = null;
  
  try {
    logger.info(`🔄 Complete background processing started for ${uploadId}`);
    
    // Step 1: Extract metadata (lightweight operation)
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
        stage: 'uploading thumbnail',
        progress: 80
      });
      
      // Upload thumbnail to B2
      thumbnailUrl = await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
      
      // Clean up local thumbnail immediately
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
      
      updateUploadStatus(uploadId, {
        thumbnailUrl,
        progress: 85
      });
      
    } catch (thumbnailError) {
      logger.warn(`⚠️ Thumbnail generation failed: ${thumbnailError.message}`);
      // Continue without thumbnail
    }

    // Step 3: Upload video to B2 with optimized chunking (25MB chunks)
    updateUploadStatus(uploadId, {
      status: 'uploading',
      stage: 'uploading video to cloud storage',
      progress: 90
    });
    
    logger.info(`☁️ Starting B2 upload: ${filename}`);
    
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
          thumbnailUrl: thumbnailUrl,
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
      thumbnailUrl: thumbnailUrl,
      metadata: videoMetadata,
      uploadComplete: true,
      publishReady: true,
      completedAt: new Date().toISOString()
    };
    
    completeUploadStatus(uploadId, finalData);
    
    logger.info(`🎉 Upload completed successfully: ${uploadId}`);
    
  } catch (error) {
    logger.error(`❌ Background processing failed for ${uploadId}:`, {
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
    
    // Add basic server health info
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
    service: 'complete-upload-service-busboy',
    memory: {
      rss: `${Math.floor(memInfo.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.floor(memInfo.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.floor(memInfo.heapTotal / 1024 / 1024)}MB`
    },
    timestamp: new Date().toISOString(),
    features: {
      maxFileSize: '100GB',
      chunkSize: '25MB',
      directoryCreation: 'enabled',
      b2Upload: 'enabled',
      thumbnailGeneration: 'enabled',
      supabaseIntegration: 'enabled'
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
    message: 'Complete Upload routes CORS working',
    origin: req.headers.origin || 'Unknown',
    timestamp: new Date().toISOString(),
    service: 'complete-busboy-upload'
  });
});

module.exports = router;