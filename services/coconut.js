/**
 * Coconut.co HLS Transcoding Service
 * 
 * Triggers HLS transcoding jobs via Coconut's REST API after video upload.
 * Outputs adaptive bitrate HLS streams to a dedicated B2 bucket.
 * 
 * Uses HEVC (H.265) encoding to preserve colour space (BT.2020/HDR/10-bit)
 * from source videos. Ultrafast mode enabled for parallel chunk transcoding.
 * 
 * Encoding ladder (Coconut never upscales, so we always send all variants):
 *   - Audio-only fallback: 64kbps AAC
 *   - 720p:  HEVC, CRF quality=5, maxrate 3000k
 *   - 1080p: HEVC, CRF quality=5, maxrate 9000k
 *   - 2160p: HEVC, CRF quality=5, maxrate 15000k
 */
const logger = require('../utils/logger');
const { config } = require('../config');

const COCONUT_API_URL = process.env.COCONUT_API_URL || 'https://api-eu-west-1.coconut.co/v2/jobs';

/**
 * Create an HLS transcoding job with Coconut
 * 
 * @param {string} videoId    - Supabase video record ID (used for output path)
 * @param {string} sourceUrl  - Public B2 URL of the uploaded source video
 * @returns {Promise<Object>} - { jobId, hlsBaseUrl } on success
 */
async function createHlsJob(videoId, sourceUrl) {
  const apiKey = config.coconut.apiKey;
  if (!apiKey) {
    logger.warn('[Coconut] API key not configured — skipping HLS transcode');
    return null;
  }

  // Validate inputs
  if (!videoId || !sourceUrl) {
    logger.error('[Coconut] Missing videoId or sourceUrl', { videoId, sourceUrl });
    return null;
  }

  const hlsBucket = config.b2.buckets.hls;
  if (!hlsBucket || !hlsBucket.id) {
    logger.warn('[Coconut] HLS bucket not configured — skipping HLS transcode');
    return null;
  }

  // Build the output path inside the HLS bucket: /{videoId}/hls/
  const outputPath = `/${videoId}/hls`;

  // Build the webhook URL
  const webhookUrl = config.coconut.webhookUrl;
  if (!webhookUrl) {
    logger.warn('[Coconut] Webhook URL not configured — skipping HLS transcode');
    return null;
  }

  // Append videoId as query param so the webhook knows which video to update
  const notificationUrl = `${webhookUrl}?videoId=${encodeURIComponent(videoId)}`;

  const jobPayload = {
    settings: {
      ultrafast: true
    },
    input: {
      url: sourceUrl
    },
    storage: {
      service: 'backblaze',
      bucket_id: hlsBucket.id,
      credentials: {
        app_key_id: hlsBucket.appKeyId,
        app_key: hlsBucket.appKey
      }
    },
    notification: {
      type: 'http',
      url: notificationUrl
    },
    outputs: {
      httpstream: {
        hls: {
          path: outputPath
        },
        // HEVC encoding ladder — preserves colour space from H.265/HDR sources
        // Coconut skips any variant above source resolution
        variants: [
          'mp4:x:64k',
          'mp4:hevc_720p::quality=5,maxrate=3000k',
          'mp4:hevc_1080p::quality=5,maxrate=9000k',
          'mp4:hevc_2160p::quality=5,maxrate=15000k'
        ]
      }
    }
  };

  logger.info(`[Coconut] Creating HLS job for video ${videoId}`, {
    sourceUrl,
    outputPath,
    webhookUrl: notificationUrl
  });

  try {
    // Coconut uses Basic Auth: API key as username, blank password
    const authHeader = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');

    const response = await fetch(COCONUT_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify(jobPayload)
    });

    const data = await response.json();

    if (!response.ok) {
      logger.error(`[Coconut] API error (${response.status}):`, data);
      return null;
    }

    const jobId = data.id;
    // Construct the expected master playlist URL
    const hlsBaseUrl = `https://f${hlsBucket.id.substring(0, 3)}.backblazeb2.com/file/${hlsBucket.name}/${videoId}/hls/master.m3u8`;
    // Also construct the S3-style URL which is more reliable
    const hlsUrl = `https://${hlsBucket.name}.s3.eu-central-003.backblazeb2.com/${videoId}/hls/master.m3u8`;

    logger.info(`[Coconut] Job created successfully`, {
      jobId,
      videoId,
      hlsUrl,
      status: data.status
    });

    return {
      jobId,
      hlsUrl
    };

  } catch (error) {
    logger.error(`[Coconut] Failed to create HLS job:`, error);
    return null;
  }
}

/**
 * Get the status of a Coconut job
 * 
 * @param {string} jobId - Coconut job ID
 * @returns {Promise<Object|null>} - Job status data
 */
async function getJobStatus(jobId) {
  const apiKey = config.coconut.apiKey;
  if (!apiKey || !jobId) return null;

  try {
    const authHeader = 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');

    const response = await fetch(`${COCONUT_API_URL}/${jobId}`, {
      method: 'GET',
      headers: {
        'Authorization': authHeader
      }
    });

    if (!response.ok) {
      logger.error(`[Coconut] Failed to get job status (${response.status})`);
      return null;
    }

    return await response.json();

  } catch (error) {
    logger.error(`[Coconut] Error fetching job status:`, error);
    return null;
  }
}

module.exports = {
  createHlsJob,
  getJobStatus
};