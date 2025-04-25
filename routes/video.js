const express = require('express');
const router = express.Router();
const b2Service = require('../services/b2');
const logger = require('../utils/logger');
const { config } = require('../config');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    
    // Look up the filename from Supabase
    const { data, error } = await supabase
      .from('videos')
      .select('storage_url, original_filename')
      .eq('id', videoId)
      .single();
    
    if (error || !data) {
      logger.error(`❌ Error looking up video data:`, error || 'No data found');
      return res.status(404).json({ error: "Video not found in database" });
    }
    
    // Extract filename from storage URL or use original_filename
    let filename;
    if (data.storage_url) {
      filename = data.storage_url.split('/').pop();
    } else if (data.original_filename) {
      filename = data.original_filename;
    } else {
      return res.status(400).json({ error: "Could not determine filename for deletion" });
    }
    
    logger.info(`📌 Found filename for video ${videoId}: ${filename}`);
    
    // Delete the file from B2
    const deleted = await b2Service.deleteFile(filename, config.b2.buckets.video.id);
    
    if (!deleted) {
      logger.warn(`⚠️ File ${filename} not found in B2 bucket`);
      // Continue anyway because the database record is already deleted
    } else {
      logger.info(`✅ Successfully deleted file ${filename} from B2`);
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