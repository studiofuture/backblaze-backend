const B2 = require('backblaze-b2');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const { config } = require('../config');
const logger = require('../utils/logger');
const { updateUploadStatus } = require('../utils/status');
const memoryMonitor = require('../utils/memory-monitor');

// Initialize Backblaze B2 client
const b2 = new B2({
  applicationKeyId: config.b2.accountId,
  applicationKey: config.b2.applicationKey,
});

/**
 * OPTIMIZED: Upload file with minimal memory usage (25MB chunks max)
 */
async function uploadFileOptimized(file, uploadId, options = {}) {
  const {
    deleteFile = true,
    bucketId = config.b2.buckets.video.id,
    bucketName = config.b2.buckets.video.name,
    contentType = 'video/mp4'
  } = options;
  
  let fileHandle = null;
  
  try {
    // Authorize B2
    await b2.authorize();
    
    const fileStats = await fs.stat(file.path);
    const fileSize = fileStats.size;
    
    // OPTIMIZED: Use smaller chunks (25MB) for better memory management
    const chunkSize = 25 * 1024 * 1024; // 25MB chunks
    
    logger.info(`Ã°Å¸â€œÅ’ Starting optimized upload: ${file.originalname} (${Math.round(fileSize / 1024 / 1024)}MB)`);
    memoryMonitor.logMemoryUsage(`Before B2 upload ${uploadId}`);
    
    updateUploadStatus(uploadId, { 
      stage: 'initializing B2 upload',
      progress: 85 
    });
    
    // Calculate final URL
    const fileUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${file.originalname}`;
    
    // Open file handle for reading
    fileHandle = await fs.open(file.path, 'r');
    
    if (fileSize > chunkSize) {
      // Large file upload with optimized chunking
      logger.info(`Ã°Å¸â€œÅ’ Large file detected. Using chunked upload with ${Math.round(chunkSize / 1024 / 1024)}MB chunks`);
      
      const startFileResponse = await b2.startLargeFile({
        bucketId: bucketId,
        fileName: file.originalname,
        contentType: contentType,
      });
      
      const fileId = startFileResponse.data.fileId;
      const totalParts = Math.ceil(fileSize / chunkSize);
      let partSha1Array = [];
      
      logger.info(`Ã°Å¸â€œÅ’ Uploading ${totalParts} parts of ~${Math.round(chunkSize / 1024 / 1024)}MB each`);
      
      // Process chunks sequentially to minimize memory usage
      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        const start = (partNumber - 1) * chunkSize;
        const end = Math.min(partNumber * chunkSize, fileSize);
        const currentChunkSize = end - start;
        
        // CRITICAL: Read only this chunk into memory
        const buffer = Buffer.alloc(currentChunkSize);
        const { bytesRead } = await fileHandle.read(buffer, 0, currentChunkSize, start);
        
        if (bytesRead !== currentChunkSize) {
          throw new Error(`Read ${bytesRead} bytes but expected ${currentChunkSize}`);
        }
        
        // Calculate SHA-1 for this chunk
        const sha1Hash = crypto.createHash('sha1').update(buffer).digest('hex');
        
        // Upload this chunk with retry logic
        logger.debug(`Ã°Å¸â€œÅ’ Uploading part ${partNumber}/${totalParts} (${Math.round(currentChunkSize / 1024 / 1024)}MB)`);
        
        await uploadChunkWithRetry(fileId, partNumber, buffer, uploadId);
        
        // Store hash
        partSha1Array.push(sha1Hash);
        
        // CRITICAL: Clear buffer to free memory immediately
        buffer.fill(0);
        
        // Force garbage collection if available
        if (global.gc) {
          global.gc();
        }
        
        // Update progress
        const progressPercent = Math.min(97, 85 + Math.floor((partNumber / totalParts) * 12));
        updateUploadStatus(uploadId, {
          progress: progressPercent,
          stage: `uploaded part ${partNumber}/${totalParts}`
        });
        
        // Log memory usage every 10 parts
        if (partNumber % 10 === 0) {
          memoryMonitor.logMemoryUsage(`B2 upload part ${partNumber}/${totalParts}`);
        }
      }
      
      // Finalize the large file upload
      logger.info(`Ã°Å¸â€œÅ’ Finalizing large file upload with ${partSha1Array.length} parts`);
      updateUploadStatus(uploadId, { 
        progress: 98,
        stage: 'finalizing B2 upload' 
      });
      
      await b2.finishLargeFile({ fileId, partSha1Array });
      
    } else {
      // Small file upload (< 25MB)
      logger.info(`Ã°Å¸â€œÅ’ Small file detected (${Math.round(fileSize / 1024 / 1024)}MB). Using direct upload`);
      
      updateUploadStatus(uploadId, { 
        progress: 90,
        stage: 'uploading small file directly' 
      });
      
      // Get upload URL
      const uploadUrlData = await b2.getUploadUrl({ bucketId: bucketId });
      
      // Read entire file for small files (acceptable for <25MB)
      const fileData = await fs.readFile(file.path);
      
      // Upload file
      await b2.uploadFile({
        uploadUrl: uploadUrlData.data.uploadUrl,
        uploadAuthToken: uploadUrlData.data.authorizationToken,
        fileName: file.originalname,
        data: fileData,
        contentType: contentType,
      });
      
      logger.info(`Ã¢Å“â€¦ Small file upload complete`);
    }
    
    // Close file handle
    if (fileHandle) {
      await fileHandle.close();
      fileHandle = null;
    }
    
    // Clean up temp file immediately if requested
    if (deleteFile && fsSync.existsSync(file.path)) {
      await fs.unlink(file.path);
      logger.info(`Ã°Å¸Â§Â¹ Cleaned up temp file: ${file.path}`);
    }
    
    memoryMonitor.logMemoryUsage(`After B2 upload ${uploadId}`);
    logger.info(`Ã¢Å“â€¦ B2 upload completed: ${fileUrl}`);
    
    return fileUrl;
    
  } catch (error) {
    logger.error(`Ã¢ÂÅ’ B2 upload failed for ${uploadId}:`, error);
    
    // Clean up file handle
    if (fileHandle) {
      try {
        await fileHandle.close();
      } catch (closeError) {
        logger.error(`Ã¢ÂÅ’ Error closing file handle:`, closeError);
      }
    }
    
    // Clean up temp file on error
    if (deleteFile && fsSync.existsSync(file.path)) {
      try {
        await fs.unlink(file.path);
        logger.info(`Ã°Å¸Â§Â¹ Cleaned up temp file after error: ${file.path}`);
      } catch (cleanupError) {
        logger.error(`Ã¢ÂÅ’ Failed to clean up temp file:`, cleanupError);
      }
    }
    
    throw error;
  }
}

/**
 * Upload a single chunk with retry logic and minimal memory usage
 */
async function uploadChunkWithRetry(fileId, partNumber, buffer, uploadId, maxRetries = 3) {
  let attempts = 0;
  
  while (attempts < maxRetries) {
    try {
      // Get upload URL for this part
      const uploadPartUrl = await b2.getUploadPartUrl({ fileId });
      
      // Upload the part
      const response = await b2.uploadPart({
        partNumber,
        uploadUrl: uploadPartUrl.data.uploadUrl,
        uploadAuthToken: uploadPartUrl.data.authorizationToken,
        data: buffer,
      });
      
      logger.debug(`Ã¢Å“â€¦ Uploaded part ${partNumber} successfully`);
      return response;
      
    } catch (error) {
      attempts++;
      logger.warn(`Ã¢Å¡Â Ã¯Â¸Â Failed to upload part ${partNumber} (attempt ${attempts}/${maxRetries}):`, error.message);
      
      if (attempts >= maxRetries) {
        logger.error(`Ã¢ÂÅ’ Part ${partNumber} failed after ${maxRetries} attempts`);
        throw error;
      }
      
      // Exponential backoff
      const backoffMs = 1000 * Math.pow(2, attempts);
      logger.info(`Ã¢ÂÂ³ Retrying part ${partNumber} in ${backoffMs/1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}

/**
 * OPTIMIZED: Upload thumbnail with immediate cleanup
 */
async function uploadThumbnail(filePath, fileName) {
  try {
    await b2.authorize();
    
    const bucketId = config.b2.buckets.thumbnail.id;
    const bucketName = config.b2.buckets.thumbnail.name;
    
    if (!fsSync.existsSync(filePath)) {
      throw new Error(`Thumbnail file not found at: ${filePath}`);
    }
    
    logger.info(`Ã°Å¸â€“Â¼Ã¯Â¸Â Uploading thumbnail: ${fileName}`);
    
    // Get upload URL
    const uploadUrlData = await b2.getUploadUrl({ bucketId });
    
    // Read thumbnail file (small, usually <1MB)
    const fileData = await fs.readFile(filePath);
    
    // Upload thumbnail
    await b2.uploadFile({
      uploadUrl: uploadUrlData.data.uploadUrl,
      uploadAuthToken: uploadUrlData.data.authorizationToken,
      fileName: fileName,
      data: fileData,
      contentType: "image/jpeg",
    });
    
    // Construct thumbnail URL
    const thumbnailUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${fileName}`;
    
    logger.info(`Ã¢Å“â€¦ Thumbnail uploaded: ${thumbnailUrl}`);
    return thumbnailUrl;
    
  } catch (error) {
    logger.error(`Ã¢ÂÅ’ Thumbnail upload failed:`, error);
    throw error;
  }
}

/**
 * Upload subtitle file to B2 (VTT format)
 */
async function uploadSubtitle(filePath, fileName) {
  try {
    await b2.authorize();
    
    const bucketId = config.b2.buckets.subtitle.id;
    const bucketName = config.b2.buckets.subtitle.name;
    
    if (!fsSync.existsSync(filePath)) {
      throw new Error(`Subtitle file not found at: ${filePath}`);
    }
    
    logger.info(`ðŸ“„ Uploading subtitle: ${fileName}`);
    
    // Get upload URL
    const uploadUrlData = await b2.getUploadUrl({ bucketId });
    
    // Read subtitle file (small text file, usually <1MB)
    const fileData = await fs.readFile(filePath);
    
    // Upload subtitle
    await b2.uploadFile({
      uploadUrl: uploadUrlData.data.uploadUrl,
      uploadAuthToken: uploadUrlData.data.authorizationToken,
      fileName: fileName,
      data: fileData,
      contentType: "text/vtt",
    });
    
    // Construct subtitle URL
    const subtitleUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${fileName}`;
    
    logger.info(`âœ… Subtitle uploaded: ${subtitleUrl}`);
    return subtitleUrl;
    
  } catch (error) {
    logger.error(`âŒ Subtitle upload failed:`, error);
    throw error;
  }
}

/**
 * Upload frame image to B2 (JPEG format)
 */
async function uploadFrame(filePath, fileName) {
  try {
    await b2.authorize();
    
    const bucketId = config.b2.buckets.frame.id;
    const bucketName = config.b2.buckets.frame.name;
    
    if (!fsSync.existsSync(filePath)) {
      throw new Error(`Frame file not found at: ${filePath}`);
    }
    
    logger.info(`ðŸ–¼ï¸ Uploading frame: ${fileName}`);
    
    // Get upload URL
    const uploadUrlData = await b2.getUploadUrl({ bucketId });
    
    // Read frame file (small image, usually 1-5MB)
    const fileData = await fs.readFile(filePath);
    
    // Upload frame
    await b2.uploadFile({
      uploadUrl: uploadUrlData.data.uploadUrl,
      uploadAuthToken: uploadUrlData.data.authorizationToken,
      fileName: fileName,
      data: fileData,
      contentType: "image/jpeg",
    });
    
    // Construct frame URL
    const frameUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${fileName}`;
    
    logger.info(`âœ… Frame uploaded: ${frameUrl}`);
    return frameUrl;
    
  } catch (error) {
    logger.error(`âŒ Frame upload failed:`, error);
    throw error;
  }
}

/**
 * Delete a file from B2 with improved error handling
 */
async function deleteFile(fileName, bucketId = config.b2.buckets.video.id) {
  try {
    await b2.authorize();
    
    logger.info(`Ã°Å¸â€”â€˜Ã¯Â¸Â Searching for file to delete: ${fileName}`);
    
    // Find the file
    const listFilesResponse = await b2.listFileNames({
      bucketId: bucketId,
      prefix: fileName,
      maxFileCount: 10
    });
    
    const file = listFilesResponse.data.files.find(f => f.fileName === fileName);
    
    if (!file) {
      logger.warn(`Ã¢Å¡Â Ã¯Â¸Â File not found for deletion: ${fileName}`);
      return false;
    }
    
    // Delete the file
    await b2.deleteFileVersion({
      fileId: file.fileId,
      fileName: file.fileName
    });
    
    logger.info(`Ã¢Å“â€¦ Successfully deleted: ${fileName}`);
    return true;
    
  } catch (error) {
    logger.error(`Ã¢ÂÅ’ Delete failed for ${fileName}:`, error);
    throw error;
  }
}

/**
 * Test B2 connection
 */
async function testConnection() {
  try {
    await b2.authorize();
    logger.info('Ã¢Å“â€¦ B2 connection successful');
    return true;
  } catch (error) {
    logger.error('Ã¢ÂÅ’ B2 connection failed:', error);
    throw error;
  }
}

module.exports = {
  uploadFileOptimized,
  uploadFile: uploadFileOptimized, // Alias for backward compatibility
  uploadThumbnail,
  uploadSubtitle,
  uploadFrame,
  deleteFile,
  testConnection
};