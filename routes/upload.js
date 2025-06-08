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
const logger = require('../utils/logger');

/**
 * DELAYED RESPONSE: Wait for complete upload before responding (like Multer)
 * This should fix the QUIC protocol error by not responding during active upload
 */
router.post('/video', async (req, res) => {
  let uploadId;
  
  try {
    uploadId = `upload_${Date.now()}`;
    logger.info(`⏳ DELAYED RESPONSE upload started: ${uploadId}`);
    
    // Log request details
    logger.info('📋 Request info:', {
      method: req.method,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      origin: req.headers.origin
    });
    
    // DO NOT RESPOND IMMEDIATELY - Wait for upload completion
    logger.info(`⏳ Waiting for upload completion before responding (like Multer)`);

    // Process upload and wait for completion
    const result = await handleDelayedResponseUpload(req, uploadId);
    
    // Only respond after upload is complete
    logger.info(`✅ Upload completed, now sending response: ${uploadId}`);
    res.json({
      status: "success",
      uploadId,
      message: "Upload completed successfully - delayed response like Multer",
      ...result
    });
    
  } catch (error) {
    logger.error(`❌ Upload failed: ${error.message}`);
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
 * DELAYED RESPONSE: Process upload completely before resolving (like Multer behavior)
 */
async function handleDelayedResponseUpload(req, uploadId) {
  return new Promise(async (resolve, reject) => {
    logger.info(`⏳ Starting delayed response upload handler for ${uploadId}`);
    
    try {
      // Step 1: Directory creation
      logger.info(`📁 Creating directories...`);
      await ensureDirectory('uploads');
      await ensureDirectory('uploads/temp');
      logger.info(`✅ Directories ready`);
      
      // Step 2: Busboy setup
      logger.info(`🔧 Setting up busboy...`);
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
      let tempFilePath;
      let writeStream;
      let totalBytesReceived = 0;
      let uploadComplete = false;
      let processingComplete = false;

      // Initialize status
      initUploadStatus(uploadId, {
        status: 'receiving',
        stage: 'delayed response - receiving file'
      });

      // File handler
      bb.on('file', (fieldname, file, info) => {
        logger.info(`📥 File handler triggered:`, {
          fieldname,
          filename: info.filename,
          mimeType: info.mimeType
        });
        
        try {
          fileReceived = true;
          filename = generateUniqueFilename(info.filename);
          tempFilePath = getUploadPath('temp', filename);
          
          logger.info(`📁 Target: ${tempFilePath}`);
          
          // Verify directory
          const tempDir = path.dirname(tempFilePath);
          if (!fs.existsSync(tempDir)) {
            logger.error(`❌ Directory missing: ${tempDir}`);
            return reject(new Error(`Directory not found: ${tempDir}`));
          }
          
          // Create write stream
          try {
            writeStream = fs.createWriteStream(tempFilePath);
            logger.info(`✅ Write stream created`);
            
            writeStream.on('error', (streamError) => {
              logger.error(`❌ Write stream error: ${streamError.message}`);
              reject(streamError);
            });
            
          } catch (streamCreateError) {
            logger.error(`❌ Write stream creation failed: ${streamCreateError.message}`);
            return reject(streamCreateError);
          }
          
          // File data handling
          file.on('data', (chunk) => {
            try {
              totalBytesReceived += chunk.length;
              
              // Log progress every 10MB
              if (totalBytesReceived % (10 * 1024 * 1024) < chunk.length) {
                logger.info(`📊 Received: ${Math.floor(totalBytesReceived / 1024 / 1024)}MB`);
                
                updateUploadStatus(uploadId, {
                  progress: Math.min(50, Math.floor((totalBytesReceived / (req.headers['content-length'] || totalBytesReceived)) * 50)),
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
              progress: 60,
              stage: 'file reception complete, processing...',
              status: 'processing'
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
            logger.info(`✅ Write stream closed - starting background processing`);
            uploadComplete = true;
            
            // Start background processing
            processVideoMinimal(uploadId, tempFilePath, filename, info.filename)
              .then((result) => {
                logger.info(`✅ Background processing completed for ${uploadId}`);
                processingComplete = true;
                
                // Only resolve after BOTH upload AND processing are complete
                resolve(result);
              })
              .catch((error) => {
                logger.error(`❌ Background processing failed: ${error.message}`);
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

      // Other busboy handlers
      bb.on('field', (fieldname, value) => {
        logger.debug(`📝 Field: ${fieldname} = ${value}`);
      });

      bb.on('finish', () => {
        logger.info(`🏁 Busboy finished for ${uploadId}`);
        
        if (!fileReceived) {
          const error = new Error('No file received');
          logger.error(`❌ ${error.message}`);
          reject(error);
        } else {
          logger.info(`✅ Busboy finished successfully, waiting for processing...`);
        }
      });

      bb.on('error', (error) => {
        logger.error(`❌ Busboy error: ${error.message}`);
        reject(error);
      });

      // Request handlers
      req.on('error', (error) => {
        logger.error(`❌ Request error: ${error.message}`);
        reject(error);
      });

      req.on('aborted', () => {
        logger.warn(`⚠️ Request aborted for ${uploadId}`);
        reject(new Error('Request aborted'));
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
      
      logger.info(`⏳ Waiting for upload and processing to complete...`);
      
    } catch (setupError) {
      logger.error(`❌ Setup error: ${setupError.message}`);
      reject(setupError);
    }
  });
}

/**
 * Minimal processing - just complete the upload for testing
 */
async function processVideoMinimal(uploadId, tempFilePath, filename, originalName) {
  try {
    logger.info(`🔄 Starting minimal processing for ${uploadId}`);
    
    updateUploadStatus(uploadId, {
      stage: 'processing complete',
      progress: 90
    });

    // For testing - just verify file exists and get size
    const fileStats = fs.statSync(tempFilePath);
    const fileSizeMB = Math.floor(fileStats.size / 1024 / 1024);
    
    logger.info(`📊 File processed: ${fileSizeMB}MB`);
    
    // Clean up temp file
    if (fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
      logger.info(`🧹 Cleaned up temp file`);
    }
    
    // Complete status
    const finalData = {
      videoUrl: `https://example.com/videos/${filename}`,
      uploadComplete: true,
      fileSizeMB,
      completedAt: new Date().toISOString()
    };
    
    completeUploadStatus(uploadId, finalData);
    
    logger.info(`🎉 Processing completed successfully: ${uploadId}`);
    return finalData;
    
  } catch (error) {
    logger.error(`❌ Processing failed: ${error.message}`);
    
    // Clean up on error
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
        logger.info(`🧹 Cleaned up temp file after error`);
      } catch (cleanupError) {
        logger.error(`❌ Cleanup failed: ${cleanupError.message}`);
      }
    }
    
    failUploadStatus(uploadId, error);
    throw error;
  }
}

/**
 * Status endpoint
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
    
    res.json(status);
    
  } catch (error) {
    logger.error(`❌ Status check error: ${error.message}`);
    res.status(500).json({ 
      error: 'Status check failed',
      details: error.message
    });
  }
});

/**
 * Health check
 */
router.get('/health', (req, res) => {
  const memInfo = process.memoryUsage();
  res.json({
    status: 'healthy',
    service: 'delayed-response-upload',
    memory: {
      rss: `${Math.floor(memInfo.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.floor(memInfo.heapUsed / 1024 / 1024)}MB`
    },
    timestamp: new Date().toISOString(),
    features: {
      responseStrategy: 'delayed-like-multer',
      maxFileSize: '100GB'
    }
  });
});

module.exports = router;