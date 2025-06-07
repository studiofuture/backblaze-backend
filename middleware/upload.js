const multer = require('multer');
const path = require('path');
const logger = require('../utils/logger');
const { generateUniqueFilename } = require('../utils/directory');

// Configure multer storage 
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Store all uploads in the uploads directory
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    // Generate unique filename
    const uniqueFilename = generateUniqueFilename(file.originalname);
    logger.debug(`Generated unique filename: ${uniqueFilename}`);
    cb(null, uniqueFilename);
  }
});

// Configure file filter to validate file types
const fileFilter = (req, file, cb) => {
  // Check for video files
  if (file.fieldname === 'file' && req.path.includes('/video')) {
    const validVideoTypes = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska'];
    if (validVideoTypes.includes(file.mimetype)) {
      logger.debug(`Accepted video file: ${file.originalname} (${file.mimetype})`);
      return cb(null, true);
    }
    logger.warn(`Rejected invalid video file: ${file.originalname} (${file.mimetype})`);
    return cb(new Error('Only video files are allowed for video uploads'), false);
  }
  
  // Check for image files (thumbnails, profile pics)
  if (file.fieldname === 'file' && (req.path.includes('/thumbnail') || req.path.includes('/profile-pic'))) {
    const validImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (validImageTypes.includes(file.mimetype)) {
      logger.debug(`Accepted image file: ${file.originalname} (${file.mimetype})`);
      return cb(null, true);
    }
    logger.warn(`Rejected invalid image file: ${file.originalname} (${file.mimetype})`);
    return cb(new Error('Only image files are allowed for image uploads'), false);
  }
  
  // Default accept file
  logger.debug(`Accepted file by default: ${file.originalname} (${file.mimetype})`);
  cb(null, true);
};

// Configure upload limits - UPDATED for paid plan with very high limits
const limits = {
  fileSize: 100 * 1024 * 1024 * 1024, // 100GB max file size for paid plan
  files: 1, // Maximum number of files per request
  fieldSize: 100 * 1024 * 1024, // 100MB field size
  fields: 50 // Maximum number of fields
};

// Create multer instance
const upload = multer({ 
  storage: storage,
  fileFilter: fileFilter,
  limits: limits
});

module.exports = {
  upload
};
