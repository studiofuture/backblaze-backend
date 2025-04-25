/**
 * Supabase integration service
 * Note: This service will attempt to use supabase client if available,
 * otherwise it will operate in a fallback mode.
 */
const logger = require('../utils/logger');

/**
 * Update video metadata in Supabase
 * @param {string} videoId - ID of the video in Supabase
 * @param {Object} metadata - Video metadata to update
 * @returns {Promise<boolean>} - Success status
 */
async function updateVideoMetadata(videoId, metadata) {
  try {
    logger.info(`[Supabase] Updating metadata for video ${videoId}`, metadata);
    
    // Try to import Supabase client
    try {
      // Attempt to import from your integration file
      const { supabase } = require('../integrations/supabase/server');
      
      // Update the videos table
      const { data, error } = await supabase
        .from('videos')
        .update({
          url: metadata.url,
          thumbnail_url: metadata.thumbnailUrl,
          duration: Math.round(metadata.duration || 0),
          width: metadata.width || 0,
          height: metadata.height || 0,
          updated_at: new Date().toISOString()
        })
        .eq('id', videoId)
        .select();
        
      if (error) {
        logger.error(`[Supabase] Error updating video:`, error);
        return false;
      }
      
      logger.info(`[Supabase] Updated video successfully:`, data);
      return true;
    } catch (importError) {
      // If we can't import the Supabase client, log that it's not available
      logger.info(`[Supabase] Integration not available:`, importError.message);
      
      // Return true anyway so the rest of the flow can continue
      return false;
    }
  } catch (error) {
    logger.error(`[Supabase] Update error:`, error);
    return false;
  }
}

/**
 * Check if Supabase integration is available
 * @returns {Promise<boolean>} - Availability status
 */
async function isSupabaseAvailable() {
  try {
    const { supabase } = require('../integrations/supabase/server');
    return !!supabase;
  } catch (error) {
    return false;
  }
}

module.exports = {
  updateVideoMetadata,
  isSupabaseAvailable
};