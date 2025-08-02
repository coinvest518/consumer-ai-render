const { DataAPIClient } = require('@datastax/astra-db-ts');

// Initialize AstraDB client
let astraClient = null;
if (process.env.ASTRA_DB_APPLICATION_TOKEN && process.env.ASTRA_DB_API_ENDPOINT) {
  astraClient = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
}

// Disabled embedding to save OpenAI quota
async function generateEmbedding(text) {
  return null;
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

// Simplified legal search without embeddings
async function enhancedLegalSearch(userQuestion) {
  if (!astraClient || !process.env.ASTRA_DB_API_ENDPOINT) {
    console.log('AstraDB not configured, skipping legal search');
    return '';
  }

  try {
    const db = astraClient.db(process.env.ASTRA_DB_API_ENDPOINT);
    const collection = db.collection('legal_documents');
    
    const searchTerms = extractLegalKeywords(userQuestion);
    
    // Simple text-based search without embeddings
    const results = await collection.find(
      { $or: searchTerms.map(term => ({ text: { $regex: term, $options: 'i' } })) },
      { limit: 5 }
    );
    
    return results.map(doc => {
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