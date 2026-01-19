const { createClient } = require('@supabase/supabase-js');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { ChatGoogle } = require('@langchain/google-gauth');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');
const { Mistral } = require('@mistralai/mistralai');
const { PostgresChatMessageHistory } = require('@langchain/community/stores/message/postgres');
const { RunnableWithMessageHistory } = require('@langchain/core/runnables');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const Stripe = require('stripe');
const { Pool } = require('pg');

// Import and initialize LangSmith configuration
const { configureTracingForModels } = require('./langsmithConfig');

// Helper function to strip markdown formatting from text
function stripMarkdown(text) {
  if (!text) return text;
  if (typeof text !== 'string') return String(text);
  
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/^[\s]*[-\*\+]\s+/gm, '')
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Import with error handling
let enhancedLegalSearch, graph;
try {
  enhancedLegalSearch = require('./legalSearch').enhancedLegalSearch;
} catch (error) {
  console.warn('Legal search not available:', error.message);
  enhancedLegalSearch = async (query) => `Legal search unavailable: ${query}`;
}

try {
  graph = require('./agents/supervisor').graph;
} catch (error) {
  console.warn('Agent supervisor not available:', error.message);
  graph = null;
}

// Import AI utilities (use `let` so tests can override the implementation)
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

// Initialize Supabase client (optional)
let supabase = null;
console.log('SUPABASE_URL value:', process.env.SUPABASE_URL);
console.log('SUPABASE_SERVICE_ROLE_KEY value:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Present' : 'Not present');
console.log('SUPABASE_URL present:', !!process.env.SUPABASE_URL);
console.log('SUPABASE_SERVICE_ROLE_KEY present:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    console.log('Initializing Supabase client...');
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false
        }
      }
    );
    console.log('Supabase client initialized successfully');
  } catch (error) {
    console.warn('Supabase client initialization failed:', error.message);
  }
} else {
  console.warn('Supabase configuration not provided - some features will be unavailable');
}

// Initialize PostgreSQL connection for LangChain memory and admin checks
let pgPool = null;
if (process.env.SUPABASE_POSTGRES_URL) {
  try {
    pgPool = new Pool({ connectionString: process.env.SUPABASE_POSTGRES_URL, ssl: { rejectUnauthorized: false } });
    console.log('PostgreSQL pool configured from SUPABASE_POSTGRES_URL');
  } catch (error) {
    console.warn('Failed to configure PostgreSQL pool from SUPABASE_POSTGRES_URL:', error.message);
  }
} else {
  // No direct Postgres connection configured. Do NOT attempt to derive DB host
  // from SUPABASE_URL (that is an HTTP endpoint); prefer the Supabase HTTP
  // client fallback which writes to `chat_history` via the Supabase REST API.
  console.log('No SUPABASE_POSTGRES_URL set — skipping direct Postgres pool configuration (using Supabase HTTP fallback).');
}

// Initialize Google AI with Gemini 2.5 Flash model
let chatModel = null;
const googleApiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY;
if (googleApiKey) {
  try {
    console.log('Initializing Google AI model with API key:', googleApiKey ? 'Present' : 'Missing');
    // LangSmith tracing is automatic when environment variables are set
    // No need to wrap - it's handled at the LangChain level
    const baseModel = new ChatGoogleGenerativeAI({
      apiKey: googleApiKey,
      model: 'gemini-2.5-flash',
      temperature: 0.7,
      maxRetries: 3,
      maxOutputTokens: 2048,
      topP: 0.95,
      safetySettings: [
        {
          category: 'HARM_CATEGORY_HARASSMENT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE'
        },
        {
          category: 'HARM_CATEGORY_HATE_SPEECH',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE'
        }
      ]
    });

    // Apply LangSmith configuration
    chatModel = baseModel;
    configureTracingForModels(chatModel);
    
    console.log('✅ Google AI model initialized with LangSmith tracing enabled');
  } catch (error) {
    console.error('❌ Failed to initialize Google AI model:', error.message);
    chatModel = null;
  }
} else {
  console.warn('⚠️  GOOGLE_API_KEY not found in environment variables');
}

// Initialize Mistral as backup AI model
let mistralClient = null;
const mistralApiKey = process.env.MISTRAL_API_KEY;
if (mistralApiKey) {
  try {
    console.log('Initializing Mistral AI client');
    mistralClient = new Mistral({
      apiKey: mistralApiKey,
    });
    console.log('Mistral AI client initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Mistral AI client:', error.message);
    mistralClient = null;
  }
} else {
  console.warn('MISTRAL_API_KEY not found in environment variables');
}

// Note: Hugging Face Inference access available via HF_TOKEN, but we avoid OpenAI SDK usage here.
// For Hugging Face fallback, the code in `aiUtils.js` will use direct HTTP calls (axios) to the Hugging Face Inference API when HF_TOKEN is present.
let hfClient = null;
const hfApiKey = process.env.HF_TOKEN;
if (!hfApiKey) {
  console.warn('HF_TOKEN not found in environment variables');
} else {
  console.log('HF_TOKEN present - Hugging Face will be used via HTTP fallback in aiUtils');
}

// Note: MuleRouter (Qwen) access available via MULEROUTER_API_KEY, but we avoid OpenAI SDK usage here.
// For MuleRouter fallback, the code in `aiUtils.js` will use direct HTTP calls (axios) to MuleRouter endpoints when MULEROUTER_API_KEY is present.
let muleRouterClient = null;
const muleRouterApiKey = process.env.MULEROUTER_API_KEY;
if (!muleRouterApiKey) {
  console.warn('MULEROUTER_API_KEY not found in environment variables');
} else {
  console.log('MULEROUTER_API_KEY present - MuleRouter will be used via HTTP fallback in aiUtils');
}

// chatWithFallback moved to `aiUtils.js` and imported earlier to avoid duplication

// Initialize Stripe (optional)
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  try {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2023-10-16'
    });
  } catch (error) {
    console.warn('Stripe initialization failed:', error.message);
  }
} else {
  console.warn('Stripe configuration not provided - payment features will be unavailable');
}

// Memory storage for chat sessions and response cache
const chatSessions = new Map();
const chatStores = new Map(); // For LangChain message history stores
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Ensure a chat message store exists for a session. Prefer PostgresChatMessageHistory when
// `pgPool` is available; otherwise provide a lightweight Supabase-backed wrapper that
// exposes `addMessages(messages)` to keep existing callsites working.
async function ensureChatStore(sessionId, userId = null) {
  if (chatStores.has(sessionId)) return chatStores.get(sessionId);

  // Try to initialize LangChain PostgresChatMessageHistory when possible
  if (typeof PostgresChatMessageHistory !== 'undefined' && pgPool) {
    try {
      let instance;
      try {
        // Prefer object-style constructor if available
        instance = new PostgresChatMessageHistory({ pool: pgPool });
      } catch (err) {
        // Fallback to positional constructor
        instance = new PostgresChatMessageHistory(pgPool);
      }

      // If the instance has an `addMessages` method, use it directly
      if (instance && typeof instance.addMessages === 'function') {
        chatStores.set(sessionId, instance);
        return instance;
      }
    } catch (err) {
      console.warn('Failed to initialize PostgresChatMessageHistory:', err && err.message ? err.message : err);
    }
  }

  // Fallback wrapper that inserts into Supabase `chat_history` table if available.
  const wrapper = {
    addMessages: async (messages) => {
      if (!messages || messages.length === 0) return;

      // Normalize messages into rows for `chat_history`
      const rows = messages.map((m) => {
        // messages may be instances of HumanMessage/AIMessage or simple objects
        const content = m.content || m.text || m.message || (typeof m === 'string' ? m : '');
        let role = m.role || m.type || null;
        if (!role) {
          // Try to detect by constructor name
          try {
            if (m && m.constructor && m.constructor.name === 'HumanMessage') role = 'user';
            else if (m && m.constructor && m.constructor.name === 'AIMessage') role = 'assistant';
          } catch (e) {}
        }
        role = role === 'assistant' || role === 'ai' || role === 'system' ? 'assistant' : 'user';

        return {
          session_id: sessionId,
          user_id: userId || null,
          role,
          message: String(content || ''),
          created_at: new Date().toISOString()
        };
      });

      if (supabase) {
        try {
          await supabase.from('chat_history').insert(rows);
        } catch (err) {
          console.error('Failed to save chat messages via Supabase fallback:', err && err.message ? err.message : err);
        }
      } else {
        // If no persistent backend, keep messages in-memory (best-effort)
        try {
          const session = chatSessions.get(sessionId) || [];
          rows.forEach(r => session.push(new HumanMessage(r.message)));
          chatSessions.set(sessionId, session);
        } catch (e) {
          // ignore
        }
      }
    }
  };

  chatStores.set(sessionId, wrapper);
  return wrapper;
}

// Simple response caching
function getCachedResponse(message) {
  const key = message.toLowerCase().trim();
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.response;
  }
  return null;
}

function setCachedResponse(message, response) {
  const key = message.toLowerCase().trim();
  responseCache.set(key, {
    response,
    timestamp: Date.now()
  });
  
  // Clean old cache entries
  if (responseCache.size > 100) {
    const entries = Array.from(responseCache.entries());
    entries.slice(0, 50).forEach(([k]) => responseCache.delete(k));
  }
}

// Rate limiting
const requestQueue = [];
let isProcessing = false;

async function processWithRateLimit(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  
  isProcessing = true;
  const { fn, resolve, reject } = requestQueue.shift();
  
  try {
    // Call the provided function (fn may use the centralized fallback)
    const result = await fn();
    resolve(result);
  } catch (error) {
    console.error('AI request failed:', error.message);
    // Normalize common errors but don't assume provider
    if (error.message.toLowerCase().includes('quota') || error.message.toLowerCase().includes('rate limit')) {
      reject(new Error('AI quota exceeded. Please check your provider quotas.'));
    } else if (error.message.toLowerCase().includes('permission') || error.message.toLowerCase().includes('unauthorized')) {
      reject(new Error('Authorization failed. Please check your API keys and permissions.'));
    } else {
      reject(new Error('AI service error: ' + error.message));
    }
  } finally {
    isProcessing = false;
    // Faster queue processing
    setTimeout(() => processQueue(), 200);
  }
}

// Enhanced agent detection with document analysis priority
function detectAgentNeed(message) {
  const msg = message.toLowerCase();
  
  // Skip agent routing for simple questions
  if (msg.match(/^(what can you do|what do you do|help|how are you|hi|hello|hey)$/i)) {
    return false;
  }
  
  // Document analysis triggers (high priority) - includes access questions
  const documentTriggers = [
    'analyze my credit report', 'review my credit report', 'review my credit report', 
    'my uploaded report', 'my credit file', 'check my credit report', 'look at my credit report',
    'get my credit report', 'd you see my credit report', 'find my credit report',
    'show me my', 'pull up my credit report', 'retrieve my credit report',
  ];
  // Other specific agent triggers
  const otherTriggers = [
    'search for', 'find information about', 'look up',
    'generate letter', 'create dispute letter', 'write a letter',
    'send email', 'email notification',
    'set reminder', 'calendar event'
  ];
  
  return documentTriggers.some(trigger => msg.includes(trigger)) ||
    otherTriggers.some(trigger => msg.includes(trigger));
}

// Helper to get user's recent files for AI context
async function getUserFilesContext(userId) {
  console.log('getUserFilesContext called with userId:', userId, 'supabase available:', !!supabase);
  
  if (!supabase || !userId) {
    console.log('No supabase or userId, returning empty context');
    return 'User has no uploaded files yet.';
  }
  
  try {
    console.log('Fetching user files from database...');
    const { data, error } = await supabase
      .from('report_analyses')
      .select('file_name, processed_at, analysis')
      .eq('user_id', userId)
      .order('processed_at', { ascending: false })
      .limit(3);

    console.log('Database query result:', { data, error });

    if (error) {
      console.error('Database error in getUserFilesContext:', error);
      return 'Error accessing user files.';
    }

    if (!data || data.length === 0) {
      console.log('No files found for user');
      return 'User has no uploaded files yet.';
    }

    const filesList = data.map((file, index) => {
      const violations = file.analysis?.violations?.length || 0;
      const errors = file.analysis?.errors?.length || 0;
      const status = file.analysis ? 'analyzed' : 'processing';
      const date = file.processed_at ? new Date(file.processed_at).toLocaleDateString() : 'Unknown date';
      
      return `${index + 1}. ${file.file_name || 'Unknown file'} (${date}) - ${status} - ${violations} violations, ${errors} errors`;
    }).join('\n');

    const context = `User's recent files:\n${filesList}`;
    console.log('Generated file context:', context);
    return context;
  } catch (error) {
    console.error('Exception in getUserFilesContext:', error);
    return 'Error accessing user files.';
  }
}

// No fallback user id: clients must provide a valid authenticated `userId`.

// Helper to get or create chat history
async function getChatHistory(sessionId, userId = null) {
  if (!chatSessions.has(sessionId)) {
    const systemMessage = new SystemMessage(
      "You are ConsumerAI, a professional legal assistant specializing in consumer rights and credit law under FDCPA and FCRA regulations.\n\n" +
      "Your capabilities include:\n" +
      "• Analyze credit reports for FCRA/FDCPA violations\n" +
      "• Detect errors, outdated items, identity theft indicators\n" +
      "• Generate dispute letters\n" +
      "• Calculate legal deadlines and timelines\n" +
      "• Provide actionable steps for disputes\n\n" +
      "Be professional, accurate, and helpful. Focus on actionable legal advice."
    );
    
    const history = [systemMessage];
    
    // Load previous messages using Supabase
    if (supabase && userId) {
      try {
        const { data, error } = await supabase
          .from('chat_history')
          .select('*')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: true })
          .limit(20);
        
        if (!error && data) {
          data.forEach(msg => {
            if (msg.role === 'user') {
              history.push(new HumanMessage(msg.message));
            } else if (msg.role === 'assistant') {
              history.push(new AIMessage(msg.message));
            }
          });
        }
      } catch (dbError) {
        console.error('Failed to load chat history from Supabase:', dbError);
      }
    }
    
    chatSessions.set(sessionId, history);
    // Ensure a message history store is available for this session
    try {
      // best-effort - do not block history creation on store initialization
      ensureChatStore(sessionId, userId).catch(err => console.warn('ensureChatStore error:', err && err.message ? err.message : err));
    } catch (e) {
      console.warn('ensureChatStore call failed:', e && e.message ? e.message : e);
    }
  }
  return chatSessions.get(sessionId);
}

// Removed quick responses - AI should always have full context

// Smart message processing with agent detection
async function processMessage(message, sessionId, socketId = null, useAgents = null, userId = null) {
  try {
    // processMessage requires the caller to pass a valid `userId`.
    // (tracking agent removed) timeline & mailing questions handled via supervisor/legal flows
    const msg = message.toLowerCase();
    
    // No quick responses - always use AI with full context
    
    // Only use agents for specific requests, not general questions
    const isSimpleQuestion = msg.match(/^(hi|hello|hey|what can you do|what do you do|help|how are you)$/i);
    const needsAgents = useAgents === true || (useAgents !== false && detectAgentNeed(message) && !isSimpleQuestion);
    const cachedResponse = !needsAgents ? getCachedResponse(message) : null;
    if (cachedResponse) {
      // Emit Socket.IO events for cached response
      console.log('Cached response found, attempting to emit events');
      console.log('socketId:', socketId, 'global.io exists:', !!global.io);
      if (socketId && global.io) {
        console.log('Emitting cached response events to socket:', socketId);
        global.io.to(socketId).emit('agent-thinking-start');
        global.io.to(socketId).emit('agent-thinking-complete');
        console.log('Cached events emitted');
      } else {
        console.log('Cannot emit cached events - socketId:', socketId, 'io:', !!global.io);
      }

      return {
        message: stripMarkdown(cachedResponse),
        sessionId,
        messageId: `${Date.now()}-ai`,
        created_at: new Date().toISOString(),
        usedModel: 'cached',
        decisionTrace: {
          usedAgent: 'cached',
          steps: ['Cached response']
        }
      };
    }
    
    const history = await getChatHistory(sessionId, userId);
    const userMessage = new HumanMessage(message);
    history.push(userMessage);

    let reasoningSteps = [];
    let usedAgent = 'direct';
    
    // Special case: Direct report analysis ONLY for explicit analysis requests
    const isReportAnalysis = (message.toLowerCase().includes('analyz') && 
                             (message.toLowerCase().includes('report') || 
                              message.toLowerCase().includes('document') ||
                              message.toLowerCase().includes('credit'))) ||
                            (message.toLowerCase().includes('check') && message.toLowerCase().includes('report') && message.toLowerCase().includes('analyz'));
    
    if (isReportAnalysis && supabase && userId) {
      reasoningSteps.push('Direct report analysis activated');
      usedAgent = 'report';

      // Emit agent selection for report analysis
      if (socketId && global.io) {
        console.log('Emitting agent-step for report analysis to socket:', socketId);
        global.io.to(socketId).emit('agent-step', {
          tool: 'report',
          toolInput: message,
          log: 'Analyzing credit report',
          timestamp: new Date().toISOString()
        });
      }

      // Human in loop: Emit notification for human review
      if (socketId && global.io) {
        console.log('Emitting human-review-needed for credit report analysis');
        global.io.to(socketId).emit('human-review-needed', {
          type: 'credit_report_analysis',
          userId: userId,
          message: message,
          timestamp: new Date().toISOString(),
          requiresApproval: true
        });
      }

      try {
        // Import reportAgent directly
        const { reportAgent } = require('./agents/supervisor');

        // Call reportAgent with proper state
        const result = await reportAgent({
          messages: [{ content: message }],
          userId: userId,
          supabase: supabase
        });

        const lastMessage = result.messages ? result.messages[result.messages.length - 1] : result;
        var aiResponse = { content: lastMessage.content || lastMessage.message || 'Analysis completed' };

        // Emit completion
        if (socketId && global.io) {
          global.io.to(socketId).emit('agent-step', {
            tool: 'report',
            toolInput: message,
            log: 'Credit report analysis completed',
            timestamp: new Date().toISOString()
          });
          global.io.to(socketId).emit('agent-thinking-complete');
        }

        // DISABLED: Chat history saving now handled on frontend
        // Save report analysis to database
        // if (supabase && userId) {
        //   try {
        //     await supabase.from('chat_history').insert([
        //       {
        //         session_id: sessionId,
        //         user_id: userId,
        //         role: 'user',
        //         content: message,
        //         created_at: new Date().toISOString()
        //       },
        //       {
        //         session_id: sessionId,
        //         user_id: userId,
        //         role: 'assistant',
        //         content: stripMarkdown(aiResponse.content || 'Analysis completed'),
        //         created_at: new Date().toISOString()
        //       }
        //     ]);
        //   } catch (dbError) {
        //     console.error('Failed to save report messages to database:', dbError);
        //   }
        // }

        // Save messages using LangChain PostgresChatMessageHistory
        const store = chatStores.get(sessionId);
        if (store) {
          try {
            await store.addMessages([
              new HumanMessage(message),
              new AIMessage(stripMarkdown(aiResponse.content || 'Analysis completed'))
            ]);
          } catch (dbError) {
            console.error('Failed to save report messages to Postgres:', dbError);
          }
        }

        // Cache the report response
        setCachedResponse(message, aiResponse.content || 'Analysis completed');

        return {
          message: stripMarkdown(aiResponse.content || 'Analysis completed'),
          sessionId,
          messageId: `${Date.now()}-ai`,
          created_at: new Date().toISOString(),
          usedModel: 'report',
          decisionTrace: {
            usedAgent: 'report',
            steps: reasoningSteps
          }
        };
      } catch (reportError) {
        console.log('Direct report analysis failed, falling back to direct AI:', reportError.message);
        // Fall through to direct AI response instead of returning error
      }
    }
    
    if (needsAgents) {
      reasoningSteps.push('Direct agent routing');
      
      const msg = message.toLowerCase();
      let agentResult = null;
      let selectedAgent = 'direct';
      
      // Direct agent routing based on message content
      if (msg.includes('letter') || msg.includes('dispute letter') || msg.includes('cease')) {
        selectedAgent = 'letter';
        if (socketId && global.io) {
          global.io.to(socketId).emit('agent-step', {
            tool: 'letter',
            toolInput: message,
            log: 'Using letter agent',
            timestamp: new Date().toISOString()
          });
        }
        
        try {
          const { letterAgent } = require('./agents/supervisor');
          agentResult = await letterAgent({ messages: [{ content: message }], userId, supabase });
        } catch (error) {
          console.error('Letter agent error:', error);
          agentResult = { messages: [{ content: 'Letter generation service temporarily unavailable.', name: 'LetterAgent' }] };
        }
        
      } else if (msg.includes('legal') || msg.includes('law') || msg.includes('rights') || 
                 msg.includes('statute') || msg.includes('fdcp') || msg.includes('fcr')) {
        selectedAgent = 'legal';
        if (socketId && global.io) {
          global.io.to(socketId).emit('agent-step', {
            tool: 'legal',
            toolInput: message,
            log: 'Using legal agent',
            timestamp: new Date().toISOString()
          });
        }
        
        try {
          const { legalAgent } = require('./agents/supervisor');
          agentResult = await legalAgent({ messages: [{ content: message }], userId, supabase });
        } catch (error) {
          console.error('Legal agent error:', error);
          agentResult = { messages: [{ content: 'Legal information service temporarily unavailable.', name: 'LegalAgent' }] };
        }
        
      } else if (msg.includes('search') || msg.includes('find') || msg.includes('research')) {
        selectedAgent = 'search';
        if (socketId && global.io) {
          global.io.to(socketId).emit('agent-step', {
            tool: 'search',
            toolInput: message,
            log: 'Using search agent',
            timestamp: new Date().toISOString()
          });
        }
        
        try {
          const { searchAgent } = require('./agents/supervisor');
          agentResult = await searchAgent({ messages: [{ content: message }], userId, supabase });
        } catch (error) {
          console.error('Search agent error:', error);
          agentResult = { messages: [{ content: 'Search service temporarily unavailable.', name: 'SearchAgent' }] };
        }
        
      } else {
        // Default to report agent for analysis requests
        selectedAgent = 'report';
        if (socketId && global.io) {
          global.io.to(socketId).emit('agent-step', {
            tool: 'report',
            toolInput: message,
            log: 'Using report agent',
            timestamp: new Date().toISOString()
          });
        }
        
        try {
          const { reportAgent } = require('./agents/supervisor');
          agentResult = await reportAgent({ messages: [{ content: message }], userId, supabase });
        } catch (error) {
          console.error('Report agent error:', error);
          agentResult = { messages: [{ content: 'Report analysis service temporarily unavailable.', name: 'ReportAgent' }] };
        }
      }
      
      if (agentResult && agentResult.messages && agentResult.messages.length > 0) {
        const lastMessage = agentResult.messages[agentResult.messages.length - 1];
        var aiResponse = { content: lastMessage.content };
        usedAgent = lastMessage.name || selectedAgent;
        
        // Emit thinking complete
        if (socketId && global.io) {
          global.io.to(socketId).emit('agent-thinking-complete');
        }

        // DISABLED: Chat history saving now handled on frontend
        // Save agent response to database
        // if (supabase && userId) {
        //   try {
        //     await supabase.from('chat_history').insert([
        //       {
        //         session_id: sessionId,
        //         user_id: userId,
        //         role: 'user',
        //         content: message,
        //         created_at: new Date().toISOString()
        //       },
        //       {
        //         session_id: sessionId,
        //         user_id: userId,
        //         role: 'assistant',
        //         content: stripMarkdown(aiResponse.content),
        //         created_at: new Date().toISOString()
        //       }
        //     ]);
        //   } catch (dbError) {
        //     console.error('Failed to save agent messages to database:', dbError);
        //   }
        // }

        // Save messages using Supabase
        if (supabase && userId) {
          try {
            console.log('Saving agent messages to Supabase for session:', sessionId);
            await supabase.from('chat_history').insert([
              {
                session_id: sessionId,
                user_id: userId,
                role: 'user',
                message: message, // Use 'message' column
                created_at: new Date().toISOString()
              },
              {
                session_id: sessionId,
                user_id: userId,
                role: 'assistant',
                message: stripMarkdown(aiResponse.content), // Use 'message' column
                created_at: new Date().toISOString()
              }
            ]);
            console.log('Agent messages saved successfully to Supabase');
          } catch (dbError) {
            console.error('Failed to save agent messages to Supabase:', dbError);
          }
        }

        // Cache the agent response
        setCachedResponse(message, aiResponse.content);

        return {
          message: stripMarkdown(aiResponse.content),
          sessionId,
          messageId: `${Date.now()}-ai`,
          created_at: new Date().toISOString(),
          usedModel,
          decisionTrace: {
            usedAgent,
            steps: reasoningSteps
          }
        };
      }
    } else {
      // Regular chat - direct Google AI
      console.log('Taking direct AI path for message:', message);
      reasoningSteps.push('Direct AI response');

      // Emit thinking start
      if (socketId && global.io) {
        global.io.to(socketId).emit('agent-thinking-start');
      }

      var result = await processWithRateLimit(() => chatWithFallback(history));
      var aiResponse = result.response;
      var usedModel = result.model;

      // Emit thinking complete for direct AI
      if (socketId && global.io) {
        global.io.to(socketId).emit('agent-thinking-complete');
      }

      // DISABLED: Chat history saving now handled on frontend
      // Save to database for direct AI
      // if (supabase && userId) {
      //   try {
      //     await supabase.from('chat_history').insert([
      //     {
      //       session_id: sessionId,
      //       user_id: userId,
      //       role: 'user',
      //       content: message,
      //       created_at: new Date().toISOString()
      //     },
      //     {
      //       session_id: sessionId,
      //       user_id: userId,
      //       role: 'assistant',
      //       content: stripMarkdown(aiResponse.content),
      //       created_at: new Date().toISOString()
      //     }
      //   ]);
      //   } catch (dbError) {
      //     console.error('Failed to save messages to database:', dbError);
      //   }
      // }

      // Save messages using LangChain PostgresChatMessageHistory
      const store = chatStores.get(sessionId);
      if (store) {
        try {
          console.log('Saving messages to LangChain store for session:', sessionId);
          await store.addMessages([
            new HumanMessage(message),
            new AIMessage(stripMarkdown(aiResponse.content))
          ]);
          console.log('Messages saved successfully to LangChain store');
        } catch (dbError) {
          console.error('Failed to save messages to Postgres:', dbError);
        }
      } else {
        console.log('No store found for session:', sessionId);
      }

      // Cache the response for direct AI
      setCachedResponse(message, aiResponse.content);

      return {
        message: stripMarkdown(aiResponse.content),
        sessionId,
        messageId: `${Date.now()}-ai`,
        created_at: new Date().toISOString(),
        usedModel,
        decisionTrace: {
          usedAgent: 'direct',
          steps: reasoningSteps
        }
      };
    }
  } catch (error) {
    console.error('Error processing message:', error);
    
    if (socketId && global.io) {
      global.io.to(socketId).emit('agent-thinking-error', error.message);
    }
    
    throw error;
  }
}

// Storage plan definitions
const STORAGE_PLANS = {
  basic: { price: 500, storage: 1073741824, files: 200 },
  pro: { price: 1000, storage: 5368709120, files: 1000 },
  enterprise: { price: 2500, storage: 21474836480, files: 5000 }
};

// Asynchronous function to process a Stripe event after responding
const processStripeEvent = async (event) => {
  try {
    if (!supabase) {
      console.warn('Supabase not configured, skipping stripe event processing');
      return;
    }
    
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.userId;

      if (userId) {
        console.log(`Processing successful checkout for user: ${userId}`);
        const { data: metrics, error: metricsError } = await supabase
          .from('user_metrics')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (metricsError && metricsError.code !== 'PGRST116') throw metricsError;

        const currentMetrics = metrics || {
          user_id: userId,
          daily_limit: 5,
          chats_used: 0,
          is_pro: false,
        };

        await supabase.from('user_metrics').upsert({
          ...currentMetrics,
          daily_limit: currentMetrics.daily_limit + 50,
          is_pro: true,
          last_purchase: new Date().toISOString(),
          last_updated: new Date().toISOString()
        });

        await supabase.from('purchases').insert([{
          user_id: userId,
          amount: session.amount_total ? session.amount_total / 100 : 0,
          credits: 50,
          stripe_session_id: session.id,
          status: 'completed',
          metadata: {
            payment_status: session.payment_status,
            customer_email: session.customer_details?.email
          }
        }]);
        console.log(`User ${userId} metrics and purchase recorded.`);
      } else {
        console.error('Webhook received for checkout.session.completed without a userId in metadata.');
      }
    }
  } catch (error) {
    console.error('Error processing stripe-webhook event asynchronously:', error);
  }
};

// Asynchronous function to process a storage-related Stripe event
const processStorageEvent = async (event) => {
  try {
    if (!supabase) {
      console.warn('Supabase not configured, skipping storage event processing');
      return;
    }
    
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const plan = session.metadata?.plan;
      const userId = session.metadata?.userId;
      const planDetails = STORAGE_PLANS[plan];

      if (!userId || !planDetails) {
        throw new Error('Missing required metadata or unknown plan in Stripe session for storage upgrade');
      }
      const storageBytes = planDetails.storage;
      const files = planDetails.files;

      console.log(`Processing storage upgrade for user: ${userId}, plan: ${plan}`);

      await supabase.from('storage_transactions').update({
        status: 'completed',
        completed_at: new Date().toISOString()
      }).eq('stripe_session_id', session.id);

      // Ensure storage_limits exists for this user to avoid PGRST116 errors
      await ensureDefaultStorageLimits(userId);

      const { data: currentLimits, error: limitsError } = await supabase
        .from('storage_limits')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (limitsError && limitsError.code !== 'PGRST116') throw limitsError;

      if (currentLimits) {
        await supabase.from('storage_limits').update({
          max_storage_bytes: (currentLimits.max_storage_bytes || 0) + storageBytes,
          max_files: (currentLimits.max_files || 0) + files,
          is_premium: true,
          tier_name: plan,
          updated_at: new Date().toISOString()
        }).eq('user_id', userId);
      } else {
        await supabase.from('storage_limits').insert([{
          user_id: userId,
          max_storage_bytes: storageBytes,
          used_storage_bytes: 0,
          max_files: files,
          used_files: 0,
          is_premium: true,
          tier_name: plan
        }]);
      }
      console.log(`Storage limits updated for user: ${userId}`);
    }
  } catch (error) {
    console.error('Error processing storage/webhook event asynchronously:', error);
  }
};

// Ensure default storage_limits row exists for a user and dedupe duplicates
async function ensureDefaultStorageLimits(userId) {
  if (!supabase || !userId) return null;

  try {
    const { data, error } = await supabase
      .from('storage_limits')
      .select('*')
      .eq('user_id', userId);

    if (error) {
      console.error('Error checking storage_limits for user:', error);
      return null;
    }

    if (!data || data.length === 0) {
      // insert default row
      const defaults = {
        user_id: userId,
        max_storage_bytes: 1073741824, // 1GB default
        used_storage_bytes: 0,
        max_files: 200,
        used_files: 0,
        is_premium: false,
        tier_name: 'basic',
        created_at: new Date().toISOString()
      };
      const { data: inserted, error: insertErr } = await supabase
        .from('storage_limits')
        .insert([defaults])
        .select()
        .maybeSingle();
      if (insertErr) console.error('Failed to insert default storage_limits:', insertErr);
      return inserted || defaults;
    }

    if (data.length > 1) {
      // keep the first, remove duplicates
      const keep = data[0];
      const dupIds = data.slice(1).map(r => r.id).filter(Boolean);
      if (dupIds.length > 0) {
        await supabase.from('storage_limits').delete().in('id', dupIds);
        console.warn(`Removed ${dupIds.length} duplicate storage_limits rows for user ${userId}`);
      }
      return keep;
    }

    return data[0];
  } catch (err) {
    console.error('ensureDefaultStorageLimits error:', err);
    return null;
  }
}

// Main API handler
module.exports = async function handler(req, res) {
  // Store io reference for emitting events (set by server.js)
  // global.io is set when the module is initialized
  
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const path = req.url.split('?')[0].replace(/^\//, '') || '';
  console.log(`[API Router] Routing request to: ${path}`);

  try {
    // Stripe webhook endpoint
    if (path === 'stripe-webhook') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      
      if (!stripe) {
        return res.status(503).json({ error: 'Stripe not configured' });
      }
      
      const sig = req.headers['stripe-signature'];
      try {
        const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
        res.status(200).json({ received: true });
        processStripeEvent(event);
      } catch (err) {
        console.error(`Webhook signature verification failed.`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }
      return;
    }

    // Storage webhook endpoint
    else if (path === 'storage/webhook') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      
      if (!stripe) {
        return res.status(503).json({ error: 'Stripe not configured' });
      }
      
      const sig = req.headers['stripe-signature'];
      try {
        const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
        res.status(200).json({ received: true });
        processStorageEvent(event);
      } catch (err) {
        console.error('Storage webhook signature verification failed:', err.message);
        return res.status(400).json({ error: err.message });
      }
      return;
    }

    // Daily login bonus endpoint
    if (path === 'daily-login-bonus') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ error: 'Missing userId' });
      
      try {
        // Simple daily bonus logic
        const today = new Date().toISOString().split('T')[0];
        
        if (supabase) {
          // Check if user already claimed today
          const { data: existing } = await supabase
            .from('daily_bonuses')
            .select('*')
            .eq('user_id', userId)
            .eq('date_claimed', today)
            .single();
            
          if (existing) {
            return res.status(200).json({ 
              success: false, 
              message: 'Already claimed today',
              nextClaimDate: new Date(Date.now() + 24*60*60*1000).toISOString()
            });
          }
          
          // Award bonus
          await supabase.from('daily_bonuses').insert({
            user_id: userId,
            date_claimed: today,
            bonus_amount: 1
          });
          
          // Update user credits
          const { data: metrics } = await supabase
            .from('user_metrics')
            .select('daily_limit')
            .eq('user_id', userId)
            .single();
            
          await supabase.from('user_metrics').upsert({
            user_id: userId,
            daily_limit: (metrics?.daily_limit || 5) + 1,
            last_updated: new Date().toISOString()
          });
        }
        
        return res.status(200).json({ 
          success: true, 
          message: 'Daily bonus claimed!',
          bonusAmount: 1,
          nextClaimDate: new Date(Date.now() + 24*60*60*1000).toISOString()
        });
        } catch (error) {
          return res.status(500).json({ error: error.message });
        }
      }
  
      // Test database access endpoint
      if (path === 'test/db-access') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      
      try {
        const { testDatabaseAccess } = require('./temp/test-db-access');
        const results = await testDatabaseAccess();
        return res.status(200).json({ success: true, results });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // Test email access endpoint
    if (path === 'test/email-access') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      
      try {

      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // Legal search endpoint - used by front-end button to request search + optional save
    if (path === 'legal/search') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      try {
        const { query, save, userId: bodyUserId } = req.body || {};
        const uid = bodyUserId || req.headers['user-id'] || null;
        if (!query) return res.status(400).json({ error: 'query is required' });

        // If save requested, ensure a userId is available (bind saved docs to a user)
        if (save && !uid) return res.status(403).json({ error: 'userId required to save documents' });

        const result = await enhancedLegalSearch(query, { save: !!save, userId: uid });
        return res.status(200).json({ success: true, result });
      } catch (err) {
        console.error('legal/search failed:', err);
        return res.status(500).json({ error: 'legal search/save failed', details: err.message });
      }
    }

    // Test email access endpoint
    if (path === 'test/email-access') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      
      try {
        const { testEmailAccess } = require('./temp/test-email-access');
        const results = await testEmailAccess();
        return res.status(200).json({ success: true, results });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // Admin DB schema & permissions check (server-side only)
    if (path === 'admin/db-check') {
      console.log('supabase object:', typeof supabase, supabase ? 'has rpc:' + typeof supabase.rpc : 'no supabase');
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
      try {
        const required = {
          tables: ['ocr_artifacts', 'report_analyses'],
          report_analyses_cols: ['ocr_artifact_id', 'doc_type']
        };

        const results = { tables: {}, columns: {}, notes: [] };

        // Prefer using pgPool to query information_schema correctly (avoids using supabase.from('information_schema.*'))
        if (pgPool) {
          try {
            const tableNames = ['ocr_artifacts', 'report_analyses'];
            for (const t of tableNames) {
              try {
                const q = `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS exists`;
                const r = await pgPool.query(q, [t]);
                results.tables[t] = r && r.rows && r.rows[0] && r.rows[0].exists === true;
              } catch (err) {
                results.tables[t] = false;
                results.notes.push(`information_schema query for ${t} failed: ${err.message}`);
              }
            }

            const cols = ['ocr_artifact_id', 'doc_type'];
            for (const c of cols) {
              try {
                const qc = `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='report_analyses' AND column_name=$1) AS exists`;
                const rc = await pgPool.query(qc, [c]);
                results.columns[c] = rc && rc.rows && rc.rows[0] && rc.rows[0].exists === true;
              } catch (err) {
                results.columns[c] = false;
                results.notes.push(`information_schema query for column ${c} failed: ${err.message}`);
              }
            }
          } catch (err) {
            results.notes.push('pgPool information_schema checks failed: ' + (err.message || err));
          }
        } else {
          // Fallback: Check tables/columns by performing harmless selects via Supabase client
          const tableChecks = [
            { name: 'ocr_artifacts', query: () => supabase.from('ocr_artifacts').select('id').limit(1) },
            { name: 'report_analyses', query: () => supabase.from('report_analyses').select('id').limit(1) }
          ];

          for (const { name, query } of tableChecks) {
            try {
              const { data, error } = await query();
              results.tables[name] = !error;
              if (error) results.notes.push(`Table ${name} check failed: ${error.message}`);
            } catch (err) {
              results.tables[name] = false;
              results.notes.push(`Table ${name} check error: ${err.message}`);
            }
          }

          // Check columns by trying selects
          const columnChecks = [
            { name: 'ocr_artifact_id', query: () => supabase.from('report_analyses').select('ocr_artifact_id').limit(1) },
            { name: 'doc_type', query: () => supabase.from('report_analyses').select('doc_type').limit(1) }
          ];

          for (const { name, query } of columnChecks) {
            try {
              const { data, error } = await query();
              results.columns[name] = !error;
              if (error) results.notes.push(`Column ${name} check failed: ${error.message}`);
            } catch (err) {
              results.columns[name] = false;
              results.notes.push(`Column ${name} check error: ${err.message}`);
            }
          }
        }

        // Permission hint: try a harmless select on ocr_artifacts
        try {
          await supabase.from('ocr_artifacts').select('id').limit(1);
          results.notes.push('Select on ocr_artifacts succeeded');
        } catch (err) {
          results.notes.push('Select on ocr_artifacts failed: ' + (err.message || err));
        }

        return res.status(200).json({ ok: true, results });
      } catch (err) {
        console.error('admin/db-check error:', err.message || err);
        return res.status(500).json({ error: err.message || 'DB check failed' });
      }
    }

    // Labeled samples - add labeled example (server-side; requires SUPABASE_SERVICE_ROLE_KEY)
    if (path === 'labels') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { userId, label, snippet, filePath } = req.body || {};
      if (!label || !snippet) return res.status(400).json({ error: 'Missing label or snippet' });
      try {
        const rp = require('./reportProcessor');
        const inserted = await rp.addLabeledSample(userId || null, label, snippet, filePath || null);
        return res.status(200).json({ success: true, inserted });
      } catch (err) {
        console.error('Failed to insert labeled sample via API:', err.message || err);
        return res.status(500).json({ error: err.message || 'Insert failed' });
      }
    }

    // Chat endpoint - simplified without complex agents
    if (path === 'chat') {
      if (req.method === 'GET') return res.status(200).json({ status: 'ok' });
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      
      const { message, sessionId, socketId, useAgents, userId } = req.body;
      if (!message || !sessionId) {
        return res.status(400).json({ error: 'Missing message or sessionId' });
      }
      // Require a real userId from client. Do not allow defaults or fake IDs.
      // Skip validation in test mode
      const isTestMode = req.headers['x-test-mode'] === 'true';
      if (!userId && !isTestMode) {
        return res.status(400).json({ error: 'Missing userId. Client must pass authenticated user id.' });
      }

      try {
        // Validate that the provided userId exists in `profiles` to avoid fake IDs.
        if (supabase && !isTestMode) {
          try {
            const { data: profile, error: profileErr } = await supabase
              .from('profiles')
              .select('id')
              .eq('id', userId)
              .maybeSingle();

            if (profileErr) {
              console.error('Error checking profile existence:', profileErr);
              return res.status(500).json({ error: 'Error validating userId' });
            }
            if (!profile) {
              return res.status(400).json({ error: { code: 'INVALID_USER', message: 'Invalid userId: profile not found' } });
            }
          } catch (err) {
            console.error('Exception validating userId:', err);
            return res.status(500).json({ error: 'Exception validating userId' });
          }
        }

        const result = await processMessage(message, sessionId, socketId, useAgents, userId);
        return res.status(200).json({ data: result });
      } catch (error) {
        console.error('Chat error:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // Chat history endpoint
    if (path === 'chat/history') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const sessionId = req.query.sessionId || req.headers['x-session-id'];
      if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

      console.log('Chat history request for sessionId:', sessionId);
      console.log('Supabase available:', !!supabase);

      if (!supabase) {
        console.log('No Supabase client, returning empty history');
        return res.status(200).json({ data: [] }); // Return empty history if no database
      }

      try {
        console.log('Attempting to query chat_history table...');
        const { data, error } = await supabase
          .from('chat_history')
          .select('*')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: true });

        console.log('Supabase query completed. Data length:', data?.length || 0, 'Error:', error);

        if (error) {
          console.error('Failed to fetch chat history:', error);
          console.error('Error details:', JSON.stringify(error, null, 2));
          return res.status(500).json({ error: error.message, details: error });
        }

        const formatted = (data || []).map((msg, idx) => ({
          id: msg.id || `${sessionId}-${idx}-${msg.role}`,
          content: msg.message, // Use 'message' column
          role: msg.role,
          created_at: msg.created_at
        }));

        return res.status(200).json({ data: formatted });
      } catch (error) {
        console.error('Failed to fetch chat history:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    // User stats endpoint
    if (path === 'user/stats') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'Missing userId' });

      if (!supabase) {
        return res.status(200).json({
          dailyLimit: 5,
          chatsUsed: 0,
          remaining: 5
        });
      }

      const { data, error } = await supabase
        .from('user_metrics')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') {
        return res.status(500).json({ error: error.message });
      }

      const metrics = data || {
        dailyLimit: 5,
        chatsUsed: 0,
        remaining: 5
      };

      return res.status(200).json({
        dailyLimit: metrics.daily_limit || 5,
        chatsUsed: metrics.chats_used || 0,
        remaining: Math.max(0, (metrics.daily_limit || 5) - (metrics.chats_used || 0))
      });
    }

    // User credits endpoint
    if (path === 'user/credits') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'Missing userId' });

      if (!supabase) {
        return res.status(200).json({ credits: 5 });
      }

      const { data, error } = await supabase
        .from('user_metrics')
        .select('daily_limit, chats_used')
        .eq('user_id', userId)
        .single();

      if (error && error.code !== 'PGRST116') {
        return res.status(500).json({ error: error.message });
      }

      const metrics = data || { daily_limit: 5, chats_used: 0 };
      return res.status(200).json({
        credits: Math.max(0, metrics.daily_limit - metrics.chats_used)
      });
    }

    // User files endpoint - get last 3 files
    if (path === 'user/files') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const userId = req.headers['user-id'] || req.query.userId;
      
      console.log('User files request - userId:', userId, 'supabase available:', !!supabase);
      
      if (!userId) return res.status(400).json({ error: 'Missing userId' });

      if (!supabase) {
        console.log('No supabase connection, returning empty files');
        return res.status(200).json({ files: [] });
      }

      try {
        console.log('Querying report_analyses for user:', userId);
        const { data, error } = await supabase
          .from('report_analyses')
          .select('file_name, file_path, processed_at, analysis')
          .eq('user_id', userId)
          .order('processed_at', { ascending: false })
          .limit(3);

        console.log('Query result - data:', data, 'error:', error);

        if (error) {
          console.error('Database error:', error);
          return res.status(500).json({ error: error.message });
        }

        const files = (data || []).map(file => {
          const processedDate = file.processed_at ? new Date(file.processed_at) : new Date();
          return {
            name: file.file_name || 'Unknown file',
            path: file.file_path,
            date: processedDate.toISOString(),
            dateFormatted: processedDate.toLocaleDateString(),
            status: file.analysis ? 'analyzed' : 'processing',
            violations: file.analysis?.violations?.length || 0,
            errors: file.analysis?.errors?.length || 0
          };
        });

        console.log('Returning files:', files);
        return res.status(200).json({ files });
      } catch (err) {
        console.error('User files endpoint error:', err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Report analysis endpoint
    if (path === 'report/analyze') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      
      const { filePath, userId } = req.body;
      if (!filePath) {
        return res.status(400).json({ error: 'Missing filePath' });
      }

      try {
        console.log('📋 Processing credit report:', filePath);
        const { processCreditReport } = require('./reportProcessor');
        const result = await processCreditReport(filePath);
        
        // Log analysis field counts
        if (result.analysis) {
          console.log('📊 API: Analysis has fields:');
          console.log('  - personal_info_issues:', (result.analysis.personal_info_issues || []).length);
          console.log('  - account_issues:', (result.analysis.account_issues || []).length);
          console.log('  - inquiries:', (result.analysis.inquiries || []).length);
          console.log('  - collection_accounts:', (result.analysis.collection_accounts || []).length);
          console.log('  - fcra_violations:', (result.analysis.fcra_violations || []).length);
          console.log('  - dispute_letters_needed:', (result.analysis.dispute_letters_needed || []).length);
        }
        
        // Store analysis result in database if needed
        if (supabase && userId) {
          await supabase.from('report_analyses').insert({
            user_id: userId,
            file_path: filePath,
            ocr_artifact_id: result.ocr_artifact_id || null,
            analysis: result.analysis,
            processed_at: result.processedAt || new Date().toISOString()
          });
          console.log('✅ Analysis stored in database');
        }

        return res.status(200).json(result);
      } catch (error) {
        console.error('❌ Report analysis error:', error);
        return res.status(500).json({ error: error.message });
      }
    }
    
    // Debug endpoint: Get last analysis with full breakdown
    if (path === 'debug/last-analysis') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      
      const userId = req.query.userId || req.query.user_id;
      if (!userId) return res.status(400).json({ error: 'Missing userId' });
      
      try {
        const { data } = await supabase
          .from('report_analyses')
          .select('*')
          .eq('user_id', userId)
          .order('processed_at', { ascending: false })
          .limit(1);
        
        if (!data || data.length === 0) {
          return res.status(404).json({ error: 'No analysis found' });
        }
        
        const analysis = data[0].analysis;
        return res.status(200).json({
          processed_at: data[0].processed_at,
          file_path: data[0].file_path,
          field_counts: {
            summary: !!analysis.summary,
            personal_info_issues: (analysis.personal_info_issues || []).length,
            account_issues: (analysis.account_issues || []).length,
            inquiries: (analysis.inquiries || []).length,
            collection_accounts: (analysis.collection_accounts || []).length,
            fcra_violations: (analysis.fcra_violations || []).length,
            overall_assessment: !!analysis.overall_assessment,
            dispute_letters_needed: (analysis.dispute_letters_needed || []).length
          },
          raw_response_snippet: analysis._raw_response_snippet || null,
          missing_sections: analysis._missing_sections || [],
          validation: analysis._validation || null,
          analysis_models: analysis._analysis_models || [],
          full_analysis: analysis
        });
      } catch (err) {
        console.error('debug error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // Fetch stored analysis + OCR evidence for a file
    if (path === 'report/analysis' && req.method === 'GET') {
      const filePath = req.query.filePath || req.query.file_path;
      const userId = req.query.userId || req.query.user_id;
      if (!filePath || !userId) return res.status(400).json({ error: 'Missing filePath or userId' });
      try {
        const { data: rows, error } = await supabase.from('report_analyses').select('*').eq('user_id', userId).eq('file_path', filePath).limit(1);
        if (error) return res.status(500).json({ error: error.message });
        if (!rows || rows.length === 0) return res.status(404).json({ error: 'No analysis found' });
        const row = rows[0];
        let ocr = null;
        if (row.ocr_artifact_id) {
          const { data: ocrRows, error: oErr } = await supabase.from('ocr_artifacts').select('*').eq('id', row.ocr_artifact_id).limit(1);
          if (!oErr && ocrRows && ocrRows.length > 0) ocr = ocrRows[0];
        }
        return res.status(200).json({ analysis: row.analysis, ocr });
      } catch (err) {
        console.error('report/analysis error:', err.message || err);
        return res.status(500).json({ error: err.message || 'Failed to fetch analysis' });
      }
    }

    // Preview + validation endpoint for frontend snapshots and CI
    if (path === 'report/preview') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const analysis = req.body.analysis;
      if (!analysis) return res.status(400).json({ error: 'Missing analysis JSON in body.analysis' });

      try {
        const { validate } = require('./utils/ajvValidate');
        const { valid, errors } = validate(analysis);

        // Simple HTML preview generator for comprehensive analysis
        const escapeHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const summary = analysis.summary || 'No summary provided';
        const personalIssues = Array.isArray(analysis.personal_info_issues) ? analysis.personal_info_issues : [];
        const accountIssues = Array.isArray(analysis.account_issues) ? analysis.account_issues : [];
        const collectionAccounts = Array.isArray(analysis.collection_accounts) ? analysis.collection_accounts : [];
        const fcraViolations = Array.isArray(analysis.fcra_violations) ? analysis.fcra_violations : [];
        const overall = analysis.overall_assessment || {};

        let html = `<!doctype html><html><head><meta charset="utf-8"><title>Credit Report Analysis Preview</title>
          <style>body{font-family:Arial,Helvetica,sans-serif;padding:16px;max-width:800px;margin:0 auto} h1{font-size:24px;margin-bottom:8px} h2{font-size:18px;margin-top:24px} h3{font-size:16px;margin-top:16px} .badge{display:inline-block;padding:4px 8px;border-radius:12px;background:#eee;margin-left:8px} .high{background:#fee} .medium{background:#ffd} .low{background:#efe} .section{margin-bottom:24px} .item{margin-bottom:12px;padding:8px;border-left:4px solid #ccc} .evidence{font-style:italic;color:#666;margin-top:4px} ul{list-style:none;padding:0} li{margin-bottom:8px}</style></head><body>`;

        html += `<h1>Credit Report Analysis Preview</h1>`;
        html += `<div class="section"><h2>Summary</h2><p>${escapeHtml(summary)}</p></div>`;

        if (personalIssues.length > 0) {
          html += `<div class="section"><h2>Personal Information Issues</h2><ul>`;
          personalIssues.slice(0, 5).forEach(issue => {
            html += `<li class="item ${issue.severity || 'low'}"><strong>${escapeHtml(issue.type || 'Issue')}</strong> <span class="badge">${escapeHtml(issue.severity || 'unknown')}</span><div>${escapeHtml(issue.description || '')}</div><div class="evidence">${escapeHtml(issue.evidence || '')}</div></li>`;
          });
          html += `</ul></div>`;
        }

        if (accountIssues.length > 0) {
          html += `<div class="section"><h2>Account Issues</h2><ul>`;
          accountIssues.slice(0, 10).forEach(issue => {
            html += `<li class="item ${issue.severity || 'low'}"><strong>${escapeHtml(issue.account_name || 'Unknown Account')}</strong> <span class="badge">${escapeHtml(issue.severity || 'unknown')}</span><div>${escapeHtml(issue.description || '')}</div><div class="evidence">${escapeHtml(issue.evidence || '')}</div></li>`;
          });
          html += `</ul></div>`;
        }

        if (collectionAccounts.length > 0) {
          html += `<div class="section"><h2>Collection Accounts</h2><ul>`;
          collectionAccounts.slice(0, 5).forEach(acc => {
            html += `<li class="item"><strong>${escapeHtml(acc.collection_agency || 'Unknown Agency')}</strong><div>Original Creditor: ${escapeHtml(acc.creditor_name || '')}</div><div>Balance: ${escapeHtml(acc.current_balance || '')}</div></li>`;
          });
          html += `</ul></div>`;
        }

        if (fcraViolations.length > 0) {
          html += `<div class="section"><h2>FCRA Violations</h2><ul>`;
          fcraViolations.slice(0, 5).forEach(v => {
            html += `<li class="item ${v.severity || 'low'}"><strong>${escapeHtml(v.violation_type || 'Violation')}</strong> <span class="badge">${escapeHtml(v.severity || 'unknown')}</span><div>${escapeHtml(v.description || '')}</div><div class="evidence">${escapeHtml(v.evidence || '')}</div></li>`;
          });
          html += `</ul></div>`;
        }

        if (overall.priority_actions) {
          html += `<div class="section"><h2>Priority Actions</h2><ul>`;
          (overall.priority_actions || []).slice(0, 5).forEach(action => {
            html += `<li>${escapeHtml(action)}</li>`;
          });
          html += `</ul></div>`;
        }

        html += `<footer><small>Validation: ${valid ? '✅ Valid' : '❌ Invalid'} | Risk Level: ${escapeHtml(overall.overall_risk_level || 'unknown')}</small></footer>`;
        html += `</body></html>`;

        return res.status(200).json({ valid, errors, html });
      } catch (err) {
        console.error('Preview endpoint error:', err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Ensure storage limits endpoint - creates defaults if missing
    if (path === 'storage/ensure') {
      const userId = req.method === 'GET' ? req.query.user_id : req.body.user_id;
      if (!userId) return res.status(400).json({ error: 'Missing user_id' });

      try {
        const row = await ensureDefaultStorageLimits(userId);
        return res.status(200).json({ data: row });
      } catch (err) {
        console.error('storage/ensure error:', err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Supabase DB / Storage webhook endpoint
    if (path === 'supabase/webhook') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      // Optional secret validation - configure SUPABASE_WEBHOOK_SECRET in .env
      const authHeader = req.headers.authorization || '';
      if (process.env.SUPABASE_WEBHOOK_SECRET) {
        const expected = `Bearer ${process.env.SUPABASE_WEBHOOK_SECRET}`;
        if (authHeader !== expected) {
          console.warn('Supabase webhook rejected due to invalid Authorization header');
          return res.status(401).json({ error: 'Invalid webhook signature' });
        }
      }

      try {
        const payload = req.body;

        // Common Supabase DB webhook shape: { table, event, record }
        if (payload && payload.table && payload.event && payload.record) {
          const { table, event, record } = payload;
          console.log(`Supabase webhook: table=${table} event=${event}`);

          // Trigger automation when automation_queue gets new tasks
          if (table === 'automation_queue' && event === 'INSERT') {
            // Process the automation queue immediately
            setTimeout(async () => {
              try {
                await fetch(`${process.env.BASE_URL || 'http://localhost:3001'}/api/automation/process-queue`, {
                  method: 'POST'
                });
              } catch (err) {
                console.error('Failed to trigger automation processing:', err);
              }
            }, 2000); // 2 second delay
          }
          
          // Handle certified_mail updates
          if (table === 'certified_mail' && event === 'UPDATE') {
            console.log('Mail status updated via webhook, automation will be triggered by database trigger');
          }
          
          // Handle calendar_events inserts
          if (table === 'calendar_events' && event === 'INSERT') {
            console.log('New calendar event created, reminder automation scheduled by database trigger');
          }

          // If a new file row is inserted, try to find a file path and trigger processing
          if (event === 'INSERT') {
            const filePath = record.file_path || record.path || record.name || record.object_key || record.url;
            const userId = record.user_id || record.owner || null;
            if (filePath) {
              // Ensure storage_limits exists for this user before processing
              if (userId) await ensureDefaultStorageLimits(userId);

              // Fire-and-forget processing
              (async () => {
                try {
                  const { processDocument } = require('./reportProcessor');
                  const result = await processDocument(filePath, userId || null);
                  console.log('Triggered report processing from Supabase webhook for file:', filePath);

                  // Optionally store analysis results in DB if supabase client is available
                  if (supabase && userId) {
                    await supabase.from('report_analyses').insert({
                      user_id: userId,
                      file_path: filePath,
                      ocr_artifact_id: result.ocr_artifact_id || null,
                      analysis: result.analysis || result,
                      processed_at: result.processedAt || new Date().toISOString()
                    }).catch(err => console.error('Failed to save analysis:', err));
                  }
                } catch (err) {
                  console.error('Error processing file from Supabase webhook:', err);
                }
              })();
            }
          }

          return res.status(200).json({ received: true });
        }

        // Storage (object) events may use a different shape
        if (payload && payload.eventType && payload.data) {
          // Example: { eventType: 'object_created', data: { bucket, name, ... } }
          const name = payload.data.name || payload.data.path || payload.data.key;
          const bucket = payload.data.bucket || payload.data.bucketId;
          if (name) {
            const filePath = `${bucket}/${name}`;
            (async () => {
              try {
                const { processDocument } = require('./reportProcessor');
                const result = await processDocument(filePath, null);
                console.log('Processed storage object via Supabase webhook:', filePath);
                // No direct DB save here because webhook may not include user_id; if you have user metadata, include it above
              } catch (err) {
                console.error('Error processing storage object:', err);
              }
            })();
            return res.status(200).json({ received: true });
          }
        }

        // Unknown payload
        console.warn('Supabase webhook received unknown payload shape');
        return res.status(400).json({ error: 'Unknown webhook payload' });
      } catch (err) {
        console.error('Error handling Supabase webhook:', err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Human approval endpoint for sensitive operations
    if (path === 'human-approve' && req.method === 'POST') {
      try {
        const { approvalId, approved, feedback } = req.body;

        if (!approvalId) {
          return res.status(400).json({ error: 'approvalId is required' });
        }

        // Just emit socket event to notify the user/AI - no database storage
        if (global.io && approvalId) {
          const eventType = approved ? 'human-approval-granted' : 'human-approval-denied';
          global.io.to(approvalId).emit(eventType, {
            approvalId,
            approved,
            feedback,
            timestamp: new Date().toISOString()
          });
        }

        return res.status(200).json({
          success: true,
          approvalId,
          approved,
          feedback
        });

      } catch (error) {
        console.error('Human approval error:', error);
        return res.status(500).json({ error: 'Failed to process approval' });
      }
    }

    // File upload endpoint - associates files with authenticated users
    if (path === 'upload') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      // Get user ID from header (set by frontend authentication)
      const userId = req.headers['user-id'];
      if (!userId) {
        return res.status(401).json({ error: 'User authentication required' });
      }

      try {
        // Check storage limits before upload
        await ensureDefaultStorageLimits(userId);
        const { data: limits, error: limitsError } = await supabase
          .from('storage_limits')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (limitsError && limitsError.code !== 'PGRST116') {
          console.error('Error checking storage limits:', limitsError);
          return res.status(500).json({ error: 'Failed to check storage limits' });
        }

        const currentLimits = limits || {
          max_storage_bytes: 1073741824, // 1GB default
          used_storage_bytes: 0,
          max_files: 200,
          used_files: 0
        };

        // Check file count limit
        if (currentLimits.used_files >= currentLimits.max_files) {
          return res.status(400).json({
            error: 'File limit exceeded',
            details: `Maximum ${currentLimits.max_files} files allowed`
          });
        }

        // For now, expect file to be uploaded directly to Supabase storage
        // Frontend should upload to credit-reports/{userId}/filename
        // This endpoint just validates and triggers processing
        const { filePath, fileName } = req.body;

        if (!filePath || !fileName) {
          return res.status(400).json({
            error: 'Missing file information',
            details: 'filePath and fileName are required'
          });
        }

        // Validate file path format (should be userId/filename)
        const expectedPrefix = `${userId}/`;
        if (!filePath.startsWith(expectedPrefix)) {
          return res.status(400).json({
            error: 'Invalid file path',
            details: `File path must start with user ID: ${expectedPrefix}`
          });
        }

        // Verify file exists in storage - check multiple buckets with correct paths
        const buckets = ['users-file-storage', 'credit-reports', 'uploads', 'documents'];
        let fileExists = false;
        let fileInfo = null;
        let foundBucket = null;

        for (const bucket of buckets) {
          try {
            let listPath = userId;
            
            // For users-file-storage bucket, files are stored under credit-reports/userId/
            if (bucket === 'users-file-storage') {
              listPath = `credit-reports/${userId}`;
            }
            
            const { data: fileData, error: fileError } = await supabase.storage
              .from(bucket)
              .list(listPath, { limit: 1000 });

            if (!fileError && fileData) {
              const foundFile = fileData.find(file => file.name === fileName);
              if (foundFile) {
                fileExists = true;
                fileInfo = foundFile;
                foundBucket = bucket;
                break;
              }
            }
          } catch (bucketError) {
            console.log(`Skipping bucket ${bucket} during verification:`, bucketError.message);
          }
        }

        if (!fileExists) {
          return res.status(404).json({
            error: 'File not found',
            details: 'File was not successfully uploaded to storage'
          });
        }

        // Update storage usage
        const fileSize = fileInfo?.metadata?.size || 0;

        await supabase.from('storage_limits').update({
          used_files: (currentLimits.used_files || 0) + 1,
          used_storage_bytes: (currentLimits.used_storage_bytes || 0) + fileSize,
          updated_at: new Date().toISOString()
        }).eq('user_id', userId);

        // Trigger report processing (fire-and-forget)
        (async () => {
          try {
            // Notify user that analysis has started
            global.emitToUser && global.emitToUser(userId, 'analysis-started', {
              userId,
              filePath,
              fileName,
              message: 'File analysis has begun. This may take a few moments...',
              timestamp: new Date().toISOString()
            });

            const { processCreditReport } = require('./reportProcessor');
            const result = await processCreditReport(filePath);

            // Store analysis results
            await supabase.from('report_analyses').insert({
              user_id: userId,
              file_path: filePath,
              bucket: foundBucket,
              file_name: fileName,
              extracted_text: result.extractedText?.substring(0, 2000),
              analysis: result.analysis,
              violations_found: result.analysis?.violations?.length > 0,
              errors_found: result.analysis?.errors?.length > 0
            });

            console.log('✅ File processed and analysis stored:', filePath);

            // Notify user via Socket.IO that analysis is complete
            global.emitToUser && global.emitToUser(userId, 'analysis-complete', {
              userId,
              filePath,
              fileName,
              analysis: result.analysis,
              timestamp: new Date().toISOString()
            });
          } catch (processError) {
            console.error('❌ Error processing uploaded file:', processError);
            
            // Notify user of analysis error
            global.emitToUser && global.emitToUser(userId, 'analysis-error', {
              userId,
              filePath,
              fileName,
              error: processError.message,
              timestamp: new Date().toISOString()
            });
          }
        })();

        return res.status(200).json({
          success: true,
          message: 'File uploaded and processing started',
          filePath,
          fileName,
          userId
        });

      } catch (error) {
        console.error('Upload processing error:', error);
        return res.status(500).json({
          error: 'Failed to process upload',
          details: error.message
        });
      }
    }

    // Public storage limits lookup (safe to call from frontend)
    if (path === 'storage/limits') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

      // Parse query params
      const queryString = req.url.split('?')[1] || '';
      const params = new URLSearchParams(queryString);
      const userId = params.get('user_id');

      if (!userId) return res.status(400).json({ error: 'user_id query parameter is required' });

      try {
        // Use maybeSingle to avoid PostgREST PGRST116 when no row exists
        const { data, error } = await supabase
          .from('storage_limits')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle();

        if (error) {
          console.error('Error fetching storage limits:', error);
          return res.status(500).json({ error: error.message });
        }

        // If no limits found, return sensible defaults rather than a 406/404
        if (!data) {
          return res.status(200).json({
            user_id: userId,
            max_storage_bytes: 0,
            used_storage_bytes: 0,
            max_files: 0,
            used_files: 0,
            is_premium: false
          });
        }

        return res.status(200).json(data);
      } catch (err) {
        console.error('Unexpected error fetching storage limits:', err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Simple user action endpoints
    if (path === 'user-actions/mailed-letter' && req.method === 'POST') {
      const { userId, letterType, mailedDate, recipient } = req.body;
      if (!userId || !mailedDate) return res.status(400).json({ error: 'Missing userId or mailedDate' });
      
      try {
        // 1. Save to database
        await supabase.from('certified_mail').insert({
          user_id: userId,
          recipient: recipient || 'Credit Bureau',
          description: `${letterType || 'Dispute'} letter mailed`,
          date_mailed: mailedDate,
          status: 'mailed',
          tracking_number: `PENDING-${Date.now()}`
        });
        
        // 2. Calculate deadline (30 days from mail date)
        const deadline = new Date(mailedDate);
        deadline.setDate(deadline.getDate() + 30);
        
        // 3. Create reminder
        await supabase.from('calendar_events').insert({
          user_id: userId,
          title: `Follow up on ${letterType || 'dispute'} letter`,
          description: `30-day deadline to receive response`,
          event_date: deadline.toISOString(),
          event_type: 'deadline',
          related_type: 'certified_mail'
        });
        
        // 4. Send confirmation email (if email configured)
        if (process.env.SMTP_HOST) {
          const { sendEmailTool } = require('./emailTools');
          await sendEmailTool.invoke(JSON.stringify({
            to: 'user@example.com', // Replace with actual user email
            subject: 'Letter Tracking Confirmed',
            body: `Your ${letterType || 'dispute'} letter mailed on ${mailedDate} is now being tracked. Follow-up deadline: ${deadline.toDateString()}`
          }));
        }
        
        return res.status(200).json({ 
          success: true, 
          message: 'Letter tracked and reminder set',
          deadline: deadline.toISOString()
        });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }
    
    if (path === 'user-actions/set-reminder' && req.method === 'POST') {
      const { userId, title, days, description } = req.body;
      if (!userId || !title || !days) return res.status(400).json({ error: 'Missing required fields' });
      
      try {
        const reminderDate = new Date();
        reminderDate.setDate(reminderDate.getDate() + parseInt(days));
        
        await supabase.from('calendar_events').insert({
          user_id: userId,
          title: title,
          description: description || 'User reminder',
          event_date: reminderDate.toISOString(),
          event_type: 'reminder'
        });
        
        return res.status(200).json({ 
          success: true, 
          message: 'Reminder set',
          reminderDate: reminderDate.toISOString()
        });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }
    
    if (path === 'user-actions/get-timeline' && req.method === 'GET') {
      const userId = req.query.userId;
      if (!userId) return res.status(400).json({ error: 'Missing userId' });
      
      try {
        const { data: events } = await supabase
          .from('calendar_events')
          .select('*')
          .eq('user_id', userId)
          .gte('event_date', new Date().toISOString())
          .order('event_date', { ascending: true })
          .limit(10);
          
        return res.status(200).json({ events: events || [] });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }
    
    // Auto-generate follow-up email
    if (path === 'user-actions/auto-followup' && req.method === 'POST') {
      const { userId, disputeId } = req.body;
      if (!userId || !disputeId) return res.status(400).json({ error: 'Missing userId or disputeId' });
      
      try {
        // Check user credits
        const { data: userMetrics } = await supabase
          .from('user_metrics')
          .select('daily_limit, chats_used')
          .eq('user_id', userId)
          .single();
          
        const creditsLeft = (userMetrics?.daily_limit || 5) - (userMetrics?.chats_used || 0);
        if (creditsLeft < 5) {
          return res.status(400).json({ error: 'Insufficient credits. Need 5 credits.' });
        }
        
        // Get dispute details
        const { data: dispute } = await supabase
          .from('disputes')
          .select('*')
          .eq('id', disputeId)
          .eq('user_id', userId)
          .single();
          
        if (!dispute) {
          return res.status(404).json({ error: 'Dispute not found' });
        }
        
        // Generate follow-up letter using AI
        const aiPrompt = `Generate a professional FCRA follow-up letter for:
        - Dispute: ${dispute.title}
        - Bureau: ${dispute.bureau}
        - Date sent: ${dispute.date_sent}
        - Tracking: ${dispute.tracking_number}
        
        Make it firm but professional. Reference the 30-day investigation period.`;
        
        const { chatWithFallback } = require('./temp/aiUtils');
        const { response } = await chatWithFallback([{ content: aiPrompt }]);
        
        // Send email with generated letter
        if (process.env.SMTP_HOST) {
          const { sendEmailTool } = require('./emailTools');
          await sendEmailTool.invoke(JSON.stringify({
            to: 'user@example.com', // Replace with actual user email
            subject: `Follow-up Letter for ${dispute.title}`,
            body: `<h3>Your Follow-up Letter</h3><pre>${response.content}</pre><p><strong>Instructions:</strong> Print this letter and send via certified mail to ${dispute.bureau}.</p>`
          }));
        }
        
        // Log email sent
        await supabase.rpc('log_email_sent', {
          p_user_id: userId,
          p_email_type: 'followup_letter',
          p_recipient_email: 'user@example.com',
          p_subject: `Follow-up Letter for ${dispute.title}`,
          p_related_id: disputeId,
          p_related_type: 'dispute',
          p_credits_charged: 5
        });
        
        // Deduct credits
        await supabase
          .from('user_metrics')
          .update({ chats_used: (userMetrics?.chats_used || 0) + 5 })
          .eq('user_id', userId);
          
        return res.status(200).json({ 
          success: true, 
          message: 'Follow-up letter generated and sent',
          creditsUsed: 5,
          creditsRemaining: creditsLeft - 5
        });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }
    
    // Process automation queue (triggered by user actions or webhooks)
    if (path === 'automation/process-queue' && req.method === 'POST') {
      try {
        // Get tasks ready for API processing
        const { data: tasks } = await supabase
          .from('automation_queue')
          .select('*')
          .eq('status', 'ready_for_api')
          .limit(10);
        
        let processedCount = 0;
        for (const task of tasks || []) {
          try {
            if (task.task_type === 'send_delivery_notification') {
              // Send delivery notification
              const { sendEmailTool } = require('./emailTools');
              await sendEmailTool.invoke(JSON.stringify({
                to: 'user@example.com', // Get from user profile
                subject: 'Mail Delivered - Deadlines Created',
                body: `Your certified mail (${task.metadata.tracking_number}) was delivered. We've automatically created your 30-day deadline reminders.`
              }));
              
            } else if (task.task_type === 'send_reminder_email') {
              // Send reminder email
              const { sendEmailTool } = require('./emailTools');
              await sendEmailTool.invoke(JSON.stringify({
                to: 'user@example.com', // Get from user profile
                subject: `Reminder: ${task.metadata.event_title}`,
                body: `<h3>${task.metadata.event_title}</h3><p>${task.metadata.event_description}</p><p><strong>Due:</strong> ${new Date(task.metadata.event_date).toLocaleDateString()}</p>`
              }));
            }
            
            // Mark task as completed
            await supabase
              .from('automation_queue')
              .update({ 
                status: 'completed', 
                completed_at: new Date().toISOString() 
              })
              .eq('id', task.id);
              
            processedCount++;
            
          } catch (taskError) {
            // Mark task as failed
            await supabase
              .from('automation_queue')
              .update({ 
                status: 'failed', 
                error_message: taskError.message 
              })
              .eq('id', task.id);
          }
        }
        
        return res.status(200).json({ 
          success: true, 
          processed: processedCount
        });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }
    
    // Trigger automation when user updates mail status
    if (path === 'user-actions/update-mail-status' && req.method === 'POST') {
      const { userId, mailId, status, deliveryDate } = req.body;
      
      try {
        // Update mail status
        await supabase
          .from('certified_mail')
          .update({ 
            status: status,
            date_delivered: deliveryDate,
            updated_at: new Date().toISOString()
          })
          .eq('id', mailId)
          .eq('user_id', userId);
        
        // Process any triggered automation
        await supabase.rpc('process_automation_queue');
        
        // Immediately process the queue
        setTimeout(async () => {
          await fetch(`${req.protocol}://${req.get('host')}/api/automation/process-queue`, {
            method: 'POST'
          });
        }, 1000);
        
        return res.status(200).json({ 
          success: true, 
          message: 'Mail status updated and automation triggered'
        });
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    }

    // Fallback for unhandled paths
    return res.status(404).json({
      error: { message: `API endpoint /${path} not found`, code: 'NOT_FOUND' }
    });
  } catch (error) {
    console.error(`[API Router] Unexpected error:`, error);
    return res.status(500).json({
      error: {
        message: 'Internal server error',
        details: error instanceof Error ? error.message : String(error)
      }
    });
  }
};

// Export helper functions for use by agents
module.exports.getUserFilesContext = getUserFilesContext;
module.exports.chatWithFallback = chatWithFallback;
// Expose `processMessage` for testing and provide test helpers to stub internals
module.exports.processMessage = processMessage;
module.exports._test = {
  setChatWithFallback: (fn) => { if (typeof fn === 'function') chatWithFallback = fn; },
  setSupabaseClient: (client) => { supabase = client; },
  setPgPool: (pool) => { pgPool = pool; }
};