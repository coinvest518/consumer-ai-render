const { createClient } = require('@supabase/supabase-js');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const { Mistral } = require('@mistralai/mistralai');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Mistral client for OCR
const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});

// Initialize Google AI model (only for final analysis)
const openaiModel = new ChatGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY,
  model: 'gemini-2.5-flash',
  temperature: 0.1, // Low temperature for analysis
});

/**
 * Download file from Supabase storage
 * @param {string} filePath - Path to file in storage
 * @returns {Promise<Buffer>} - File buffer
 */
async function downloadFromStorage(filePath) {
  try {
    // Try buckets in order of likelihood based on actual structure
    const buckets = ['users-file-storage', 'credit-reports', 'uploads', 'documents'];
    
    for (const bucket of buckets) {
      try {
        console.log(`Trying to download from ${bucket}: ${filePath}`);
        const { data, error } = await supabase.storage
          .from(bucket)
          .download(filePath);

        if (!error && data) {
          console.log(`✅ Successfully downloaded from ${bucket}`);
          return Buffer.from(await data.arrayBuffer());
        }
      } catch (bucketError) {
        console.log(`❌ Failed to download from ${bucket}:`, bucketError.message);
      }
    }
    
    throw new Error(`File not found in any storage bucket: ${filePath}`);
  } catch (error) {
    console.error('Error downloading file:', error);
    throw new Error(`Failed to download file: ${error.message}`);
  }
}

/**
 * Extract text from PDF using Mistral OCR
 * @param {Buffer} buffer - PDF buffer
 * @returns {Promise<string>} - Extracted text
 */
async function extractTextFromPDF(buffer) {
  try {
    console.log('🔍 Extracting text from PDF using Mistral OCR, buffer size:', buffer.length);

    // Convert buffer to base64 data URL for Mistral
    const base64Data = buffer.toString('base64');
    const dataUrl = `data:application/pdf;base64,${base64Data}`;

    console.log('📤 Sending PDF to Mistral OCR...');

    // Use Mistral OCR API
    const ocrResponse = await mistral.ocr.process({
      model: "mistral-ocr-latest",
      document: {
        type: "document_url",
        documentUrl: dataUrl
      }
    });

    console.log('✅ Mistral OCR completed, pages processed:', ocrResponse.pages?.length || 0);

    // Combine all pages' markdown content
    const extractedText = ocrResponse.pages
      .map(page => page.markdown)
      .join('\n\n');

    console.log('📝 Extracted text length:', extractedText.length);

    if (!extractedText || extractedText.trim().length < 10) {
      throw new Error('Mistral OCR returned insufficient text from PDF');
    }

    return extractedText;

  } catch (error) {
    console.error('❌ Mistral OCR error:', error);
    // Fallback to original pdf-parse method
    console.log('🔄 Falling back to pdf-parse...');
    try {
      const data = await pdfParse(buffer);
      console.log('📄 PDF-parse fallback: pages:', data.numpages, 'text length:', data.text.length);
      return data.text;
    } catch (fallbackError) {
      console.error('❌ Fallback also failed:', fallbackError);
      throw new Error(`OCR failed: ${error.message}`);
    }
  }
}

/**
 * Extract text from image using Tesseract OCR
 * @param {Buffer} buffer - Image buffer
 * @returns {Promise<string>} - Extracted text
 */
async function extractTextFromImage(buffer, fileName) {
  console.log('⚠️ Local OCR not available in deployment environment');

  // Since local OCR libraries are not supported in Render,
  // return a helpful error message instead of crashing
  return `Unable to extract text from ${fileName}. The document appears to be image-based or scanned.

Please try uploading a text-based PDF or contact support for assistance with document processing.

For credit report analysis, we recommend:
1. Using digital credit reports from your credit bureau
2. Ensuring your PDF contains selectable text (not just images)
3. Contacting support if you need help with scanned documents`;
}

/**
 * Determine if file is PDF or image and extract text
 * @param {Buffer} buffer - File buffer
 * @param {string} fileName - Original file name
 * @returns {Promise<string>} - Extracted text
 */
async function extractText(buffer, fileName) {
  const ext = path.extname(fileName).toLowerCase();

  if (ext === '.pdf') {
    try {
      // First try regular PDF text extraction
      const pdfText = await extractTextFromPDF(buffer);
      if (pdfText && pdfText.trim().length > 100) {
        return pdfText; // Return if we got good text
      }
      
      // If PDF text extraction failed or returned very little text,
      // it might be a scanned PDF - try OCR
      console.log('PDF text extraction yielded insufficient text, trying OCR...');
      return await extractTextFromImage(buffer, fileName);
    } catch (pdfError) {
      console.log('PDF extraction failed, trying OCR:', pdfError.message);
      // Fallback to OCR for scanned PDFs
      return await extractTextFromImage(buffer, fileName);
    }
  }
}

/**
 * Analyze extracted text for errors and violations using OpenAI
 * @param {string} text - Extracted text
 * @returns {Promise<Object>} - Structured analysis
 */
async function analyzeText(text) {
  // Handle empty or very short text
  if (!text || text.trim().length < 50) {
    return {
      summary: "Insufficient text for analysis - PDF may be image-based or corrupted",
      violations: [],
      errors: [{
        type: "extraction_error",
        description: "Could not extract readable text from the document",
        evidence: "Text length: " + (text?.length || 0) + " characters"
      }],
      overall_score: "unknown",
      needs_ocr: true
    };
  }

  const systemPrompt = `You are a legal analysis AI that ONLY returns valid JSON. No explanations, no apologies, no conversational text.

Analyze the credit report text and return ONLY a JSON object with this EXACT structure:
{
  "summary": "Brief summary of findings (max 200 chars)",
  "violations": [
    {
      "type": "FCRA or FDCPA",
      "description": "Brief description",
      "severity": "high/medium/low",
      "evidence": "Quote from text",
      "recommendation": "Action needed"
    }
  ],
  "errors": [
    {
      "type": "personal_info/account_info/inquiry/etc",
      "description": "Error description",
      "evidence": "Quote from text"
    }
  ],
  "overall_score": "clean/minor_issues/significant_issues/serious_violations"
}

IMPORTANT: Return ONLY the JSON object, no other text or formatting.`;

  try {
    const response = await openaiModel.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`Analyze this credit report text:\n\n${text}`)
    ]);

    // Parse the JSON response
    const analysisText = response.content.trim();
    console.log('AI Response:', analysisText.substring(0, 200) + '...');
    
    // Remove markdown code blocks if present
    const jsonText = analysisText.replace(/```json\n?|\n?```/g, '').trim();
    
    try {
      return JSON.parse(jsonText);
    } catch (parseError) {
      console.error('JSON parse error, trying to extract JSON from response');
      
      // Try to find JSON in the response
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (secondParseError) {
          console.error('Still cannot parse JSON');
        }
      }
      
      // Fallback: return a structured response
      return {
        summary: analysisText.substring(0, 500),
        violations: [],
        errors: [],
        overall_score: "unknown",
        raw_response: analysisText
      };
    }
  } catch (error) {
    console.error('Error analyzing text:', error);
    return {
      summary: "Analysis failed",
      violations: [],
      errors: [],
      overall_score: "unknown",
      error: error.message
    };
  }
}

/**
 * Process a credit report file from storage
 * @param {string} filePath - Path to file in storage
 * @returns {Promise<Object>} - Complete analysis
 */
async function processCreditReport(filePath) {
  try {
    // Download file
    const buffer = await downloadFromStorage(filePath);

    // Extract text
    const text = await extractText(buffer, filePath);

    // Analyze text
    const analysis = await analyzeText(text);

    return {
      filePath,
      extractedText: text,
      analysis,
      processedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error processing credit report:', error);
    return {
      filePath,
      error: error.message,
      processedAt: new Date().toISOString()
    };
  }
}

module.exports = {
  processCreditReport,
  downloadFromStorage,
  extractText,
  analyzeText
};