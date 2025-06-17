const logger = require('../utils/logger');

// Enhanced configuration with security settings
const config = {
  port: process.env.PORT || 3000,
  
  // B2 Configuration - Enhanced with validation
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
  
  // Upload Configuration - Enhanced with security limits
  upload: {
    // Memory management
    chunkSize: parseInt(process.env.CHUNK_SIZE) || 25 * 1024 * 1024, // 25MB chunks
    maxConcurrentChunks: parseInt(process.env.MAX_CONCURRENT_CHUNKS) || 1,
    
    // Retry and timeout settings
    retryAttempts: Math.min(parseInt(process.env.RETRY_ATTEMPTS) || 3, 5), // Max 5 retries
    statusRetention: parseInt(process.env.UPLOAD_STATUS_RETENTION) || 30 * 60 * 1000, // 30 minutes
    cleanupInterval: parseInt(process.env.UPLOAD_CLEANUP_INTERVAL) || 10 * 60 * 1000, // 10 minutes
    timeoutMs: Math.min(parseInt(process.env.UPLOAD_TIMEOUT_MS) || 600000, 1800000), // Max 30 minutes
    
    // Security limits
    maxFileSize: Math.min(
      parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024 * 1024, // 100GB default
      500 * 1024 * 1024 * 1024 // Absolute max 500GB
    ),
    maxFilesPerUpload: 1, // Security: Only one file per upload
    maxFieldSize: 1024 * 1024, // 1MB max field size
    maxFields: 20, // Max form fields
    
    // Busboy configuration with security
    busboy: {
      limits: {
        fileSize: Math.min(
          parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024 * 1024,
          500 * 1024 * 1024 * 1024
        ),
        files: 1,
        fields: 20,
        fieldSize: 1024 * 1024,
        fieldNameSize: 100,
        headerPairs: 20
      },
      validFieldNames: ['video', 'file', 'upload', 'media', 'thumbnail', 'image'],
      validVideoTypes: [
        'video/mp4', 'video/quicktime', 'video/x-msvideo', 
        'video/x-matroska', 'video/mpeg', 'video/webm',
        'video/x-ms-wmv', 'video/3gpp'
      ],
      validImageTypes: [
        'image/jpeg', 'image/jpg', 'image/png', 'image/webp'
      ]
    }
  },
  
  // FFmpeg Configuration - Enhanced with security
  ffmpeg: {
    binPath: process.env.FFMPEG_BIN_PATH || 'ffmpeg',
    timeout: Math.min(parseInt(process.env.FFMPEG_TIMEOUT) || 300000, 600000), // Max 10 minutes
    maxConcurrentJobs: parseInt(process.env.MAX_FFMPEG_JOBS) || 2,
    tempDir: process.env.FFMPEG_TEMP_DIR || './uploads/temp'
  },
  
  // Supabase Configuration
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    options: {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      },
      db: {
        schema: 'public'
      }
    }
  },
  
  // Server Configuration - Enhanced with security
  server: {
    bodyLimit: '5mb',
    timeoutMs: Math.min(parseInt(process.env.SERVER_TIMEOUT_MS) || 1800000, 3600000), // Max 1 hour
    maxConnections: parseInt(process.env.MAX_CONNECTIONS) || 1000,
    keepAliveTimeout: 65000,
    headersTimeout: 66000
  },
  
  // Security Configuration
  security: {
    // Rate limiting
    rateLimiting: {
      enabled: process.env.DISABLE_RATE_LIMITING !== 'true',
      global: {
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: parseInt(process.env.GLOBAL_RATE_LIMIT) || 1000
      },
      upload: {
        windowMs: 15 * 60 * 1000,
        max: parseInt(process.env.UPLOAD_RATE_LIMIT) || 20
      },
      multipart: {
        windowMs: 15 * 60 * 1000,
        max: parseInt(process.env.MULTIPART_RATE_LIMIT) || 5
      }
    },
    
    // CORS configuration
    cors: {
      strictMode: process.env.CORS_STRICT_MODE === 'true',
      allowedOrigins: process.env.ALLOWED_ORIGINS ? 
        process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()) : [
          "https://www.rvshes.com",
          "https://rvshes.com",
          "https://c36396e7-7511-4311-b6cd-951c02385844.lovableproject.com",
          "https://id-preview--c36396e7-7511-4311-b6cd-951c02385844.lovable.app",
          "https://lovable.dev",
          "http://localhost:3000",
          "http://localhost:5173"
        ]
    },
    
    // Input validation
    validation: {
      maxStringLength: 10000,
      maxArrayLength: 1000,
      maxObjectDepth: 5,
      allowedFileTypes: [
        'video/mp4', 'video/quicktime', 'video/x-msvideo', 
        'video/x-matroska', 'video/mpeg', 'video/webm',
        'video/x-ms-wmv', 'video/3gpp',
        'image/jpeg', 'image/jpg', 'image/png', 'image/webp'
      ]
    },
    
    // Trust proxy settings
    trustProxy: process.env.TRUST_PROXY === 'true'
  },
  
  // Background Processing Configuration
  backgroundProcessing: {
    enabled: process.env.ENABLE_BACKGROUND_PROCESSING !== 'false',
    maxConcurrentJobs: Math.min(parseInt(process.env.MAX_BACKGROUND_JOBS) || 2, 5),
    jobRetentionTime: parseInt(process.env.JOB_RETENTION_TIME) || 30 * 60 * 1000, // 30 minutes
    processingIntervalMs: Math.max(parseInt(process.env.BACKGROUND_JOB_INTERVAL) || 2000, 1000), // Min 1 second
    maxRetryAttempts: Math.min(parseInt(process.env.MAX_JOB_RETRY_ATTEMPTS) || 3, 5),
    retryDelayMs: Math.max(parseInt(process.env.JOB_RETRY_DELAY) || 5000, 1000) // Min 1 second
  },
  
  // Multipart Upload Configuration
  multipart: {
    enabled: process.env.ENABLE_MULTIPART_UPLOADS !== 'false',
    defaultPartUrlCount: Math.min(parseInt(process.env.DEFAULT_PART_URL_COUNT) || 5, 20),
    maxPartsPerUpload: Math.min(parseInt(process.env.MAX_MULTIPART_PARTS) || 10000, 10000), // B2 limit
    partUrlExpirationHours: Math.min(parseInt(process.env.PART_URL_EXPIRATION_BUFFER) || 23, 23),
    autoCleanupIncompleteUploads: process.env.AUTO_CLEANUP_INCOMPLETE_UPLOADS !== 'false',
    incompleteUploadCleanupHours: Math.min(parseInt(process.env.INCOMPLETE_UPLOAD_CLEANUP_HOURS) || 24, 168) // Max 1 week
  },
  
  // Memory Management Configuration
  memory: {
    gcAfterUpload: process.env.FORCE_GC_AFTER_UPLOAD !== 'false',
    warningThreshold: Math.min(parseInt(process.env.MEMORY_WARNING_THRESHOLD) || 80, 95),
    criticalThreshold: Math.min(parseInt(process.env.MEMORY_CRITICAL_THRESHOLD) || 90, 98),
    monitoringEnabled: process.env.ENABLE_GC_MONITORING !== 'false'
  },
  
  // Feature Flags
  features: {
    formdataUploads: process.env.ENABLE_FORMDATA_UPLOADS !== 'false',
    legacyChunkedUploads: process.env.ENABLE_LEGACY_CHUNKED !== 'false',
    multipartUploads: process.env.ENABLE_MULTIPART_UPLOADS !== 'false',
    backgroundProcessing: process.env.ENABLE_BACKGROUND_PROCESSING !== 'false',
    customThumbnails: process.env.ENABLE_CUSTOM_THUMBNAILS !== 'false',
    debugRoutes: process.env.NODE_ENV !== 'production',
    enhancedLogging: process.env.ENABLE_ENHANCED_LOGGING !== 'false'
  }
};

// Required environment variables for security validation
const requiredEnvVars = [
  'B2_ACCOUNT_ID',
  'B2_APPLICATION_KEY',
  'B2_VIDEO_BUCKET_ID',
  'B2_THUMBNAIL_BUCKET_ID',
  'B2_PROFILE_BUCKET_ID'
];

// Optional environment variables with warnings
const optionalEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'B2_VIDEO_BUCKET_NAME',
  'B2_THUMBNAIL_BUCKET_NAME',
  'B2_PROFILE_BUCKET_NAME'
];

/**
 * Validate environment variables with enhanced security checks
 */
function validateEnvironment() {
  logger.info('🔍 Starting environment validation...');
  
  // Check for required variables
  const missing = requiredEnvVars.filter(varName => !process.env[varName]);
  
  // Validate B2 credentials format (basic check)
  if (process.env.B2_ACCOUNT_ID && !/^[a-fA-F0-9]{12}$/.test(process.env.B2_ACCOUNT_ID)) {
    logger.warn('⚠️ B2_ACCOUNT_ID format appears invalid (should be 12 hex characters)');
  }
  
  if (process.env.B2_APPLICATION_KEY && process.env.B2_APPLICATION_KEY.length < 20) {
    logger.warn('⚠️ B2_APPLICATION_KEY appears too short');
  }
  
  // Validate bucket IDs format
  ['B2_VIDEO_BUCKET_ID', 'B2_THUMBNAIL_BUCKET_ID', 'B2_PROFILE_BUCKET_ID'].forEach(bucketVar => {
    const bucketId = process.env[bucketVar];
    if (bucketId && !/^[a-fA-F0-9]{24}$/.test(bucketId)) {
      logger.warn(`⚠️ ${bucketVar} format appears invalid (should be 24 hex characters)`);
    }
  });
  
  // Log all environment variables status
  logger.info('📊 Environment variables status:', {
    accountId: process.env.B2_ACCOUNT_ID ? '✅ Set' : '❌ Missing',
    applicationKey: process.env.B2_APPLICATION_KEY ? '✅ Set' : '❌ Missing',
    videoBucketId: process.env.B2_VIDEO_BUCKET_ID ? '✅ Set' : '❌ Missing',
    videoBucketName: process.env.B2_VIDEO_BUCKET_NAME || '❌ Missing (using default)',
    thumbnailBucketId: process.env.B2_THUMBNAIL_BUCKET_ID ? '✅ Set' : '❌ Missing',
    thumbnailBucketName: process.env.B2_THUMBNAIL_BUCKET_NAME || '❌ Missing (using default)',
    profileBucketId: process.env.B2_PROFILE_BUCKET_ID ? '✅ Set' : '❌ Missing',
    profileBucketName: process.env.B2_PROFILE_BUCKET_NAME || '❌ Missing (using default)',
    supabaseUrl: process.env.SUPABASE_URL ? '✅ Set' : '⚠️ Optional - Missing',
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Set' : '⚠️ Optional - Missing'
  });

  // Security configuration summary
  logger.info('🔒 Security configuration:', {
    rateLimiting: config.security.rateLimiting.enabled ? '✅ Enabled' : '❌ Disabled',
    corsStrictMode: config.security.cors.strictMode ? '✅ Enabled' : '⚠️ Permissive',
    trustProxy: config.security.trustProxy ? '✅ Enabled' : '❌ Disabled',
    allowedOrigins: config.security.cors.allowedOrigins.length,
    maxFileSize: `${Math.floor(config.upload.maxFileSize / 1024 / 1024 / 1024)}GB`,
    maxConcurrentUploads: config.upload.maxConcurrentChunks
  });

  // Upload configuration summary
  logger.info('⬆️ Upload configuration:', {
    maxFileSize: `${Math.floor(config.upload.maxFileSize / 1024 / 1024 / 1024)}GB`,
    chunkSize: `${Math.floor(config.upload.chunkSize / 1024 / 1024)}MB`,
    concurrentChunks: config.upload.maxConcurrentChunks,
    timeout: `${Math.floor(config.upload.timeoutMs / 1000)}s`,
    retryAttempts: config.upload.retryAttempts,
    method: 'enhanced-secure-streaming'
  });

  // Feature flags summary
  logger.info('🎛️ Feature flags:', {
    formdataUploads: config.features.formdataUploads ? '✅' : '❌',
    legacyChunked: config.features.legacyChunkedUploads ? '✅' : '❌',
    multipartUploads: config.features.multipartUploads ? '✅' : '❌',
    backgroundProcessing: config.features.backgroundProcessing ? '✅' : '❌',
    customThumbnails: config.features.customThumbnails ? '✅' : '❌'
  });

  // Show warnings for missing optional variables
  optionalEnvVars.forEach(varName => {
    if (!process.env[varName]) {
      if (varName.startsWith('SUPABASE_')) {
        logger.warn(`⚠️ WARNING: ${varName} is not set. Database features will be limited.`);
      } else if (varName.includes('BUCKET_NAME')) {
        logger.warn(`⚠️ WARNING: ${varName} is not set. Using default bucket name.`);
      }
    }
  });

  // Validate numeric environment variables
  const numericVars = {
    'PORT': process.env.PORT,
    'CHUNK_SIZE': process.env.CHUNK_SIZE,
    'MAX_FILE_SIZE': process.env.MAX_FILE_SIZE,
    'UPLOAD_TIMEOUT_MS': process.env.UPLOAD_TIMEOUT_MS
  };

  Object.entries(numericVars).forEach(([varName, value]) => {
    if (value && isNaN(parseInt(value))) {
      logger.warn(`⚠️ WARNING: ${varName} is not a valid number: ${value}`);
    }
  });

  // Security validation warnings
  if (process.env.NODE_ENV === 'production') {
    if (config.security.cors.strictMode === false) {
      logger.warn('⚠️ SECURITY: CORS strict mode is disabled in production');
    }
    
    if (config.security.rateLimiting.enabled === false) {
      logger.warn('⚠️ SECURITY: Rate limiting is disabled in production');
    }
    
    if (config.features.debugRoutes === true) {
      logger.warn('⚠️ SECURITY: Debug routes are enabled in production');
    }
  }

  // Hard fail if critical variables are missing
  if (missing.length > 0) {
    logger.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
    logger.error('📝 Please add these variables to your .env file');
    logger.error('🔗 See .env.example for required format');
    process.exit(1);
  }

  // Validate file size limits
  if (config.upload.maxFileSize > 500 * 1024 * 1024 * 1024) {
    logger.warn('⚠️ WARNING: Max file size exceeds recommended limit of 500GB');
  }

  // Validate memory settings
  if (config.memory.warningThreshold >= config.memory.criticalThreshold) {
    logger.warn('⚠️ WARNING: Memory warning threshold should be less than critical threshold');
  }

  // Validate multipart settings
  if (config.multipart.enabled && config.multipart.maxPartsPerUpload > 10000) {
    logger.warn('⚠️ WARNING: Multipart max parts exceeds B2 limit of 10,000');
    config.multipart.maxPartsPerUpload = 10000;
  }

  logger.info('✅ Environment validation completed successfully');
}

/**
 * Get sanitized configuration for logging (removes sensitive information)
 */
function getSanitizedConfig() {
  const sanitized = JSON.parse(JSON.stringify(config));
  
  // Remove sensitive information
  if (sanitized.b2) {
    sanitized.b2.accountId = sanitized.b2.accountId ? '***REDACTED***' : undefined;
    sanitized.b2.applicationKey = sanitized.b2.applicationKey ? '***REDACTED***' : undefined;
  }
  
  if (sanitized.supabase) {
    sanitized.supabase.serviceRoleKey = sanitized.supabase.serviceRoleKey ? '***REDACTED***' : undefined;
    sanitized.supabase.url = sanitized.supabase.url ? 
      sanitized.supabase.url.replace(/\/\/[^@]+@/, '//***:***@') : undefined;
  }
  
  return sanitized;
}

/**
 * Validate configuration values at runtime
 */
function validateConfig() {
  const errors = [];
  const warnings = [];
  
  // Validate numeric values
  if (config.upload.chunkSize < 1024 * 1024) {
    warnings.push('Chunk size is very small (< 1MB), may impact performance');
  }
  
  if (config.upload.chunkSize > 100 * 1024 * 1024) {
    warnings.push('Chunk size is very large (> 100MB), may impact memory usage');
  }
  
  if (config.upload.maxConcurrentChunks > 5) {
    warnings.push('High concurrent chunk limit may impact server stability');
  }
  
  if (config.upload.retryAttempts > 5) {
    warnings.push('High retry attempts may cause extended failure delays');
  }
  
  // Validate security settings
  if (config.security.rateLimiting.global.max > 10000) {
    warnings.push('Very high global rate limit may not provide adequate protection');
  }
  
  if (config.security.cors.allowedOrigins.length === 0) {
    errors.push('No CORS origins configured');
  }
  
  // Log warnings and errors
  warnings.forEach(warning => logger.warn(`⚠️ CONFIG: ${warning}`));
  errors.forEach(error => logger.error(`❌ CONFIG: ${error}`));
  
  if (errors.length > 0) {
    throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
  }
  
  return true;
}

/**
 * Get environment-specific configuration overrides
 */
function getEnvironmentOverrides() {
  const env = process.env.NODE_ENV || 'development';
  
  const overrides = {
    development: {
      security: {
        rateLimiting: {
          enabled: process.env.DISABLE_RATE_LIMITING === 'true' ? false : true
        },
        cors: {
          strictMode: false
        }
      },
      features: {
        debugRoutes: true,
        enhancedLogging: true
      }
    },
    
    production: {
      security: {
        rateLimiting: {
          enabled: true
        },
        cors: {
          strictMode: process.env.CORS_STRICT_MODE !== 'false'
        }
      },
      features: {
        debugRoutes: false,
        enhancedLogging: process.env.ENABLE_ENHANCED_LOGGING === 'true'
      }
    },
    
    test: {
      security: {
        rateLimiting: {
          enabled: false
        }
      },
      upload: {
        statusRetention: 5 * 60 * 1000, // 5 minutes for tests
        cleanupInterval: 1 * 60 * 1000   // 1 minute for tests
      }
    }
  };
  
  return overrides[env] || {};
}

// Apply environment-specific overrides
const envOverrides = getEnvironmentOverrides();
Object.keys(envOverrides).forEach(key => {
  if (config[key] && typeof config[key] === 'object') {
    config[key] = { ...config[key], ...envOverrides[key] };
  } else {
    config[key] = envOverrides[key];
  }
});

module.exports = {
  config,
  validateEnvironment,
  validateConfig,
  getSanitizedConfig
};