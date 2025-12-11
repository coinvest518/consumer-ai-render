const { DataAPIClient } = require('@datastax/astra-db-ts');
const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');

// Initialize AstraDB client
let astraClient = null;
if (process.env.ASTRA_DB_APPLICATION_TOKEN && process.env.ASTRA_DB_API_ENDPOINT) {
  astraClient = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
}

// Initialize Google AI embeddings
let embeddings = null;
if (process.env.GOOGLE_API_KEY) {
  embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GOOGLE_API_KEY,
    modelName: 'embedding-001', // Google's text embedding model
  });
}

// Generate embedding using Google AI
async function generateEmbedding(text) {
  if (!embeddings) return null;

  try {
    const embedding = await embeddings.embedQuery(text);
    return embedding;
  } catch (error) {
    console.error('Embedding generation failed:', error);
    return null;
  }
}

// Extract legal keywords from user question
function extractLegalKeywords(question) {
  const legalTerms = [
    'FDCPA', 'FCRA', 'TCPA', 'CCPA', 'debt collection', 'credit report', 
    'harassment', 'validation', 'dispute', 'consumer rights', 'fair debt',
    'credit bureau', 'collection agency', 'cease and desist', 'statute of limitations'
  ];
  
  const found = legalTerms.filter(term => 
    question.toLowerCase().includes(term.toLowerCase())
  );
  
  // If no specific terms found, use the full question
  return found.length > 0 ? found : [question];
}

// Enhanced AstraDB search function
async function enhancedLegalSearch(userQuestion) {
  if (!astraClient || !process.env.ASTRA_DB_API_ENDPOINT) {
    console.log('AstraDB not configured, skipping legal search');
    return '';
  }

  try {
    const db = astraClient.db(process.env.ASTRA_DB_API_ENDPOINT);
    const collection = db.collection('legal_documents');
    
    const searchTerms = extractLegalKeywords(userQuestion);
    const searches = [];
    
    // Multiple targeted searches
    for (const term of searchTerms.slice(0, 3)) { // Limit to 3 searches
      const embedding = await generateEmbedding(term);
      if (embedding) {
        searches.push(
          collection.find({}, {
            sort: { $vector: embedding },
            limit: 5
          })
        );
      }
    }
    
    if (searches.length === 0) return '';
    
    // Combine and deduplicate results
    const allResults = await Promise.all(searches);
    const combinedResults = allResults.flat().slice(0, 10);
    
    // Format results for AI context
    return combinedResults.map(doc => {
      const data = doc.data || doc;
      return `${data.case_name || data.title || 'Legal Document'}: ${data.summary || data.text || ''}`;
    }).join('\n\n');
    
  } catch (error) {
    console.error('Legal search failed:', error);
    return '';
  }
}

// Search by specific legal area
async function searchByLegalArea(area, question) {
  if (!astraClient) return '';
  
  try {
    const db = astraClient.db(process.env.ASTRA_DB_API_ENDPOINT);
    const collection = db.collection('legal_documents');
    
    const results = await collection.find(
      { legal_area: area },
      { limit: 5 }
    );
    
    return results.map(doc => {
      const data = doc.data || doc;
      return `${data.citation || ''}: ${data.summary || data.text || ''}`;
    }).join('\n\n');
    
  } catch (error) {
    console.error('Legal area search failed:', error);
    return '';
  }
}

module.exports = {
  enhancedLegalSearch,
  searchByLegalArea,
  extractLegalKeywords
};