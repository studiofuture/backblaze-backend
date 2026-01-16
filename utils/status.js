const { config } = require('../config');
const logger = require('./logger');
const memoryMonitor = require('./memory-monitor');

// UNIFIED: In-memory storage for upload status - Enhanced for multipart uploads
const uploadStatus = {};

// Socket.io instance (will be set by server.js)
let io;

// Security: Rate limiting for status updates
const statusUpdateLimiter = {
  lastUpdate: {},
  minInterval: 100, // Minimum 100ms between updates for same uploadId
  
  canUpdate(uploadId) {
    const now = Date.now();
    const lastUpdate = this.lastUpdate[uploadId] || 0;
    
    if (now - lastUpdate >= this.minInterval) {
      this.lastUpdate[uploadId] = now;
      return true;
    }
    return false;
  },
  
  cleanup() {
    // Clean up old entries periodically
    const cutoff = Date.now() - (5 * 60 * 1000); // 5 minutes
    for (const [uploadId, timestamp] of Object.entries(this.lastUpdate)) {
      if (timestamp < cutoff) {
        delete this.lastUpdate[uploadId];
      }
    }
  }
};

// Security: Cleanup interval for rate limiter
setInterval(() => {
  statusUpdateLimiter.cleanup();
}, 5 * 60 * 1000); // Every 5 minutes

// Set up socket.io for real-time updates
function setupSocketIO(ioInstance) {
  io = ioInstance;
  logger.info('Socket.io initialized in enhanced secure status utility');
}

// Enhanced cleanup with security considerations
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  Object.keys(uploadStatus).forEach(key => {
    const status = uploadStatus[key];
    
    // Remove statuses older than the configured retention period
    if (status.timestamp && now - status.timestamp > config.upload.statusRetention) {
      // Log cleanup for multipart uploads specifically
      if (status.uploadMethod === 'direct_multipart' || status.uploadMethod === 'multipart') {
        logger.info(`🧹 Cleaning up multipart upload status: ${key} (method: ${status.uploadMethod})`);
      }
      
      delete uploadStatus[key];
      cleanedCount++;
    }
  });
  
  if (cleanedCount > 0) {
    logger.info(`🧹 Cleaned up ${cleanedCount} stale upload statuses`);
  }
}, config.upload.cleanupInterval);

// Get status for a specific upload with security filtering
function getUploadStatus(uploadId) {
  // Input validation
  if (!uploadId || typeof uploadId !== 'string' || uploadId.length > 100) {
    return null;
  }
  
  const status = uploadStatus[uploadId];
  
  if (status) {
    // Security: Remove sensitive information before returning
    const sanitizedStatus = {
      ...status,
      // Remove sensitive fields
      authorizationToken: undefined,
      clientIP: undefined,
      userAgent: undefined,
      internalNotes: undefined
    };
    
    // Add enhanced information for multipart uploads
    if (status.uploadMethod === 'direct_multipart' || status.uploadMethod === 'multipart') {
      return {
        ...sanitizedStatus,
        isMultipart: true,
        supportsResume: true,
        directToB2: true
      };
    }
    
    return sanitizedStatus;
  }
  
  return status;
}

// Create or update upload status - Enhanced for multipart tracking with security
function updateUploadStatus(uploadId, status) {
  try {
    // Input validation
    if (!uploadId || typeof uploadId !== 'string' || uploadId.length > 100) {
      logger.warn('Invalid uploadId provided to updateUploadStatus');
      return null;
    }
    
    // Security: Rate limit status updates
    if (!statusUpdateLimiter.canUpdate(uploadId)) {
      return uploadStatus[uploadId]; // Return existing status without update
    }
    
    // Merge with existing status if available
    const currentStatus = uploadStatus[uploadId] || {};
    
    // Security: Sanitize status input
    const sanitizedStatus = sanitizeStatusInput(status);
    
    uploadStatus[uploadId] = {
      ...currentStatus,
      ...sanitizedStatus,
      timestamp: Date.now(),
      lastUpdated: new Date().toISOString()
    };
    
    // Enhanced logging for multipart uploads
    if (sanitizedStatus.uploadMethod === 'direct_multipart' || sanitizedStatus.uploadMethod === 'multipart') {
      logger.debug(`📊 Multipart status update ${uploadId}:`, {
        status: sanitizedStatus.status,
        stage: sanitizedStatus.stage,
        progress: sanitizedStatus.progress,
        b2FileId: sanitizedStatus.b2FileId ? '✅' : '❌'
      });
    }
    
    // Emit to all clients subscribed to this upload
    if (io) {
      try {
        // Security: Create sanitized status for emission
        const statusToEmit = createEmissionSafeStatus(uploadStatus[uploadId]);
        
        io.to(uploadId).emit('status', statusToEmit);
        
        logger.debug(`📡 Emitted status update for ${uploadId}:`, {
          status: sanitizedStatus.status || 'unknown',
          progress: sanitizedStatus.progress || 0,
          method: sanitizedStatus.uploadMethod || 'unknown',
          hasMetadata: !!sanitizedStatus.metadata
        });
      } catch (error) {
        logger.error(`❌ Failed to emit status update for ${uploadId}:`, error);
      }
    } else {
      logger.warn(`⚠️ Socket.io not initialized, cannot emit status update for ${uploadId}`);
    }
    
    return uploadStatus[uploadId];
    
  } catch (error) {
    logger.error(`❌ Error updating upload status for ${uploadId}:`, error);
    return null;
  }
}

// Initialize a new upload status - Enhanced with upload method detection and security
function initUploadStatus(uploadId, initialData = {}) {
  try {
    // Input validation
    if (!uploadId || typeof uploadId !== 'string' || uploadId.length > 100) {
      throw new Error('Invalid uploadId provided to initUploadStatus');
    }
    
    // Security: Sanitize initial data
    const sanitizedInitialData = sanitizeStatusInput(initialData);
    
    const uploadMethod = sanitizedInitialData.uploadMethod || detectUploadMethod(uploadId, sanitizedInitialData);
    
    const status = {
      status: 'preparing',
      progress: 0,
      stage: 'initializing',
      uploadMethod: uploadMethod,
      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
      ...sanitizedInitialData
    };
    
    uploadStatus[uploadId] = status;
    
    // Enhanced logging based on upload method
    if (uploadMethod === 'direct_multipart' || uploadMethod === 'multipart') {
      logger.info(`🚀 Initialized secure multipart upload status: ${uploadId}`);
    } else {
      logger.debug(`📝 Initialized upload status: ${uploadId} (method: ${uploadMethod})`);
    }
    
    if (io) {
      try {
        const statusToEmit = createEmissionSafeStatus(status);
        
        io.to(uploadId).emit('status', statusToEmit);
        logger.debug(`📡 Emitted initial status for ${uploadId}`);
      } catch (error) {
        logger.error(`❌ Failed to emit initial status for ${uploadId}:`, error);
      }
    }
    
    return status;
    
  } catch (error) {
    logger.error(`❌ Error initializing upload status for ${uploadId}:`, error);
    return null;
  }
}

// Mark upload as complete - Enhanced for different upload methods with security
function completeUploadStatus(uploadId, data = {}) {
  try {
    // Input validation
    if (!uploadId || typeof uploadId !== 'string' || uploadId.length > 100) {
      logger.warn('Invalid uploadId provided to completeUploadStatus');
      return null;
    }
    
    const currentStatus = uploadStatus[uploadId] || {};
    
    // Security: Sanitize completion data
    const sanitizedData = sanitizeStatusInput(data);
    
    // Always ensure these critical flags are set for a complete state
    // CRITICAL FIX: Spread sanitizedData AFTER currentStatus to ensure all data (including metadata) is preserved
    const status = {
      ...currentStatus,
      ...sanitizedData, // This ensures metadata and all other fields from data are included
      status: 'complete',
      progress: 100,
      stage: 'complete',
      uploadComplete: true,
      publishReady: sanitizedData.publishReady !== undefined ? sanitizedData.publishReady : true,
      timestamp: Date.now(),
      completedAt: sanitizedData.completedAt || new Date().toISOString()
    };
    
    uploadStatus[uploadId] = status;
    
    // Enhanced logging based on upload method
    const uploadMethod = status.uploadMethod;
    logger.info(`✅ Upload completed: ${uploadId} (method: ${uploadMethod || 'unknown'})`, {
      hasMetadata: !!status.metadata,
      metadataDuration: status.metadata?.duration || 'none',
      videoUrl: status.videoUrl ? '✅' : '❌',
      thumbnailUrl: status.thumbnailUrl ? '✅' : '❌'
    });
    
    if (io) {
      try {
        const statusToEmit = createEmissionSafeStatus(status);
        
        // Log what we're emitting to debug
        logger.debug(`📡 Emitting completion status for ${uploadId}:`, {
          hasMetadata: !!statusToEmit.metadata,
          metadataFields: statusToEmit.metadata ? Object.keys(statusToEmit.metadata) : [],
          status: statusToEmit.status
        });
        
        // Emit multiple times with increasing delays to ensure delivery for important completion events
        io.to(uploadId).emit('status', statusToEmit);
        
        // Second emit after 500ms for all uploads (to ensure metadata delivery)
        setTimeout(() => {
          try {
            io.to(uploadId).emit('status', statusToEmit);
            logger.debug(`📡 Re-emitted completion status for ${uploadId} (500ms)`);
            
            // Third emit after 2 seconds for extra reliability
            setTimeout(() => {
              try {
                io.to(uploadId).emit('status', statusToEmit);
                logger.debug(`📡 Re-emitted completion status for ${uploadId} (2s)`);
              } catch (thirdError) {
                logger.error(`❌ Failed on third completion emit for ${uploadId}:`, thirdError);
              }
            }, 1500);
          } catch (secondError) {
            logger.error(`❌ Failed on second completion emit for ${uploadId}:`, secondError);
          }
        }, 500);
        
      } catch (error) {
        logger.error(`❌ Failed to emit completion status for ${uploadId}:`, error);
      }
    } else {
      logger.warn(`⚠️ Socket.io not initialized, cannot emit completion for ${uploadId}`);
    }
    
    return status;
    
  } catch (error) {
    logger.error(`❌ Error completing upload status for ${uploadId}:`, error);
    return null;
  }
}

// Mark upload as failed - Enhanced with method-specific error handling and security
function failUploadStatus(uploadId, error) {
  try {
    // Input validation
    if (!uploadId || typeof uploadId !== 'string' || uploadId.length > 100) {
      logger.warn('Invalid uploadId provided to failUploadStatus');
      return null;
    }
    
    const currentStatus = uploadStatus[uploadId] || {};
    
    // Security: Sanitize error information
    const sanitizedError = sanitizeErrorForStatus(error);
    
    const status = {
      ...currentStatus,
      status: 'error',
      error: sanitizedError.message,
      errorDetails: {
        message: sanitizedError.message,
        code: sanitizedError.code,
        timestamp: new Date().toISOString(),
        uploadMethod: currentStatus.uploadMethod || 'unknown',
        // Don't include stack traces in production
        stack: process.env.NODE_ENV === 'development' ? sanitizedError.stack : undefined
      },
      timestamp: Date.now(),
      failedAt: new Date().toISOString()
    };
    
    uploadStatus[uploadId] = status;
    
    // Enhanced error logging based on upload method
    const uploadMethod = status.uploadMethod || currentStatus.uploadMethod;
    if (uploadMethod === 'direct_multipart' || uploadMethod === 'multipart') {
      logger.error(`💥 Multipart upload failed: ${uploadId}`, {
        error: sanitizedError.message,
        b2FileId: currentStatus.b2FileId || 'none',
        stage: currentStatus.stage || 'unknown'
      });
    } else {
      logger.error(`❌ Upload failed: ${uploadId} (method: ${uploadMethod || 'unknown'})`, sanitizedError.message);
    }
    
    if (io) {
      try {
        const statusToEmit = createEmissionSafeStatus(status);
        
        io.to(uploadId).emit('status', statusToEmit);
      } catch (socketError) {
        logger.error(`❌ Failed to emit error status for ${uploadId}:`, socketError);
      }
    } else {
      logger.warn(`⚠️ Socket.io not initialized, cannot emit error for ${uploadId}`);
    }
    
    return status;
    
  } catch (statusError) {
    logger.error(`❌ Error setting upload status to failed for ${uploadId}:`, statusError);
    return null;
  }
}

// Helper function to detect upload method from uploadId and data
function detectUploadMethod(uploadId, initialData) {
  // Check for explicit upload method
  if (initialData.uploadMethod) {
    return initialData.uploadMethod;
  }
  
  // Detect from uploadId pattern
  if (uploadId.startsWith('multipart_')) {
    return 'direct_multipart';
  } else if (uploadId.startsWith('upload_')) {
    return 'formdata';
  } else if (uploadId.startsWith('thumbnail_')) {
    return 'thumbnail';
  } else if (uploadId.includes('chunk')) {
    return 'chunked';
  }
  
  // Default fallback
  return 'unknown';
}

// Helper function to get all statuses (for monitoring) - Enhanced with filtering and security
function getAllStatuses(filter = {}) {
  const { uploadMethod, status, limit = 100 } = filter;
  
  let statuses = Object.entries(uploadStatus).map(([uploadId, status]) => ({
    uploadId,
    ...status
  }));
  
  // Apply filters
  if (uploadMethod) {
    statuses = statuses.filter(s => s.uploadMethod === uploadMethod);
  }
  
  if (status) {
    statuses = statuses.filter(s => s.status === status);
  }
  
  // Security: Remove sensitive information
  statuses = statuses.map(status => ({
    ...status,
    authorizationToken: undefined,
    clientIP: undefined,
    userAgent: undefined,
    internalNotes: undefined
  }));
  
  // Sort by timestamp (newest first) and limit
  statuses = statuses
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, Math.min(limit, 1000)); // Cap at 1000 for security
  
  return statuses;
}

// Get statistics about current uploads - Enhanced for multipart tracking with security
function getUploadStatistics() {
  const allStatuses = Object.values(uploadStatus);
  
  const stats = {
    total: allStatuses.length,
    byMethod: {},
    byStatus: {},
    activeUploads: 0,
    completedUploads: 0,
    failedUploads: 0,
    multipartUploads: 0,
    memoryUsage: {
      statusCount: allStatuses.length,
      estimatedMemoryMB: Math.ceil(JSON.stringify(uploadStatus).length / 1024 / 1024)
    }
  };
  
  allStatuses.forEach(status => {
    // Count by method
    const method = status.uploadMethod || 'unknown';
    stats.byMethod[method] = (stats.byMethod[method] || 0) + 1;
    
    // Count by status
    const statusKey = status.status || 'unknown';
    stats.byStatus[statusKey] = (stats.byStatus[statusKey] || 0) + 1;
    
    // Count special categories
    if (status.status === 'complete') {
      stats.completedUploads++;
    } else if (status.status === 'error') {
      stats.failedUploads++;
    } else {
      stats.activeUploads++;
    }
    
    // Count multipart uploads
    if (method === 'direct_multipart' || method === 'multipart') {
      stats.multipartUploads++;
    }
  });
  
  return {
    ...stats,
    timestamp: new Date().toISOString(),
    memoryUsage: {
      ...stats.memoryUsage,
      system: memoryMonitor.getMemoryInfo()
    }
  };
}

// Clean up specific upload status (manual cleanup) with security
function cleanupUploadStatus(uploadId) {
  // Input validation
  if (!uploadId || typeof uploadId !== 'string' || uploadId.length > 100) {
    return false;
  }
  
  if (uploadStatus[uploadId]) {
    const method = uploadStatus[uploadId].uploadMethod;
    delete uploadStatus[uploadId];
    
    logger.info(`🧹 Manually cleaned up upload status: ${uploadId} (method: ${method})`);
    return true;
  }
  
  return false;
}

// Security: Sanitize status input to prevent injection and data corruption
function sanitizeStatusInput(input) {
  if (!input || typeof input !== 'object') {
    return {};
  }
  
  const sanitized = {};
  
  // Allow only specific fields and sanitize them
  // IMPORTANT: Added more fields to ensure all upload data is preserved
  const allowedFields = [
    'status', 'progress', 'stage', 'uploadMethod', 'fileName', 'fileSize',
    'videoId', 'b2FileId', 'estimatedParts', 'partsUploaded', 'videoUrl',
    'thumbnailUrl', 'backgroundTask', 'publishReady', 'completedAt',
    'errorDetails', 'uploadComplete', 'metadata', 'fileSizeMB'
  ];
  
  allowedFields.forEach(field => {
    if (input.hasOwnProperty(field)) {
      let value = input[field];
      
      // Special handling for metadata object - preserve all fields with proper types
      if (field === 'metadata' && value && typeof value === 'object' && !Array.isArray(value)) {
        // Preserve metadata structure completely - this is critical for frontend
        sanitized[field] = {
          duration: typeof value.duration === 'number' ? parseFloat(value.duration) : (parseFloat(value.duration) || 0),
          width: typeof value.width === 'number' ? parseInt(value.width) : (parseInt(value.width) || 0),
          height: typeof value.height === 'number' ? parseInt(value.height) : (parseInt(value.height) || 0),
          codec: typeof value.codec === 'string' ? String(value.codec).slice(0, 100) : String(value.codec || ''),
          bitrate: typeof value.bitrate === 'number' ? parseInt(value.bitrate) : (parseInt(value.bitrate) || 0),
          size: typeof value.size === 'number' ? parseInt(value.size) : (parseInt(value.size) || 0),
          // Preserve optional fields if they exist
          thumbnailUrl: value.thumbnailUrl ? String(value.thumbnailUrl).slice(0, 500) : undefined,
          videoUrl: value.videoUrl ? String(value.videoUrl).slice(0, 500) : undefined
        };
        return; // Skip the general sanitization for metadata
      }
      
      if (typeof value === 'string') {
        // Sanitize strings
        value = value.trim().slice(0, 2000); // Limit length
      } else if (typeof value === 'number') {
        // Sanitize numbers
        value = Math.max(0, Math.min(value, Number.MAX_SAFE_INTEGER));
      } else if (typeof value === 'boolean') {
        // Booleans are safe
        value = Boolean(value);
      } else if (value && typeof value === 'object') {
        // For objects, do a shallow sanitization
        if (Array.isArray(value)) {
          value = value.slice(0, 100); // Limit array size
        } else {
          // Limit object size and depth
          const limited = {};
          const keys = Object.keys(value).slice(0, 50); // Increased limit for metadata
          keys.forEach(key => {
            if (typeof value[key] === 'string') {
              limited[key] = String(value[key]).slice(0, 1000);
            } else if (typeof value[key] === 'number') {
              limited[key] = Number(value[key]);
            } else if (typeof value[key] === 'boolean') {
              limited[key] = Boolean(value[key]);
            } else if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) {
              // Handle nested objects (but not metadata - that's handled above)
              const nestedLimited = {};
              const nestedKeys = Object.keys(value[key]).slice(0, 20);
              nestedKeys.forEach(nestedKey => {
                if (typeof value[key][nestedKey] === 'string') {
                  nestedLimited[nestedKey] = String(value[key][nestedKey]).slice(0, 500);
                } else if (typeof value[key][nestedKey] === 'number') {
                  nestedLimited[nestedKey] = Number(value[key][nestedKey]);
                } else if (typeof value[key][nestedKey] === 'boolean') {
                  nestedLimited[nestedKey] = Boolean(value[key][nestedKey]);
                }
              });
              limited[key] = nestedLimited;
            }
          });
          value = limited;
        }
      }
      
      sanitized[field] = value;
    }
  });
  
  return sanitized;
}

// Security: Sanitize error information for status storage
function sanitizeErrorForStatus(error) {
  if (!error) {
    return { message: 'Unknown error' };
  }
  
  if (typeof error === 'string') {
    return { 
      message: error.slice(0, 1000), // Limit message length
      code: 'UNKNOWN'
    };
  }
  
  if (error instanceof Error) {
    return {
      message: error.message ? error.message.slice(0, 1000) : 'Unknown error',
      code: error.code || 'UNKNOWN',
      stack: error.stack ? error.stack.slice(0, 2000) : undefined
    };
  }
  
  return { 
    message: String(error).slice(0, 1000),
    code: 'UNKNOWN'
  };
}

// Security: Create emission-safe status object (removes all sensitive data)
function createEmissionSafeStatus(status) {
  if (!status) return null;
  
  // IMPORTANT: Preserve metadata in the emission
  return {
    ...status,
    // Remove ONLY sensitive information (NOT metadata)
    authorizationToken: undefined,
    clientIP: undefined,
    userAgent: undefined,
    internalNotes: undefined,
    serverTimestamp: Date.now(),
    isMultipart: status.uploadMethod === 'direct_multipart' || status.uploadMethod === 'multipart'
    // metadata is preserved by the spread operator
  };
}

module.exports = {
  setupSocketIO,
  getUploadStatus,
  updateUploadStatus,
  initUploadStatus,
  completeUploadStatus,
  failUploadStatus,
  getAllStatuses,
  getUploadStatistics,
  cleanupUploadStatus
};