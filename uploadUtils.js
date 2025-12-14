const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client for uploads
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * Upload a file to Supabase storage with proper user association
 * @param {Buffer|File} fileData - The file data to upload
 * @param {string} fileName - Original filename
 * @param {string} userId - Authenticated user ID
 * @param {string} bucket - Storage bucket name (default: 'credit-reports')
 * @returns {Promise<{success: boolean, filePath: string, error?: string}>}
 */
async function uploadUserFile(fileData, fileName, userId, bucket = 'credit-reports') {
  try {
    if (!userId) {
      throw new Error('User ID is required for file upload');
    }

    // Sanitize filename and create unique path
    const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const timestamp = Date.now();
    const uniqueFileName = `${timestamp}_${sanitizedName}`;
    const filePath = `${userId}/${uniqueFileName}`;

    console.log(`Uploading file to ${bucket}/${filePath}`);

    // Upload to Supabase storage
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(filePath, fileData, {
        contentType: getContentType(fileName),
        upsert: false // Don't overwrite existing files
      });

    if (error) {
      console.error('Upload error:', error);
      return {
        success: false,
        error: error.message,
        filePath: null
      };
    }

    console.log('✅ File uploaded successfully:', filePath);

    return {
      success: true,
      filePath,
      fileName: uniqueFileName,
      bucket
    };

  } catch (error) {
    console.error('Upload processing error:', error);
    return {
      success: false,
      error: error.message,
      filePath: null
    };
  }
}

/**
 * Get MIME content type from filename
 * @param {string} filename - The filename
 * @returns {string} - MIME type
 */
function getContentType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  const types = {
    'pdf': 'application/pdf',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'txt': 'text/plain',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };

  return types[ext] || 'application/octet-stream';
}

/**
 * Register uploaded file with the API (updates storage limits and triggers processing)
 * @param {string} filePath - The file path in storage
 * @param {string} fileName - The original filename
 * @param {string} userId - The user ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function registerUploadedFile(filePath, fileName, userId) {
  try {
    const response = await fetch(`${process.env.API_BASE_URL || 'http://localhost:3001'}/api/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'user-id': userId
      },
      body: JSON.stringify({
        filePath,
        fileName
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Failed to register file');
    }

    return {
      success: true,
      ...result
    };

  } catch (error) {
    console.error('File registration error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Complete file upload process (upload + register)
 * @param {Buffer|File} fileData - The file data
 * @param {string} fileName - Original filename
 * @param {string} userId - Authenticated user ID
 * @returns {Promise<{success: boolean, filePath: string, error?: string}>}
 */
async function uploadAndRegisterFile(fileData, fileName, userId) {
  try {
    // Step 1: Upload file to storage
    const uploadResult = await uploadUserFile(fileData, fileName, userId);

    if (!uploadResult.success) {
      return uploadResult;
    }

    // Step 2: Register with API for processing
    const registerResult = await registerUploadedFile(
      uploadResult.filePath,
      uploadResult.fileName,
      userId
    );

    if (!registerResult.success) {
      // Try to clean up the uploaded file if registration failed
      try {
        await supabase.storage
          .from('credit-reports')
          .remove([uploadResult.filePath]);
      } catch (cleanupError) {
        console.warn('Failed to cleanup uploaded file:', cleanupError);
      }

      return {
        success: false,
        error: registerResult.error
      };
    }

    return {
      success: true,
      filePath: uploadResult.filePath,
      fileName: uploadResult.fileName,
      message: 'File uploaded and processing started'
    };

  } catch (error) {
    console.error('Complete upload process error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  uploadUserFile,
  registerUploadedFile,
  uploadAndRegisterFile,
  getContentType
};