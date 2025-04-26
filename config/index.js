const logger = require('../utils/logger');

// Configuration settings
const config = {
  port: process.env.PORT || 3000,
  b2: {
    accountId: process.env.B2_ACCOUNT_ID,
    applicationKey: process.env.B2_APPLICATION_KEY,
    buckets: {
      video: {
        id: process.env.B2_VIDEO_BUCKET_ID,
        name: process.env.B2_VIDEO_BUCKET_NAME || 'rushes-videos'
      },
      thumbnail: {
        id: process.env.B2_THUMBNAIL_BUCKET_ID,
        name: process.env.B2_THUMBNAIL_BUCKET_NAME || 'rushes-thumbnails'
      },
      profile: {
        id: process.env.B2_PROFILE_BUCKET_ID,
        name: process.env.B2_PROFILE_BUCKET_NAME || 'rushes-profile-pics'
      }
    }
  },
  upload: {
    chunkSize: 50 * 1024 * 1024, // 50MB chunks (smaller for better reliability)
    maxConcurrentChunks: 3,      // Reduced from 5 to prevent overwhelming the server
    retryAttempts: 5,            // Increased from 3 to 5
    statusRetention: 24 * 60 * 60 * 1000, // 24 hours
    cleanupInterval: 60 * 60 * 1000, // 1 hour
    timeoutMs: 120000,           // 2 minutes timeout for requests
  },
  ffmpeg: {
    binPath: 'ffmpeg', // Use system PATH instead of hardcoded Mac path
    timeout: 45000,    // 45 seconds (increased from 30)
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  },
  server: {
    bodyLimit: '1gb',  // Increase body size limit
    timeoutMs: 3600000 // 1 hour timeout for server operations
  }
};

const requiredEnvVars = [
  'B2_ACCOUNT_ID',
  'B2_APPLICATION_KEY',
  'B2_VIDEO_BUCKET_ID',
  'B2_THUMBNAIL_BUCKET_ID',
  'B2_PROFILE_BUCKET_ID'
];

// Validate environment variables
function validateEnvironment() {
  const missing = requiredEnvVars.filter(varName => !process.env[varName]);
  
  // Log all environment variables status
  logger.info('Environment variables:', {
    accountId: process.env.B2_ACCOUNT_ID ? '✅ Set' : '❌ Missing',
    applicationKey: process.env.B2_APPLICATION_KEY ? '✅ Set' : '❌ Missing',
    videoBucketId: process.env.B2_VIDEO_BUCKET_ID ? '✅ Set' : '❌ Missing',
    videoBucketName: process.env.B2_VIDEO_BUCKET_NAME || '❌ Missing',
    thumbnailBucketId: process.env.B2_THUMBNAIL_BUCKET_ID ? '✅ Set' : '❌ Missing',
    thumbnailBucketName: process.env.B2_THUMBNAIL_BUCKET_NAME || '❌ Missing',
    profileBucketName: process.env.B2_PROFILE_BUCKET_NAME || '❌ Missing'
  });

  // Show warnings for missing variables
  if (!process.env.B2_VIDEO_BUCKET_NAME) {
    logger.warn('⚠️ WARNING: B2_VIDEO_BUCKET_NAME is not set in your .env file. Using default value.');
  }
  if (!process.env.B2_THUMBNAIL_BUCKET_NAME) {
    logger.warn('⚠️ WARNING: B2_THUMBNAIL_BUCKET_NAME is not set in your .env file. Using default value.');
  }
  if (!process.env.B2_PROFILE_BUCKET_NAME) {
    logger.warn('⚠️ WARNING: B2_PROFILE_BUCKET_NAME is not set in your .env file. Using default value.');
  }

  // Hard fail if critical variables are missing
  if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(', ')}`);
    logger.error('Please add these variables to your .env file');
    process.exit(1);
  }
}

module.exports = {
  config,
  validateEnvironment
};