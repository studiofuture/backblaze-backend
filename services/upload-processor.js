const fs = require('fs');
const path = require('path');
const { updateUploadStatus, completeUploadStatus, failUploadStatus } = require('../utils/status');
const { generateUniqueFilename, getUploadPath } = require('../utils/directory');
const b2Service = require('./b2');
const ffmpegService = require('./ffmpeg');

/**
 * Upload Processor Service
 * MODIFIED: Processes everything synchronously and returns metadata
 * No more background processing - everything happens before response
 */

/**
 * Process a complete video file through the full pipeline
 * @param {string} uploadId - Unique upload identifier
 * @param {string} tempFilePath - Path to the video file to process
 * @param {string} originalName - Original filename from client
 * @param {string} videoId - Optional video ID for frontend reference
 * @returns {Promise<Object>} - Processing result with URLs and metadata
 */
async function processVideo(uploadId, tempFilePath, originalName, videoId) {
  let thumbnailPath = null;
  let videoMetadata = null;
  
  try {
    console.log(`🚀 Video processing started for ${uploadId}`);
    
    // Step 1: Extract video metadata FIRST (before upload)
    updateUploadStatus(uploadId, {
      stage: 'extracting video metadata',
      progress: 60
    });
    
    try {
      // Use the unified function that handles both local and remote files
      videoMetadata = await ffmpegService.extractVideoMetadataUnified(tempFilePath);
      console.log(`✅ Metadata extracted for ${uploadId}:`, {
        duration: videoMetadata.duration,
        dimensions: `${videoMetadata.width}x${videoMetadata.height}`,
        size: `${Math.floor(videoMetadata.size / 1024 / 1024)}MB`
      });
    } catch (metadataError) {
      console.warn(`⚠️ Metadata extraction failed: ${metadataError.message}`);
      videoMetadata = { duration: 0, width: 0, height: 0, size: 0, codec: '', bitrate: 0 };
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
    
    const filename = generateUniqueFilename(originalName);
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
    
    // Step 5: Complete with full data (no database update from server)
    const finalData = {
      videoUrl,
      thumbnailUrl: thumbnailUrl,
      metadata: videoMetadata || {
        duration: 0,
        width: 0,
        height: 0,
        codec: '',
        bitrate: 0,
        size: 0
      },
      uploadComplete: true,
      publishReady: true,
      completedAt: new Date().toISOString(),
      fileSizeMB: Math.floor(fileStats.size / 1024 / 1024)
    };
    
    completeUploadStatus(uploadId, finalData);
    
    console.log(`🎉 Video processing successful: ${uploadId}`);
    return finalData;
    
  } catch (error) {
    console.error(`❌ Video processing failed for ${uploadId}:`, {
      error: error.message,
      stack: error.stack,
      tempFilePath,
      originalName
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
 * Validate video file before processing
 * @param {string} filePath - Path to video file
 * @returns {boolean} - True if file is valid
 */
function validateVideoFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`❌ Video file not found: ${filePath}`);
      return false;
    }
    
    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      console.error(`❌ Video file is empty: ${filePath}`);
      return false;
    }
    
    console.log(`✅ Video file validated: ${filePath} (${Math.floor(stats.size / 1024 / 1024)}MB)`);
    return true;
  } catch (error) {
    console.error(`❌ Video file validation failed: ${error.message}`);
    return false;
  }
}

/**
 * Get video file information
 * @param {string} filePath - Path to video file
 * @returns {Object} - File information
 */
function getVideoFileInfo(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath);
    const basename = path.basename(filePath, ext);
    
    return {
      path: filePath,
      size: stats.size,
      sizeMB: Math.floor(stats.size / 1024 / 1024),
      extension: ext,
      basename: basename,
      created: stats.birthtime,
      modified: stats.mtime
    };
  } catch (error) {
    console.error(`❌ Failed to get video file info: ${error.message}`);
    return null;
  }
}

module.exports = {
  processVideo,
  validateVideoFile,
  getVideoFileInfo
};