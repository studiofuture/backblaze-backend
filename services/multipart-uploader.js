const B2 = require('backblaze-b2');
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

/**
 * Secure Multipart Upload Service
 * Handles direct B2 multipart uploads with proper validation and rate limiting
 */

/**
 * Initialize a B2 large file upload with validation
 * @param {string} uploadId - Unique upload identifier
 * @param {string} fileName - Original filename (will be sanitized)
 * @param {string} contentType - File content type
 * @param {string} bucketId - B2 bucket ID (optional, defaults to video bucket)
 * @param {Object} options - Additional options including user context
 * @returns {Promise<Object>} - B2 file ID and initial part URLs
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
    
    logger.info(`🚀 Initializing secure B2 multipart upload: ${uploadId} for ${sanitizedFileName}`);
    
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
      stage: 'starting secure B2 multipart upload',
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
    
    updateUploadStatus(uploadId, {
      status: 'ready_for_chunks',
      stage: 'ready to receive chunks',
      progress: 10,
      b2FileId: b2FileId,
      fileName: uniqueFileName
    });
    
    // Pre-generate part URLs for first few chunks (with rate limiting)
    const initialPartUrls = await generatePartUrls(b2FileId, 1, 5);
    
    memoryMonitor.logMemoryUsage(`After multipart init ${uploadId}`);
    
    return {
      success: true,
      b2FileId: b2FileId,
      fileName: uniqueFileName,
      partUrls: initialPartUrls,
      uploadId: uploadId,
      expiresAt: Date.now() + (23 * 60 * 60 * 1000) // 23 hours
    };
    
  } catch (error) {
    logger.error(`❌ Failed to initialize multipart upload ${uploadId}:`, error);
    failUploadStatus(uploadId, error);
    throw error;
  }
}

/**
 * Generate signed URLs for uploading specific parts with security checks
 * @param {string} b2FileId - B2 file ID from initialization
 * @param {number} startPartNumber - Starting part number (1-based)
 * @param {number} count - Number of part URLs to generate
 * @returns {Promise<Array>} - Array of part upload URLs
 */
async function generatePartUrls(b2FileId, startPartNumber = 1, count = 10) {
  try {
    // Validate inputs
    if (!b2FileId || typeof b2FileId !== 'string') {
      throw new Error('Valid b2FileId is required');
    }
    
    if (startPartNumber < 1 || startPartNumber > 10000) {
      throw new Error('Part number must be between 1 and 10000');
    }
    
    if (count < 1 || count > 100) {
      throw new Error('Count must be between 1 and 100');
    }
    
    logger.debug(`🔗 Generating ${count} secure part URLs starting from part ${startPartNumber}`);
    
    const partUrls = [];
    
    // Generate URLs for requested parts with rate limiting
    for (let i = 0; i < count; i++) {
      const partNumber = startPartNumber + i;
      
      // Prevent generating too many parts
      if (partNumber > 10000) {
        logger.warn(`Stopping part URL generation at part ${partNumber} (B2 limit: 10000)`);
        break;
      }
      
      await b2ApiLimiter.waitForNext();
      
      const uploadPartResponse = await b2.getUploadPartUrl({
        fileId: b2FileId
      });
      
      partUrls.push({
        partNumber: partNumber,
        uploadUrl: uploadPartResponse.data.uploadUrl,
        authorizationToken: uploadPartResponse.data.authorizationToken,
        expiresAt: Date.now() + (23 * 60 * 60 * 1000), // 23 hours (B2 URLs valid for 24h)
        generatedAt: Date.now()
      });
    }
    
    logger.debug(`✅ Generated ${partUrls.length} secure part URLs`);
    return partUrls;
    
  } catch (error) {
    logger.error(`❌ Failed to generate part URLs for ${b2FileId}:`, error);
    throw error;
  }
}

/**
 * Get additional part URLs if needed (for URL expiration or additional chunks)
 * @param {string} uploadId - Upload identifier
 * @param {string} b2FileId - B2 file ID
 * @param {number} fromPartNumber - Starting part number
 * @param {number} count - Number of URLs needed
 * @param {Object} context - User context for authorization
 * @returns {Promise<Array>} - Array of fresh part upload URLs
 */
async function getAdditionalPartUrls(uploadId, b2FileId, fromPartNumber, count = 10, context = {}) {
  try {
    // Validate that this upload belongs to the requesting user (if context provided)
    if (context.userId) {
      const { getUploadStatus } = require('../utils/status');
      const uploadStatus = getUploadStatus(uploadId);
      
      if (uploadStatus && uploadStatus.userId && uploadStatus.userId !== context.userId) {
        throw new Error('Unauthorized: Upload does not belong to user');
      }
    }
    
    logger.info(`🔄 Getting additional part URLs for ${uploadId}, parts ${fromPartNumber}-${fromPartNumber + count - 1}`);
    
    updateUploadStatus(uploadId, {
      stage: `generating upload URLs for parts ${fromPartNumber}-${fromPartNumber + count - 1}`
    });
    
    const partUrls = await generatePartUrls(b2FileId, fromPartNumber, count);
    
    return {
      success: true,
      partUrls: partUrls,
      uploadId: uploadId
    };
    
  } catch (error) {
    logger.error(`❌ Failed to get additional part URLs for ${uploadId}:`, error);
    throw error;
  }
}

/**
 * Complete the multipart upload after all parts are uploaded with validation
 * @param {string} uploadId - Upload identifier
 * @param {string} b2FileId - B2 file ID
 * @param {Array} partSha1Array - Array of SHA1 hashes for each part
 * @param {string} originalFileName - Original filename for metadata
 * @param {string} videoId - Optional video ID for database updates
 * @param {Object} context - User context for authorization
 * @returns {Promise<Object>} - Upload completion result
 */
async function completeMultipartUpload(uploadId, b2FileId, partSha1Array, originalFileName, videoId = null, context = {}) {
  try {
    // Validate inputs
    if (!uploadId || !b2FileId || !Array.isArray(partSha1Array) || !originalFileName) {
      throw new Error('Missing required parameters for upload completion');
    }
    
    if (partSha1Array.length === 0) {
      throw new Error('No parts provided for upload completion');
    }
    
    if (partSha1Array.length > 10000) {
      throw new Error('Too many parts (B2 limit: 10000)');
    }
    
    // Validate SHA1 format
    const sha1Regex = /^[a-f0-9]{40}$/i;
    for (let i = 0; i < partSha1Array.length; i++) {
      if (!sha1Regex.test(partSha1Array[i])) {
        throw new Error(`Invalid SHA1 hash at index ${i}: ${partSha1Array[i]}`);
      }
    }
    
    // Validate authorization if context provided
    if (context.userId) {
      const { getUploadStatus } = require('../utils/status');
      const uploadStatus = getUploadStatus(uploadId);
      
      if (uploadStatus && uploadStatus.userId && uploadStatus.userId !== context.userId) {
        throw new Error('Unauthorized: Upload does not belong to user');
      }
    }
    
    logger.info(`🏁 Completing multipart upload ${uploadId} with ${partSha1Array.length} parts`);
    
    updateUploadStatus(uploadId, {
      status: 'finalizing',
      stage: 'finalizing B2 multipart upload',
      progress: 90
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
    
    logger.info(`✅ Multipart upload completed: ${videoUrl}`);
    
    updateUploadStatus(uploadId, {
      status: 'processing_metadata',
      stage: 'video uploaded, processing thumbnails...',
      progress: 95,
      videoUrl: videoUrl
    });
    
    // Queue background thumbnail generation
    const backgroundTaskResult = await queueBackgroundProcessing(uploadId, videoUrl, originalFileName, videoId);
    
    memoryMonitor.logMemoryUsage(`After multipart completion ${uploadId}`);
    
    return {
      success: true,
      videoUrl: videoUrl,
      fileName: fileName,
      uploadId: uploadId,
      backgroundTask: backgroundTaskResult,
      fileSize: finishResponse.data.contentLength
    };
    
  } catch (error) {
    logger.error(`❌ Failed to complete multipart upload ${uploadId}:`, error);
    
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
    // Validate authorization if context provided
    if (context.userId) {
      const { getUploadStatus } = require('../utils/status');
      const uploadStatus = getUploadStatus(uploadId);
      
      if (uploadStatus && uploadStatus.userId && uploadStatus.userId !== context.userId) {
        throw new Error('Unauthorized: Upload does not belong to user');
      }
    }
    
    logger.info(`🛑 Cancelling multipart upload ${uploadId}`);
    
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
 * Get multipart upload status and progress with authorization
 * @param {string} uploadId - Upload identifier
 * @param {string} b2FileId - B2 file ID
 * @param {Object} context - User context for authorization
 * @returns {Promise<Object>} - Upload status information
 */
async function getMultipartUploadStatus(uploadId, b2FileId, context = {}) {
  try {
    // Get current status from status utility
    const { getUploadStatus } = require('../utils/status');
    const currentStatus = getUploadStatus(uploadId);
    
    if (!currentStatus) {
      return {
        found: false,
        message: 'Upload not found or expired'
      };
    }
    
    // Validate authorization if context provided
    if (context.userId && currentStatus.userId && currentStatus.userId !== context.userId) {
      return {
        found: false,
        message: 'Upload not found or expired' // Don't reveal unauthorized access
      };
    }
    
    // Enhance with B2-specific information if available
    const enhanced = {
      ...currentStatus,
      b2FileId: b2FileId,
      multipartUpload: true,
      lastChecked: new Date().toISOString(),
      // Remove sensitive information
      authorizationToken: undefined
    };
    
    return enhanced;
    
  } catch (error) {
    logger.error(`❌ Failed to get multipart upload status for ${uploadId}:`, error);
    throw error;
  }
}

/**
 * Test B2 multipart upload capability
 * @returns {Promise<boolean>} - Success status
 */
async function testMultipartCapability() {
  try {
    logger.info('🧪 Testing B2 multipart upload capability...');
    
    await b2ApiLimiter.waitForNext();
    await b2.authorize();
    
    // Test with a minimal file initialization
    await b2ApiLimiter.waitForNext();
    const testResponse = await b2.startLargeFile({
      bucketId: config.b2.buckets.video.id,
      fileName: `test_multipart_${Date.now()}_${generateSecureId()}.txt`,
      contentType: 'text/plain',
    });
    
    const testFileId = testResponse.data.fileId;
    
    // Immediately cancel the test upload
    await b2ApiLimiter.waitForNext();
    await b2.cancelLargeFile({ fileId: testFileId });
    
    logger.info('✅ B2 multipart upload capability confirmed');
    return true;
    
  } catch (error) {
    logger.error('❌ B2 multipart upload test failed:', error);
    return false;
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

module.exports = {
  initializeMultipartUpload,
  generatePartUrls,
  getAdditionalPartUrls,
  completeMultipartUpload,
  cancelMultipartUpload,
  getMultipartUploadStatus,
  testMultipartCapability
};