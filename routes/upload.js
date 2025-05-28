const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { upload } = require('../middleware/upload');
const { 
  initUploadStatus, 
  getUploadStatus, 
  updateUploadStatus, 
  completeUploadStatus, 
  failUploadStatus 
} = require('../utils/status');
const { generateUniqueFilename, getUploadPath } = require('../utils/directory');

// Import services - try both possible paths
let b2Service, ffmpegService, supabaseService;

try {
  // Try services directory first
  b2Service = require('../services/b2');
  ffmpegService = require('../services/ffmpeg');
  supabaseService = require('../services/supabase');
} catch (servicesError) {
  try {
    // Fall back to utils directory
    b2Service = require('../utils/b2');
    ffmpegService = require('../utils/ffmpeg');
    supabaseService = require('../utils/supabase');
  } catch (utilsError) {
    console.error('❌ Could not import services from either /services or /utils:', {
      servicesError: servicesError.message,
      utilsError: utilsError.message
    });
    process.exit(1);
  }
}

const logger = require('../utils/logger');
const { config } = require('../config');

/**
 * Get upload status - REMOVED duplicate route, handled in server.js
 * This route is commented out to prevent conflicts
 */
// router.get('/status/:uploadId', ...) - HANDLED IN SERVER.JS

/**
 * CORS test endpoint
 */
router.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'Upload routes CORS working',
    origin: req.headers.origin || 'Unknown',
    timestamp: new Date().toISOString(),
    route: 'upload/cors-test'
  });
});

/**
 * Upload video to Backblaze with thumbnail extraction
 * POST /upload/video
 */
router.post('/video', upload.single('file'), async (req, res) => {
  let uploadId;
  
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    uploadId = `upload_${Date.now()}`;
    logger.info(`🎬 Video upload started: ${uploadId}`);
    logger.info(`📁 File: ${req.file.originalname} (${req.file.size} bytes)`);

    // Generate unique filename
    const originalExt = path.extname(req.file.originalname);
    const baseName = path.basename(req.file.originalname, originalExt);
    const uniqueFilename = `${baseName}_${Date.now()}${originalExt}`;
    req.file.originalname = uniqueFilename;
    
    // Prepare video URL
    const bucketName = config.b2.buckets.video.name;
    const videoUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${uniqueFilename}`;
    
    // Initialize upload status
    initUploadStatus(uploadId, {
      videoUrl,
      filename: uniqueFilename,
      originalName: baseName
    });
    
    // Return immediately to client
    res.json({ 
      status: "processing", 
      uploadId,
      url: videoUrl
    });
    
    // Background processing
    processVideoUpload(uploadId, req.file, videoUrl, baseName, req.body?.videoId);
    
  } catch (error) {
    logger.error(`❌ Video upload failed: ${error.message}`);
    if (uploadId) {
      failUploadStatus(uploadId, error);
    }
    res.status(500).json({ error: error.message });
  }
});

/**
 * Background video processing function
 */
async function processVideoUpload(uploadId, file, videoUrl, baseName, videoId) {
  let thumbnailUrl = null;
  let metadata = null;
  
  try {
    logger.info(`🔄 Background processing started for ${uploadId}`);
    
    // Step 1: Extract metadata and thumbnail from local file
    updateUploadStatus(uploadId, {
      status: 'processing',
      stage: 'extracting metadata',
      progress: 5
    });
    
    try {
      logger.info(`📊 Extracting metadata from: ${file.path}`);
      metadata = await ffmpegService.extractVideoMetadata(file.path);
      logger.info(`✅ Metadata extracted:`, {
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height
      });
      
      updateUploadStatus(uploadId, {
        stage: 'generating thumbnail',
        progress: 15,
        metadata
      });
      
      // Generate thumbnail
      const thumbnailFileName = `${baseName}_${Date.now()}.jpg`;
      const thumbnailPath = getUploadPath('thumbs', thumbnailFileName);
      
      logger.info(`🖼️ Generating thumbnail: ${thumbnailPath}`);
      await ffmpegService.generateThumbnail(file.path, thumbnailPath);
      
      // Upload thumbnail to B2
      updateUploadStatus(uploadId, {
        stage: 'uploading thumbnail',
        progress: 25
      });
      
      const thumbBucketName = config.b2.buckets.thumbnail.name;
      thumbnailUrl = `https://${thumbBucketName}.s3.eu-central-003.backblazeb2.com/${thumbnailFileName}`;
      
      await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
      logger.info(`✅ Thumbnail uploaded: ${thumbnailUrl}`);
      
      // Clean up local thumbnail
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
      
      updateUploadStatus(uploadId, {
        thumbnailUrl,
        progress: 35
      });
      
    } catch (thumbnailError) {
      logger.error(`⚠️ Thumbnail extraction failed: ${thumbnailError.message}`);
      // Continue with upload, will create placeholder later
    }
    
    // Step 2: Upload video to B2
    updateUploadStatus(uploadId, {
      status: 'uploading',
      stage: 'uploading video to cloud storage',
      progress: 40
    });
    
    logger.info(`☁️ Uploading video to B2: ${file.originalname}`);
    await b2Service.uploadFile(file, uploadId);
    logger.info(`✅ Video uploaded successfully`);
    
    // Step 3: Create placeholder thumbnail if none exists
    if (!thumbnailUrl) {
      try {
        updateUploadStatus(uploadId, {
          stage: 'creating placeholder thumbnail',
          progress: 95
        });
        
        const placeholderFileName = `placeholder_${baseName}_${Date.now()}.jpg`;
        const placeholderPath = getUploadPath('thumbs', placeholderFileName);
        
        await ffmpegService.createPlaceholderThumbnail(placeholderPath);
        
        const thumbBucketName = config.b2.buckets.thumbnail.name;
        thumbnailUrl = `https://${thumbBucketName}.s3.eu-central-003.backblazeb2.com/${placeholderFileName}`;
        
        await b2Service.uploadThumbnail(placeholderPath, placeholderFileName);
        
        if (fs.existsSync(placeholderPath)) {
          fs.unlinkSync(placeholderPath);
        }
        
        logger.info(`✅ Placeholder thumbnail created: ${thumbnailUrl}`);
      } catch (placeholderError) {
        logger.error(`❌ Placeholder creation failed: ${placeholderError.message}`);
      }
    }
    
    // Step 4: Update Supabase if videoId provided
    if (videoId && thumbnailUrl) {
      try {
        updateUploadStatus(uploadId, {
          stage: 'updating database',
          progress: 98
        });
        
        await supabaseService.updateVideoMetadata(videoId, {
          url: videoUrl,
          thumbnailUrl,
          duration: metadata?.duration || 0,
          width: metadata?.width || 0,
          height: metadata?.height || 0
        });
        
        logger.info(`✅ Database updated for video ${videoId}`);
      } catch (supabaseError) {
        logger.error(`⚠️ Database update failed: ${supabaseError.message}`);
      }
    }
    
    // Step 5: Mark as complete
    completeUploadStatus(uploadId, {
      videoUrl,
      thumbnailUrl,
      metadata,
      uploadComplete: true,
      publishReady: true,
      completedAt: new Date().toISOString()
    });
    
    logger.info(`🎉 Upload completed successfully: ${uploadId}`);
    
  } catch (error) {
    logger.error(`❌ Background processing failed for ${uploadId}:`, error);
    failUploadStatus(uploadId, error);
  }
}

/**
 * Upload standalone thumbnail
 * POST /upload/thumbnail
 */
router.post('/thumbnail', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    logger.info(`🖼️ Thumbnail upload: ${req.file.originalname}`);

    const uniqueFilename = generateUniqueFilename(req.file.originalname);
    const thumbnailUrl = await b2Service.uploadThumbnail(req.file.path, uniqueFilename);
    
    logger.info(`✅ Thumbnail uploaded: ${thumbnailUrl}`);
    
    res.json({ 
      status: "success", 
      url: thumbnailUrl
    });
      
  } catch (error) {
    logger.error(`❌ Thumbnail upload failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload profile picture
 * POST /upload/profile-pic
 */
router.post('/profile-pic', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const uploadId = `profile_${Date.now()}`;
    logger.info(`👤 Profile picture upload: ${uploadId}`);

    const uniqueFilename = generateUniqueFilename(req.file.originalname);
    req.file.originalname = uniqueFilename;
    
    const bucketName = config.b2.buckets.profile.name;
    const profilePicUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${uniqueFilename}`;
    
    await b2Service.uploadFile(req.file, uploadId, {
      bucketId: config.b2.buckets.profile.id,
      bucketName,
      contentType: req.file.mimetype || 'image/jpeg'
    });
    
    logger.info(`✅ Profile picture uploaded: ${profilePicUrl}`);
    
    res.json({ 
      status: "success", 
      url: profilePicUrl
    });
    
  } catch (error) {
    logger.error(`❌ Profile picture upload failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Generate thumbnail from video URL
 * POST /upload/generate-thumbnail
 */
router.post('/generate-thumbnail', async (req, res) => {
  try {
    const { videoUrl, videoId, timestamp } = req.body;
    
    if (!videoUrl) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Video URL is required' 
      });
    }
    
    logger.info(`🎬 Generating thumbnail from URL: ${videoUrl}`);
    
    const videoFilename = path.basename(videoUrl);
    const baseName = path.basename(videoFilename, path.extname(videoFilename));
    const thumbnailFileName = `${baseName}_thumb_${Date.now()}.jpg`;
    const thumbnailPath = getUploadPath('thumbs', thumbnailFileName);
    
    let thumbnailUrl = null;
    let metadata = null;
    let usedPlaceholder = false;
    
    // Extract metadata
    try {
      metadata = await ffmpegService.extractVideoMetadata(videoUrl);
      logger.info(`✅ Metadata extracted from URL`);
    } catch (metadataError) {
      logger.error(`⚠️ Metadata extraction failed: ${metadataError.message}`);
      metadata = { duration: 0, width: 0, height: 0 };
    }
    
    // Generate thumbnail
    try {
      await ffmpegService.extractThumbnailFromRemote(
        videoUrl, 
        thumbnailPath, 
        timestamp ? parseInt(timestamp, 10) : 5
      );
      
      const thumbnailBucketName = config.b2.buckets.thumbnail.name;
      thumbnailUrl = `https://${thumbnailBucketName}.s3.eu-central-003.backblazeb2.com/${thumbnailFileName}`;
      
      await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
      
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
      
      logger.info(`✅ Thumbnail generated from URL: ${thumbnailUrl}`);
      
    } catch (extractError) {
      // Create placeholder
      logger.info(`🔄 Creating placeholder thumbnail`);
      
      const placeholderFileName = `placeholder_${baseName}_${Date.now()}.jpg`;
      const placeholderPath = getUploadPath('thumbs', placeholderFileName);
      
      try {
        await ffmpegService.createPlaceholderThumbnail(placeholderPath);
        
        const thumbnailBucketName = config.b2.buckets.thumbnail.name;
        thumbnailUrl = `https://${thumbnailBucketName}.s3.eu-central-003.backblazeb2.com/${placeholderFileName}`;
        usedPlaceholder = true;
        
        await b2Service.uploadThumbnail(placeholderPath, placeholderFileName);
        
        if (fs.existsSync(placeholderPath)) {
          fs.unlinkSync(placeholderPath);
        }
        
        logger.info(`✅ Placeholder thumbnail created: ${thumbnailUrl}`);
      } catch (placeholderError) {
        logger.error(`❌ Placeholder creation failed: ${placeholderError.message}`);
        return res.status(500).json({
          status: 'error',
          message: 'Failed to generate thumbnail',
          details: placeholderError.message
        });
      }
    }
    
    // Update database if videoId provided
    if (videoId && thumbnailUrl) {
      try {
        await supabaseService.updateVideoMetadata(videoId, {
          thumbnailUrl,
          duration: metadata?.duration || 0,
          width: metadata?.width || 0,
          height: metadata?.height || 0
        });
        logger.info(`✅ Database updated for video ${videoId}`);
      } catch (supabaseError) {
        logger.error(`⚠️ Database update failed: ${supabaseError.message}`);
      }
    }
    
    res.json({
      status: "success",
      thumbnailUrl,
      metadata,
      fallback: usedPlaceholder
    });
    
  } catch (error) {
    logger.error(`❌ Thumbnail generation failed: ${error.message}`);
    res.status(500).json({
      status: 'error',
      message: 'Thumbnail generation failed',
      details: error.message
    });
  }
});

module.exports = router;