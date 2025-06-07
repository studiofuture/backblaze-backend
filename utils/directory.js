const mkdirp = require('mkdirp');
const path = require('path');
const logger = require('./logger');

// Required directories
const REQUIRED_DIRS = [
  'uploads',
  'uploads/thumbs',
  'uploads/temp'
];

/**
 * Create all required directories
 */
async function setupDirectories() {
  logger.info('Setting up directories...');
  
  try {
    const promises = REQUIRED_DIRS.map(async dirPath => {
      await mkdirp(dirPath);
      logger.info(`✅ Created directory: ${dirPath}`);
    });
    
    await Promise.all(promises);
    logger.info('✅ All directories created successfully');
  } catch (error) {
    logger.error('❌ Error creating directories:', error);
    throw error;
  }
}

/**
 * Ensure a specific directory exists
 * @param {string} dirPath - Path to ensure exists
 */
async function ensureDirectory(dirPath) {
  try {
    await mkdirp(dirPath);
    return dirPath;
  } catch (error) {
    logger.error(`❌ Error creating directory ${dirPath}:`, error);
    throw error;
  }
}

/**
 * Generate a unique filename with timestamp
 * @param {string} originalName - Original filename
 * @returns {string} Unique filename
 */
function generateUniqueFilename(originalName) {
  const ext = path.extname(originalName);
  const baseName = path.basename(originalName, ext);
  return `${baseName}_${Date.now()}${ext}`;
}

/**
 * Generate temporary file path in uploads directory
 * @param {string} subdir - Subdirectory under uploads
 * @param {string} filename - Filename
 * @returns {string} Full path
 */
function getUploadPath(subdir, filename) {
  return path.join('uploads', subdir, filename);
}

module.exports = {
  setupDirectories,
  ensureDirectory,
  generateUniqueFilename,
  getUploadPath
};
