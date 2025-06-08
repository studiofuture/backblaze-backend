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

// DEBUG: Check logger configuration
console.log('🔧 DEBUG: LOG_LEVEL =', process.env.LOG_LEVEL);
console.log('🔧 DEBUG: NODE_ENV =', process.env.NODE_ENV);

/**
 * COMPLETE FUNCTIONALITY: Full B2 + FFmpeg + Supabase with Delayed Response
 * Uses the working delayed response pattern to avoid QUIC protocol errors
 */
router.post('/video', async (req, res) => {
  let uploadId;
  
  try {
    uploadId = `upload_${Date.now()}`;
    console.log(`🚀 COMPLETE FUNCTIONALITY upload started: ${uploadId}`);
    
    // Log request details
    console.log('📋 Request info:', {
      method: req.method,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      origin: req.headers.origin
    });
    
    // DO NOT RESPOND IMMEDIATELY - Wait for complete processing
    console.log(`⏳ Waiting for COMPLETE processing before responding (B2 + FFmpeg + Supabase)`);

    // Process upload with FULL functionality and wait for completion
    const result = await handleCompleteUploadWithDelayedResponse(req, uploadId);
    
    // Only respond after everything is complete
    console.log(`✅ Complete processing finished, now sending response: ${uploadId}`);
    res.json({
      status: "success",
      uploadId,
      message: "Upload completed successfully with full functionality",
      url: result.videoUrl, 
      ...result
    });
    
  } catch (error) {
    console.error(`❌ Complete upload failed: ${error.message}`);
    console.error(`❌ Stack: ${error.stack}`);
    
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
 * COMPLETE PROCESSING: Full pipeline with delayed response
 * B2 Upload + FFmpeg + Thumbnail + Supabase - all before responding
 */
async function handleCompleteUploadWithDelayedResponse(req, uploadId) {
  return new Promise(async (resolve, reject) => {
    console.log(`🚀 Starting COMPLETE upload handler for ${uploadId}`);
    
    try {
      // Step 1: Directory creation
      console.log(`📁 Creating directories...`);
      await ensureDirectory('uploads');
      await ensureDirectory('uploads/temp');
      await ensureDirectory('uploads/thumbs');
      console.log(`✅ All directories ready`);
      
      // Step 2: Busboy setup
      console.log(`🔧 Setting up busboy for complete processing...`);
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
        console.log(`📥 File handler triggered:`, {
          fieldname,
          filename: info.filename,
          mimeType: info.mimeType,
          encoding: info.encoding
        });
        
        try {
          // Accept common field names
          const validFieldNames = ['video', 'file', 'upload', 'media'];
          if (!validFieldNames.includes(fieldname)) {
            console.warn(`⚠️ Unexpected field name: ${fieldname}. Accepting anyway.`);
          }
          
          fileReceived = true;
          originalName = info.filename;
          filename = generateUniqueFilename(originalName);
          tempFilePath = getUploadPath('temp', filename);
          
          console.log(`📁 Processing: ${originalName} -> ${filename}`);
          console.log(`📁 Target: ${tempFilePath}`);
          
          // FULL FILE TYPE VALIDATION
          const validVideoTypes = [
            'video/mp4', 'video/quicktime', 'video/x-msvideo', 
            'video/x-matroska', 'video/mpeg', 'video/webm',
            'video/x-ms-wmv', 'video/3gpp'
          ];
          
          if (!validVideoTypes.includes(info.mimeType)) {
            const error = new Error(`Invalid file type: ${info.mimeType}. Only video files are allowed.`);
            console.error(`❌ ${error.message}`);
            return reject(error);
          }
          
          // Verify directory
          const tempDir = path.dirname(tempFilePath);
          if (!fs.existsSync(tempDir)) {
            console.error(`❌ Directory missing: ${tempDir}`);
            return reject(new Error(`Directory not found: ${tempDir}`));
          }
          
          // Create write stream
          try {
            writeStream = fs.createWriteStream(tempFilePath);
            console.log(`✅ Write stream created successfully`);
            
            writeStream.on('error', (streamError) => {
              console.error(`❌ Write stream error: ${streamError.message}`);
              reject(streamError);
            });
            
          } catch (streamCreateError) {
            console.error(`❌ Write stream creation failed: ${streamCreateError.message}`);
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
                
                console.log(`📊 Received: ${Math.floor(totalBytesReceived / 1024 / 1024)}MB`);
                
                updateUploadStatus(uploadId, {
                  progress: progressPercent,
                  stage: `receiving: ${Math.floor(totalBytesReceived / 1024 / 1024)}MB`,
                  uploadedBytes: totalBytesReceived
                });
              }
            } catch (dataError) {
              console.error(`❌ Data handler error: ${dataError.message}`);
              reject(dataError);
            }
          });
          
          file.on('end', () => {
            console.log(`✅ File stream ended: ${Math.floor(totalBytesReceived / 1024 / 1024)}MB total`);
            
            updateUploadStatus(uploadId, {
              progress: 55,
              stage: 'file reception complete, starting processing...',
              status: 'processing',
              uploadedBytes: totalBytesReceived
            });
            
            try {
              writeStream.end();
              console.log(`✅ Write stream end() called`);
            } catch (endError) {
              console.error(`❌ Write stream end failed: ${endError.message}`);
              reject(endError);
            }
          });
          
          file.on('error', (fileError) => {
            console.error(`❌ File stream error: ${fileError.message}`);
            if (writeStream && !writeStream.destroyed) {
              writeStream.destroy();
            }
            reject(fileError);
          });
          
          writeStream.on('close', () => {
            console.log(`✅ Write stream closed - starting COMPLETE background processing`);
            
            // Extract form fields for processing
            const videoId = formFields.videoId;
            const metadata = formFields.metadata;
            
            // Start COMPLETE background processing
            processVideoComplete(uploadId, tempFilePath, filename, originalName, videoId, metadata)
              .then((result) => {
                console.log(`✅ COMPLETE processing finished for ${uploadId}`);
                resolve(result);
              })
              .catch((error) => {
                console.error(`❌ COMPLETE processing failed: ${error.message}`);
                reject(error);
              });
          });
          
          // Pipe file to write stream
          console.log(`🔗 Piping file to write stream...`);
          file.pipe(writeStream);
          
        } catch (fileHandlerError) {
          console.error(`❌ File handler error: ${fileHandlerError.message}`);
          reject(fileHandlerError);
        }
      });

      // Handle form fields (videoId, metadata, etc.)
      bb.on('field', (fieldname, value) => {
        console.log(`📝 Form field: ${fieldname} = ${value}`);
        formFields[fieldname] = value;
      });

      bb.on('finish', () => {
        console.log(`🏁 Busboy finished for ${uploadId}`);
        
        if (!fileReceived) {
          const error = new Error('No video file was uploaded. Please select a video file.');
          console.error(`❌ ${error.message}`);
          reject(error);
        } else {
          console.log(`✅ Busboy finished successfully, waiting for COMPLETE processing...`);
        }
      });

      bb.on('error', (error) => {
        console.error(`❌ Busboy error: ${error.message}`);
        
        // Clean up temp file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
          try {
            fs.unlinkSync(tempFilePath);
            console.log(`🧹 Cleaned up temp file after busboy error`);
          } catch (cleanupError) {
            console.error(`❌ Error cleaning up: ${cleanupError.message}`);
          }
        }
        reject(error);
      });

      // Request handlers
      req.on('error', (error) => {
        console.error(`❌ Request error: ${error.message}`);
        reject(error);
      });

      req.on('aborted', () => {
        console.warn(`⚠️ Request aborted for ${uploadId}`);
        reject(new Error('Upload was cancelled'));
      });

      // Pipe request to busboy
      console.log(`🔗 Piping request to busboy...`);
      try {
        req.pipe(bb);
        console.log(`✅ Request piped successfully`);
      } catch (pipeError) {
        console.error(`❌ Request pipe failed: ${pipeError.message}`);
        reject(pipeError);
      }
      
      console.log(`⏳ Waiting for COMPLETE upload and processing...`);
      
    } catch (setupError) {
      console.error(`❌ Setup error: ${setupError.message}`);
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
    console.log(`🚀 COMPLETE processing started for ${uploadId}`);
    
    // Step 1: Extract video metadata
    updateUploadStatus(uploadId, {
      stage: 'extracting video metadata',
      progress: 60
    });
    
    try {
      videoMetadata = await ffmpegService.extractVideoMetadata(tempFilePath);
      console.log(`✅ Metadata extracted for ${uploadId}:`, {
        duration: videoMetadata.duration,
        dimensions: `${videoMetadata.width}x${videoMetadata.height}`,
        size: `${Math.floor(videoMetadata.size / 1024 / 1024)}MB`
      });
    } catch (metadataError) {
      console.warn(`⚠️ Metadata extraction failed: ${metadataError.message}`);
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
      console.log(`✅ Thumbnail generated: ${thumbnailPath}`);
      
      updateUploadStatus(uploadId, {
        stage: 'uploading thumbnail to B2',
        progress: 75
      });
      
      // Upload thumbnail to B2
      thumbnailUrl = await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
      console.log(`✅ Thumbnail uploaded to B2: ${thumbnailUrl}`);
      
      // Clean up local thumbnail immediately
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
        console.log(`🧹 Local thumbnail cleaned up`);
      }
      
      updateUploadStatus(uploadId, {
        thumbnailUrl,
        progress: 80
      });
      
    } catch (thumbnailError) {
      console.warn(`⚠️ Thumbnail generation/upload failed: ${thumbnailError.message}`);
      // Continue without thumbnail
    }

    // Step 3: Upload video to B2 with optimized chunking
    updateUploadStatus(uploadId, {
      status: 'uploading',
      stage: 'uploading video to B2 cloud storage',
      progress: 85
    });
    
    console.log(`☁️ Starting B2 video upload: ${filename}`);
    
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
    console.log(`✅ Video uploaded successfully to B2: ${videoUrl}`);
    
    // Step 4: Clean up temp file immediately after B2 upload
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      console.log(`🧹 Temp file cleaned up: ${tempFilePath}`);
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
        
        console.log(`✅ Supabase database updated for video ${videoId}`);
      } catch (supabaseError) {
        console.error(`⚠️ Database update failed: ${supabaseError.message}`);
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
    
    console.log(`🎉 COMPLETE processing successful: ${uploadId}`);
    return finalData;
    
  } catch (error) {
    console.error(`❌ COMPLETE processing failed for ${uploadId}:`, {
      error: error.message,
      stack: error.stack,
      tempFilePath,
      filename
    });
    
    // Clean up files on error
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        console.log(`🧹 Error cleanup - temp file removed: ${tempFilePath}`);
      } catch (cleanupError) {
        console.error(`❌ Error cleanup failed: ${cleanupError.message}`);
      }
    }
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      try {
        fs.unlinkSync(thumbnailPath);
        console.log(`🧹 Error cleanup - thumbnail removed: ${thumbnailPath}`);
      } catch (cleanupError) {
        console.error(`❌ Thumbnail cleanup failed: ${cleanupError.message}`);
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
    console.error(`❌ Status check error: ${error.message}`);
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