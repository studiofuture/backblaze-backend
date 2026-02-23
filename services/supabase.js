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
 * Update video metadata in Supabase using hybrid approach
 * Will create the record if it doesn't exist, or update if it does
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
    
    // If we have a service client, use it
    if (serviceClient) {
      try {
        // First, try to update the existing record
        const { data: updateData, error: updateError } = await serviceClient
          .from('videos')
          .update({
            storage_url: metadata.url,
            thumbnail_url: metadata.thumbnailUrl,
            duration: Math.round(metadata.duration || 0),
            width: metadata.width || 0,
            height: metadata.height || 0,
            updated_at: new Date().toISOString()
          })
          .eq('id', videoId)
          .select();
          
        // If update was successful and found a record
        if (!updateError && updateData && updateData.length > 0) {
          logger.info(`[Supabase] Successfully updated existing video record:`, updateData);
          return true;
        }
        
        // If no record was found (empty array), create a new one
        if (!updateError && updateData && updateData.length === 0) {
          logger.info(`[Supabase] No existing record found for video ${videoId}, creating new record`);
          
          // Extract necessary fields for creating a new record
          const filename = metadata.url ? metadata.url.split('/').pop() : 'unknown.mp4';
          const title = filename.split('.')[0].replace(/_/g, ' ');
          
          const { data: insertData, error: insertError } = await serviceClient
            .from('videos')
            .insert({
              id: videoId,
              storage_url: metadata.url,
              thumbnail_url: metadata.thumbnailUrl,
              duration: Math.round(metadata.duration || 0),
              width: metadata.width || 0,
              height: metadata.height || 0,
              original_filename: filename,
              title: title,
              description: '',
              status: 'published',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .select();
            
          if (insertError) {
            // If insert fails due to duplicate, it means frontend created it in the meantime
            // Try update one more time
            if (insertError.code === '23505' || insertError.message.includes('duplicate')) {
              logger.info(`[Supabase] Record was created by frontend, retrying update`);
              
              const { data: retryData, error: retryError } = await serviceClient
                .from('videos')
                .update({
                  storage_url: metadata.url,
                  thumbnail_url: metadata.thumbnailUrl,
                  duration: Math.round(metadata.duration || 0),
                  width: metadata.width || 0,
                  height: metadata.height || 0,
                  updated_at: new Date().toISOString()
                })
                .eq('id', videoId)
                .select();
                
              if (!retryError && retryData && retryData.length > 0) {
                logger.info(`[Supabase] Successfully updated video on retry:`, retryData);
                return true;
              } else {
                logger.error(`[Supabase] Failed to update video on retry:`, retryError);
                return false;
              }
            } else {
              logger.error(`[Supabase] Failed to create new video record:`, insertError);
              return false;
            }
          } else {
            logger.info(`[Supabase] Successfully created new video record:`, insertData);
            return true;
          }
        }
        
        // If there was an update error
        if (updateError) {
          logger.error(`[Supabase] Service client error updating video:`, updateError);
          return false;
        }
        
      } catch (serviceError) {
        logger.error(`[Supabase] Service client error:`, serviceError);
        return false;
      }
    } else {
      logger.info(`[Supabase] Service client not available, skipping database update`);
      return false;
    }
  } catch (error) {
    logger.error(`[Supabase] Update error:`, error);
    return false;
  }
}

/**
 * Update thumbnail URL specifically with hybrid approach
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
  
  // Try to initialize service client
  const client = initServiceClient();
  return !!client;
}

/**
 * Update HLS transcoding status for a video
 * Called by Coconut webhook on job completion, and by upload routes to set initial status
 * @param {string} videoId - ID of the video in Supabase
 * @param {Object} hlsData - HLS status data
 * @param {string} hlsData.hls_status - 'processing' | 'ready' | 'failed'
 * @param {string} [hlsData.hls_url] - URL to master.m3u8 playlist
 * @param {string} [hlsData.transcode_job_id] - Coconut job ID
 * @returns {Promise<boolean>} - Success status
 */
async function updateHlsStatus(videoId, hlsData) {
  if (!videoId) {
    logger.error('[Supabase] Missing videoId for HLS status update');
    return false;
  }

  try {
    if (!serviceClient) {
      serviceClient = initServiceClient();
    }

    if (!serviceClient) {
      logger.warn('[Supabase] Service client not available for HLS status update');
      return false;
    }

    const updatePayload = {
      updated_at: new Date().toISOString()
    };

    if (hlsData.hls_status !== undefined) updatePayload.hls_status = hlsData.hls_status;
    if (hlsData.hls_url !== undefined) updatePayload.hls_url = hlsData.hls_url;
    if (hlsData.transcode_job_id !== undefined) updatePayload.transcode_job_id = hlsData.transcode_job_id;

    logger.info(`[Supabase] Updating HLS status for video ${videoId}:`, updatePayload);

    const { data, error } = await serviceClient
      .from('videos')
      .update(updatePayload)
      .eq('id', videoId)
      .select();

    if (error) {
      logger.error(`[Supabase] Failed to update HLS status:`, error);
      return false;
    }

    if (data && data.length > 0) {
      logger.info(`[Supabase] HLS status updated successfully for video ${videoId}`);
      return true;
    }

    // Record might not exist yet (frontend creates it) — retry once after brief delay
    logger.warn(`[Supabase] No record found for video ${videoId}, will retry in 2s`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    const { data: retryData, error: retryError } = await serviceClient
      .from('videos')
      .update(updatePayload)
      .eq('id', videoId)
      .select();

    if (retryError || !retryData || retryData.length === 0) {
      logger.error(`[Supabase] HLS status update retry failed for video ${videoId}:`, retryError);
      return false;
    }

    logger.info(`[Supabase] HLS status updated on retry for video ${videoId}`);
    return true;

  } catch (error) {
    logger.error(`[Supabase] HLS status update error:`, error);
    return false;
  }
}

module.exports = {
  updateVideoMetadata,
  updateThumbnail,
  updateHlsStatus,
  isSupabaseAvailable,
  getServiceClient: () => serviceClient
};