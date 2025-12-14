const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Google AI embeddings
let embeddings = null;
if (process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY) {
  embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY,
    modelName: 'embedding-001',
  });
}

/**
 * Generate embedding for text
 */
async function generateEmbedding(text) {
  if (!embeddings) return null;
  try {
    return await embeddings.embedQuery(text);
  } catch (error) {
    console.error('Embedding generation failed:', error);
    return null;
  }
}

/**
 * Search user documents semantically
 * @param {string} userId - User ID
 * @param {string} query - Search query
 * @param {number} limit - Max results to return
 * @returns {Promise<Array>} - Matching documents with relevance scores
 */
async function searchUserDocuments(userId, query, limit = 5) {
  if (!embeddings) {
    return await fallbackTextSearch(userId, query, limit);
  }

  try {
    const queryEmbedding = await generateEmbedding(query);
    if (!queryEmbedding) {
      return await fallbackTextSearch(userId, query, limit);
    }

    // Get user's analyses with extracted text
    const { data: analyses, error } = await supabase
      .from('report_analyses')
      .select('file_path, file_name, extracted_text, processed_at')
      .eq('user_id', userId)
      .order('processed_at', { ascending: false })
      .limit(20); // Get more to filter semantically

    if (error || !analyses || analyses.length === 0) {
      return await fallbackTextSearch(userId, query, limit);
    }

    // Calculate semantic similarity
    const results = [];
    for (const analysis of analyses) {
      if (!analysis.extracted_text) continue;

      const textEmbedding = await generateEmbedding(analysis.extracted_text.substring(0, 1000));
      if (!textEmbedding) continue;

      // Cosine similarity
      const similarity = cosineSimilarity(queryEmbedding, textEmbedding);

      results.push({
        file_path: analysis.file_path,
        file_name: analysis.file_name,
        similarity: similarity,
        processed_at: analysis.processed_at,
        preview: analysis.extracted_text.substring(0, 200) + '...'
      });
    }

    // Sort by similarity and return top results
    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

  } catch (error) {
    console.error('Semantic search failed:', error);
    return await fallbackTextSearch(userId, query, limit);
  }
}

/**
 * Fallback text search when embeddings aren't available
 */
async function fallbackTextSearch(userId, query, limit = 5) {
  try {
    const { data: analyses, error } = await supabase
      .from('report_analyses')
      .select('file_path, file_name, extracted_text, processed_at')
      .eq('user_id', userId)
      .order('processed_at', { ascending: false })
      .limit(limit);

    if (error || !analyses) return [];

    const queryLower = query.toLowerCase();
    return analyses
      .filter(analysis =>
        analysis.extracted_text &&
        analysis.extracted_text.toLowerCase().includes(queryLower)
      )
      .map(analysis => ({
        file_path: analysis.file_path,
        file_name: analysis.file_name,
        similarity: 0.5, // Default similarity for text search
        processed_at: analysis.processed_at,
        preview: analysis.extracted_text.substring(0, 200) + '...'
      }));

  } catch (error) {
    console.error('Fallback search failed:', error);
    return [];
  }
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) return 0;

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Get document analysis by file path
 * @param {string} userId - User ID
 * @param {string} filePath - File path
 * @returns {Promise<Object|null>} - Analysis data or null
 */
async function getDocumentAnalysis(userId, filePath) {
  try {
    const { data, error } = await supabase
      .from('report_analyses')
      .select('*')
      .eq('user_id', userId)
      .eq('file_path', filePath)
      .order('processed_at', { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) return null;
    return data[0];
  } catch (error) {
    console.error('Error getting document analysis:', error);
    return null;
  }
}

module.exports = {
  searchUserDocuments,
  getDocumentAnalysis,
  generateEmbedding
};