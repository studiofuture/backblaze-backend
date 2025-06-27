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
 * Delete a video from Backblaze by video ID
 * DELETE /:videoId
 */
router.delete('/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    
    if (!videoId) {
      return res.status(400).json({ error: "Video ID is required" });
    }
    
    logger.info(`📌 Attempting to delete video by ID: ${videoId}`);
    
    // Get Supabase client
    const supabase = getSupabaseClient();
    if (!supabase) {
      return res.status(500).json({ error: "Supabase client not available" });
    }
    
    // Look up the video data from Supabase
    const { data, error } = await supabase
      .from('videos')
      .select('storage_url, url, original_filename, thumbnail_url')
      .eq('id', videoId)
      .single();
    
    if (error) {
      logger.error(`❌ Error looking up video data:`, error);
      return res.status(404).json({ error: "Video not found in database" });
    }
    
    if (!data) {
      logger.warn(`⚠️ No data found for video ${videoId}`);
      return res.status(404).json({ error: "Video not found in database" });
    }
    
    // Extract filename from the storage URL
    let filename;
    let sourceUrl = data.storage_url || data.url || '';
    
    if (sourceUrl) {
      // Extract just the filename from the full URL
      // For example: https://rushes-videos.s3.eu-central-003.backblazeb2.com/RC_Vision_v5_-_with_subs_1751017336146_kcf9rt4jjmcemifki.mov
      // We want: RC_Vision_v5_-_with_subs_1751017336146_kcf9rt4jjmcemifki.mov
      
      // Remove any query parameters first
      if (sourceUrl.includes('?')) {
        sourceUrl = sourceUrl.split('?')[0];
      }
      
      // Get the last part after the final slash
      const parts = sourceUrl.split('/');
      filename = parts[parts.length - 1];
      
      logger.info(`📌 Extracted filename from URL: ${filename}`);
    }
    
    if (!filename) {
      logger.error(`❌ Could not determine filename for video ${videoId}`, data);
      return res.status(400).json({ error: "Could not determine filename for deletion" });
    }
    
    // Delete the video file from B2
    let videoDeleted = false;
    try {
      videoDeleted = await b2Service.deleteFile(filename, config.b2.buckets.video.id);
      
      if (!videoDeleted) {
        logger.warn(`⚠️ Video file ${filename} not found in B2 bucket`);
      } else {
        logger.info(`✅ Successfully deleted video file ${filename} from B2`);
      }
    } catch (b2Error) {
      logger.error(`❌ Error deleting video from B2:`, b2Error);
      // Continue anyway - we still want to try deleting the thumbnail
    }
    
    // Try to delete the thumbnail as well if present
    let thumbnailDeleted = false;
    if (data.thumbnail_url) {
      try {
        // Extract thumbnail filename from URL
        let thumbnailUrl = data.thumbnail_url;
        if (thumbnailUrl.includes('?')) {
          thumbnailUrl = thumbnailUrl.split('?')[0];
        }
        const thumbnailParts = thumbnailUrl.split('/');
        const thumbnailFilename = thumbnailParts[thumbnailParts.length - 1];
        
        if (thumbnailFilename) {
          logger.info(`📌 Attempting to delete thumbnail: ${thumbnailFilename}`);
          thumbnailDeleted = await b2Service.deleteFile(
            thumbnailFilename, 
            config.b2.buckets.thumbnail.id
          );
          
          if (thumbnailDeleted) {
            logger.info(`✅ Successfully deleted thumbnail ${thumbnailFilename}`);
          } else {
            logger.warn(`⚠️ Thumbnail file ${thumbnailFilename} not found in B2 bucket`);
          }
        }
      } catch (thumbError) {
        logger.warn(`⚠️ Error deleting thumbnail:`, thumbError);
        // Continue anyway
      }
    }
    
    // Return success with detailed status
    res.json({ 
      status: "success", 
      message: `Video ${videoId} deletion completed`,
      details: {
        videoDeleted: videoDeleted,
        thumbnailDeleted: thumbnailDeleted,
        videoFilename: filename
      }
    });
  } catch (error) {
    logger.error(`❌ Error in delete by ID endpoint:`, error);
    res.status(500).json({ error: error.message });
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
    
    // This is a placeholder. In a real implementation, you would
    // fetch metadata from Supabase or another source
    logger.info(`📌 Getting info for video: ${filename}`);
    
    // For now, return a simple response
    // This endpoint could be expanded to fetch real metadata from Supabase or B2
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