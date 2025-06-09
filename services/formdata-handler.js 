const busboy = require('busboy');
const fs = require('fs');
const path = require('path');
const { 
  initUploadStatus, 
  updateUploadStatus
} = require('../utils/status');
const { generateUniqueFilename, getUploadPath, ensureDirectory } = require('../utils/directory');
const uploadProcessor = require('./upload-processor');

/**
 * FormData Upload Handler Service
 * Handles traditional FormData uploads using Busboy
 */

/**
 * Handle complete FormData upload with Busboy
 * @param {Object} req - Express request object
 * @param {string} uploadId - Unique upload identifier
 * @returns {Promise<Object>} - Upload result
 */
async function handleFormDataUpload(req, uploadId) {
  return new Promise(async (resolve, reject) => {
    console.log(`🚀 Starting FormData upload handler for ${uploadId}`);
    
    try {
      // Step 1: Directory creation
      console.log(`📁 Creating directories...`);
      await ensureDirectory('uploads');
      await ensureDirectory('uploads/temp');
      await ensureDirectory('uploads/thumbs');
      console.log(`✅ All directories ready`);
      
      // Step 2: Busboy setup
      console.log(`🔧 Setting up busboy for FormData processing...`);
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
        stage: 'FormData processing - receiving file'
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
          
          // File type validation
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
            console.log(`✅ Write stream closed - starting background processing`);
            
            // Extract form fields for processing
            const videoId = formFields.videoId;
            
            // Process the complete file using upload processor
            uploadProcessor.processVideo(uploadId, tempFilePath, originalName, videoId)
              .then((result) => {
                console.log(`✅ FormData processing finished for ${uploadId}`);
                resolve(result);
              })
              .catch((error) => {
                console.error(`❌ FormData processing failed: ${error.message}`);
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
          console.log(`✅ Busboy finished successfully, waiting for processing...`);
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
      
      console.log(`⏳ Waiting for FormData upload and processing...`);
      
    } catch (setupError) {
      console.error(`❌ Setup error: ${setupError.message}`);
      reject(setupError);
    }
  });
}

module.exports = {
  handleFormDataUpload
};