const { DataAPIClient } = require('@datastax/astra-db-ts');
const { GoogleGenerativeAIEmbeddings } = require('@langchain/google-genai');
const { TavilySearch } = require('@langchain/tavily');
const axios = require('axios');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
let chatWithFallback;
try {
  chatWithFallback = require('./temp/aiUtils').chatWithFallback;
} catch (error) {
  console.warn('Failed to load ./temp/aiUtils, trying ./aiUtils:', error.message);
  try {
    chatWithFallback = require('./aiUtils').chatWithFallback;
  } catch (fallbackError) {
    console.error('Failed to load aiUtils from both locations:', fallbackError.message);
    // Provide a minimal fallback function
    chatWithFallback = async (messages) => {
      throw new Error('AI utilities not available - check aiUtils.js file');
    };
  }
}

// Initialize AstraDB client (support multiple constructor styles)
let astraClient = null;
try {
  const astraLib = require('@datastax/astra-db-ts');
  const ClientCtor = astraLib.DataApiClient || astraLib.DataAPIClient || astraLib.DataApiClient;
  if (ClientCtor) {
    if (process.env.ASTRA_DB_APPLICATION_TOKEN) {
      astraClient = new ClientCtor({ token: process.env.ASTRA_DB_APPLICATION_TOKEN });
      console.log('Astra client initialized with provided token');
    } else {
      try { astraClient = new ClientCtor(); console.log('Astra client initialized without token'); } catch (e) { astraClient = null; }
    }
  } else {
    console.warn('Astra client constructor not found in @datastax/astra-db-ts');
  }
} catch (err) {
  console.warn('Astra DataAPI client failed to initialize:', err.message || err);
  astraClient = null;
}

// Default law DB endpoint (used when no ASTRA_LAW_DB_API_ENDPOINT is set)
const DEFAULT_LAW_DB_ENDPOINT = process.env.ASTRA_LAW_DB_API_ENDPOINT || 'https://145531b2-b59b-4507-ac37-f62810a72b8d-us-east-2.apps.astra.datastax.com';

// Utility: ensure a collection exists (best-effort)
async function getOrCreateCollection(db, collectionName) {
  try {
    const coll = db.collection(collectionName);
    // try a simple find to validate collection existence
    try {
      await coll.find({}, { limit: 1 });
      return coll;
    } catch (e) {
      // collection may not exist yet
      console.log(`Collection '${collectionName}' may not exist; attempting to create it.`);
    }

    // Try common create methods (best-effort, some SDKs vary)
    if (typeof db.createCollection === 'function') {
      await db.createCollection(collectionName);
    } else if (typeof db.create_collection === 'function') {
      await db.create_collection(collectionName);
    } else if (typeof db.createCollectionFromDefinition === 'function') {
      await db.createCollectionFromDefinition(collectionName);
    } else {
      console.warn('No createCollection API available on db client. Please create the collection manually in Astra console.');
    }

    // Return collection handle even if creation wasn't explicit
    return db.collection(collectionName);
  } catch (err) {
    console.error('getOrCreateCollection error:', err.message || err);
    throw err;
  }
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

const { getEmbedding } = require('./utils/embeddings');

// Generate embedding using preferred local/remote providers (Mistral preferred)
async function generateEmbedding(text) {
  try {
    const emb = await getEmbedding(text);
    if (emb && emb.length) return emb;
  } catch (err) {
    console.warn('Local embedding failed:', err.message || err);
  }

  // As a last resort, try Google embeddings if configured
  if (embeddings) {
    try {
      const embedding = await embeddings.embedQuery(text);
      return embedding;
    } catch (error) {
      console.error('Google embedding generation failed:', error);
    }
  }
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

// Enhanced AstraDB search function
async function enhancedLegalSearch(userQuestion, opts = {}) {
  let collection = null;
  let lawCollection = null;
  if (astraClient && process.env.ASTRA_DB_API_ENDPOINT) {
    try {
      const db = astraClient.db(process.env.ASTRA_DB_API_ENDPOINT);
      collection = await getOrCreateCollection(db, 'caselaw');
    } catch (error) {
      console.error('AstraDB connection failed for caselaw:', error);
    }
  }

  // Optional separate law DB/collection (overrides). If not set, fall back to DEFAULT_LAW_DB_ENDPOINT
  try {
    const lawEndpoint = process.env.ASTRA_LAW_DB_API_ENDPOINT || DEFAULT_LAW_DB_ENDPOINT;
    // If a separate token is provided for the law DB, construct a dedicated client
    if (process.env.ASTRA_LAW_DB_APPLICATION_TOKEN) {
      try {
        const astraLib = require('@datastax/astra-db-ts');
        const LawClientCtor = astraLib.DataAPIClient || astraLib.DataApiClient || astraLib.DataAPIClient;
        const lawClient = new LawClientCtor({ token: process.env.ASTRA_LAW_DB_APPLICATION_TOKEN });
        const lawDb = lawClient.getDatabaseByApiEndpoint ? lawClient.getDatabaseByApiEndpoint(lawEndpoint) : lawClient.db(lawEndpoint);
        lawCollection = await getOrCreateCollection(lawDb, process.env.ASTRA_LAW_COLLECTION || 'law_cases');
        console.log('Law collection configured (with dedicated token):', process.env.ASTRA_LAW_COLLECTION || 'law_cases', 'at', lawEndpoint);
      } catch (err2) {
        console.warn('Failed to init dedicated law client with provided token:', err2.message || err2);
        lawCollection = null;
      }
    } else if (astraClient && lawEndpoint) {
      try {
        const lawDb = astraClient.getDatabaseByApiEndpoint ? astraClient.getDatabaseByApiEndpoint(lawEndpoint) : astraClient.db(lawEndpoint);
        lawCollection = await getOrCreateCollection(lawDb, process.env.ASTRA_LAW_COLLECTION || 'law_cases');
        console.log('Law collection configured:', process.env.ASTRA_LAW_COLLECTION || 'law_cases', 'at', lawEndpoint);
      } catch (err3) {
        console.warn('Failed to configure law collection with existing client (token may not be scoped to this DB):', err3.message || err3);
        lawCollection = null;
      }
    }
  } catch (err) {
    console.warn('Failed to configure law collection:', err.message || err);
    lawCollection = null;
  }

  // Search across lawCollection first (if available) then the default 'caselaw' collection
  const targetCollections = [];
  if (lawCollection) targetCollections.push(lawCollection);
  if (collection) targetCollections.push(collection);

  if (targetCollections.length > 0) {
    const searchTerms = extractLegalKeywords(userQuestion);

    // Try vector search first using local embeddings
    for (const term of searchTerms.slice(0, 3)) {
      const embedding = await generateEmbedding(term);
      if (!embedding) continue;

      for (const coll of targetCollections) {
        try {
          // Attempt server-side vector search and client-side fallback
          const res = await tryVectorAndFallbackSearch(coll, embedding, userQuestion, lawCollection === coll ? 'law_cases' : 'caselaw');
          if (res && res.length) return res;
        } catch (err) {
          console.warn('Search attempt failed on collection:', err.message || err);
        }
      }
    }

    // If no results from vector or lexical, return empty array
    return [];
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
      
      // If caller asked to save results, attempt to save to Astra (best-effort)
      let savedInfo = null;
      if (opts.save && (collection || lawCollection)) {
        const docsToInsert = onlineResults.map(r => ({
          title: r.title,
          text: r.content,
          $vectorize: r.content, // let Astra generate vectors if collection supports it
          url: r.url,
          source: 'tavily',
          query: userQuestion,
          user: opts.userId || null,
          timestamp: new Date().toISOString()
        }));

        savedInfo = { caselaw: null, law_cases: null };

        try {
          if (collection) {
            try {
              const res = await collection.insertMany(docsToInsert);
              const inserted = res.inserted_ids || res.insertedIds || res.inserted_ids || res;
              savedInfo.caselaw = inserted;
              console.log(`Saved ${docsToInsert.length} documents to AstraDB collection 'caselaw'`, 'inserted_ids:', inserted);
            } catch (e) {
              // If vectorization is not configured, retry without $vectorize
              if ((e.message || '').toLowerCase().includes('unable to vectorize')) {
                console.warn('Collection not vector-enabled; retrying insert without $vectorize');
                const docsNoVector = docsToInsert.map(d => ({ ...d, $vectorize: undefined }));
                try { const r = await collection.insertMany(docsNoVector); savedInfo.caselaw = r.inserted_ids || r.insertedIds || r; console.log('Saved docs without $vectorize to caselaw'); } catch (e2) { console.error('Insert without $vectorize failed:', e2.message || e2); }
              } else {
                console.error('Insert to caselaw failed:', e.message || e);
              }
            }
          }
          if (lawCollection) {
            try {
              const res2 = await lawCollection.insertMany(docsToInsert);
              const inserted2 = res2.inserted_ids || res2.insertedIds || res2;
              savedInfo.law_cases = inserted2;
              console.log(`Saved ${docsToInsert.length} documents to AstraDB collection '${process.env.ASTRA_LAW_COLLECTION || 'law_cases'}'`, 'inserted_ids:', inserted2);
            } catch (e) {
              if ((e.message || '').toLowerCase().includes('unable to vectorize')) {
                console.warn('Law collection not vector-enabled; retrying insert without $vectorize');
                const docsNoVector = docsToInsert.map(d => ({ ...d, $vectorize: undefined }));
                try { const r2 = await lawCollection.insertMany(docsNoVector); savedInfo.law_cases = r2.inserted_ids || r2.insertedIds || r2; console.log('Saved docs without $vectorize to law_cases'); } catch (e2) { console.error('Insert without $vectorize failed:', e2.message || e2); }
              } else {
                console.error('Insert to law_cases failed:', e.message || e);
              }
            }
          }
        } catch (error) {
          console.error('Failed to save to AstraDB:', error);
        }
      }

      // If save requested, return results plus saved info
      if (opts.save) return { results, saved: savedInfo };

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
    const collection = await getOrCreateCollection(db, 'caselaw');
    
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
        $vectorize: scrapedContent, // request Astra to generate vectors if collection supports it
        url: url,
        source: 'hyperbrowser',
        timestamp: new Date().toISOString()
      };
      try {
        const insertRes = await collection.insertOne(docToInsert);
        console.log('Saved scraped content to AstraDB (with $vectorize if collection supports it)', 'inserted_id:', insertRes.inserted_id || insertRes.insertedId || insertRes);
      } catch (e) {
        console.error('Failed to save scraped content to AstraDB:', e.message || e);
      }
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

// Utilities
function formatAstraResults(docs, sourceName) {
  return docs.map(doc => {
    const data = doc.data || doc;
    return {
      title: data.case_name || data.title || 'Legal Document',
      text: data.summary || data.text || '',
      source: data.source || sourceName,
      id: data._id || doc._id || null
    };
  });
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i=0;i<a.length;i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (na === 0 || nb === 0) return 0; return dot / (Math.sqrt(na)*Math.sqrt(nb));
}

async function tryVectorAndFallbackSearch(coll, embedding, userQuestion, sourceName) {
  try {
    const foundRaw = await coll.find({}, { sort: { $vector: embedding }, limit: 5 });
    const found = Array.isArray(foundRaw) ? foundRaw : (foundRaw?.data || foundRaw?.docs || foundRaw?.rows || []);
    if (found && found.length) return formatAstraResults(found, sourceName);
  } catch (err) {
    // server-side vector search may not be supported; continue to client-side fallback
    console.warn('Server-side vector search failed (will sample):', err.message || err);
  }

  // Sample and compute similarity locally
  try {
    const sampleRaw = await coll.find({}, { limit: 200 });
    const sample = Array.isArray(sampleRaw) ? sampleRaw : (sampleRaw?.data || sampleRaw?.docs || sampleRaw?.rows || []);
    if (!sample || sample.length === 0) return [];

    const scored = [];
    for (const doc of sample) {
      const data = doc.data || doc;
      let docVector = data.$vector || data.vector || (doc.$vector) || (doc.vector) || null;
      if (!docVector && data.text) {
        try { docVector = await getEmbedding(data.text.substring(0,2000)); } catch (e) { docVector = null; }
      }
      if (docVector && embedding) {
        const score = cosineSimilarity(embedding, docVector);
        scored.push({ doc, score });
      }
    }
    scored.sort((a,b) => b.score - a.score);
    const top = scored.slice(0,5).map(s => s.doc);
    if (top.length) return formatAstraResults(top, sourceName);
  } catch (e) {
    console.warn('Client-side sample similarity search failed:', e.message || e);
  }

  // Final fallback: try a lexical match
  try {
    const fallback = await coll.find({ $text: { $search: userQuestion } }, { limit: 5 });
    if (fallback && fallback.length) return formatAstraResults(fallback, sourceName);
  } catch (e) {
    console.warn('Lexical fallback failed:', e.message || e);
  }

  return [];
}

module.exports = {
  enhancedLegalSearch,
  searchByLegalArea,
  extractLegalKeywords,
  scrapeAndAnalyze
};