const B2 = require('backblaze-b2');
const fs = require('fs');
const crypto = require('crypto');
const { config } = require('../config');
const logger = require('../utils/logger');
const { updateUploadStatus } = require('../utils/status');

// Initialize Backblaze B2 client
const b2 = new B2({
  applicationKeyId: config.b2.accountId,
  applicationKey: config.b2.applicationKey,
});

/**
 * Test Backblaze B2 connection
 * @returns {Promise<boolean>} Connection result
 */
async function testConnection() {
  try {
    await b2.authorize();
    logger.info('✅ Backblaze B2 connection successful');
    return true;
  } catch (error) {
    logger.error('❌ Backblaze B2 connection failed:', error);
    throw error;
  }
}

/**
 * Upload a file to B2 with chunking for large files
 * @param {Object} file - File object from multer
 * @param {string} uploadId - Unique upload ID for tracking
 * @param {Object} options - Upload options
 * @returns {Promise<string>} - URL of the uploaded file
 */
async function uploadFile(file, uploadId, options = {}) {
  const {
    deleteFile = true,
    bucketId = config.b2.buckets.video.id,
    bucketName = config.b2.buckets.video.name,
    contentType = 'video/mp4'
  } = options;
  
  try {
    await b2.authorize();
    
    const fileSize = fs.statSync(file.path).size;
    const chunkSize = config.upload.chunkSize;
    
    logger.info(`📌 Uploading file: ${file.originalname} (${fileSize} bytes) to ${bucketName}`);
    updateUploadStatus(uploadId, { stage: 'starting upload' });
    
    // Calculate final URL (this is the S3-compatible URL format for Backblaze)
    const fileUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${file.originalname}`;
    
    // For large files, use chunked upload
    if (fileSize > chunkSize) {
      logger.info(`📌 Large file detected (${fileSize} bytes). Using chunked upload...`);
      updateUploadStatus(uploadId, { 
        stage: 'uploading large file in chunks',
        progress: 5 
      });
      
      // Start large file upload
      const startFileResponse = await b2.startLargeFile({
        bucketId: bucketId,
        fileName: file.originalname,
        contentType: contentType,
      });
      
      const fileId = startFileResponse.data.fileId;
      let partSha1Array = [];
      let partNumber = 1;
      let promises = [];
      
      // Calculate total number of parts for progress tracking
      const totalParts = Math.ceil(fileSize / chunkSize);
      let completedParts = 0;
      let totalBytesUploaded = 0;
      
      // Read the entire file into memory
      // Note: For extremely large files, you might want to use streams instead
      const fileData = fs.readFileSync(file.path);
      
      // Process file in chunks
      for (let offset = 0; offset < fileSize; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, fileSize);
        const chunkSize = end - offset;
        const chunk = fileData.slice(offset, end);
        
        // Calculate SHA-1 hash for this chunk
        const sha1Hash = crypto.createHash('sha1').update(chunk).digest('hex');
        partSha1Array.push(sha1Hash);
        
        logger.info(`📌 Uploading part ${partNumber}/${totalParts} (size: ${chunkSize} bytes)`);
        
        // Upload chunk with retry logic
        promises.push(
          uploadChunk(fileId, partNumber, chunk)
            .then(() => {
              // Update progress after each chunk
              completedParts++;
              totalBytesUploaded += chunkSize;
              const progressPercent = Math.min(95, Math.floor((totalBytesUploaded / fileSize) * 100));
              
              updateUploadStatus(uploadId, {
                progress: progressPercent,
                stage: `uploaded part ${completedParts}/${totalParts}`
              });
              
              logger.info(`✅ Completed parts: ${completedParts}/${totalParts} (${progressPercent}%)`);
            })
        );
        
        partNumber++;
        
        // Limit parallel uploads
        if (promises.length >= config.upload.maxConcurrentChunks) {
          await Promise.all(promises);
          promises = [];
        }
      }
      
      // Wait for any remaining uploads to complete
      if (promises.length > 0) {
        await Promise.all(promises);
      }
      
      // Finalize the large file
      logger.info(`📌 Finalizing upload with ${partSha1Array.length} parts...`);
      updateUploadStatus(uploadId, { 
        progress: 97,
        stage: 'finalizing upload' 
      });
      
      await b2.finishLargeFile({ fileId, partSha1Array });
      logger.info(`✅ Large file upload complete!`);
    } 
    // For smaller files, use simple upload
    else {
      logger.info(`📌 Small file detected (${fileSize} bytes). Using direct upload...`);
      updateUploadStatus(uploadId, { 
        progress: 10,
        stage: 'uploading file' 
      });
      
      // Simulate progress updates for small files
      const progressInterval = setInterval(() => {
        const status = updateUploadStatus(uploadId, {});
        if (status && status.progress < 80) {
          updateUploadStatus(uploadId, { progress: status.progress + 10 });
        }
      }, 500);
      
      try {
        // Get upload URL
        const uploadUrlData = await b2.getUploadUrl({ bucketId: bucketId });
        
        // Upload file
        await b2.uploadFile({
          uploadUrl: uploadUrlData.data.uploadUrl,
          uploadAuthToken: uploadUrlData.data.authorizationToken,
          fileName: file.originalname,
          data: fs.readFileSync(file.path),
          contentType: contentType,
        });
        
        clearInterval(progressInterval);
        updateUploadStatus(uploadId, { progress: 95, stage: 'upload complete' });
        logger.info(`✅ Small file upload complete!`);
      } catch (error) {
        clearInterval(progressInterval);
        throw error;
      }
    }
    
    // Clean up temp file if requested
    if (deleteFile) {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
        logger.info(`✅ Cleaned up temp file: ${file.path}`);
      }
    }
    
    // Return the file URL
    return fileUrl;
  } catch (error) {
    logger.error(`❌ Upload failed:`, error);
    
    // Try to clean up temp file on error
    if (deleteFile && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
        logger.info(`✅ Cleaned up temp file after error: ${file.path}`);
      } catch (cleanupError) {
        logger.error(`❌ Failed to clean up temp file:`, cleanupError);
      }
    }
    
    throw error;
  }
}

/**
 * Upload a thumbnail to B2
 * @param {string} filePath - Path to thumbnail file
 * @param {string} fileName - Desired filename in B2
 * @returns {Promise<string>} - URL of the uploaded thumbnail
 */
async function uploadThumbnail(filePath, fileName) {
  try {
    // Authorize with B2
    await b2.authorize();
    logger.info(`✅ B2 Authorized for thumbnail upload`);
    
    const bucketId = config.b2.buckets.thumbnail.id;
    const bucketName = config.b2.buckets.thumbnail.name;
    
    if (!fs.existsSync(filePath)) {
      throw new Error(`Thumbnail file not found at: ${filePath}`);
    }
    
    // Get upload URL
    const uploadUrlData = await b2.getUploadUrl({ 
      bucketId: bucketId 
    });
    
    logger.info(`✅ Obtained upload URL for thumbnail`);
    
    // Read the file data
    const fileData = fs.readFileSync(filePath);
    
    // Upload the file
    const uploadResult = await b2.uploadFile({
      uploadUrl: uploadUrlData.data.uploadUrl,
      uploadAuthToken: uploadUrlData.data.authorizationToken,
      fileName: fileName,
      data: fileData,
      contentType: "image/jpeg",
    });
    
    logger.info(`✅ Thumbnail uploaded successfully: ${uploadResult.data.fileName}`);
    
    // Construct the thumbnail URL
    const thumbnailUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${fileName}`;
    
    return thumbnailUrl;
  } catch (error) {
    logger.error(`❌ Error uploading thumbnail to B2:`, error);
    throw error;
  }
}

/**
 * Delete a file from B2
 * @param {string} fileName - Name of file to delete
 * @param {string} bucketId - Bucket ID
 * @returns {Promise<boolean>} - Success status
 */
async function deleteFile(fileName, bucketId = config.b2.buckets.video.id) {
  try {
    // Authorize with B2
    await b2.authorize();
    
    logger.info(`📌 Looking for file to delete: ${fileName}`);
    
    // Find the file by listing files with the filename
    const listFilesResponse = await b2.listFileNames({
      bucketId: bucketId,
      prefix: fileName,
      maxFileCount: 10
    });
    
    // Find the exact file in the response
    const file = listFilesResponse.data.files.find(f => f.fileName === fileName);
    
    if (!file) {
      logger.warn(`⚠️ File not found for deletion: ${fileName}`);
      return false;
    }
    
    logger.info(`✅ Found file to delete: ${file.fileName} (ID: ${file.fileId})`);
    
    // Delete the file using its ID
    await b2.deleteFileVersion({
      fileId: file.fileId,
      fileName: file.fileName
    });
    
    logger.info(`✅ Successfully deleted file: ${fileName}`);
    return true;
  } catch (error) {
    logger.error(`❌ Error deleting file:`, error);
    throw error;
  }
}

/**
 * Upload a chunk of a large file to B2 with retry logic
 * @param {string} fileId - B2 file ID from startLargeFile
 * @param {number} partNumber - Part number (1-based)
 * @param {Buffer} partData - Chunk data
 * @returns {Promise<Object>} - B2 response
 */
async function uploadChunk(fileId, partNumber, partData, maxRetries = config.upload.retryAttempts) {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      const uploadPartUrl = await b2.getUploadPartUrl({ fileId });

      const response = await b2.uploadPart({
        partNumber,
        uploadUrl: uploadPartUrl.data.uploadUrl,
        uploadAuthToken: uploadPartUrl.data.authorizationToken,
        data: partData,
      });

      logger.info(`✅ Uploaded part ${partNumber}`);
      return response;
    } catch (error) {
      attempts++;
      logger.error(`❌ Failed to upload part ${partNumber} (Attempt ${attempts}/${maxRetries})`, error);
      
      if (attempts >= maxRetries) {
        throw error;
      }
      
      // Wait before retrying (exponential backoff)
      const backoffMs = 1000 * Math.pow(2, attempts);
      logger.info(`Retrying in ${backoffMs/1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
}

module.exports = {
  testConnection,
  uploadFile,
  uploadThumbnail,
  deleteFile
};