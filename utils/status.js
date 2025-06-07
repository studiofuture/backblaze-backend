const { config } = require('../config');
const logger = require('./logger');
const memoryMonitor = require('./memory-monitor');

// In-memory storage for upload status
const uploadStatus = {};

// Socket.io instance (will be set by server.js)
let io;

// Set up socket.io for real-time updates
function setupSocketIO(ioInstance) {
  io = ioInstance;
  logger.info('Socket.io initialized in status utility');
}

// Clean up old statuses periodically
setInterval(() => {
  const now = Date.now();
  Object.keys(uploadStatus).forEach(key => {
    // Remove statuses older than the configured retention period
    if (uploadStatus[key].timestamp && now - uploadStatus[key].timestamp > config.upload.statusRetention) {
      delete uploadStatus[key];
      logger.info(`Cleaned up stale upload status: ${key}`);
    }
  });
}, config.upload.cleanupInterval);

// Get status for a specific upload
function getUploadStatus(uploadId) {
  return uploadStatus[uploadId];
}

// Create or update upload status
function updateUploadStatus(uploadId, status) {
  // Merge with existing status if available
  uploadStatus[uploadId] = {
    ...(uploadStatus[uploadId] || {}),
    ...status,
    timestamp: Date.now()
  };
  
  // Emit to all clients subscribed to this upload
  if (io) {
    try {
      io.to(uploadId).emit('status', uploadStatus[uploadId]);
      logger.debug(`Emitted status update for ${uploadId}:`, status);
    } catch (error) {
      logger.error(`Failed to emit status update for ${uploadId}:`, error);
    }
  } else {
    logger.warn(`Socket.io not initialized, cannot emit status update for ${uploadId}`);
  }
  
  return uploadStatus[uploadId];
}

// Initialize a new upload status
function initUploadStatus(uploadId, initialData = {}) {
  const status = {
    status: 'preparing',
    progress: 0,
    stage: 'initializing',
    timestamp: Date.now(),
    ...initialData
  };
  
  uploadStatus[uploadId] = status;
  
  if (io) {
    try {
      io.to(uploadId).emit('status', status);
      logger.debug(`Emitted initial status for ${uploadId}`);
    } catch (error) {
      logger.error(`Failed to emit initial status for ${uploadId}:`, error);
    }
  }
  
  return status;
}

// Mark upload as complete
function completeUploadStatus(uploadId, data = {}) {
  // Always ensure these critical flags are set for a complete state
  const status = {
    ...(uploadStatus[uploadId] || {}),
    ...data,
    status: 'complete',
    progress: 100,
    stage: 'complete',
    uploadComplete: true,
    publishReady: true,
    timestamp: Date.now()
  };
  
  uploadStatus[uploadId] = status;
  
  if (io) {
    try {
      // Emit multiple times with increasing delays to ensure delivery
      // First immediate emit
      io.to(uploadId).emit('status', status);
      logger.info(`Upload complete: ${uploadId}, emitted status update`);
      
      // Second emit after 500ms
      setTimeout(() => {
        try {
          io.to(uploadId).emit('status', status);
          logger.info(`Re-emitted completion status for ${uploadId} (500ms)`);
          
          // Third emit after 2 seconds
          setTimeout(() => {
            try {
              io.to(uploadId).emit('status', status);
              logger.info(`Re-emitted completion status for ${uploadId} (2s)`);
            } catch (thirdError) {
              logger.error(`Failed on third completion emit for ${uploadId}:`, thirdError);
            }
          }, 1500);
        } catch (secondError) {
          logger.error(`Failed on second completion emit for ${uploadId}:`, secondError);
        }
      }, 500);
    } catch (error) {
      logger.error(`Failed to emit completion status for ${uploadId}:`, error);
    }
  } else {
    logger.warn(`Socket.io not initialized, cannot emit completion for ${uploadId}`);
  }
  
  return status;
}

// Mark upload as failed
function failUploadStatus(uploadId, error) {
  const status = {
    ...(uploadStatus[uploadId] || {}),
    status: 'error',
    error: error.message || String(error),
    timestamp: Date.now()
  };
  
  uploadStatus[uploadId] = status;
  
  if (io) {
    try {
      io.to(uploadId).emit('status', status);
      logger.error(`Upload failed: ${uploadId}`, error);
    } catch (socketError) {
      logger.error(`Failed to emit error status for ${uploadId}:`, socketError);
    }
  } else {
    logger.warn(`Socket.io not initialized, cannot emit error for ${uploadId}`);
  }
  
  return status;
}

// Helper function to get all statuses (for monitoring)
function getAllStatuses() {
  return uploadStatus;
}

module.exports = {
  setupSocketIO,
  getUploadStatus,
  updateUploadStatus,
  initUploadStatus,
  completeUploadStatus,
  failUploadStatus,
  getAllStatuses  // Add this line
};
