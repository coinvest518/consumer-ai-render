const { DataAPIClient } = require('@datastax/astra-db-ts');
const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
const { TavilySearch } = require('@langchain/tavily');
const axios = require('axios');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { chatWithFallback } = require('./aiUtils');

// Initialize AstraDB client
let astraClient = null;
if (process.env.ASTRA_DB_APPLICATION_TOKEN && process.env.ASTRA_DB_API_ENDPOINT) {
  astraClient = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);
}

// Initialize Google AI embeddings
let embeddings = null;
if (process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY) {
  embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY,
    modelName: 'embedding-001', // Google's text embedding model
  });
}

// Initialize Tavily search
let tavilySearch = null;
if (process.env.TAVILY_API_KEY) {
  tavilySearch = new TavilySearch({
    maxResults: 5,
    apiKey: process.env.TAVILY_API_KEY,
  });
}

// Initialize Hyperbrowser (using axios directly)
let hyperbrowserApiKey = process.env.HYPERBROWSER_API_KEY;

// Initialize AI model for analysis
let aiModel = null;
if (process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY) {
  aiModel = new ChatGoogleGenerativeAI({
    apiKey: process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY,
    model: 'gemini-2.5-flash',
    temperature: 0.7,
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
  let collection = null;
  if (astraClient && process.env.ASTRA_DB_API_ENDPOINT) {
    try {
      const db = astraClient.db(process.env.ASTRA_DB_API_ENDPOINT);
      collection = db.collection('caselaw');
    } catch (error) {
      console.error('AstraDB connection failed:', error);
    }
  }

  if (collection) {
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
    
    if (searches.length > 0) {
      // Combine and deduplicate results
      const allResults = await Promise.all(searches);
      const combinedResults = allResults.flat().slice(0, 10);
      
      if (combinedResults.length > 0) {
        // Format AstraDB results for AI context
        return combinedResults.map(doc => {
          const data = doc.data || doc;
          return `${data.case_name || data.title || 'Legal Document'}: ${data.summary || data.text || ''}`;
        }).join('\n\n');
      }
    }
  }
  
  // Fallback to online search
  console.log('Using online search fallback');
  if (process.env.TAVILY_API_KEY) {
    try {
      const response = await axios.post('https://api.tavily.com/search', {
        query: userQuestion + ' legal information',
        api_key: process.env.TAVILY_API_KEY,
        max_results: 5
      });
      const onlineResults = response.data.results || [];
      const results = onlineResults.map(r => `${r.title}: ${r.content}`).join('\n\n');
      
      // Save online results to AstraDB for future use
      if (collection) {
        const docsToInsert = onlineResults.map(r => ({
          title: r.title,
          text: r.content,
          url: r.url,
          source: 'tavily',
          query: userQuestion,
          timestamp: new Date().toISOString()
        }));
        
        try {
          await collection.insertMany(docsToInsert);
          console.log(`Saved ${docsToInsert.length} documents to AstraDB`);
        } catch (error) {
          console.error('Failed to save to AstraDB:', error);
        }
      }
      
      return results;
    } catch (error) {
      console.error('Tavily search failed:', error);
    }
  }
  
  return '';
}

// Search by specific legal area
async function searchByLegalArea(area, question) {
  if (!astraClient) return '';
  
  try {
    const db = astraClient.db(process.env.ASTRA_DB_API_ENDPOINT);
    const collection = db.collection('caselaw');
    
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

async function scrapeAndAnalyze(url) {
  let collection = null;
  if (astraClient && process.env.ASTRA_DB_API_ENDPOINT) {
    try {
      const db = astraClient.db(process.env.ASTRA_DB_API_ENDPOINT);
      collection = db.collection('caselaw');
    } catch (error) {
      console.error('AstraDB connection failed:', error);
    }
  }

  let scrapedContent = '';
  let analysis = '';

  // Scrape with Hyperbrowser
  if (process.env.HYPERBROWSER_API_KEY) {
    try {
      console.log(`Starting Hyperbrowser scrape job for URL: ${url}`);
      
      // Start the scrape job
      const startResponse = await axios.post('https://api.hyperbrowser.ai/api/scrape', {
        url: url,
        scrapeOptions: { 
          formats: ['markdown', 'html'],
          onlyMainContent: true,
          waitFor: 3000,  // Wait 3 seconds for dynamic content
          timeout: 60000   // 60 second timeout
        }
      }, {
        headers: {
          'x-api-key': process.env.HYPERBROWSER_API_KEY,
          'Content-Type': 'application/json'
        }
      });
      
      const jobId = startResponse.data.jobId;
      console.log(`Hyperbrowser job started with ID: ${jobId}`);
      
      // Poll for completion
      let status = 'pending';
      let attempts = 0;
      const maxAttempts = 30; // 30 seconds max
      
      while (status !== 'completed' && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        
        const statusResponse = await axios.get(`https://api.hyperbrowser.ai/api/scrape/${jobId}/status`, {
          headers: {
            'x-api-key': process.env.HYPERBROWSER_API_KEY
          }
        });
        
        status = statusResponse.data.status;
        console.log(`Job status: ${status}`);
        attempts++;
        
        if (status === 'failed') {
          throw new Error('Scrape job failed');
        }
      }
      
      if (status === 'completed') {
        // Get the results
        const resultResponse = await axios.get(`https://api.hyperbrowser.ai/api/scrape/${jobId}`, {
          headers: {
            'x-api-key': process.env.HYPERBROWSER_API_KEY
          }
        });
        
        console.log('Hyperbrowser result response:', JSON.stringify(resultResponse.data, null, 2));
        scrapedContent = resultResponse.data.data?.markdown || resultResponse.data.data?.html || resultResponse.data.markdown || resultResponse.data.content || '';
        console.log(`Hyperbrowser scraped content length: ${scrapedContent.length}`);
      } else {
        throw new Error('Scrape job timed out');
      }
    } catch (error) {
      console.error('Hyperbrowser scrape failed:', error.response?.data || error.message);
    }
  }

  // If no content from Hyperbrowser, try Tavily search for the URL
  if (!scrapedContent && process.env.TAVILY_API_KEY) {
    try {
      console.log(`Falling back to Tavily for URL: ${url}`);
      const response = await axios.post('https://api.tavily.com/search', {
        query: `content from ${url}`,
        api_key: process.env.TAVILY_API_KEY,
        max_results: 1
      });
      const results = response.data.results || [];
      if (results.length > 0) {
        scrapedContent = results[0].content;
      }
    } catch (error) {
      console.error('Tavily fallback failed:', error);
    }
  }

  // Save to AstraDB
  if (collection && scrapedContent) {
    try {
      const docToInsert = {
        title: `Scraped from ${url}`,
        text: scrapedContent,
        url: url,
        source: 'hyperbrowser',
        timestamp: new Date().toISOString()
      };
      await collection.insertOne(docToInsert);
      console.log('Saved scraped content to AstraDB');
    } catch (error) {
      console.error('Failed to save to AstraDB:', error);
    }
  }

  // Analyze with AI
  if (aiModel && scrapedContent) {
    try {
      console.log('Analyzing content with AI...');
      const response = await chatWithFallback([
        new SystemMessage('You are a legal expert. Analyze this scraped legal content and provide a comprehensive summary, key points, and implications for consumers.'),
        new HumanMessage(scrapedContent.substring(0, 10000)) // Limit to 10k chars
      ]);
      analysis = response.content || response;
    } catch (error) {
      console.error('AI analysis failed:', error);
      analysis = 'Analysis unavailable due to error.';
    }
  }

  return {
    content: scrapedContent,
    analysis: analysis,
    saved: !!collection
  };
}

module.exports = {
  enhancedLegalSearch,
  searchByLegalArea,
  extractLegalKeywords,
  scrapeAndAnalyze
};