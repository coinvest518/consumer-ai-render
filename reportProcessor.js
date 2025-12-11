const { createClient } = require('@supabase/supabase-js');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const { createWorker } = require('tesseract.js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Google AI model
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
    const { data, error } = await supabase.storage
      .from('documents') // Assuming bucket name
      .download(filePath);

    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
  } catch (error) {
    console.error('Error downloading file:', error);
    throw new Error(`Failed to download file: ${error.message}`);
  }
}

/**
 * Extract text from PDF using pdf-parse
 * @param {Buffer} buffer - PDF buffer
 * @returns {Promise<string>} - Extracted text
 */
async function extractTextFromPDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text;
  } catch (error) {
    console.error('Error extracting text from PDF:', error);
    throw error;
  }
}

/**
 * Extract text from image using Tesseract OCR
 * @param {Buffer} buffer - Image buffer
 * @returns {Promise<string>} - Extracted text
 */
async function extractTextFromImage(buffer) {
  const worker = await createWorker('eng');
  try {
    const { data: { text } } = await worker.recognize(buffer);
    return text;
  } catch (error) {
    console.error('Error extracting text from image:', error);
    throw error;
  } finally {
    await worker.terminate();
  }
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
    return await extractTextFromPDF(buffer);
  } else if (['.jpg', '.jpeg', '.png', '.bmp', '.tiff'].includes(ext)) {
    return await extractTextFromImage(buffer);
  } else {
    throw new Error(`Unsupported file type: ${ext}`);
  }
}

/**
 * Analyze extracted text for errors and violations using OpenAI
 * @param {string} text - Extracted text
 * @returns {Promise<Object>} - Structured analysis
 */
async function analyzeText(text) {
  const systemPrompt = `You are an expert legal analyst specializing in consumer credit reports and FCRA violations.
Analyze the provided credit report text for:
1. FCRA (Fair Credit Reporting Act) violations
2. FDCPA (Fair Debt Collection Practices Act) violations
3. Errors in personal information
4. Inaccurate account information
5. Unauthorized inquiries
6. Incorrect credit scores or calculations

Return a structured JSON analysis with the following format:
{
  "summary": "Brief overview of findings",
  "violations": [
    {
      "type": "FCRA/FDCPA",
      "description": "Detailed description",
      "severity": "high/medium/low",
      "evidence": "Quote from text",
      "recommendation": "Suggested action"
    }
  ],
  "errors": [
    {
      "type": "personal_info/account_info/etc",
      "description": "Error description",
      "evidence": "Quote from text"
    }
  ],
  "overall_score": "clean/minor_issues/significant_issues/serious_violations"
}`;

  try {
    const response = await openaiModel.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`Analyze this credit report text:\n\n${text}`)
    ]);

    // Parse the JSON response
    const analysisText = response.content.trim();
    // Remove markdown code blocks if present
    const jsonText = analysisText.replace(/```json\n?|\n?```/g, '');
    return JSON.parse(jsonText);
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