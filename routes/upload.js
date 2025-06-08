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
 * MINIMAL DIAGNOSTIC: Strip everything except basic file reception
 * Goal: Find exactly where the crash occurs
 */
router.post('/video', async (req, res) => {
  let uploadId;
  
  try {
    uploadId = `upload_${Date.now()}`;
    logger.info(`🧪 MINIMAL DIAGNOSTIC upload started: ${uploadId}`);
    
    // Log request details
    logger.info('📋 Request info:', {
      method: req.method,
      url: req.url,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      origin: req.headers.origin
    });
    
    // Return immediately
    res.json({ 
      status: "uploading", 
      uploadId,
      message: "MINIMAL DIAGNOSTIC - Testing basic file reception only"
    });

    // Start minimal processing
    await handleMinimalUpload(req, uploadId);
    
  } catch (error) {
    logger.error(`❌ MINIMAL DIAGNOSTIC - Top level error: ${error.message}`);
    logger.error(`❌ Stack: ${error.stack}`);
    if (uploadId) {
      failUploadStatus(uploadId, error);
    }
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

/**
 * MINIMAL: Just receive file and save to disk - NO processing
 */
async function handleMinimalUpload(req, uploadId) {
  return new Promise(async (resolve, reject) => {
    logger.info(`🧪 STEP 1: Starting minimal upload handler for ${uploadId}`);
    
    try {
      // Step 1: Directory creation with detailed logging
      logger.info(`🧪 STEP 2: Creating directories...`);
      
      try {
        await ensureDirectory('uploads');
        logger.info(`✅ uploads/ created/verified`);
        
        await ensureDirectory('uploads/temp');
        logger.info(`✅ uploads/temp/ created/verified`);
        
        logger.info(`🧪 STEP 3: All directories ready`);
      } catch (dirError) {
        logger.error(`❌ Directory creation failed: ${dirError.message}`);
        return reject(dirError);
      }
      
      // Step 2: Busboy setup with minimal config
      logger.info(`🧪 STEP 4: Setting up busboy...`);
      
      let bb;
      try {
        bb = busboy({ 
          headers: req.headers,
          limits: {
            fileSize: 100 * 1024 * 1024, // 100MB for testing
            files: 1,
            fields: 5,
            fieldSize: 1024
          }
        });
        logger.info(`✅ Busboy created successfully`);
      } catch (busboyError) {
        logger.error(`❌ Busboy creation failed: ${busboyError.message}`);
        return reject(busboyError);
      }
      
      // Variables for tracking
      let fileReceived = false;
      let filename;
      let tempFilePath;
      let writeStream;
      let totalBytesReceived = 0;

      // Step 3: Initialize status
      logger.info(`🧪 STEP 5: Initializing status...`);
      try {
        initUploadStatus(uploadId, {
          status: 'receiving',
          stage: 'MINIMAL DIAGNOSTIC - starting file reception'
        });
        logger.info(`✅ Status initialized`);
      } catch (statusError) {
        logger.error(`❌ Status init failed: ${statusError.message}`);
        // Continue anyway
      }

      // Step 4: File handler - MINIMAL with max error handling
      bb.on('file', (fieldname, file, info) => {
        logger.info(`🧪 STEP 6: File handler triggered`);
        logger.info(`📁 File info:`, {
          fieldname: fieldname,
          filename: info.filename,
          mimeType: info.mimeType,
          encoding: info.encoding
        });
        
        try {
          fileReceived = true;
          filename = generateUniqueFilename(info.filename);
          tempFilePath = getUploadPath('temp', filename);
          
          logger.info(`📁 Generated paths:`, {
            originalName: info.filename,
            uniqueName: filename,
            tempPath: tempFilePath
          });
          
          // Verify directory exists
          const tempDir = path.dirname(tempFilePath);
          if (!fs.existsSync(tempDir)) {
            logger.error(`❌ Directory missing at file handler: ${tempDir}`);
            return reject(new Error(`Directory not found: ${tempDir}`));
          }
          
          logger.info(`✅ Directory verified exists: ${tempDir}`);
          
          // Create write stream with detailed error handling
          logger.info(`🧪 STEP 7: Creating write stream...`);
          try {
            writeStream = fs.createWriteStream(tempFilePath);
            logger.info(`✅ Write stream created: ${tempFilePath}`);
            
            // Add write stream error handler immediately
            writeStream.on('error', (streamError) => {
              logger.error(`❌ Write stream error: ${streamError.message}`);
              reject(streamError);
            });
            
            writeStream.on('open', () => {
              logger.info(`✅ Write stream opened successfully`);
            });
            
          } catch (streamCreateError) {
            logger.error(`❌ Write stream creation failed: ${streamCreateError.message}`);
            return reject(streamCreateError);
          }
          
          // Step 5: File data handling - MINIMAL
          logger.info(`🧪 STEP 8: Setting up file data handlers...`);
          
          file.on('data', (chunk) => {
            try {
              totalBytesReceived += chunk.length;
              
              // Log every 5MB
              if (totalBytesReceived % (5 * 1024 * 1024) < chunk.length) {
                logger.info(`📊 Received: ${Math.floor(totalBytesReceived / 1024 / 1024)}MB`);
                
                // Update status
                try {
                  updateUploadStatus(uploadId, {
                    progress: Math.min(90, Math.floor((totalBytesReceived / (req.headers['content-length'] || totalBytesReceived)) * 90)),
                    stage: `received ${Math.floor(totalBytesReceived / 1024 / 1024)}MB`,
                    uploadedBytes: totalBytesReceived
                  });
                } catch (statusUpdateError) {
                  logger.warn(`⚠️ Status update failed: ${statusUpdateError.message}`);
                  // Continue anyway
                }
              }
            } catch (dataError) {
              logger.error(`❌ Error in data handler: ${dataError.message}`);
              reject(dataError);
            }
          });
          
          file.on('end', () => {
            logger.info(`✅ File stream ended. Total: ${Math.floor(totalBytesReceived / 1024 / 1024)}MB`);
            
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
            logger.info(`✅ Write stream closed successfully`);
            
            // MINIMAL SUCCESS - just mark as complete
            try {
              const finalData = {
                videoUrl: `file:///${tempFilePath}`,
                uploadComplete: true,
                receivedBytes: totalBytesReceived,
                completedAt: new Date().toISOString()
              };
              
              completeUploadStatus(uploadId, finalData);
              logger.info(`🎉 MINIMAL DIAGNOSTIC SUCCESS: ${uploadId}`);
              resolve();
              
            } catch (completeError) {
              logger.error(`❌ Complete status failed: ${completeError.message}`);
              reject(completeError);
            }
          });
          
          // Step 6: Pipe file to write stream
          logger.info(`🧪 STEP 9: Piping file to write stream...`);
          try {
            file.pipe(writeStream);
            logger.info(`✅ File piped to write stream`);
          } catch (pipeError) {
            logger.error(`❌ Pipe failed: ${pipeError.message}`);
            reject(pipeError);
          }
          
        } catch (fileHandlerError) {
          logger.error(`❌ File handler error: ${fileHandlerError.message}`);
          reject(fileHandlerError);
        }
      });

      // Step 7: Other busboy handlers
      bb.on('field', (fieldname, value) => {
        logger.info(`📝 Form field: ${fieldname} = ${value}`);
      });

      bb.on('finish', () => {
        logger.info(`🏁 Busboy finished for ${uploadId}`);
        
        if (!fileReceived) {
          const error = new Error('No file was received by busboy');
          logger.error(`❌ ${error.message}`);
          reject(error);
        } else {
          logger.info(`✅ Busboy finished successfully, file was received`);
        }
      });

      bb.on('error', (error) => {
        logger.error(`❌ Busboy error: ${error.message}`);
        logger.error(`❌ Busboy error stack: ${error.stack}`);
        reject(error);
      });

      // Step 8: Request handlers
      req.on('error', (error) => {
        logger.error(`❌ Request error: ${error.message}`);
        reject(error);
      });

      req.on('aborted', () => {
        logger.warn(`⚠️ Request aborted for ${uploadId}`);
        reject(new Error('Request was aborted'));
      });

      // Step 9: Pipe request to busboy
      logger.info(`🧪 STEP 10: Piping request to busboy...`);
      try {
        req.pipe(bb);
        logger.info(`✅ Request piped to busboy successfully`);
      } catch (pipeError) {
        logger.error(`❌ Request pipe failed: ${pipeError.message}`);
        reject(pipeError);
      }
      
      logger.info(`🧪 STEP 11: All handlers set up, waiting for data...`);
      
    } catch (setupError) {
      logger.error(`❌ Setup error in minimal handler: ${setupError.message}`);
      logger.error(`❌ Setup error stack: ${setupError.stack}`);
      reject(setupError);
    }
  });
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
    service: 'minimal-diagnostic-upload',
    memory: {
      rss: `${Math.floor(memInfo.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.floor(memInfo.heapUsed / 1024 / 1024)}MB`
    },
    timestamp: new Date().toISOString()
  });
});

module.exports = router;