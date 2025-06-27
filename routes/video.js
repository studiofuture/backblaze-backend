const express = require('express');
const router = express.Router();
const b2Service = require('../services/b2');
const logger = require('../utils/logger');
const { config } = require('../config');
const { createClient } = require('@supabase/supabase-js');


// Initialize Supabase client
let supabase = null;

// Initialize the Supabase client on demand
function getSupabaseClient() {
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    if (!supabaseUrl || !supabaseServiceKey) {
      logger.error('Missing Supabase credentials. Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set');
      return null;
    }
    
    supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    
    logger.info('Supabase client initialized for video operations');
  }
  
  return supabase;
}

/**
 * Delete a video from Backblaze by filename
 * DELETE /file/:filename
 */
router.delete('/file/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    
    if (!filename) {
      return res.status(400).json({ error: "Filename is required" });
    }
    
    logger.info(`📌 Attempting to delete video by filename: ${filename}`);
    
    // Delete the file from B2
    const deleted = await b2Service.deleteFile(filename, config.b2.buckets.video.id);
    
    if (!deleted) {
      return res.status(404).json({ error: "File not found in B2 bucket" });
    }
    
    // Return success
    res.json({ 
      status: "success", 
      message: `Video ${filename} deleted successfully` 
    });
  } catch (error) {
    logger.error(`❌ Error in delete endpoint:`, error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a video from Backblaze by video ID with two-phase delete
 * DELETE /:videoId
 * 
 * Phase 1: Delete from B2 storage (video and thumbnail)
 * Phase 2: Delete from database (only if storage deletion succeeded)
 */
router.delete('/:videoId', async (req, res) => {
  const deletionReport = {
    videoId: null,
    videoDeletion: { attempted: false, success: false, filename: null, error: null },
    thumbnailDeletion: { attempted: false, success: false, filename: null, error: null },
    databaseDeletion: { attempted: false, success: false, error: null },
    overallSuccess: false
  };

  try {
    const { videoId } = req.params;
    deletionReport.videoId = videoId;
    
    if (!videoId) {
      return res.status(400).json({ 
        error: "Video ID is required",
        report: deletionReport 
      });
    }
    
    logger.info(`📌 Starting two-phase deletion for video ID: ${videoId}`);
    
    // Get Supabase client
    const supabase = getSupabaseClient();
    if (!supabase) {
      return res.status(500).json({ 
        error: "Supabase client not available",
        report: deletionReport 
      });
    }
    
    // PHASE 1: Get video data from database
    logger.info(`📋 Phase 1: Retrieving video data from database`);
    // FIXED: Removed 'url' from the select query - only use columns that exist
    const { data, error } = await supabase
      .from('videos')
      .select('storage_url, original_filename, thumbnail_url')
      .eq('id', videoId)
      .single();
    
    if (error || !data) {
      logger.error(`❌ Video not found in database:`, error);
      return res.status(404).json({ 
        error: "Video not found in database",
        report: deletionReport 
      });
    }
    
    // PHASE 2: Delete from B2 Storage
    logger.info(`🗑️ Phase 2: Deleting files from B2 storage`);
    
    // Extract video filename
    let videoFilename = null;
    // FIXED: Only use storage_url since 'url' column doesn't exist
    let sourceUrl = data.storage_url || '';
    
    if (sourceUrl) {
      // Remove query parameters
      if (sourceUrl.includes('?')) {
        sourceUrl = sourceUrl.split('?')[0];
      }
      
      // Get filename from URL
      const parts = sourceUrl.split('/');
      videoFilename = parts[parts.length - 1];
      deletionReport.videoDeletion.filename = videoFilename;
      
      logger.info(`📌 Video filename to delete: ${videoFilename}`);
    }
    
    // Delete video file from B2
    if (videoFilename) {
      deletionReport.videoDeletion.attempted = true;
      try {
        const videoDeleted = await b2Service.deleteFile(videoFilename, config.b2.buckets.video.id);
        deletionReport.videoDeletion.success = videoDeleted;
        
        if (videoDeleted) {
          logger.info(`✅ Successfully deleted video file from B2: ${videoFilename}`);
        } else {
          logger.warn(`⚠️ Video file not found in B2: ${videoFilename}`);
        }
      } catch (videoError) {
        logger.error(`❌ Error deleting video from B2:`, videoError);
        deletionReport.videoDeletion.error = videoError.message;
      }
    }
    
    // Delete thumbnail file from B2
    if (data.thumbnail_url) {
      let thumbnailUrl = data.thumbnail_url;
      if (thumbnailUrl.includes('?')) {
        thumbnailUrl = thumbnailUrl.split('?')[0];
      }
      const thumbnailParts = thumbnailUrl.split('/');
      const thumbnailFilename = thumbnailParts[thumbnailParts.length - 1];
      
      if (thumbnailFilename) {
        deletionReport.thumbnailDeletion.filename = thumbnailFilename;
        deletionReport.thumbnailDeletion.attempted = true;
        
        try {
          logger.info(`📌 Attempting to delete thumbnail: ${thumbnailFilename}`);
          const thumbnailDeleted = await b2Service.deleteFile(
            thumbnailFilename, 
            config.b2.buckets.thumbnail.id
          );
          deletionReport.thumbnailDeletion.success = thumbnailDeleted;
          
          if (thumbnailDeleted) {
            logger.info(`✅ Successfully deleted thumbnail from B2: ${thumbnailFilename}`);
          } else {
            logger.warn(`⚠️ Thumbnail file not found in B2: ${thumbnailFilename}`);
          }
        } catch (thumbError) {
          logger.error(`❌ Error deleting thumbnail from B2:`, thumbError);
          deletionReport.thumbnailDeletion.error = thumbError.message;
        }
      }
    }
    
    // PHASE 3: Delete from database (only if at least one storage deletion succeeded)
    const storageDeleted = deletionReport.videoDeletion.success || deletionReport.thumbnailDeletion.success;
    const storageNotFound = !deletionReport.videoDeletion.success && !deletionReport.thumbnailDeletion.success && 
                           deletionReport.videoDeletion.attempted && !deletionReport.videoDeletion.error;
    
    if (storageDeleted || storageNotFound) {
      logger.info(`💾 Phase 3: Deleting video record from database`);
      deletionReport.databaseDeletion.attempted = true;
      
      try {
        const { error: deleteError } = await supabase
          .from('videos')
          .delete()
          .eq('id', videoId);
        
        if (deleteError) {
          logger.error(`❌ Database deletion failed:`, deleteError);
          deletionReport.databaseDeletion.error = deleteError.message;
        } else {
          deletionReport.databaseDeletion.success = true;
          logger.info(`✅ Successfully deleted video record from database`);
        }
      } catch (dbError) {
        logger.error(`❌ Database deletion error:`, dbError);
        deletionReport.databaseDeletion.error = dbError.message;
      }
    } else {
      logger.warn(`⚠️ Skipping database deletion due to storage deletion failures`);
    }
    
    // Determine overall success
    deletionReport.overallSuccess = (
      (deletionReport.videoDeletion.success || !deletionReport.videoDeletion.attempted || storageNotFound) &&
      (deletionReport.thumbnailDeletion.success || !deletionReport.thumbnailDeletion.attempted || storageNotFound) &&
      deletionReport.databaseDeletion.success
    );
    
    // Send appropriate response
    if (deletionReport.overallSuccess) {
      logger.info(`🎉 Video ${videoId} fully deleted from system`);
      res.json({ 
        status: "success", 
        message: `Video ${videoId} successfully deleted`,
        report: deletionReport
      });
    } else {
      logger.warn(`⚠️ Partial deletion for video ${videoId}`, deletionReport);
      res.status(207).json({ 
        status: "partial_success", 
        message: "Video deletion partially completed - check report for details",
        report: deletionReport
      });
    }
    
  } catch (error) {
    logger.error(`❌ Unexpected error in delete endpoint:`, error);
    res.status(500).json({ 
      error: error.message,
      report: deletionReport
    });
  }
});

/**
 * Cleanup orphaned files endpoint
 * POST /cleanup/orphaned
 * 
 * Finds and removes files in B2 that don't have corresponding database records
 * This should be run periodically as a maintenance task
 */
router.post('/cleanup/orphaned', async (req, res) => {
  const cleanupReport = {
    videoBucket: {
      totalFiles: 0,
      orphanedFiles: 0,
      deletedFiles: 0,
      errors: []
    },
    thumbnailBucket: {
      totalFiles: 0,
      orphanedFiles: 0,
      deletedFiles: 0,
      errors: []
    },
    startTime: new Date().toISOString(),
    endTime: null
  };

  try {
    logger.info(`🧹 Starting orphaned files cleanup`);
    
    const supabase = getSupabaseClient();
    if (!supabase) {
      return res.status(500).json({ error: "Supabase client not available" });
    }
    
    // Initialize B2
    const B2 = require('backblaze-b2');
    const b2 = new B2({
      applicationKeyId: config.b2.accountId,
      applicationKey: config.b2.applicationKey,
    });
    await b2.authorize();
    
    // Step 1: Get all video URLs from database
    logger.info(`📋 Fetching all video records from database`);
    // FIXED: Removed 'url' from the select query
    const { data: videos, error: dbError } = await supabase
      .from('videos')
      .select('storage_url, thumbnail_url');
    
    if (dbError) {
      throw new Error(`Database query failed: ${dbError.message}`);
    }
    
    // Create sets of known filenames
    const knownVideoFiles = new Set();
    const knownThumbnailFiles = new Set();
    
    videos.forEach(video => {
      // Extract video filename - FIXED: Only use storage_url
      if (video.storage_url) {
        const url = video.storage_url;
        const filename = url.split('/').pop().split('?')[0];
        if (filename) knownVideoFiles.add(filename);
      }
      
      // Extract thumbnail filename
      if (video.thumbnail_url) {
        const filename = video.thumbnail_url.split('/').pop().split('?')[0];
        if (filename) knownThumbnailFiles.add(filename);
      }
    });
    
    logger.info(`📊 Found ${knownVideoFiles.size} videos and ${knownThumbnailFiles.size} thumbnails in database`);
    
    // Step 2: Clean up video bucket
    logger.info(`🗑️ Checking video bucket for orphaned files`);
    let startFileName = null;
    let hasMoreVideos = true;
    
    while (hasMoreVideos) {
      const listResponse = await b2.listFileNames({
        bucketId: config.b2.buckets.video.id,
        maxFileCount: 1000,
        startFileName: startFileName
      });
      
      const files = listResponse.data.files;
      cleanupReport.videoBucket.totalFiles += files.length;
      
      for (const file of files) {
        if (!knownVideoFiles.has(file.fileName)) {
          cleanupReport.videoBucket.orphanedFiles++;
          
          try {
            logger.info(`🗑️ Deleting orphaned video: ${file.fileName}`);
            await b2.deleteFileVersion({
              fileId: file.fileId,
              fileName: file.fileName
            });
            cleanupReport.videoBucket.deletedFiles++;
          } catch (deleteError) {
            logger.error(`❌ Failed to delete orphaned video ${file.fileName}:`, deleteError);
            cleanupReport.videoBucket.errors.push({
              fileName: file.fileName,
              error: deleteError.message
            });
          }
        }
      }
      
      hasMoreVideos = files.length === 1000;
      if (hasMoreVideos) {
        startFileName = files[files.length - 1].fileName;
      }
    }
    
    // Step 3: Clean up thumbnail bucket
    logger.info(`🗑️ Checking thumbnail bucket for orphaned files`);
    startFileName = null;
    let hasMoreThumbnails = true;
    
    while (hasMoreThumbnails) {
      const listResponse = await b2.listFileNames({
        bucketId: config.b2.buckets.thumbnail.id,
        maxFileCount: 1000,
        startFileName: startFileName
      });
      
      const files = listResponse.data.files;
      cleanupReport.thumbnailBucket.totalFiles += files.length;
      
      for (const file of files) {
        if (!knownThumbnailFiles.has(file.fileName)) {
          cleanupReport.thumbnailBucket.orphanedFiles++;
          
          try {
            logger.info(`🗑️ Deleting orphaned thumbnail: ${file.fileName}`);
            await b2.deleteFileVersion({
              fileId: file.fileId,
              fileName: file.fileName
            });
            cleanupReport.thumbnailBucket.deletedFiles++;
          } catch (deleteError) {
            logger.error(`❌ Failed to delete orphaned thumbnail ${file.fileName}:`, deleteError);
            cleanupReport.thumbnailBucket.errors.push({
              fileName: file.fileName,
              error: deleteError.message
            });
          }
        }
      }
      
      hasMoreThumbnails = files.length === 1000;
      if (hasMoreThumbnails) {
        startFileName = files[files.length - 1].fileName;
      }
    }
    
    cleanupReport.endTime = new Date().toISOString();
    
    logger.info(`✅ Orphaned files cleanup completed`, {
      videosDeleted: cleanupReport.videoBucket.deletedFiles,
      thumbnailsDeleted: cleanupReport.thumbnailBucket.deletedFiles
    });
    
    res.json({
      status: "success",
      message: "Orphaned files cleanup completed",
      report: cleanupReport
    });
    
  } catch (error) {
    logger.error(`❌ Error in cleanup endpoint:`, error);
    cleanupReport.endTime = new Date().toISOString();
    res.status(500).json({ 
      error: error.message,
      report: cleanupReport
    });
  }
});

/**
 * Get video info (metadata)
 * GET /:filename/info
 */
router.get('/:filename/info', async (req, res) => {
  try {
    const { filename } = req.params;
    
    if (!filename) {
      return res.status(400).json({ error: "Filename is required" });
    }
    
    logger.info(`📌 Getting info for video: ${filename}`);
    
    res.json({
      status: "success",
      filename,
      url: `https://${config.b2.buckets.video.name}.s3.eu-central-003.backblazeb2.com/${filename}`,
      uploaded: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`❌ Error getting video info:`, error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;