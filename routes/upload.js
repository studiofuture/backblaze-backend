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
const b2Service = require('../services/b2');
const ffmpegService = require('../services/ffmpeg');
const supabaseService = require('../services/supabase');
const logger = require('../utils/logger');
const { config } = require('../config');

/**
 * Get upload status
 * GET /upload/status/:uploadId
 */
router.get('/status/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  
  // Add debug logging
  console.log(`📊 Status request for upload ${uploadId} from origin: ${req.headers.origin || 'unknown'}`);
  
  const status = getUploadStatus(uploadId);
  if (!status) {
    console.log(`❌ Upload status not found for ID: ${uploadId}`);
    return res.status(404).json({ 
      error: 'Upload not found',
      message: 'This upload may have expired or completed already',
      uploadId: uploadId
    });
  }
  
  console.log(`✅ Returning status for ${uploadId}:`, status);
  res.json(status);
});

/**
 * Upload video to Backblaze (with thumbnail extraction and metadata)
 * POST /upload/video
 */
router.post('/video', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const uploadId = `upload_${Date.now()}`;
    logger.info(`📌 Upload started: ${uploadId}`);

    // Generate a unique filename
    const originalExt = path.extname(req.file.originalname);
    const baseName = path.basename(req.file.originalname, originalExt);
    const uniqueFilename = `${baseName}_${Date.now()}${originalExt}`;
    
    // Update filename in the file object
    req.file.originalname = uniqueFilename;
    
    // Prepare URLs
    const bucketName = config.b2.buckets.video.name;
    const videoUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${uniqueFilename}`;
    
    // Initialize status
    initUploadStatus(uploadId, {
      videoUrl: videoUrl,
      filename: uniqueFilename
    });
    
    // Return the URL immediately
    res.json({ 
      status: "processing", 
      uploadId,
      url: videoUrl
    });
    
    let thumbnailUrl = null;
    let metadata = null;
    
    try {
      // 1. FIRST EXTRACT THE THUMBNAIL (before uploading or deleting)
      try {
        logger.info(`📌 Generating thumbnail from local video file...`);
        const thumbnailFileName = `${baseName}_${Date.now()}.jpg`;
        const thumbnailPath = getUploadPath('thumbs', thumbnailFileName);
        
        updateUploadStatus(uploadId, {
          status: 'processing',
          stage: 'extracting metadata',
          progress: 5
        });
        
        // Extract metadata first
        logger.info(`📌 Extracting metadata from: ${req.file.path}`);
        metadata = await ffmpegService.extractVideoMetadata(req.file.path);
        logger.info(`📌 Extracted video metadata:`, metadata);
        
        updateUploadStatus(uploadId, {
          stage: 'generating thumbnail',
          progress: 10
        });
        
        // Generate thumbnail
        logger.info(`📌 Generating thumbnail from: ${req.file.path}`);
        await ffmpegService.generateThumbnail(req.file.path, thumbnailPath);
        
        // Upload the thumbnail to B2
        logger.info(`📌 Uploading extracted thumbnail to B2...`);
        const thumbBucketName = config.b2.buckets.thumbnail.name;
        thumbnailUrl = `https://${thumbBucketName}.s3.eu-central-003.backblazeb2.com/${thumbnailFileName}`;
        
        updateUploadStatus(uploadId, {
          stage: 'uploading thumbnail',
          progress: 15
        });
        
        await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
        
        // Clean up the local thumbnail
        if (fs.existsSync(thumbnailPath)) {
          fs.unlinkSync(thumbnailPath);
        }
        
        updateUploadStatus(uploadId, {
          thumbnailUrl,
          progress: 20
        });
      } catch (thumbnailError) {
        logger.error(`❌ Error extracting thumbnail from local file:`, thumbnailError);
        // Will fall back to placeholder later
      }
      
      // 2. NOW UPLOAD THE VIDEO
      updateUploadStatus(uploadId, {
        status: 'uploading',
        stage: 'uploading video to cloud storage',
        progress: 25
      });
      
      // Upload the video file to B2
      await b2Service.uploadFile(req.file, uploadId);
      
      // If we don't have a thumbnail yet, try to extract one from the remote URL
      if (!thumbnailUrl) {
        try {
          logger.info(`📌 Trying to extract thumbnail from remote video: ${videoUrl}`);
          
          const thumbnailFileName = `${baseName}_${Date.now()}_remote.jpg`;
          const thumbnailPath = getUploadPath('thumbs', thumbnailFileName);
          
          updateUploadStatus(uploadId, {
            stage: 'extracting thumbnail from remote video',
            progress: 96
          });
          
          await ffmpegService.extractThumbnailFromRemote(videoUrl, thumbnailPath, 5);
          
          // If we don't have metadata yet, try to get it
          if (!metadata) {
            try {
              metadata = await ffmpegService.extractVideoMetadata(videoUrl);
            } catch (metadataError) {
              logger.error(`❌ Error extracting metadata from remote:`, metadataError);
              metadata = { duration: 0, width: 0, height: 0 };
            }
          }
          
          // Upload the thumbnail to B2
          logger.info(`📌 Uploading remote-extracted thumbnail to B2...`);
          const thumbBucketName = config.b2.buckets.thumbnail.name;
          thumbnailUrl = `https://${thumbBucketName}.s3.eu-central-003.backblazeb2.com/${thumbnailFileName}`;
          
          updateUploadStatus(uploadId, {
            stage: 'uploading thumbnail',
            progress: 98
          });
          
          await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
          
          // Clean up
          if (fs.existsSync(thumbnailPath)) {
            fs.unlinkSync(thumbnailPath);
          }
        } catch (remoteError) {
          logger.error(`❌ Error extracting thumbnail from remote URL:`, remoteError);
          
          // If everything fails, create a blue placeholder thumbnail
          try {
            updateUploadStatus(uploadId, {
              stage: 'creating placeholder thumbnail',
              progress: 97
            });
            
            const placeholderFileName = `placeholder_${baseName}_${Date.now()}.jpg`;
            const placeholderPath = getUploadPath('thumbs', placeholderFileName);
            
            await ffmpegService.createPlaceholderThumbnail(placeholderPath);
            
            // Upload the placeholder
            logger.info(`📌 Uploading placeholder thumbnail to B2...`);
            const thumbBucketName = config.b2.buckets.thumbnail.name;
            thumbnailUrl = `https://${thumbBucketName}.s3.eu-central-003.backblazeb2.com/${placeholderFileName}`;
            
            await b2Service.uploadThumbnail(placeholderPath, placeholderFileName);
            
            // Clean up
            if (fs.existsSync(placeholderPath)) {
              fs.unlinkSync(placeholderPath);
            }
          } catch (placeholderError) {
            logger.error(`❌ Error creating placeholder thumbnail:`, placeholderError);
          }
        }
      }
      
      // Mark upload as complete with explicit flags for client
      completeUploadStatus(uploadId, {
        thumbnailUrl,
        metadata,
        uploadComplete: true,
        publishReady: true
      });
      
      logger.info(`✅ Upload successfully completed: ${uploadId}`);
      
      // If there's a videoId in the request body, update Supabase
      if (req.body && req.body.videoId) {
        try {
          await supabaseService.updateVideoMetadata(req.body.videoId, {
            url: videoUrl,
            thumbnailUrl,
            duration: metadata?.duration || 0,
            width: metadata?.width || 0,
            height: metadata?.height || 0
          });
        } catch (supabaseError) {
          logger.error(`❌ Error updating Supabase:`, supabaseError);
        }
      }
    } catch (error) {
      logger.error(`❌ Background upload failed: ${error.message}`);
      failUploadStatus(uploadId, error);
    }
  } catch (error) {
    logger.error("❌ Upload request failed:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload thumbnail to Backblaze
 * POST /upload/thumbnail
 */
router.post('/thumbnail', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    logger.info(`📌 Thumbnail upload started: ${req.file.originalname}`);

    // Generate a unique filename
    const uniqueFilename = generateUniqueFilename(req.file.originalname);
    
    // Use the correct bucket name
    const bucketName = config.b2.buckets.thumbnail.name;
    
    // Log the file details
    logger.info(`📌 Thumbnail file details:`, {
      originalFilename: req.file.originalname,
      uniqueFilename,
      tempPath: req.file.path,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
    
    // Upload the thumbnail to B2
    const thumbnailUrl = await b2Service.uploadThumbnail(req.file.path, uniqueFilename);
    
    // Return success response with the URL
    res.json({ 
      status: "success", 
      url: thumbnailUrl
    });
      
  } catch (error) {
    logger.error("❌ Thumbnail upload request failed:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Upload profile picture to Backblaze
 * POST /upload/profile-pic
 */
router.post('/profile-pic', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const uploadId = `profile_${Date.now()}`;
    logger.info(`📌 Profile picture upload started: ${uploadId}`);

    // Generate a unique filename
    const uniqueFilename = generateUniqueFilename(req.file.originalname);
    
    // Update filename in the file object
    req.file.originalname = uniqueFilename;
    
    // Use the correct bucket name
    const bucketName = config.b2.buckets.profile.name;
    
    // Construct the URL
    const profilePicUrl = `https://${bucketName}.s3.eu-central-003.backblazeb2.com/${uniqueFilename}`;
    
    // Upload file to B2
    await b2Service.uploadFile(req.file, uploadId, {
      bucketId: config.b2.buckets.profile.id,
      bucketName,
      contentType: req.file.mimetype || 'image/jpeg'
    });
    
    logger.info(`✅ Profile picture upload complete: ${uploadId}`);
    
    // Return success response with the URL
    res.json({ 
      status: "success", 
      url: profilePicUrl
    });
    
  } catch (error) {
    logger.error("❌ Profile picture upload failed:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Generate thumbnail from a video URL
 * POST /upload/generate-thumbnail
 */
router.post('/generate-thumbnail', async (req, res) => {
  try {
    const { videoUrl, videoId, timestamp } = req.body;
    
    logger.info(`[Thumbnail Generation] Received request:`, { 
      videoUrl,
      videoId,
      timestamp
    });
    
    if (!videoUrl) {
      logger.error('[Thumbnail Generation] Missing video URL');
      return res.status(400).json({ 
        status: 'error', 
        message: 'Video URL is required' 
      });
    }
    
    // Extract video filename and generate thumbnail name
    const videoFilename = path.basename(videoUrl);
    const baseName = path.basename(videoFilename, path.extname(videoFilename));
    const thumbnailFileName = `${baseName}_thumb_${Date.now()}.jpg`;
    
    const thumbnailPath = getUploadPath('thumbs', thumbnailFileName);
    
    let thumbnailUrl = null;
    let metadata = null;
    let usedPlaceholder = false;
    
    // First, extract metadata regardless of thumbnail extraction success
    try {
      metadata = await ffmpegService.extractVideoMetadata(videoUrl);
      logger.info(`[Thumbnail Generation] Extracted metadata:`, metadata);
    } catch (metadataError) {
      logger.error(`[Thumbnail Generation] Metadata extraction failed: ${metadataError.message}`);
      metadata = { duration: 0, width: 0, height: 0 };
    }
    
    // Now try to extract the thumbnail
    try {
      logger.info(`[Thumbnail Generation] Attempting to extract thumbnail from: ${videoUrl}`);
      
      // This will throw an error if extraction fails
      await ffmpegService.extractThumbnailFromRemote(
        videoUrl, 
        thumbnailPath, 
        timestamp ? parseInt(timestamp, 10) : 5
      );
      
      // If we get here, extraction was successful
      // Upload the thumbnail to B2
      const thumbnailBucketName = config.b2.buckets.thumbnail.name;
      thumbnailUrl = `https://${thumbnailBucketName}.s3.eu-central-003.backblazeb2.com/${thumbnailFileName}`;
      
      await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
      
      // Clean up temp files
      if (fs.existsSync(thumbnailPath)) {
        fs.unlinkSync(thumbnailPath);
      }
      
      logger.info(`[Thumbnail Generation] Successfully generated thumbnail: ${thumbnailUrl}`);
      
    } catch (extractError) {
      // Real extraction failed, now create a placeholder
      logger.error(`[Thumbnail Generation] Extraction failed: ${extractError.message}`);
      logger.info('[Thumbnail Generation] Falling back to placeholder thumbnail');
      
      // Only try placeholder creation if the real extraction failed
      const placeholderFileName = `placeholder_${baseName}_${Date.now()}.jpg`;
      const placeholderPath = getUploadPath('thumbs', placeholderFileName);
      
      try {
        await ffmpegService.createPlaceholderThumbnail(placeholderPath);
        
        const thumbnailBucketName = config.b2.buckets.thumbnail.name;
        thumbnailUrl = `https://${thumbnailBucketName}.s3.eu-central-003.backblazeb2.com/${placeholderFileName}`;
        usedPlaceholder = true;
        
        await b2Service.uploadThumbnail(placeholderPath, placeholderFileName);
        
        // Clean up placeholder file
        if (fs.existsSync(placeholderPath)) {
          fs.unlinkSync(placeholderPath);
        }
        
        logger.info(`[Thumbnail Generation] Created placeholder thumbnail: ${thumbnailUrl}`);
      } catch (placeholderError) {
        logger.error(`[Thumbnail Generation] Placeholder creation failed: ${placeholderError.message}`);
        return res.status(500).json({
          status: 'error',
          message: 'Failed to generate thumbnail or placeholder',
          details: placeholderError.message
        });
      }
    }
    
    // Update Supabase with the thumbnail URL and metadata if videoId is provided
    if (videoId && thumbnailUrl) {
      try {
        logger.info(`[Thumbnail Generation] Updating Supabase for video ID: ${videoId}`);
        
        await supabaseService.updateVideoMetadata(videoId, {
          thumbnailUrl: thumbnailUrl,
          duration: metadata?.duration || 0,
          width: metadata?.width || 0,
          height: metadata?.height || 0
        });
        
        logger.info(`[Thumbnail Generation] Supabase update completed for video ID: ${videoId}`);
      } catch (supabaseError) {
        logger.error(`[Thumbnail Generation] Supabase update failed: ${supabaseError.message}`);
        // Continue anyway - we still want to return the thumbnail URL
      }
    }
    
    // Return response with the thumbnail URL and metadata
    res.json({
      status: "success",
      thumbnailUrl,
      metadata: metadata || undefined,
      fallback: usedPlaceholder
    });
    
  } catch (error) {
    logger.error(`❌ Thumbnail generation completely failed: ${error.message}`);
    
    res.status(500).json({
      status: 'error',
      message: 'Thumbnail generation failed',
      details: error.message || 'Unknown error'
    });
  }
});

/**
 * CORS test endpoint
 * GET /upload/cors-test
 */
router.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'CORS is working correctly',
    origin: req.headers.origin || 'Unknown',
    headers: req.headers,
    time: new Date().toISOString()
  });
});

module.exports = router;