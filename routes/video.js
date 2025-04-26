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
    
    // Look up the filename from Supabase - try different column names
    const { data, error } = await supabase
      .from('videos')
      .select('storage_url, url, original_filename')
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
    
    // Extract filename from various possible URL fields
    let filename;
    let sourceUrl = data.storage_url || data.url || '';
    
    if (sourceUrl) {
      // Try to extract the filename from the URL
      // Handle both formats: full URL and relative path
      if (sourceUrl.includes('/')) {
        filename = sourceUrl.split('/').pop();
      } else {
        filename = sourceUrl;
      }
      
      // Make sure we have a clean filename without any URL parameters
      if (filename.includes('?')) {
        filename = filename.split('?')[0];
      }
    } else if (data.original_filename) {
      filename = data.original_filename;
    }
    
    if (!filename) {
      logger.error(`❌ Could not determine filename for video ${videoId}`, data);
      return res.status(400).json({ error: "Could not determine filename for deletion" });
    }
    
    logger.info(`📌 Found filename for video ${videoId}: ${filename}`);
    
    // Handle special characters in filename (decodeURIComponent)
    try {
      if (filename.includes('%')) {
        const decodedFilename = decodeURIComponent(filename);
        logger.info(`📌 Decoded filename: ${decodedFilename}`);
        filename = decodedFilename;
      }
    } catch (decodeError) {
      logger.warn(`⚠️ Error decoding filename: ${decodeError.message}. Using original.`);
    }
    
    // Delete the file from B2
    let deleted = false;
    try {
      deleted = await b2Service.deleteFile(filename, config.b2.buckets.video.id);
      
      if (!deleted) {
        logger.warn(`⚠️ File ${filename} not found in B2 bucket`);
      } else {
        logger.info(`✅ Successfully deleted file ${filename} from B2`);
      }
    } catch (b2Error) {
      logger.error(`❌ Error deleting from B2:`, b2Error);
      // Continue anyway, don't return an error to the client
    }
    
    // Try to delete the thumbnail as well if present
    if (data.thumbnail_url) {
      try {
        const thumbnailFilename = data.thumbnail_url.split('/').pop();
        if (thumbnailFilename) {
          logger.info(`📌 Attempting to delete thumbnail: ${thumbnailFilename}`);
          const thumbDeleted = await b2Service.deleteFile(
            thumbnailFilename, 
            config.b2.buckets.thumbnail.id
          );
          
          if (thumbDeleted) {
            logger.info(`✅ Successfully deleted thumbnail ${thumbnailFilename}`);
          }
        }
      } catch (thumbError) {
        logger.warn(`⚠️ Error deleting thumbnail:`, thumbError);
        // Continue anyway
      }
    }
    
    // Return success even if B2 deletion failed
    res.json({ 
      status: "success", 
      message: `Video ${videoId} deletion process completed`,
      b2DeleteStatus: deleted ? 'success' : 'not_found'
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