const fs = require('fs');
const path = require('path');
const { updateUploadStatus, completeUploadStatus } = require('./status');
const ffmpegService = require('../services/ffmpeg');
const b2Service = require('../services/b2');
const supabaseService = require('../services/supabase');
const { generateUniqueFilename, getUploadPath, ensureDirectory } = require('./directory');
const logger = require('./logger');
const memoryMonitor = require('./memory-monitor');

/**
 * Background Upload Processing Queue
 * Handles thumbnail generation and metadata processing for completed uploads
 * Compatible with Gen 7 structure
 */

// In-memory job queue (for simple implementation - can be upgraded to Redis later)
const jobQueue = [];
const activeJobs = new Map();
const completedJobs = new Map();

// Queue configuration
const QUEUE_CONFIG = {
  maxConcurrentJobs: 2,           // Process max 2 thumbnails simultaneously
  jobRetentionTime: 30 * 60 * 1000, // Keep completed job info for 30 minutes
  maxRetryAttempts: 3,            // Retry failed jobs up to 3 times
  retryDelayMs: 5000,             // Wait 5 seconds between retries
  processingIntervalMs: 2000      // Check for new jobs every 2 seconds
};

/**
 * Add a thumbnail generation job to the queue
 * @param {Object} jobData - Job data containing upload information
 * @returns {Promise<Object>} - Job creation result
 */
async function addThumbnailJob(jobData) {
  try {
    const jobId = `thumb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const job = {
      jobId: jobId,
      type: 'thumbnail_generation',
      status: 'queued',
      data: {
        uploadId: jobData.uploadId,
        videoUrl: jobData.videoUrl,
        originalFileName: jobData.originalFileName,
        videoId: jobData.videoId,
        queuedAt: jobData.queuedAt || new Date().toISOString()
      },
      attempts: 0,
      maxAttempts: QUEUE_CONFIG.maxRetryAttempts,
      createdAt: new Date().toISOString(),
      priority: jobData.priority || 'normal'
    };
    
    // Add job to queue
    jobQueue.push(job);
    
    logger.info(`📋 Added thumbnail job to queue: ${jobId} for upload ${jobData.uploadId}`);
    
    // Update upload status to indicate background processing started
    updateUploadStatus(jobData.uploadId, {
      backgroundTask: {
        jobId: jobId,
        status: 'queued',
        type: 'thumbnail_generation'
      }
    });
    
    return {
      jobId: jobId,
      status: 'queued',
      estimatedProcessingTime: '1-2 minutes',
      queuePosition: jobQueue.length
    };
    
  } catch (error) {
    logger.error(`❌ Failed to add thumbnail job:`, error);
    throw error;
  }
}

/**
 * Process the job queue - called by interval timer
 */
async function processQueue() {
  try {
    // Check if we can process more jobs
    if (activeJobs.size >= QUEUE_CONFIG.maxConcurrentJobs) {
      return; // Already at max capacity
    }
    
    // Get next job from queue
    const job = jobQueue.shift();
    if (!job) {
      return; // No jobs to process
    }
    
    // Mark job as active
    activeJobs.set(job.jobId, job);
    job.status = 'processing';
    job.startedAt = new Date().toISOString();
    
    logger.info(`🔄 Processing thumbnail job: ${job.jobId}`);
    
    // Process the job
    try {
      await processThumbnailJob(job);
    } catch (error) {
      await handleJobFailure(job, error);
    }
    
  } catch (error) {
    logger.error(`❌ Queue processing error:`, error);
  }
}

/**
 * Process a single thumbnail generation job
 * @param {Object} job - The job to process
 */
async function processThumbnailJob(job) {
  const { uploadId, videoUrl, originalFileName, videoId } = job.data;
  
  try {
    logger.info(`🖼️ Starting thumbnail generation for ${uploadId}`);
    
    // Update status
    updateUploadStatus(uploadId, {
      backgroundTask: {
        jobId: job.jobId,
        status: 'processing',
        stage: 'generating thumbnail'
      }
    });
    
    // Generate unique thumbnail filename
    const timestamp = uploadId.split('_')[1] || Date.now();
    const baseName = path.basename(originalFileName, path.extname(originalFileName));
    const thumbnailFileName = `${baseName}_${timestamp}.jpg`;
    const thumbnailPath = getUploadPath('thumbs', thumbnailFileName);
    
    // Ensure thumbs directory exists
    await ensureDirectory('uploads/thumbs');
    
    // Generate thumbnail from remote video URL
    await ffmpegService.extractThumbnailFromRemote(videoUrl, thumbnailPath, 5);
    logger.info(`✅ Thumbnail generated: ${thumbnailPath}`);
    
    // Update status
    updateUploadStatus(uploadId, {
      backgroundTask: {
        jobId: job.jobId,
        status: 'uploading_thumbnail',
        stage: 'uploading thumbnail to storage'
      }
    });
    
    // Upload thumbnail to B2
    const thumbnailUrl = await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
    logger.info(`✅ Thumbnail uploaded: ${thumbnailUrl}`);
    
    // Clean up local thumbnail file
    if (fs.existsSync(thumbnailPath)) {
      fs.unlinkSync(thumbnailPath);
      logger.info(`🧹 Local thumbnail cleaned up: ${thumbnailPath}`);
    }
    
    // Update database if videoId provided
    if (videoId && supabaseService) {
      try {
        updateUploadStatus(uploadId, {
          backgroundTask: {
            jobId: job.jobId,
            status: 'updating_database',
            stage: 'updating video metadata'
          }
        });
        
        await supabaseService.updateThumbnail(videoId, thumbnailUrl, {
          processing_completed_at: new Date().toISOString(),
          thumbnail_generated_by: 'background_processor'
        });
        
        logger.info(`✅ Database updated for video ${videoId}`);
      } catch (dbError) {
        logger.warn(`⚠️ Database update failed for ${videoId}:`, dbError.message);
        // Don't fail the entire job for database issues
      }
    }
    
    // Mark job as complete
    await completeJob(job, {
      thumbnailUrl: thumbnailUrl,
      videoUrl: videoUrl,
      processingTime: Date.now() - new Date(job.startedAt).getTime()
    });
    
    memoryMonitor.logMemoryUsage(`After thumbnail job ${job.jobId}`);
    
  } catch (error) {
    logger.error(`❌ Thumbnail job failed for ${uploadId}:`, error);
    throw error;
  }
}

/**
 * Mark a job as successfully completed
 * @param {Object} job - The completed job
 * @param {Object} result - Job completion result
 */
async function completeJob(job, result) {
  const { uploadId } = job.data;
  
  try {
    // Remove from active jobs
    activeJobs.delete(job.jobId);
    
    // Mark job as complete
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.result = result;
    
    // Store in completed jobs for tracking
    completedJobs.set(job.jobId, job);
    
    // Complete the upload status with final data
    completeUploadStatus(uploadId, {
      thumbnailUrl: result.thumbnailUrl,
      videoUrl: result.videoUrl,
      uploadComplete: true,
      publishReady: true,
      processingCompletedAt: job.completedAt,
      backgroundTask: {
        jobId: job.jobId,
        status: 'completed',
        processingTime: `${Math.floor(result.processingTime / 1000)}s`
      }
    });
    
    logger.info(`🎉 Thumbnail job completed successfully: ${job.jobId}`);
    
    // Schedule cleanup of completed job info
    setTimeout(() => {
      completedJobs.delete(job.jobId);
    }, QUEUE_CONFIG.jobRetentionTime);
    
  } catch (error) {
    logger.error(`❌ Failed to complete job ${job.jobId}:`, error);
  }
}

/**
 * Handle job failure with retry logic
 * @param {Object} job - The failed job
 * @param {Error} error - The error that caused failure
 */
async function handleJobFailure(job, error) {
  const { uploadId } = job.data;
  
  try {
    // Remove from active jobs
    activeJobs.delete(job.jobId);
    
    // Increment attempt counter
    job.attempts++;
    job.lastError = error.message;
    job.lastAttemptAt = new Date().toISOString();
    
    logger.warn(`⚠️ Job ${job.jobId} failed (attempt ${job.attempts}/${job.maxAttempts}): ${error.message}`);
    
    // Check if we should retry
    if (job.attempts < job.maxAttempts) {
      // Schedule retry
      job.status = 'retry_scheduled';
      
      updateUploadStatus(uploadId, {
        backgroundTask: {
          jobId: job.jobId,
          status: 'retrying',
          stage: `retry ${job.attempts}/${job.maxAttempts} in ${QUEUE_CONFIG.retryDelayMs/1000}s`,
          error: error.message
        }
      });
      
      setTimeout(() => {
        job.status = 'queued';
        jobQueue.unshift(job); // Add to front of queue for retry
        logger.info(`🔄 Retrying job ${job.jobId} (attempt ${job.attempts + 1}/${job.maxAttempts})`);
      }, QUEUE_CONFIG.retryDelayMs);
      
    } else {
      // Max retries exceeded - mark as failed
      job.status = 'failed';
      job.failedAt = new Date().toISOString();
      
      completedJobs.set(job.jobId, job);
      
      updateUploadStatus(uploadId, {
        backgroundTask: {
          jobId: job.jobId,
          status: 'failed',
          stage: 'thumbnail generation failed after retries',
          error: error.message,
          attempts: job.attempts
        },
        // Don't fail the entire upload for thumbnail issues
        thumbnailUrl: null,
        thumbnailStatus: 'failed'
      });
      
      logger.error(`❌ Job ${job.jobId} failed permanently after ${job.attempts} attempts`);
      
      // Schedule cleanup
      setTimeout(() => {
        completedJobs.delete(job.jobId);
      }, QUEUE_CONFIG.jobRetentionTime);
    }
    
  } catch (error) {
    logger.error(`❌ Failed to handle job failure for ${job.jobId}:`, error);
  }
}

/**
 * Get job status
 * @param {string} jobId - Job ID to check
 * @returns {Object|null} - Job status or null if not found
 */
function getJobStatus(jobId) {
  // Check active jobs
  if (activeJobs.has(jobId)) {
    return activeJobs.get(jobId);
  }
  
  // Check completed jobs
  if (completedJobs.has(jobId)) {
    return completedJobs.get(jobId);
  }
  
  // Check queued jobs
  const queuedJob = jobQueue.find(job => job.jobId === jobId);
  if (queuedJob) {
    return queuedJob;
  }
  
  return null;
}

/**
 * Get queue statistics
 * @returns {Object} - Queue status information
 */
function getQueueStats() {
  return {
    queued: jobQueue.length,
    active: activeJobs.size,
    completed: completedJobs.size,
    maxConcurrent: QUEUE_CONFIG.maxConcurrentJobs,
    queuedJobs: jobQueue.map(job => ({
      jobId: job.jobId,
      uploadId: job.data.uploadId,
      queuedAt: job.createdAt,
      attempts: job.attempts
    })),
    activeJobs: Array.from(activeJobs.values()).map(job => ({
      jobId: job.jobId,
      uploadId: job.data.uploadId,
      startedAt: job.startedAt,
      attempts: job.attempts
    }))
  };
}

/**
 * Initialize the queue processor
 */
function initializeQueue() {
  logger.info('🚀 Initializing background upload queue processor...');
  
  // Start queue processing interval
  const processingInterval = setInterval(processQueue, QUEUE_CONFIG.processingIntervalMs);
  
  // Cleanup interval for old completed jobs
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    const expiredJobs = [];
    
    for (const [jobId, job] of completedJobs.entries()) {
      const completedTime = new Date(job.completedAt || job.failedAt).getTime();
      if (now - completedTime > QUEUE_CONFIG.jobRetentionTime) {
        expiredJobs.push(jobId);
      }
    }
    
    expiredJobs.forEach(jobId => {
      completedJobs.delete(jobId);
    });
    
    if (expiredJobs.length > 0) {
      logger.debug(`🧹 Cleaned up ${expiredJobs.length} expired job records`);
    }
  }, 5 * 60 * 1000); // Cleanup every 5 minutes
  
  logger.info(`✅ Queue processor initialized (${QUEUE_CONFIG.maxConcurrentJobs} concurrent jobs, ${QUEUE_CONFIG.processingIntervalMs}ms interval)`);
  
  return {
    stop: () => {
      clearInterval(processingInterval);
      clearInterval(cleanupInterval);
      logger.info('🛑 Background queue processor stopped');
    }
  };
}

module.exports = {
  addThumbnailJob,
  getJobStatus,
  getQueueStats,
  initializeQueue,
  QUEUE_CONFIG
};