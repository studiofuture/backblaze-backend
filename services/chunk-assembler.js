const fs = require('fs');
const path = require('path');
const { updateUploadStatus } = require('../utils/status');
const { generateUniqueFilename, getUploadPath, ensureDirectory } = require('../utils/directory');

/**
 * Chunk Assembler Service
 * Handles raw chunk uploads and assembly
 */

/**
 * Save a raw chunk to disk
 * @param {Object} req - Express request object (raw binary data)
 * @param {string} uploadId - Unique upload identifier
 * @param {number} chunkIndex - Index of this chunk
 * @param {number} totalChunks - Total number of chunks expected
 * @returns {Promise<void>}
 */
async function saveChunk(req, uploadId, chunkIndex, totalChunks) {
  return new Promise(async (resolve, reject) => {
    try {
      // Ensure chunks directory exists
      await ensureDirectory('uploads/chunks');
      
      // Create chunk file path
      const chunkPath = path.join('uploads/chunks', `${uploadId}_chunk_${chunkIndex}`);
      const writeStream = fs.createWriteStream(chunkPath);
      
      console.log(`💾 Saving chunk to: ${chunkPath}`);
      
      // Pipe raw request body to file
      req.pipe(writeStream);
      
      writeStream.on('finish', () => {
        console.log(`✅ Chunk ${chunkIndex} saved successfully`);
        
        // Update upload status
        const progressPercent = Math.floor(((chunkIndex + 1) / totalChunks) * 50); // 50% for chunk upload
        updateUploadStatus(uploadId, {
          progress: progressPercent,
          stage: `received chunk ${chunkIndex + 1}/${totalChunks}`,
          status: 'receiving_chunks'
        });
        
        resolve();
      });
      
      writeStream.on('error', (error) => {
        console.error(`❌ Error saving chunk ${chunkIndex}:`, error);
        reject(error);
      });
      
    } catch (error) {
      console.error(`❌ Chunk save setup error:`, error);
      reject(error);
    }
  });
}

/**
 * Assemble all chunks into a single file
 * @param {string} uploadId - Unique upload identifier
 * @param {number} totalChunks - Total number of chunks to assemble
 * @param {string} originalFilename - Original filename from client
 * @returns {Promise<string>} - Path to assembled file
 */
async function assembleChunks(uploadId, totalChunks, originalFilename) {
  console.log(`🔧 Assembling ${totalChunks} chunks for ${uploadId}`);
  
  // Create final file path
  const finalFileName = generateUniqueFilename(originalFilename);
  const finalFilePath = getUploadPath('temp', finalFileName);
  
  // Ensure temp directory exists
  await ensureDirectory('uploads/temp');
  
  const writeStream = fs.createWriteStream(finalFilePath);
  let assembledBytes = 0;
  
  try {
    // Combine chunks in order
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const chunkPath = path.join('uploads/chunks', `${uploadId}_chunk_${chunkIndex}`);
      
      console.log(`📎 Processing chunk ${chunkIndex}: ${chunkPath}`);
      
      // Check if chunk exists
      if (!fs.existsSync(chunkPath)) {
        throw new Error(`Missing chunk ${chunkIndex} at ${chunkPath}`);
      }
      
      // Read and append chunk
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);
      assembledBytes += chunkData.length;
      
      console.log(`✅ Appended chunk ${chunkIndex} (${chunkData.length} bytes)`);
      
      // Update progress
      const progressPercent = 55 + Math.floor(((chunkIndex + 1) / totalChunks) * 5); // 55-60%
      updateUploadStatus(uploadId, {
        progress: progressPercent,
        stage: `assembling chunk ${chunkIndex + 1}/${totalChunks}`
      });
      
      // Clean up chunk file immediately
      fs.unlinkSync(chunkPath);
      console.log(`🧹 Cleaned up chunk file: ${chunkPath}`);
    }
    
    // Close the write stream
    await new Promise((resolve, reject) => {
      writeStream.end((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    
    console.log(`✅ File assembly complete: ${finalFilePath} (${assembledBytes} bytes)`);
    
    // Clean up chunks directory if empty
    try {
      const chunksDir = 'uploads/chunks';
      const remainingFiles = fs.readdirSync(chunksDir).filter(file => file.startsWith(uploadId));
      if (remainingFiles.length === 0) {
        console.log(`🧹 All chunks for ${uploadId} cleaned up`);
      }
    } catch (cleanupError) {
      console.warn(`⚠️ Chunk cleanup warning:`, cleanupError.message);
    }
    
    return finalFilePath;
    
  } catch (error) {
    // Clean up on error
    if (fs.existsSync(finalFilePath)) {
      fs.unlinkSync(finalFilePath);
    }
    
    // Clean up any remaining chunks
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join('uploads/chunks', `${uploadId}_chunk_${i}`);
      if (fs.existsSync(chunkPath)) {
        fs.unlinkSync(chunkPath);
        console.log(`🧹 Error cleanup: removed ${chunkPath}`);
      }
    }
    
    throw error;
  }
}

/**
 * Validate that all chunks exist for an upload
 * @param {string} uploadId - Unique upload identifier
 * @param {number} totalChunks - Expected number of chunks
 * @returns {boolean} - True if all chunks exist
 */
function validateChunks(uploadId, totalChunks) {
  console.log(`🔍 Validating ${totalChunks} chunks for ${uploadId}`);
  
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join('uploads/chunks', `${uploadId}_chunk_${i}`);
    if (!fs.existsSync(chunkPath)) {
      console.error(`❌ Missing chunk ${i} at ${chunkPath}`);
      return false;
    }
  }
  
  console.log(`✅ All ${totalChunks} chunks validated for ${uploadId}`);
  return true;
}

/**
 * Clean up chunks for a specific upload (emergency cleanup)
 * @param {string} uploadId - Unique upload identifier
 * @param {number} totalChunks - Total chunks to clean up
 */
function cleanupChunks(uploadId, totalChunks) {
  console.log(`🧹 Emergency cleanup for ${uploadId}`);
  
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join('uploads/chunks', `${uploadId}_chunk_${i}`);
    if (fs.existsSync(chunkPath)) {
      try {
        fs.unlinkSync(chunkPath);
        console.log(`🧹 Removed chunk ${i}`);
      } catch (error) {
        console.error(`❌ Failed to remove chunk ${i}:`, error.message);
      }
    }
  }
}

module.exports = {
  saveChunk,
  assembleChunks,
  validateChunks,
  cleanupChunks
};