/**
 * Supabase integration service
 * Note: This service will attempt to use supabase client if available,
 * otherwise it will operate in a fallback mode.
 */
const logger = require('../utils/logger');
const { createClient } = require('@supabase/supabase-js');

// Initialize service client if credentials are available
let serviceClient = null;

/**
 * Initialize the Supabase service client
 */
function initServiceClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  if (!supabaseUrl || !supabaseServiceKey) {
    logger.warn('[Supabase] Service role credentials not found in environment variables');
    return null;
  }
  
  try {
    const client = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    logger.info('[Supabase] Service client initialized successfully');
    return client;
  } catch (error) {
    logger.error('[Supabase] Failed to initialize service client:', error);
    return null;
  }
}

/**
 * Update video metadata in Supabase
 * @param {string} videoId - ID of the video in Supabase
 * @param {Object} metadata - Video metadata to update
 * @returns {Promise<boolean>} - Success status
 */
async function updateVideoMetadata(videoId, metadata) {
  try {
    logger.info(`[Supabase] Updating metadata for video ${videoId}`, metadata);
    
    // Initialize service client if not already initialized
    if (!serviceClient) {
      serviceClient = initServiceClient();
    }
    
    // If we have a service client, use it first (has higher permissions)
    if (serviceClient) {
      try {
        const { data, error } = await serviceClient
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
          logger.error(`[Supabase] Service client error updating video:`, error);
          // Fall through to try the regular client
        } else {
          logger.info(`[Supabase] Service client updated video successfully:`, data);
          return true;
        }
      } catch (serviceError) {
        logger.error(`[Supabase] Service client error:`, serviceError);
        // Fall through to try the regular client
      }
    }
    
    // Fallback to regular client from integrations
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
      return false;
    }
  } catch (error) {
    logger.error(`[Supabase] Update error:`, error);
    return false;
  }
}

/**
 * Update thumbnail URL specifically
 * @param {string} videoId - ID of the video in Supabase
 * @param {string} thumbnailUrl - URL of the thumbnail
 * @param {Object} additionalMetadata - Optional additional metadata
 * @returns {Promise<boolean>} - Success status
 */
async function updateThumbnail(videoId, thumbnailUrl, additionalMetadata = {}) {
  if (!videoId || !thumbnailUrl) {
    logger.error('[Supabase] Missing required parameters for thumbnail update');
    return false;
  }
  
  return updateVideoMetadata(videoId, {
    thumbnailUrl,
    ...additionalMetadata
  });
}

/**
 * Check if Supabase integration is available
 * @returns {Promise<boolean>} - Availability status
 */
async function isSupabaseAvailable() {
  // Check if service client is available
  if (serviceClient) {
    return true;
  }
  
  // Otherwise try the regular integration
  try {
    const { supabase } = require('../integrations/supabase/server');
    return !!supabase;
  } catch (error) {
    return false;
  }
}

module.exports = {
  updateVideoMetadata,
  updateThumbnail,
  isSupabaseAvailable,
  getServiceClient: () => serviceClient
};