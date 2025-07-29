const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { ensureDirectory } = require('../utils/directory');
const logger = require('../utils/logger');

/**
 * Generate a thumbnail from a local video file
 * @param {string} videoPath - Path to the video file
 * @param {string} outputPath - Path for the thumbnail output
 * @param {string} timestamp - Timestamp for thumbnail extraction (e.g. '00:00:05')
 * @returns {Promise<string>} - Path to the generated thumbnail
 */
async function generateThumbnail(videoPath, outputPath, timestamp = '00:00:05') {
  logger.info('🔍 THUMBNAIL EXTRACTION STARTING');
  logger.info('Video path:', videoPath);
  logger.info('Output path:', outputPath);
  
  // Create the directory if it doesn't exist
  const directory = path.dirname(outputPath);
  await ensureDirectory(directory);
  
  return new Promise((resolve, reject) => {
    // Use spawn directly with ffmpeg path from config
    const ffmpegProcess = spawn(config.ffmpeg.binPath, [
      '-ss', timestamp,
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      outputPath
    ]);
    
    let errorOutput = '';
    // Log all output
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      errorOutput += output;
      logger.debug(`FFmpeg Output: ${output}`);
    });
    
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        logger.info(`✅ Thumbnail generated successfully: ${outputPath}`);
        resolve(outputPath);
      } else {
        const error = new Error(`FFmpeg failed with code ${code}: ${errorOutput}`);
        logger.error(error.message);
        reject(error);
      }
    });

    // Set a timeout
    const timeout = setTimeout(() => {
      ffmpegProcess.kill('SIGKILL');
      const error = new Error('Thumbnail generation timed out');
      logger.error(error.message);
      reject(error);
    }, config.ffmpeg.timeout);

    ffmpegProcess.on('close', () => clearTimeout(timeout));
    ffmpegProcess.on('error', () => clearTimeout(timeout));
  });
}

/**
 * Extract video metadata using FFprobe
 * @param {string} videoPath - Path to the video file
 * @returns {Promise<Object>} - Video metadata
 */
async function extractVideoMetadata(videoPath) {
  return new Promise((resolve, reject) => {
    logger.info(`📊 Extracting metadata from: ${videoPath}`);
    
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        logger.error(`[FFprobe] Error extracting metadata: ${err.message}`);
        reject(err);
        return;
      }
      
      // Find video stream
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      
      if (!videoStream) {
        const error = new Error('No video stream found');
        logger.error(error.message);
        reject(error);
        return;
      }
      
      const result = {
        duration: parseFloat(metadata.format.duration || 0),
        width: videoStream.width || 0,
        height: videoStream.height || 0,
        codec: videoStream.codec_name || '',
        bitrate: parseInt(metadata.format.bit_rate || 0),
        size: parseInt(metadata.format.size || 0),
      };
      
      logger.info(`[FFprobe] Extracted metadata:`, result);
      resolve(result);
    });
  });
}

/**
 * Extract video metadata from a remote URL
 * @param {string} videoUrl - URL of the video
 * @returns {Promise<Object>} - Video metadata
 */
async function extractMetadataFromRemote(videoUrl) {
  return new Promise((resolve, reject) => {
    logger.info(`📊 Extracting metadata from remote URL: ${videoUrl}`);
    
    const ffprobeArgs = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name:format=duration,size,bit_rate',
      '-of', 'json',
      '-analyzeduration', '5000000', // Analyze first 5 seconds only
      '-probesize', '5000000', // Probe first 5MB only
      videoUrl
    ];
    
    const ffprobeProcess = spawn('ffprobe', ffprobeArgs);
    let output = '';
    let errorOutput = '';
    
    ffprobeProcess.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ffprobeProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    // Set timeout to prevent hanging
    const timeout = setTimeout(() => {
      ffprobeProcess.kill();
      reject(new Error('Metadata extraction timeout after 30 seconds'));
    }, 30000);
    
    ffprobeProcess.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code !== 0) {
        reject(new Error(`FFprobe failed with code ${code}: ${errorOutput}`));
        return;
      }
      
      try {
        const metadata = JSON.parse(output);
        const videoStream = metadata.streams?.[0];
        const format = metadata.format;
        
        if (!videoStream || !format) {
          reject(new Error('No valid video stream found'));
          return;
        }
        
        const result = {
          duration: parseFloat(format.duration || 0),
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          codec: videoStream.codec_name || '',
          bitrate: parseInt(format.bit_rate || 0),
          size: parseInt(format.size || 0),
        };
        
        logger.info(`✅ Extracted remote metadata:`, result);
        resolve(result);
      } catch (parseError) {
        reject(new Error(`Failed to parse metadata: ${parseError.message}`));
      }
    });
    
    ffprobeProcess.on('error', (error) => {
      clearTimeout(timeout);
      logger.error(`❌ FFprobe process error: ${error.message}`);
      reject(error);
    });
  });
}

/**
 * Unified function to extract metadata from either local files or remote URLs
 * @param {string} source - Local file path or remote URL
 * @returns {Promise<Object>} - Video metadata
 */
async function extractVideoMetadataUnified(source) {
  try {
    // Determine if source is local file or URL
    const isRemote = source.startsWith('http://') || source.startsWith('https://');
    
    if (isRemote) {
      logger.info(`📊 Detected remote source: ${source}`);
      return await extractMetadataFromRemote(source);
    } else {
      logger.info(`📊 Detected local source: ${source}`);
      return await extractVideoMetadata(source);
    }
  } catch (error) {
    logger.warn(`⚠️ Metadata extraction failed: ${error.message}`);
    
    // Return safe defaults instead of throwing
    return {
      duration: 0,
      width: 0,
      height: 0,
      codec: 'unknown',
      bitrate: 0,
      size: 0,
      error: error.message
    };
  }
}

/**
 * Extract a thumbnail from a remote video URL
 * @param {string} videoUrl - URL of the video
 * @param {string} thumbnailPath - Path for the thumbnail output
 * @param {number} seekTime - Time position for thumbnail (in seconds)
 * @returns {Promise<string>} - Path to the generated thumbnail
 */
async function extractThumbnailFromRemote(videoUrl, thumbnailPath, seekTime = 5) {
  return new Promise((resolve, reject) => {
    logger.info(`[FFmpeg] Extracting thumbnail from remote URL: ${videoUrl} at ${seekTime}s`);
    
    // Ensure the output directory exists
    const directory = path.dirname(thumbnailPath);
    ensureDirectory(directory);
    
    let errorOutput = '';
    
    // Use spawn directly for better error handling and control
    const ffmpegProcess = spawn(config.ffmpeg.binPath, [
      '-y',                       // Overwrite output files
      '-ss', seekTime.toString(), // Seek to position
      '-i', videoUrl,             // Input file
      '-vframes', '1',            // Extract 1 frame
      '-q:v', '2',                // High quality
      thumbnailPath               // Output path
    ]);
    
    // Collect error output
    ffmpegProcess.stderr.on('data', (data) => {
      const output = data.toString();
      errorOutput += output;
      logger.debug(`[FFmpeg] ${output}`);
    });
    
    // Set a timeout in case FFmpeg hangs
    const timeout = setTimeout(() => {
      ffmpegProcess.kill('SIGKILL');
      const error = new Error('FFmpeg process timed out after 30 seconds');
      logger.error(error.message);
      reject(error);
    }, config.ffmpeg.timeout);
    
    // Handle process completion
    ffmpegProcess.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code === 0 && fs.existsSync(thumbnailPath)) {
        logger.info(`✅ Successfully extracted thumbnail: ${thumbnailPath}`);
        resolve(thumbnailPath);
      } else {
        const error = new Error(`FFmpeg failed with code ${code}: ${errorOutput}`);
        logger.error(error.message);
        reject(error);
      }
    });
    
    // Handle process errors
    ffmpegProcess.on('error', (error) => {
      clearTimeout(timeout);
      logger.error(`❌ FFmpeg process error: ${error.message}`);
      reject(error);
    });
  });
}

/**
 * Create a placeholder blue thumbnail
 * @param {string} outputPath - Path for the placeholder thumbnail
 * @returns {Promise<string>} - Path to the generated placeholder
 */
async function createPlaceholderThumbnail(outputPath) {
  return new Promise((resolve, reject) => {
    logger.info(`[FFmpeg] Creating placeholder thumbnail: ${outputPath}`);
    
    // Ensure the output directory exists
    const directory = path.dirname(outputPath);
    ensureDirectory(directory);
    
    // Use FFmpeg to generate a solid blue image
    const command = spawn(config.ffmpeg.binPath, [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=blue:s=640x360',
      '-frames:v', '1',
      outputPath
    ]);
    
    let errorOutput = '';
    
    command.stderr.on('data', (data) => {
      const output = data.toString();
      errorOutput += output;
      logger.debug(`[FFmpeg] ${output}`);
    });
    
    command.on('close', (code) => {
      if (code === 0) {
        if (fs.existsSync(outputPath)) {
          logger.info(`✅ Created placeholder thumbnail: ${outputPath}`);
          resolve(outputPath);
        } else {
          const error = new Error('FFmpeg completed but placeholder file was not created');
          logger.error(error.message);
          reject(error);
        }
      } else {
        const error = new Error(`FFmpeg exited with code ${code}: ${errorOutput}`);
        logger.error(error.message);
        reject(error);
      }
    });
    
    // Set a timeout
    const timeout = setTimeout(() => {
      command.kill('SIGKILL');
      reject(new Error('FFmpeg process timed out'));
    }, 10000);
    
    command.on('close', () => clearTimeout(timeout));
    command.on('error', () => clearTimeout(timeout));
  });
}

/**
 * Test if FFmpeg is working correctly
 * @returns {Promise<boolean>} - Success status
 */
async function testFfmpeg() {
  const outputPath = path.join('uploads', 'test-output.jpg');
  
  return new Promise((resolve, reject) => {
    logger.info('Testing FFmpeg...');
    
    const ffmpegProcess = spawn(config.ffmpeg.binPath, [
      '-f', 'lavfi',
      '-i', 'testsrc=duration=1:size=640x360:rate=1',
      '-frames:v', '1',
      outputPath
    ]);
    
    ffmpegProcess.stderr.on('data', (data) => {
      logger.debug(`FFmpeg: ${data.toString()}`);
    });
    
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        logger.info(`FFmpeg test successful! Image saved to ${outputPath}`);
        resolve(true);
      } else {
        logger.error(`FFmpeg failed with code ${code}`);
        reject(new Error('FFmpeg test failed'));
      }
    });
  });
}

module.exports = {
  generateThumbnail,
  extractVideoMetadata,
  extractMetadataFromRemote,
  extractVideoMetadataUnified,
  extractThumbnailFromRemote,
  createPlaceholderThumbnail,
  testFfmpeg
};