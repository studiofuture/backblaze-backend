const express = require('express');
const router = express.Router();
const b2Service = require('../services/b2');
const logger = require('../utils/logger');
const { config } = require('../config');

/**
 * Delete a video from Backblaze
 * DELETE /:filename
 */
router.delete('/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    
    if (!filename) {
      return res.status(400).json({ error: "Filename is required" });
    }
    
    logger.info(`📌 Attempting to delete video: ${filename}`);
    
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