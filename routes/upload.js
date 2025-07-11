const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { 
  initUploadStatus, 
  updateUploadStatus, 
  completeUploadStatus, 
  failUploadStatus,
  getUploadStatus
} = require('../utils/status');
const { generateUniqueFilename, getUploadPath, ensureDirectory } = require('../utils/directory');

// Import BOTH existing services AND new streaming multipart services
const formdataHandler = require('../services/formdata-handler');
const chunkAssembler = require('../services/chunk-assembler');
const uploadProcessor = require('../services/upload-processor');
const b2Service = require('../services/b2');
const ffmpegService = require('../services/ffmpeg');
const multipartUploader = require('../services/multipart-uploader'); // Now streaming proxy version

// Security: Rate limiting configurations
const strictRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 multipart initializations per IP per 15 minutes
  message: {
    error: 'Too many upload attempts. Please wait before trying again.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const moderateRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000, // 2000 requests per IP per 15 minutes
  message: {
    error: 'Too many requests. Please slow down.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300, // 300 requests per IP per minute
  message: {
    error: 'Too many requests. Please wait.',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Feature flag for multipart uploads (can be controlled via environment variable)
const ENABLE_MULTIPART_UPLOADS = process.env.ENABLE_MULTIPART_UPLOADS !== 'false';

// Security: Input validation middleware
const validateUploadInput = (req, res, next) => {
  try {
    // Validate content length for security
    const contentLength = parseInt(req.headers['content-length'] || '0');
    const maxSize = 100 * 1024 * 1024 * 1024; // 100GB
    
    if (contentLength > maxSize) {
      return res.status(413).json({
        error: 'File too large',
        maxSize: '100GB'
      });
    }
    
    // Validate user agent (basic bot protection)
    const userAgent = req.headers['user-agent'];
    if (!userAgent || userAgent.length < 10) {
      return res.status(400).json({
        error: 'Invalid request'
      });
    }
    
    next();
  } catch (error) {
    res.status(400).json({
      error: 'Invalid request headers'
    });
  }
};

// Security: Sanitize input data
const sanitizeInput = (data) => {
  if (typeof data === 'string') {
    return data.trim().slice(0, 1000); // Limit string length
  }
  if (typeof data === 'number') {
    return Math.max(0, Math.min(data, Number.MAX_SAFE_INTEGER));
  }
  return data;
};

// DEBUG: Check logger configuration
console.log('🔧 DEBUG: LOG_LEVEL =', process.env.LOG_LEVEL);
console.log('🔧 DEBUG: NODE_ENV =', process.env.NODE_ENV);
console.log('🔧 DEBUG: MULTIPART_UPLOADS =', ENABLE_MULTIPART_UPLOADS);

// ============================================================================
// EXISTING FUNCTIONALITY - PRESERVED UNCHANGED
// ============================================================================

/**
 * EXISTING: FORMDATA UPLOAD ROUTE
 * POST /upload/video
 * MODIFIED: Returns metadata in response
 */
router.post('/video', generalRateLimit, validateUploadInput, async (req, res) => {
  let uploadId;
  
  try {
    uploadId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`🚀 FormData upload started: ${uploadId}`);
    
    // Process upload using FormData handler service
    const result = await formdataHandler.handleFormDataUpload(req, uploadId);
    
    console.log(`✅ FormData upload completed: ${uploadId}`);
    res.json({
      status: "success",
      uploadId,
      message: "Upload completed successfully",
      url: result.videoUrl,
      // Include metadata in response
      metadata: result.metadata || {
        duration: 0,
        width: 0,
        height: 0,
        codec: '',
        bitrate: 0,
        size: 0
      },
      thumbnailUrl: result.thumbnailUrl || null,
      ...result
    });
    
  } catch (error) {
    console.error(`❌ FormData upload failed: ${error.message}`);
    
    if (uploadId) {
      failUploadStatus(uploadId, error);
    }
    
    res.status(500).json({ 
      error: error.message,
      uploadId: uploadId || 'unknown'
    });
  }
});

/**
 * EXISTING: RAW CHUNK UPLOAD ROUTE
 * POST /upload/chunk
 * Receives individual raw binary chunks - UNCHANGED
 */
router.post('/chunk', moderateRateLimit, validateUploadInput, async (req, res) => {
  try {
    const uploadId = sanitizeInput(req.headers['x-upload-id']);
    const chunkIndex = parseInt(sanitizeInput(req.headers['x-chunk-index']));
    const totalChunks = parseInt(sanitizeInput(req.headers['x-total-chunks']));
    
    console.log(`📦 Receiving chunk ${chunkIndex}/${totalChunks} for upload ${uploadId}`);
    
    // Validate headers
    if (!uploadId || chunkIndex === undefined || !totalChunks) {
      return res.status(400).json({
        error: 'Missing required headers: x-upload-id, x-chunk-index, x-total-chunks'
      });
    }
    
    // Security: Validate chunk index bounds
    if (chunkIndex < 0 || chunkIndex >= totalChunks || totalChunks > 10000) {
      return res.status(400).json({
        error: 'Invalid chunk parameters'
      });
    }
    
    // Process chunk using chunk assembler service
    await chunkAssembler.saveChunk(req, uploadId, chunkIndex, totalChunks);
    
    console.log(`✅ Chunk ${chunkIndex} saved successfully`);
    res.json({
      success: true,
      chunkIndex,
      message: `Chunk ${chunkIndex} received successfully`
    });
    
  } catch (error) {
    console.error(`❌ Chunk upload error:`, error);
    res.status(500).json({
      error: 'Chunk upload failed',
      details: error.message
    });
  }
});

/**
 * EXISTING: COMPLETE CHUNKS ROUTE
 * POST /upload/complete-chunks
 * Assembles chunks and processes video - ENHANCED WITH SECURITY
 */
router.post('/complete-chunks', moderateRateLimit, async (req, res) => {
  let uploadId;
  
  try {
    console.log('📋 Complete chunks request body:', req.body);
    
    const { 
      uploadId: reqUploadId, 
      totalChunks, 
      originalFilename, 
      videoId 
    } = req.body;
    
    // Sanitize inputs
    uploadId = sanitizeInput(reqUploadId);
    const sanitizedTotalChunks = sanitizeInput(totalChunks);
    const sanitizedFilename = sanitizeInput(originalFilename);
    const sanitizedVideoId = sanitizeInput(videoId);
    
    console.log('📋 Extracted fields:', {
      uploadId,
      totalChunks: sanitizedTotalChunks,
      originalFilename: sanitizedFilename,
      videoId: sanitizedVideoId
    });
    
    // Validate request body
    if (!uploadId || !sanitizedTotalChunks || !sanitizedFilename) {
      return res.status(400).json({
        error: 'Missing required fields: uploadId, totalChunks, originalFilename',
        received: { 
          uploadId: !!uploadId, 
          totalChunks: !!sanitizedTotalChunks, 
          originalFilename: !!sanitizedFilename 
        }
      });
    }
    
    // Security: Validate totalChunks bounds
    if (sanitizedTotalChunks < 1 || sanitizedTotalChunks > 10000) {
      return res.status(400).json({
        error: 'Invalid totalChunks value. Must be between 1 and 10000.'
      });
    }
    
    console.log(`🔄 Starting chunk assembly for upload ${uploadId}`);
    
    // Initialize processing status
    initUploadStatus(uploadId, {
      status: 'assembling',
      stage: 'assembling chunks into final file',
      progress: 55
    });
    
    // Assemble chunks using chunk assembler service
    const finalFilePath = await chunkAssembler.assembleChunks(uploadId, sanitizedTotalChunks, sanitizedFilename);
    console.log(`✅ Chunks assembled into: ${finalFilePath}`);
    
    // Process the assembled file using upload processor service
    const result = await uploadProcessor.processVideo(uploadId, finalFilePath, sanitizedFilename, sanitizedVideoId);
    
    console.log(`✅ Chunked upload processing completed: ${uploadId}`);
    res.json({
      status: "success",
      uploadId,
      message: "Chunked upload completed successfully",
      url: result.videoUrl,
      ...result
    });
    
  } catch (error) {
    console.error(`❌ Complete chunks processing failed:`, error);
    
    if (uploadId) {
      failUploadStatus(uploadId, error);
    }
    
    res.status(500).json({
      error: error.message,
      uploadId: uploadId || 'unknown'
    });
  }
});

// ============================================================================
// NEW STREAMING PROXY MULTIPART UPLOAD FUNCTIONALITY
// ============================================================================

/**
 * NEW: Initialize Streaming Proxy B2 Multipart Upload
 * POST /upload/multipart/initialize
 * Sets up B2 upload but returns server endpoints instead of B2 URLs
 */
router.post('/multipart/initialize', strictRateLimit, validateUploadInput, async (req, res) => {
  // Check if multipart uploads are enabled
  if (!ENABLE_MULTIPART_UPLOADS) {
    return res.status(503).json({
      error: 'Multipart uploads are currently disabled',
      fallback: 'Use /upload/video for FormData uploads or /upload/chunk for chunked uploads'
    });
  }
  
  let uploadId;
  
  try {
    const { fileName, fileSize, contentType, videoId, chunkSize } = req.body;
    
    // Sanitize inputs
    const sanitizedFileName = sanitizeInput(fileName);
    const sanitizedFileSize = sanitizeInput(fileSize);
    const sanitizedContentType = sanitizeInput(contentType);
    const sanitizedVideoId = sanitizeInput(videoId);
    const sanitizedChunkSize = sanitizeInput(chunkSize);
    
    // Validate required fields
    if (!sanitizedFileName || !sanitizedFileSize) {
      return res.status(400).json({
        error: 'Missing required fields: fileName and fileSize are required',
        received: { fileName: !!sanitizedFileName, fileSize: !!sanitizedFileSize }
      });
    }
    
    // Security: Validate file size bounds
    const maxFileSize = 100 * 1024 * 1024 * 1024; // 100GB
    const minFileSize = 1024; // 1KB
    
    if (sanitizedFileSize < minFileSize || sanitizedFileSize > maxFileSize) {
      return res.status(400).json({
        error: `File size must be between ${minFileSize} bytes and ${maxFileSize} bytes`,
        received: sanitizedFileSize
      });
    }
    
    // Security: Validate filename
    if (sanitizedFileName.length < 1 || sanitizedFileName.length > 255) {
      return res.status(400).json({
        error: 'Filename must be between 1 and 255 characters'
      });
    }
    
    // Generate unique upload ID with more entropy
    uploadId = `multipart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${Math.random().toString(36).substr(2, 9)}`;
    
    console.log(`🚀 Initializing streaming proxy multipart upload: ${uploadId} for ${sanitizedFileName} (${Math.floor(sanitizedFileSize / 1024 / 1024)}MB)`);
    
    // Initialize upload status tracking
    initUploadStatus(uploadId, {
      status: 'initializing',
      uploadMethod: 'streaming_proxy',
      fileName: sanitizedFileName,
      fileSize: sanitizedFileSize,
      videoId: sanitizedVideoId,
      progress: 5,
      clientIP: req.ip,
      userAgent: req.headers['user-agent']
    });
    
    // Initialize B2 large file upload with streaming proxy
    const b2Result = await multipartUploader.initializeMultipartUpload(
      uploadId,
      sanitizedFileName,
      sanitizedContentType || 'video/mp4',
      null, // Use default bucket
      { clientIP: req.ip }
    );
    
    // Calculate estimated parts
    const defaultChunkSize = sanitizedChunkSize || (25 * 1024 * 1024); // 25MB default
    const estimatedParts = Math.ceil(sanitizedFileSize / defaultChunkSize);
    
    // Update status with B2 information
    updateUploadStatus(uploadId, {
      status: 'ready_for_upload',
      stage: 'ready for streaming proxy chunk uploads',
      progress: 10,
      b2FileId: b2Result.b2FileId,
      fileName: b2Result.fileName,
      estimatedParts: estimatedParts
    });
    
    console.log(`✅ Streaming proxy multipart upload initialized: ${uploadId}`);
    
    res.json({
      success: true,
      uploadId: uploadId,
      b2FileId: b2Result.b2FileId,
      fileName: b2Result.fileName,
      estimatedParts: estimatedParts,
      maxPartSize: 5 * 1024 * 1024 * 1024, // 5GB B2 limit
      message: 'Streaming proxy multipart upload initialized successfully',
      instructions: {
        step1: 'Upload chunks to /upload/multipart/stream-chunk',
        step2: 'Server will stream chunks directly to B2 (no CORS issues)',
        step3: 'Call /upload/multipart/complete when all chunks are uploaded',
        step4: 'Monitor progress via WebSocket or /upload/status endpoint',
        benefits: 'Low server memory usage via streaming proxy'
      }
    });
    
  } catch (error) {
    console.error(`❌ Failed to initialize streaming proxy multipart upload:`, error);
    
    if (uploadId) {
      failUploadStatus(uploadId, error);
    }
    
    res.status(500).json({
      error: 'Failed to initialize streaming proxy multipart upload',
      details: error.message,
      uploadId: uploadId || null,
      fallback: 'Try using /upload/video for FormData uploads'
    });
  }
});

/**
 * NEW: Stream Chunk to B2 (Proxy Upload)
 * POST /upload/multipart/stream-chunk
 * Receives chunk from browser and streams directly to B2
 */
router.post('/multipart/stream-chunk', moderateRateLimit, validateUploadInput, async (req, res) => {
  try {
    const uploadId = sanitizeInput(req.headers['x-upload-id']);
    const b2FileId = sanitizeInput(req.headers['x-b2-file-id']);
    const partNumber = parseInt(sanitizeInput(req.headers['x-part-number']));
    
    // Validate required headers
    if (!uploadId || !b2FileId || !partNumber) {
      return res.status(400).json({
        error: 'Missing required headers: x-upload-id, x-b2-file-id, x-part-number'
      });
    }
    
    // Security: Validate part number bounds
    if (partNumber < 1 || partNumber > 10000) {
      return res.status(400).json({
        error: 'Part number must be between 1 and 10000'
      });
    }
    
    console.log(`📤 Streaming chunk ${partNumber} to B2 for ${uploadId}`);
    
    // Validate upload exists and is in correct state
    const uploadStatus = getUploadStatus(uploadId);
    if (!uploadStatus) {
      return res.status(404).json({
        error: 'Upload not found or expired',
        uploadId: uploadId
      });
    }
    
    if (uploadStatus.status === 'complete' || uploadStatus.status === 'error') {
      return res.status(400).json({
        error: `Upload is in ${uploadStatus.status} state and cannot accept new chunks`,
        uploadId: uploadId
      });
    }
    
    updateUploadStatus(uploadId, {
      stage: `streaming chunk ${partNumber} to B2`,
      progress: Math.min(90, 10 + (partNumber * 2))
    });
    
    // Stream the chunk directly to B2 using request body
    const streamResult = await multipartUploader.streamChunkToB2(
      uploadId,
      b2FileId,
      partNumber,
      req, // Pass the request stream directly
      { clientIP: req.ip }
    );
    
    console.log(`✅ Successfully streamed chunk ${partNumber} to B2`);
    
    res.json({
      success: true,
      uploadId: uploadId,
      partNumber: partNumber,
      sha1: streamResult.sha1,
      size: streamResult.size,
      message: `Chunk ${partNumber} streamed to B2 successfully`
    });
    
  } catch (error) {
    console.error(`❌ Failed to stream chunk to B2:`, error);
    
    res.status(500).json({
      error: 'Failed to stream chunk to B2',
      details: error.message
    });
  }
});

/**
 * Complete Streaming Proxy Multipart Upload
 * POST /upload/multipart/complete
 * MODIFIED: Returns metadata in response
 */
router.post('/multipart/complete', moderateRateLimit, async (req, res) => {
  try {
    const { uploadId, b2FileId, totalParts, originalFileName, videoId } = req.body;
    
    // Sanitize inputs
    const sanitizedUploadId = sanitizeInput(uploadId);
    const sanitizedB2FileId = sanitizeInput(b2FileId);
    const sanitizedTotalParts = sanitizeInput(totalParts);
    const sanitizedOriginalFileName = sanitizeInput(originalFileName);
    const sanitizedVideoId = sanitizeInput(videoId);
    
    // Validate required fields
    if (!sanitizedUploadId || !sanitizedB2FileId || !sanitizedTotalParts || !sanitizedOriginalFileName) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['uploadId', 'b2FileId', 'totalParts', 'originalFileName'],
        received: {
          uploadId: !!sanitizedUploadId,
          b2FileId: !!sanitizedB2FileId,
          totalParts: !!sanitizedTotalParts,
          originalFileName: !!sanitizedOriginalFileName
        }
      });
    }
    
    // Validate totalParts
    if (sanitizedTotalParts < 1 || sanitizedTotalParts > 10000) {
      return res.status(400).json({
        error: 'Invalid totalParts value. Must be between 1 and 10000.'
      });
    }
    
    console.log(`🏁 Completing streaming proxy multipart upload ${sanitizedUploadId} with ${sanitizedTotalParts} parts`);
    
    // Validate upload exists and is in correct state
    const uploadStatus = getUploadStatus(sanitizedUploadId);
    if (!uploadStatus) {
      return res.status(404).json({
        error: 'Upload not found or expired',
        uploadId: sanitizedUploadId
      });
    }
    
    if (uploadStatus.status === 'complete') {
      return res.status(400).json({
        error: 'Upload already completed',
        uploadId: sanitizedUploadId,
        existingResult: {
          status: uploadStatus.status,
          videoUrl: uploadStatus.videoUrl
        }
      });
    }
    
    updateUploadStatus(sanitizedUploadId, {
      status: 'finalizing',
      stage: 'finalizing B2 multipart upload',
      progress: 95
    });
    
    // Complete the multipart upload (now includes metadata extraction)
    const result = await multipartUploader.completeMultipartUpload(
      sanitizedUploadId,
      sanitizedB2FileId,
      sanitizedTotalParts,
      sanitizedOriginalFileName,
      sanitizedVideoId,
      { clientIP: req.ip }
    );
    
    console.log(`✅ B2 upload finalized with metadata: ${result.videoUrl}`);
    
    // Mark upload as complete with all data
    completeUploadStatus(sanitizedUploadId, {
      videoUrl: result.videoUrl,
      fileName: result.fileName,
      uploadMethod: 'streaming_proxy',
      partsUploaded: sanitizedTotalParts,
      publishReady: true,
      completedAt: new Date().toISOString(),
      fileSize: result.fileSize,
      metadata: result.metadata,
      thumbnailUrl: result.thumbnailUrl
    });
    
    console.log(`🎉 Streaming proxy multipart upload completed successfully: ${sanitizedUploadId}`);
    
    // Return response with metadata
    res.json({
      success: true,
      uploadId: sanitizedUploadId,
      videoUrl: result.videoUrl,
      fileName: result.fileName,
      partsUploaded: sanitizedTotalParts,
      fileSize: result.fileSize,
      publishReady: true,
      // Include metadata in response for frontend
      metadata: result.metadata,
      thumbnailUrl: result.thumbnailUrl,
      message: 'Upload completed successfully with metadata extracted'
    });
    
  } catch (error) {
    console.error(`❌ Failed to complete streaming proxy multipart upload:`, error);
    
    const { uploadId } = req.body;
    if (uploadId) {
      failUploadStatus(sanitizeInput(uploadId), error);
    }
    
    res.status(500).json({
      error: 'Failed to complete streaming proxy multipart upload',
      details: error.message,
      uploadId: uploadId || null
    });
  }
});

/**
 * NEW: Cancel Streaming Proxy Multipart Upload
 * POST /upload/multipart/cancel
 * Cancels B2 upload and cleans up resources
 */
router.post('/multipart/cancel', moderateRateLimit, async (req, res) => {
  try {
    const { uploadId, b2FileId } = req.body;
    
    // Sanitize inputs
    const sanitizedUploadId = sanitizeInput(uploadId);
    const sanitizedB2FileId = sanitizeInput(b2FileId);
    
    if (!sanitizedUploadId || !sanitizedB2FileId) {
      return res.status(400).json({
        error: 'Missing required fields: uploadId and b2FileId are required'
      });
    }
    
    console.log(`🛑 Cancelling streaming proxy multipart upload ${sanitizedUploadId}`);
    
    // Cancel the B2 multipart upload
    const cancelled = await multipartUploader.cancelMultipartUpload(
      sanitizedUploadId, 
      sanitizedB2FileId,
      { clientIP: req.ip }
    );
    
    if (cancelled) {
      console.log(`✅ Successfully cancelled upload ${sanitizedUploadId}`);
      
      res.json({
        success: true,
        uploadId: sanitizedUploadId,
        message: 'Upload cancelled successfully'
      });
    } else {
      res.status(500).json({
        error: 'Failed to cancel upload',
        uploadId: sanitizedUploadId
      });
    }
    
  } catch (error) {
    console.error(`❌ Failed to cancel streaming proxy multipart upload:`, error);
    
    res.status(500).json({
      error: 'Failed to cancel upload',
      details: error.message
    });
  }
});

// ============================================================================
// EXISTING FUNCTIONALITY CONTINUED - PRESERVED WITH SECURITY ENHANCEMENTS
// ============================================================================

/**
 * EXISTING: GENERATE THUMBNAIL ROUTE
 * POST /upload/generate-thumbnail
 * Generates thumbnail from video URL - ENHANCED WITH SECURITY
 */
router.post('/generate-thumbnail', moderateRateLimit, async (req, res) => {
  try {
    const { videoUrl, seekTime = 5 } = req.body;
    
    // Sanitize inputs
    const sanitizedVideoUrl = sanitizeInput(videoUrl);
    const sanitizedSeekTime = Math.max(0, Math.min(sanitizeInput(seekTime), 3600)); // Max 1 hour
    
    console.log(`🖼️ Thumbnail generation requested for: ${sanitizedVideoUrl}`);
    
    if (!sanitizedVideoUrl) {
      return res.status(400).json({
        error: 'Video URL is required',
        message: 'Please provide a videoUrl in the request body'
      });
    }
    
    // Security: Validate URL format (basic check)
    try {
      new URL(sanitizedVideoUrl);
    } catch {
      return res.status(400).json({
        error: 'Invalid video URL format'
      });
    }
    
    // Extract filename from URL for thumbnail naming
    const urlParts = sanitizedVideoUrl.split('/');
    const filename = urlParts[urlParts.length - 1];
    const baseName = path.basename(filename, path.extname(filename));
    const thumbnailFileName = `${baseName}_${Date.now()}.jpg`;
    const thumbnailPath = getUploadPath('thumbs', thumbnailFileName);
    
    // Ensure thumbs directory exists
    await ensureDirectory('uploads/thumbs');
    
    // Generate thumbnail from remote video URL
    await ffmpegService.extractThumbnailFromRemote(sanitizedVideoUrl, thumbnailPath, sanitizedSeekTime);
    console.log(`✅ Thumbnail generated from remote URL: ${thumbnailPath}`);
    
    // Upload thumbnail to B2
    const thumbnailUrl = await b2Service.uploadThumbnail(thumbnailPath, thumbnailFileName);
    console.log(`✅ Thumbnail uploaded to B2: ${thumbnailUrl}`);
    
    // Clean up local thumbnail
    if (fs.existsSync(thumbnailPath)) {
      fs.unlinkSync(thumbnailPath);
      console.log(`🧹 Local thumbnail cleaned up: ${thumbnailPath}`);
    }
    
    res.json({
      success: true,
      thumbnailUrl,
      message: 'Thumbnail generated successfully',
      seekTime: sanitizedSeekTime,
      originalVideo: sanitizedVideoUrl
    });
    
  } catch (error) {
    console.error(`❌ Thumbnail generation failed: ${error.message}`);
    res.status(500).json({
      error: 'Thumbnail generation failed',
      details: error.message,
      message: 'Could not generate thumbnail from video'
    });
  }
});

/**
 * EXISTING: CUSTOM THUMBNAIL UPLOAD ROUTE
 * POST /upload/thumbnail
 * Handles user-uploaded custom thumbnail images - ENHANCED WITH SECURITY
 */
router.post('/thumbnail', moderateRateLimit, validateUploadInput, async (req, res) => {
  let uploadId;

  try {
    uploadId = `thumbnail_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    console.log(`🖼️ Custom thumbnail upload started: ${uploadId}`);

    // Directory setup
    await ensureDirectory('uploads');
    await ensureDirectory('uploads/thumbs');

    // Busboy setup for image uploads with security limits
    const busboy = require('busboy');
    const bb = busboy({
      headers: req.headers,
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB max for images
        files: 1,
        fields: 10,
        fieldSize: 1024 * 1024
      }
    });

    let fileReceived = false;
    let filename;
    let originalName;
    let tempFilePath;
    let writeStream;
    let formFields = {};

    // File handler with security validation
    bb.on('file', (fieldname, file, info) => {
      console.log(`📥 Thumbnail file handler triggered:`, {
        fieldname,
        filename: info.filename,
        mimeType: info.mimeType,
        encoding: info.encoding
      });

      try {
        // Accept common field names for thumbnails
        const validFieldNames = ['thumbnail', 'image', 'file', 'upload'];
        if (!validFieldNames.includes(fieldname)) {
          console.warn(`⚠️ Unexpected field name: ${fieldname}. Rejecting.`);
          return res.status(400).json({
            error: 'Invalid field name for thumbnail upload'
          });
        }

        fileReceived = true;
        originalName = sanitizeInput(info.filename);
        filename = generateUniqueFilename(originalName);
        tempFilePath = getUploadPath('thumbs', filename);

        console.log(`📁 Processing thumbnail: ${originalName} -> ${filename}`);

        // Security: Image type validation
        const validImageTypes = [
          'image/jpeg', 'image/jpg', 'image/png', 'image/webp'
        ];

        if (!validImageTypes.includes(info.mimeType)) {
          const error = new Error(`Invalid image type: ${info.mimeType}. Only JPEG, PNG, and WebP images are allowed.`);
          console.error(`❌ ${error.message}`);
          return res.status(400).json({
            error: error.message
          });
        }

        // Create write stream with error handling
        writeStream = fs.createWriteStream(tempFilePath);

        writeStream.on('error', (streamError) => {
          console.error(`❌ Thumbnail write stream error: ${streamError.message}`);
          res.status(500).json({
            error: 'File write error',
            uploadId
          });
        });

        // File data handling with size monitoring
        let totalBytes = 0;
        file.on('data', (chunk) => {
          totalBytes += chunk.length;
          
          // Security: Additional size check during upload
          if (totalBytes > 10 * 1024 * 1024) {
            file.destroy();
            writeStream.destroy();
            return res.status(413).json({
              error: 'Thumbnail file too large (max 10MB)'
            });
          }
        });

        file.on('end', () => {
          console.log(`✅ Thumbnail file stream ended: ${Math.floor(totalBytes / 1024)}KB total`);
          writeStream.end();
        });

        file.on('error', (fileError) => {
          console.error(`❌ Thumbnail file stream error: ${fileError.message}`);
          if (writeStream && !writeStream.destroyed) {
            writeStream.destroy();
          }
          res.status(500).json({
            error: 'File upload error',
            uploadId
          });
        });

        writeStream.on('close', async () => {
          console.log(`✅ Thumbnail write stream closed - processing`);

          try {
            // Security: Verify file exists and has reasonable size
            const stats = fs.statSync(tempFilePath);
            if (stats.size === 0) {
              throw new Error('Uploaded file is empty');
            }
            if (stats.size > 10 * 1024 * 1024) {
              throw new Error('Uploaded file exceeds size limit');
            }

            // Upload thumbnail directly to B2
            const thumbnailUrl = await b2Service.uploadThumbnail(tempFilePath, filename);
            console.log(`✅ Custom thumbnail uploaded to B2: ${thumbnailUrl}`);

            // Clean up local file immediately
            if (fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
              console.log(`🧹 Local thumbnail cleaned up: ${tempFilePath}`);
            }

            // Get video ID from form fields if provided
            const videoId = sanitizeInput(formFields.videoId);

            // Update database if videoId provided
            if (videoId) {
              try {
                const supabaseService = require('../services/supabase');
                await supabaseService.updateThumbnail(videoId, thumbnailUrl);
                console.log(`✅ Database updated with custom thumbnail for video ${videoId}`);
              } catch (dbError) {
                console.warn(`⚠️ Database update failed: ${dbError.message}`);
                // Continue anyway - upload was successful
              }
            }

            res.json({
              success: true,
              url: thumbnailUrl,
              thumbnailUrl,
              message: 'Custom thumbnail uploaded successfully',
              uploadId,
              videoId: videoId || null,
              fileSize: stats.size
            });

          } catch (uploadError) {
            console.error(`❌ Custom thumbnail upload failed: ${uploadError.message}`);

            // Clean up temp file on error
            if (fs.existsSync(tempFilePath)) {
              fs.unlinkSync(tempFilePath);
            }

            res.status(500).json({
              error: 'Custom thumbnail upload failed',
              details: uploadError.message,
              uploadId
            });
          }
        });

        // Pipe file to write stream
        file.pipe(writeStream);

      } catch (fileHandlerError) {
        console.error(`❌ Thumbnail file handler error: ${fileHandlerError.message}`);
        res.status(500).json({
          error: 'File handler error',
          uploadId
        });
      }
    });

    // Handle form fields with sanitization
    bb.on('field', (fieldname, value) => {
      console.log(`📝 Thumbnail form field: ${fieldname} = ${value}`);
      formFields[fieldname] = sanitizeInput(value);
    });

    bb.on('finish', () => {
      console.log(`🏁 Thumbnail busboy finished for ${uploadId}`);

      if (!fileReceived) {
        return res.status(400).json({
          error: 'No thumbnail image was uploaded',
          message: 'Please select an image file (JPEG, PNG, or WebP)',
          uploadId
        });
      }
    });

    bb.on('error', (error) => {
      console.error(`❌ Thumbnail busboy error: ${error.message}`);

      // Clean up temp file
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupError) {
          console.error(`❌ Thumbnail cleanup error: ${cleanupError.message}`);
        }
      }

      res.status(500).json({
        error: 'Thumbnail upload failed',
        details: error.message,
        uploadId
      });
    });

    // Request handlers with security
    req.on('error', (error) => {
      console.error(`❌ Thumbnail request error: ${error.message}`);
      res.status(500).json({
        error: 'Thumbnail upload request failed',
        uploadId
      });
    });

    req.on('aborted', () => {
      console.warn(`⚠️ Thumbnail request aborted for ${uploadId}`);
      if (!res.headersSent) {
        res.status(400).json({
          error: 'Thumbnail upload was cancelled',
          uploadId
        });
      }
    });

    // Pipe request to busboy
    req.pipe(bb);

  } catch (error) {
    console.error(`❌ Custom thumbnail upload setup error: ${error.message}`);
    res.status(500).json({
      error: 'Thumbnail upload setup failed',
      details: error.message,
      uploadId: uploadId || 'unknown'
    });
  }
});

/**
 * EXISTING: UPLOAD STATUS ROUTE
 * GET /upload/status/:uploadId
 * Returns current upload status - ENHANCED WITH SECURITY
 */
router.get('/status/:uploadId', generalRateLimit, (req, res) => {
  const uploadId = sanitizeInput(req.params.uploadId);
  
  try {
    if (!uploadId || uploadId.length > 100) {
      return res.status(400).json({
        error: 'Invalid upload ID'
      });
    }
    
    const status = getUploadStatus(uploadId);
    
    if (!status) {
      return res.status(404).json({ 
        error: 'Upload not found',
        uploadId,
        message: 'Upload may have expired or not yet started'
      });
    }
    
    // Security: Remove sensitive information from status
    const sanitizedStatus = {
      ...status,
      // Remove sensitive fields
      authorizationToken: undefined,
      clientIP: undefined,
      userAgent: undefined
    };
    
    // Add server health info (limited)
    const memUsage = process.memoryUsage();
    const response = {
      ...sanitizedStatus,
      serverHealth: {
        memoryUsageMB: Math.floor(memUsage.rss / 1024 / 1024),
        timestamp: new Date().toISOString()
      }
    };
    
    res.json(response);
    
  } catch (error) {
    console.error(`❌ Status check error: ${error.message}`);
    res.status(500).json({ 
      error: 'Status check failed'
    });
  }
});

/**
 * EXISTING: HEALTH CHECK ROUTE
 * GET /upload/health
 * Returns service health status - ENHANCED
 */
router.get('/health', (req, res) => {
  const memInfo = process.memoryUsage();
  const health = {
    status: 'healthy',
    service: 'enhanced-upload-service-streaming-proxy',
    memory: {
      rss: `${Math.floor(memInfo.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.floor(memInfo.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.floor(memInfo.heapTotal / 1024 / 1024)}MB`
    },
    timestamp: new Date().toISOString(),
    features: {
      maxFileSize: '100GB',
      chunkSize: '25MB',
      formdataUploads: 'enabled',
      chunkedUploads: 'enabled',
      streamingProxyMultipartUploads: ENABLE_MULTIPART_UPLOADS ? 'enabled' : 'disabled',
      customThumbnailUpload: 'enabled',
      b2Upload: 'enabled',
      thumbnailGeneration: 'enabled',
      backgroundProcessing: 'enabled',
      supabaseIntegration: 'enabled',
      ffmpegMetadata: 'enabled',
      rateLimiting: 'enabled',
      inputSanitization: 'enabled',
      securityValidation: 'enabled',
      streamingProxy: 'enabled'
    }
  };
  
  res.json(health);
});

/**
 * EXISTING: CORS TEST ROUTE
 * GET /upload/cors-test
 * Tests CORS configuration - ENHANCED
 */
router.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'Enhanced Streaming Proxy Upload routes CORS working',
    origin: req.headers.origin || 'Unknown',
    timestamp: new Date().toISOString(),
    service: 'enhanced-upload-service-streaming-proxy',
    capabilities: {
      formdata: true,
      chunked: true,
      streamingProxyMultipart: ENABLE_MULTIPART_UPLOADS,
      customThumbnails: true,
      security: 'enabled',
      cors: 'no_issues_with_streaming_proxy'
    }
  });
});

module.exports = router;