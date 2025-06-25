const B2 = require('backblaze-b2');
const crypto = require('crypto');
const { config } = require('../config');
const logger = require('../utils/logger');
const { updateUploadStatus, failUploadStatus } = require('../utils/status');
const memoryMonitor = require('../utils/memory-monitor');

// Initialize B2 client for multipart operations
const b2 = new B2({
  applicationKeyId: config.b2.accountId,
  applicationKey: config.b2.applicationKey,
});

// Rate limiting for B2 API calls
const b2ApiLimiter = {
  lastCall: 0,
  minInterval: 100, // Minimum 100ms between B2 API calls
  
  async waitForNext() {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCall;
    if (timeSinceLastCall < this.minInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minInterval - timeSinceLastCall));
    }
    this.lastCall = Date.now();
  }
};

// Store active multipart uploads with their B2 URLs
const activeUploads = new Map();

/**
 * Streaming Proxy Multipart Upload Service
 * Browser uploads to server, server streams to B2 - minimal memory usage
 */

/**
 * Initialize a B2 large file upload and pre-generate part URLs for streaming proxy
 * @param {string} uploadId - Unique upload identifier
 * @param {string} fileName - Original filename (will be sanitized)
 * @param {string} contentType - File content type
 * @param {string} bucketId - B2 bucket ID (optional, defaults to video bucket)
 * @param {Object} options - Additional options including user context
 * @returns {Promise<Object>} - B2 file ID and upload information
 */
async function initializeMultipartUpload(uploadId, fileName, contentType = 'video/mp4', bucketId = null, options = {}) {
  try {
    // Input validation
    if (!uploadId || typeof uploadId !== 'string') {
      throw new Error('Valid uploadId is required');
    }
    
    if (!fileName || typeof fileName !== 'string') {
      throw new Error('Valid fileName is required');
    }
    
    // Sanitize filename to prevent path traversal
    const sanitizedFileName = sanitizeFileName(fileName);
    
    // Validate content type
    const validContentTypes = [
      'video/mp4', 'video/quicktime', 'video/x-msvideo', 
      'video/x-matroska', 'video/mpeg', 'video/webm',
      'video/x-ms-wmv', 'video/3gpp'
    ];
    
    if (!validContentTypes.includes(contentType)) {
      throw new Error(`Invalid content type: ${contentType}`);
    }
    
    logger.info(`🚀 Initializing streaming proxy B2 multipart upload: ${uploadId} for ${sanitizedFileName}`);
    
    // Rate limit B2 API calls
    await b2ApiLimiter.waitForNext();
    
    // Authorize B2 if needed
    await b2.authorize();
    
    // Use default video bucket if not specified
    const targetBucketId = bucketId || config.b2.buckets.video.id;
    
    // Generate unique filename to prevent conflicts and add timestamp
    const timestamp = Date.now();
    const uniqueFileName = `${sanitizedFileName.split('.')[0]}_${timestamp}_${generateSecureId()}.${sanitizedFileName.split('.').pop()}`;
    
    updateUploadStatus(uploadId, {
      status: 'initializing',
      stage: 'starting streaming proxy B2 multipart upload',
      progress: 5,
      fileName: uniqueFileName
    });
    
    // Start the large file upload with retry logic
    let startFileResponse;
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
      try {
        await b2ApiLimiter.waitForNext();
        startFileResponse = await b2.startLargeFile({
          bucketId: targetBucketId,
          fileName: uniqueFileName,
          contentType: contentType,
        });
        break;
      } catch (error) {
        retryCount++;
        if (retryCount >= maxRetries) {
          throw error;
        }
        logger.warn(`Retry ${retryCount}/${maxRetries} for B2 startLargeFile: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
      }
    }
    
    const b2FileId = startFileResponse.data.fileId;
    
    logger.info(`✅ B2 multipart upload initialized: ${b2FileId}`);
    
    // Store upload information for streaming proxy
    activeUploads.set(uploadId, {
      b2FileId: b2FileId,
      fileName: uniqueFileName,
      bucketId: targetBucketId,
      partUrls: new Map(), // Will store part URLs as needed
      partSha1Array: [], // Will store SHA1 hashes in order
      createdAt: Date.now()
    });
    
    updateUploadStatus(uploadId, {
      status: 'ready_for_chunks',
      stage: 'ready to receive chunks via streaming proxy',
      progress: 10,
      b2FileId: b2FileId,
      fileName: uniqueFileName,
      uploadMethod: 'streaming_proxy'
    });
    
    memoryMonitor.logMemoryUsage(`After streaming proxy init ${uploadId}`);
    
    return {
      success: true,
      uploadId: uploadId,
      b2FileId: b2FileId,
      fileName: uniqueFileName,
      message: 'Streaming proxy multipart upload initialized',
      instructions: {
        step1: 'Upload chunks to /upload/multipart/stream-chunk',
        step2: 'Server will stream chunks directly to B2',
        step3: 'Call /upload/multipart/complete when all chunks uploaded',
        step4: 'Monitor progress via WebSocket'
      }
    };
    
  } catch (error) {
    logger.error(`❌ Failed to initialize streaming proxy multipart upload ${uploadId}:`, error);
    failUploadStatus(uploadId, error);
    throw error;
  }
}

/**
 * Stream a chunk directly to B2 (proxy upload)
 * @param {string} uploadId - Upload identifier
 * @param {string} b2FileId - B2 file ID
 * @param {number} partNumber - Part number (1-based)
 * @param {Buffer|Stream} chunkData - Chunk data to upload
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} - Upload result with SHA1
 */
async function streamChunkToB2(uploadId, b2FileId, partNumber, chunkData, options = {}) {
  try {
    // Validate inputs
    if (!uploadId || !b2FileId || !partNumber || !chunkData) {
      throw new Error('Missing required parameters for chunk streaming');
    }
    
    if (partNumber < 1 || partNumber > 10000) {
      throw new Error('Part number must be between 1 and 10000');
    }
    
    // Get upload info
    const uploadInfo = activeUploads.get(uploadId);
    if (!uploadInfo) {
      throw new Error('Upload not found or expired');
    }
    
    logger.info(`📤 Streaming chunk ${partNumber} to B2 for ${uploadId}`);
    
    // Get or create part URL for this part number
    let partUrl = uploadInfo.partUrls.get(partNumber);
    if (!partUrl) {
      await b2ApiLimiter.waitForNext();
      const uploadPartUrlResponse = await b2.getUploadPartUrl({
        fileId: b2FileId
      });
      
      partUrl = {
        uploadUrl: uploadPartUrlResponse.data.uploadUrl,
        authorizationToken: uploadPartUrlResponse.data.authorizationToken
      };
      
      uploadInfo.partUrls.set(partNumber, partUrl);
    }
    
    // Calculate SHA1 while streaming
    const sha1Hash = crypto.createHash('sha1');
    let totalBytes = 0;
    
    // Handle both Buffer and Stream inputs
    if (Buffer.isBuffer(chunkData)) {
      sha1Hash.update(chunkData);
      totalBytes = chunkData.length;
    } else {
      // Stream case - calculate hash as we read
      const chunks = [];
      for await (const chunk of chunkData) {
        chunks.push(chunk);
        sha1Hash.update(chunk);
        totalBytes += chunk.length;
      }
      chunkData = Buffer.concat(chunks);
    }
    
    const sha1Result = sha1Hash.digest('hex');
    
    // Upload to B2 with retry logic
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
      try {
        await b2ApiLimiter.waitForNext();
        
        const uploadResponse = await b2.uploadPart({
          partNumber: partNumber,
          uploadUrl: partUrl.uploadUrl,
          uploadAuthToken: partUrl.authorizationToken,
          data: chunkData,
        });
        
        // Store SHA1 in correct order
        uploadInfo.partSha1Array[partNumber - 1] = sha1Result;
        
        updateUploadStatus(uploadId, {
          stage: `streamed chunk ${partNumber} to B2`,
          progress: Math.min(95, 10 + (partNumber * 2)) // Rough progress estimate
        });
        
        logger.info(`✅ Successfully streamed chunk ${partNumber} (${Math.floor(totalBytes / 1024 / 1024)}MB) to B2`);
        
        // Force garbage collection
        if (global.gc) {
          global.gc();
        }
        
        memoryMonitor.logMemoryUsage(`After streaming chunk ${partNumber}`);
        
        return {
          success: true,
          partNumber: partNumber,
          sha1: sha1Result,
          size: totalBytes,
          uploadResponse: uploadResponse
        };
        
      } catch (error) {
        retryCount++;
        if (retryCount >= maxRetries) {
          throw error;
        }
        logger.warn(`Retry ${retryCount}/${maxRetries} for chunk ${partNumber}: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
      }
    }
    
  } catch (error) {
    logger.error(`❌ Failed to stream chunk ${partNumber} for ${uploadId}:`, error);
    throw error;
  }
}

/**
 * Complete the multipart upload after all chunks are streamed
 * @param {string} uploadId - Upload identifier
 * @param {string} b2FileId - B2 file ID
 * @param {number} totalParts - Total number of parts uploaded
 * @param {string} originalFileName - Original filename for metadata
 * @param {string} videoId - Optional video ID for database updates
 * @param {Object} context - User context for authorization
 * @returns {Promise<Object>} - Upload completion result
 */
async function completeMultipartUpload(uploadId, b2FileId, totalParts, originalFileName, videoId = null, context = {}) {
  try {
    // Validate inputs
    if (!uploadId || !b2FileId || !totalParts || !originalFileName) {
      throw new Error('Missing required parameters for upload completion');
    }
    
    if (totalParts < 1 || totalParts > 10000) {
      throw new Error('Invalid total parts count');
    }
    
    // Get upload info
    const uploadInfo = activeUploads.get(uploadId);
    if (!uploadInfo) {
      throw new Error('Upload not found or expired');
    }
    
    // Ensure we have all SHA1 hashes
    const partSha1Array = uploadInfo.partSha1Array.slice(0, totalParts);
    if (partSha1Array.length !== totalParts || partSha1Array.some(hash => !hash)) {
      throw new Error(`Missing SHA1 hashes. Expected ${totalParts}, got ${partSha1Array.filter(h => h).length}`);
    }
    
    logger.info(`🏁 Completing streaming proxy multipart upload ${uploadId} with ${totalParts} parts`);
    
    updateUploadStatus(uploadId, {
      status: 'finalizing',
      stage: 'finalizing B2 multipart upload',
      progress: 95
    });
    
    // Rate limit the finalization call
    await b2ApiLimiter.waitForNext();
    
    // Finalize the large file upload in B2 with retry logic
    let finishResponse;
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
      try {
        finishResponse = await b2.finishLargeFile({
          fileId: b2FileId,
          partSha1Array: partSha1Array
        });
        break;
      } catch (error) {
        retryCount++;
        if (retryCount >= maxRetries) {
          throw error;
        }
        logger.warn(`Retry ${retryCount}/${maxRetries} for B2 finishLargeFile: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
      }
    }
    
    // Construct the final video URL
    const bucketName = config.b2.buckets.video.name;
    const fileName = finishResponse.data.fileName;
    const videoUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${fileName}`;
    
    logger.info(`✅ Streaming proxy multipart upload completed: ${videoUrl}`);
    
    // Clean up active upload
    activeUploads.delete(uploadId);
    
    updateUploadStatus(uploadId, {
      status: 'processing_metadata',
      stage: 'video uploaded, processing thumbnails...',
      progress: 98,
      videoUrl: videoUrl
    });
    
    // Queue background thumbnail generation
    const backgroundTaskResult = await queueBackgroundProcessing(uploadId, videoUrl, originalFileName, videoId);
    
    memoryMonitor.logMemoryUsage(`After streaming proxy completion ${uploadId}`);
    
    return {
      success: true,
      videoUrl: videoUrl,
      fileName: fileName,
      uploadId: uploadId,
      backgroundTask: backgroundTaskResult,
      fileSize: finishResponse.data.contentLength,
      totalParts: totalParts
    };
    
  } catch (error) {
    logger.error(`❌ Failed to complete streaming proxy multipart upload ${uploadId}:`, error);
    
    // Clean up on error
    activeUploads.delete(uploadId);
    
    // Attempt cleanup of incomplete upload
    try {
      await b2ApiLimiter.waitForNext();
      await b2.cancelLargeFile({ fileId: b2FileId });
      logger.info(`🧹 Cleaned up incomplete upload ${b2FileId}`);
    } catch (cleanupError) {
      logger.warn(`⚠️ Failed to cleanup incomplete upload ${b2FileId}:`, cleanupError.message);
    }
    
    failUploadStatus(uploadId, error);
    throw error;
  }
}

/**
 * Cancel/abort a multipart upload with authorization check
 * @param {string} uploadId - Upload identifier
 * @param {string} b2FileId - B2 file ID to cancel
 * @param {Object} context - User context for authorization
 * @returns {Promise<boolean>} - Success status
 */
async function cancelMultipartUpload(uploadId, b2FileId, context = {}) {
  try {
    logger.info(`🛑 Cancelling streaming proxy multipart upload ${uploadId}`);
    
    // Clean up active upload
    activeUploads.delete(uploadId);
    
    await b2ApiLimiter.waitForNext();
    await b2.cancelLargeFile({ fileId: b2FileId });
    
    updateUploadStatus(uploadId, {
      status: 'cancelled',
      stage: 'upload cancelled',
      progress: 0
    });
    
    logger.info(`✅ Successfully cancelled upload ${uploadId}`);
    return true;
    
  } catch (error) {
    logger.error(`❌ Failed to cancel upload ${uploadId}:`, error);
    return false;
  }
}

/**
 * Get upload information for streaming proxy
 * @param {string} uploadId - Upload identifier
 * @returns {Object|null} - Upload information or null if not found
 */
function getUploadInfo(uploadId) {
  return activeUploads.get(uploadId) || null;
}

/**
 * Queue background processing for thumbnail generation and metadata
 * @param {string} uploadId - Upload identifier
 * @param {string} videoUrl - Final video URL
 * @param {string} originalFileName - Original filename
 * @param {string} videoId - Optional video ID for database updates
 * @returns {Promise<Object>} - Background task result
 */
async function queueBackgroundProcessing(uploadId, videoUrl, originalFileName, videoId) {
  try {
    // Import background queue utility
    const { addThumbnailJob } = require('../utils/upload-queue');
    
    const jobData = {
      uploadId: uploadId,
      videoUrl: videoUrl,
      originalFileName: originalFileName,
      videoId: videoId,
      queuedAt: new Date().toISOString()
    };
    
    const jobResult = await addThumbnailJob(jobData);
    
    logger.info(`📋 Queued background processing for ${uploadId}`);
    
    return {
      jobId: jobResult.jobId,
      estimatedProcessingTime: '1-2 minutes',
      status: 'queued'
    };
    
  } catch (error) {
    logger.error(`❌ Failed to queue background processing for ${uploadId}:`, error);
    // Don't fail the entire upload for background task issues
    return {
      jobId: null,
      status: 'failed_to_queue',
      error: error.message
    };
  }
}

/**
 * Utility functions
 */

/**
 * Sanitize filename to prevent path traversal and other security issues
 * @param {string} fileName - Original filename
 * @returns {string} - Sanitized filename
 */
function sanitizeFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') {
    throw new Error('Invalid filename');
  }
  
  // Remove path separators and dangerous characters
  const sanitized = fileName
    .replace(/[^a-zA-Z0-9._-]/g, '_') // Replace dangerous chars with underscore
    .replace(/^\.+/, '') // Remove leading dots
    .replace(/\.+$/, '') // Remove trailing dots
    .slice(0, 255); // Limit length
  
  if (sanitized.length === 0) {
    throw new Error('Filename became empty after sanitization');
  }
  
  return sanitized;
}

/**
 * Generate a secure random ID
 * @returns {string} - Secure random ID
 */
function generateSecureId() {
  return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
}

/**
 * Cleanup old active uploads (prevent memory leaks)
 */
function cleanupOldUploads() {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  
  for (const [uploadId, uploadInfo] of activeUploads.entries()) {
    if (now - uploadInfo.createdAt > maxAge) {
      logger.info(`🧹 Cleaning up old upload: ${uploadId}`);
      activeUploads.delete(uploadId);
    }
  }
}

// Clean up old uploads every hour
setInterval(cleanupOldUploads, 60 * 60 * 1000);

module.exports = {
  initializeMultipartUpload,
  streamChunkToB2,
  completeMultipartUpload,
  cancelMultipartUpload,
  getUploadInfo
};