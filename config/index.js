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
    chunkSize: 25 * 1024 * 1024,     // 25MB chunks for optimal memory efficiency
    maxConcurrentChunks: 1,          // Process one chunk at a time to minimize memory
    retryAttempts: 3,                // Reduced retries for faster failure detection
    statusRetention: 30 * 60 * 1000, // 30 minutes retention (was 24 hours)
    cleanupInterval: 10 * 60 * 1000, // 10 minutes cleanup interval
    timeoutMs: 600000,               // 10 minutes timeout for large files
    maxFileSize: 100 * 1024 * 1024 * 1024, // 100GB max file size for professionals
    busboy: {
      // Busboy-specific configuration
      limits: {
        fileSize: 100 * 1024 * 1024 * 1024, // 100GB
        files: 1,           // One file at a time
        fields: 10,         // Max form fields
        fieldSize: 1024 * 1024 // 1MB max field size
      },
      validFieldNames: ['video', 'file', 'upload', 'media'], // Accepted field names
      validVideoTypes: [
        'video/mp4', 'video/quicktime', 'video/x-msvideo', 
        'video/x-matroska', 'video/mpeg', 'video/webm',
        'video/x-ms-wmv', 'video/3gpp'
      ]
    }
  },
  ffmpeg: {
    binPath: 'ffmpeg', // Use system PATH
    timeout: 300000,   // 5 minutes for large video processing (increased from 2 minutes)
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  },
  server: {
    bodyLimit: '5mb',    // Small limit for API calls (file uploads use streaming)
    timeoutMs: 1800000   // 30 minutes for overall request timeout
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
    videoBucketName: process.env.B2_VIDEO_BUCKET_NAME || '❌ Missing (using default)',
    thumbnailBucketId: process.env.B2_THUMBNAIL_BUCKET_ID ? '✅ Set' : '❌ Missing',
    thumbnailBucketName: process.env.B2_THUMBNAIL_BUCKET_NAME || '❌ Missing (using default)',
    profileBucketName: process.env.B2_PROFILE_BUCKET_NAME || '❌ Missing (using default)'
  });

  // Show configuration summary
  logger.info('Upload configuration:', {
    maxFileSize: `${config.upload.maxFileSize / 1024 / 1024 / 1024}GB`,
    chunkSize: `${config.upload.chunkSize / 1024 / 1024}MB`,
    concurrentChunks: config.upload.maxConcurrentChunks,
    timeout: `${config.upload.timeoutMs / 1000}s`,
    method: 'busboy-streaming'
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

  logger.info('✅ Environment validation completed successfully');
}

module.exports = {
  config,
  validateEnvironment
};