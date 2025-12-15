const { createClient } = require('@supabase/supabase-js');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { ChatGoogle } = require('@langchain/google-gauth');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');
const { Mistral } = require('@mistralai/mistralai');
const Stripe = require('stripe');

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

// Initialize Google AI with Gemini 2.5 Flash model
let chatModel = null;
const googleApiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY;
if (googleApiKey) {
  try {
    console.log('Initializing Google AI model with API key:', googleApiKey ? 'Present' : 'Missing');
    // Try without LangSmith wrapping first to isolate the issue
    const baseModel = new ChatGoogleGenerativeAI({
      apiKey: googleApiKey,
      model: 'gemini-2.5-flash',
      temperature: 0.7,
      maxRetries: 3,
      maxOutputTokens: 2048, // Setting a reasonable output limit
      topP: 0.95, // Default value per documentation
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

    chatModel = baseModel;
    console.log('Google AI model initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Google AI model:', error.message);
    chatModel = null;
  }
} else {
  console.warn('GOOGLE_API_KEY not found in environment variables');
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

// Initialize Hugging Face Inference as third backup AI model
let hfClient = null;
const hfApiKey = process.env.HF_TOKEN;
if (hfApiKey) {
  try {
    console.log('Initializing Hugging Face Inference client');
    const { OpenAI } = require('openai');
    hfClient = new OpenAI({
      baseURL: 'https://router.huggingface.co/v1',
      apiKey: hfApiKey,
    });
    console.log('Hugging Face Inference client initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Hugging Face Inference client:', error.message);
    hfClient = null;
  }
} else {
  console.warn('HF_TOKEN not found in environment variables');
}

// Fallback chat function: Try Google first, then Mistral
async function chatWithFallback(messages) {
  // Try Google first
  if (chatModel) {
    try {
      console.log('Attempting chat with Google Gemini...');
      const response = await chatModel.invoke(messages);
      console.log('Google Gemini response successful');
      return { response, model: 'google-gemini' };
    } catch (error) {
      console.warn('Google Gemini failed, trying Mistral backup:', error.message);
    }
  }

  // Fallback to Mistral
  if (mistralClient) {
    try {
      console.log('Attempting chat with Mistral backup...');

      // Convert LangChain messages to Mistral format
      const mistralMessages = messages.map(msg => {
        if (msg instanceof SystemMessage) {
          return { role: 'system', content: msg.content };
        } else if (msg instanceof HumanMessage) {
          return { role: 'user', content: msg.content };
        } else if (msg instanceof AIMessage) {
          return { role: 'assistant', content: msg.content };
        } else {
          return { role: 'user', content: msg.content };
        }
      });

      const mistralResponse = await mistralClient.chat.complete({
        model: 'mistral-small-latest',
        messages: mistralMessages,
        temperature: 0.7,
        max_tokens: 2048,
        stream: false
      });

      // Convert Mistral response to LangChain format
      const content = mistralResponse.choices[0]?.message?.content || 'I apologize, but I encountered an error processing your request.';
      console.log('Mistral backup response successful');

      const response = {
        content: content,
        additional_kwargs: {},
        tool_calls: []
      };

      return { response, model: 'mistral' };
    } catch (error) {
      console.error('Mistral backup also failed:', error.message);
    }
  }

  // Third fallback to Hugging Face
  if (hfClient) {
    try {
      console.log('Attempting chat with Hugging Face fallback...');

      // Convert LangChain messages to OpenAI format (HF router uses OpenAI-compatible API)
      const hfMessages = messages.map(msg => {
        if (msg instanceof SystemMessage) {
          return { role: 'system', content: msg.content };
        } else if (msg instanceof HumanMessage) {
          return { role: 'user', content: msg.content };
        } else if (msg instanceof AIMessage) {
          return { role: 'assistant', content: msg.content };
        } else {
          return { role: 'user', content: msg.content };
        }
      });

      const hfResponse = await hfClient.chat.completions.create({
        model: 'meta-llama/Llama-3.2-3B-Instruct',
        messages: hfMessages,
        temperature: 0.7,
        max_tokens: 2048,
        stream: false
      });

      // Convert HF response to LangChain format
      const content = hfResponse.choices[0]?.message?.content || 'I apologize, but I encountered an error processing your request.';
      console.log('Hugging Face fallback response successful');

      const response = {
        content: content,
        additional_kwargs: {},
        tool_calls: []
      };

      return { response, model: 'huggingface' };
    } catch (error) {
      console.error('Hugging Face fallback also failed:', error.message);
      throw new Error('All AI models (Google Gemini, Mistral, and Hugging Face) failed to respond');
    }
  }

  // No models available
  throw new Error('No AI models are available. Please check your API keys.');
}

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
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
    // Check if Google AI model is available
    if (!chatModel) {
      throw new Error('Google AI (Gemini) model not configured - Please ensure you have:\n1. Valid GOOGLE_API_KEY environment variable\n2. Google AI API enabled in your Google Cloud project\n3. Proper API key with Gemini API access');
    }
    const result = await fn();
    resolve(result);
  } catch (error) {
    console.error('Google AI request failed:', error.message);
    // Check for common Google Cloud errors
    if (error.message.includes('quota') || error.message.includes('rate limit')) {
      reject(new Error('Google AI quota exceeded. Please check your quota limits in Google Cloud Console.'));
    } else if (error.message.includes('permission') || error.message.includes('unauthorized')) {
      reject(new Error('Authorization failed. Please check your API key and permissions.'));
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
  
  // Document analysis triggers (high priority) - includes access questions
  const documentTriggers = [
    'analyze', 'review', 'my report', 'credit report', 'document',
    'uploaded', 'file', 'violations', 'errors', 'fcra', 'fdcpa',
    'dispute', 'credit bureau', 'equifax', 'experian', 'transunion',
    'access', 'can you access', 'upload', 'documents', 'files',
    'get my', 'see my', 'check my', 'look at my', 'find my',
    'do you have', 'show me', 'pull up', 'retrieve'
  ];
  
  // Tracking-specific triggers
  const trackingTriggers = [
    'track', 'tracking', 'certified mail', 'usps', 'postal service',
    'delivery status', 'package status', 'mail status', 'where is my',
    'tracking number', 'delivery confirmation'
  ];
  
  // Other agent triggers
  const otherTriggers = [
    'search for', 'find information about', 'look up',
    'generate letter', 'create dispute letter',
    'send email', 'email notification',
    'set reminder', 'calendar event'
  ];
  
  return documentTriggers.some(trigger => msg.includes(trigger)) ||
         trackingTriggers.some(trigger => msg.includes(trigger)) || 
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

// Helper to get or create chat history
async function getChatHistory(sessionId, userId = null) {
  if (!chatSessions.has(sessionId)) {
    // Get user's file context for system message
    const filesContext = userId ? await getUserFilesContext(userId) : 'No files uploaded yet.';
    
    const systemMessage = new SystemMessage(
      "=== CONSUMERAI SYSTEM INSTRUCTIONS ===\n\n" +
      "You are ConsumerAI, a professional legal assistant specializing in consumer rights and credit law under FDCPA and FCRA regulations.\n\n" +
      
      "=== DATABASE ACCESS (CRITICAL) ===\n" +
      "• You have FULL ACCESS to Supabase database\n" +
      "• Table: 'report_analyses' with columns: user_id (UUID), file_name, file_path, processed_at, analysis\n" +
      "• You receive userId in every request via state.userId\n" +
      "• Query example: supabase.from('report_analyses').select('*').eq('user_id', userId)\n" +
      "• The system automatically fetches user files and provides them in context\n\n" +
      
      "=== CURRENT USER FILES ===\n" +
      filesContext + "\n\n" +
      
      "=== WHEN USER ASKS ABOUT FILES ===\n" +
      "• 'Can you get my reports?' → YES, reference specific files above by name and date\n" +
      "• 'Do you have access?' → YES, show them their uploaded files\n" +
      "• 'Can you see my credit report?' → YES, list their files with dates\n" +
      "• If NO files: Ask 'Have you uploaded a credit report yet? I can analyze it for FCRA violations once you upload.'\n" +
      "• If HAS files: 'Yes! I can see you uploaded [filename] on [date]. Would you like me to analyze it?'\n\n" +
      
      "=== YOUR CAPABILITIES ===\n" +
      "• Analyze credit reports for FCRA/FDCPA violations\n" +
      "• Detect errors, outdated items, identity theft indicators\n" +
      "• Generate dispute letters\n" +
      "• Calculate legal deadlines and timelines\n" +
      "• Provide actionable steps for disputes\n\n" +
      
      "=== RESPONSE RULES ===\n" +
      "• Always check user files context first\n" +
      "• Reference specific files by name when they exist\n" +
      "• Ask clarifying questions if user intent is unclear\n" +
      "• Be professional, accurate, and helpful\n" +
      "• Focus on actionable legal advice"
    );
    
    const history = [systemMessage];
    
    // Load previous messages from database if available
    if (supabase && userId) {
      try {
        const { data, error } = await supabase
          .from('chat_history')
          .select('*')
          .eq('session_id', sessionId)
          .order('created_at', { ascending: true })
          .limit(20); // Last 20 messages
        
        if (!error && data) {
          data.forEach(msg => {
            if (msg.role === 'user') {
              history.push(new HumanMessage(msg.content));
            } else if (msg.role === 'assistant') {
              history.push(new AIMessage(msg.content));
            }
          });
        }
      } catch (dbError) {
        console.error('Failed to load chat history from database:', dbError);
      }
    }
    
    chatSessions.set(sessionId, history);
  }
  return chatSessions.get(sessionId);
}

// Removed quick responses - AI should always have full context

// Smart message processing with agent detection
async function processMessage(message, sessionId, socketId = null, useAgents = null, userId = null) {
  try {
    // Check for tracking requests first - these should use agents
    const msg = message.toLowerCase();
    const isTrackingRequest = msg.includes('track') || msg.includes('certified mail') || 
                             msg.includes('usps') || msg.includes('delivery') || 
                             msg.includes('package') || msg.includes('mail status');
    
    // No quick responses - always use AI with full context
    
    // Always use supervisor for non-greeting messages
    const needsAgents = useAgents === true || (useAgents !== false && !msg.match(/^(hi|hello|hey)$/i));
    const cachedResponse = !needsAgents ? getCachedResponse(message) : null;
    if (cachedResponse) {
      // Emit Socket.IO events for cached response
      console.log('Cached response found, attempting to emit events');
      console.log('socketId:', socketId, 'global.io exists:', !!global.io);
      if (socketId && global.io) {
        console.log('Emitting cached response events to socket:', socketId);
        global.io.to(socketId).emit('agent-thinking-start');
        global.io.to(socketId).emit('agent-thinking-complete', {
          response: stripMarkdown(cachedResponse)
        });
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
    const isReportAnalysis = (message.toLowerCase().includes('analyze') && 
                             (message.toLowerCase().includes('report') || 
                              message.toLowerCase().includes('document') ||
                              message.toLowerCase().includes('credit'))) ||
                            (message.toLowerCase().includes('check') && message.toLowerCase().includes('report') && message.toLowerCase().includes('analyze'));
    
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

        // Emit thinking start
        if (socketId && global.io) {
          global.io.to(socketId).emit('agent-thinking-start');
        }

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
          global.io.to(socketId).emit('agent-thinking-complete', {
            response: stripMarkdown(aiResponse.content || 'Analysis completed'),
            sessionId: sessionId,
            timestamp: new Date().toISOString()
          });
        }

        // Save report analysis to database
        if (supabase && userId) {
          try {
            await supabase.from('chat_history').insert([
              {
                session_id: sessionId,
                user_id: userId,
                role: 'user',
                content: message,
                created_at: new Date().toISOString()
              },
              {
                session_id: sessionId,
                user_id: userId,
                role: 'assistant',
                content: stripMarkdown(aiResponse.content || 'Analysis completed'),
                created_at: new Date().toISOString()
              }
            ]);
          } catch (dbError) {
            console.error('Failed to save report messages to database:', dbError);
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
    
    if (needsAgents && graph) {
      reasoningSteps.push('Supervisor agent analyzing');
      usedAgent = 'supervisor';
      
      // Emit agent selection
      if (socketId && global.io) {
        console.log('Emitting agent-step to socket:', socketId);
        global.io.to(socketId).emit('agent-step', {
          tool: 'supervisor',
          toolInput: message,
          log: 'Using supervisor agent',
          timestamp: new Date().toISOString()
        });
      }
      
      // Emit thinking start
      if (socketId && global.io) {
        console.log('Emitting agent-thinking-start to socket:', socketId);
        global.io.to(socketId).emit('agent-thinking-start');
      }

      try {
        // Use supervisor graph with timeout
        const result = await Promise.race([
          graph.invoke({
            messages: [{ role: 'user', content: message }],
            userId: userId,
            supabase: supabase
          }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Agent timeout')), 30000) // Increased to 30 seconds
          )
        ]);
        
        const lastMessage = result.messages[result.messages.length - 1];
        var aiResponse = { content: lastMessage.content };
        usedAgent = lastMessage.name || 'supervisor';
        
        // Emit agent steps
        if (socketId && global.io) {
          result.messages.forEach(msg => {
            if (msg.name) {
              global.io.to(socketId).emit('agent-step', {
                tool: msg.name.replace('Agent', '').toLowerCase(),
                toolInput: message,
                log: `${msg.name} completed`,
                timestamp: new Date().toISOString()
              });
            }
          });
          // Emit thinking complete
          global.io.to(socketId).emit('agent-thinking-complete', {
            response: stripMarkdown(aiResponse.content),
            sessionId: sessionId,
            timestamp: new Date().toISOString()
          });
        }

        // Save agent response to database
        if (supabase && userId) {
          try {
            await supabase.from('chat_history').insert([
              {
                session_id: sessionId,
                user_id: userId,
                role: 'user',
                content: message,
                created_at: new Date().toISOString()
              },
              {
                session_id: sessionId,
                user_id: userId,
                role: 'assistant',
                content: stripMarkdown(aiResponse.content),
                created_at: new Date().toISOString()
              }
            ]);
          } catch (dbError) {
            console.error('Failed to save agent messages to database:', dbError);
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
      } catch (agentError) {
        console.log('Agent failed, falling back to direct AI:', agentError.message);
        reasoningSteps.push('Agent failed, using direct AI response');

        // Emit thinking complete for failed agent
        if (socketId && global.io) {
          global.io.to(socketId).emit('agent-thinking-complete', {
            response: 'I apologize, but I encountered an error processing your request with advanced analysis. Let me provide a direct response instead.',
            sessionId: sessionId,
            timestamp: new Date().toISOString()
          });
        }

        // Save error response to database
        if (supabase && userId) {
          try {
            await supabase.from('chat_history').insert([
              {
                session_id: sessionId,
                user_id: userId,
                role: 'user',
                content: message,
                created_at: new Date().toISOString()
              },
              {
                session_id: sessionId,
                user_id: userId,
                role: 'assistant',
                content: 'I apologize, but I encountered an error processing your request with advanced analysis. Let me provide a direct response instead.',
                created_at: new Date().toISOString()
              }
            ]);
          } catch (dbError) {
            console.error('Failed to save error messages to database:', dbError);
          }
        }

        return {
          message: 'I apologize, but I encountered an error processing your request with advanced analysis. Let me provide a direct response instead.',
          sessionId,
          messageId: `${Date.now()}-ai`,
          created_at: new Date().toISOString(),
          usedModel: 'error',
          decisionTrace: {
            usedAgent: 'error',
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
        global.io.to(socketId).emit('agent-thinking-complete', {
          response: stripMarkdown(aiResponse.content),
          sessionId: sessionId,
          timestamp: new Date().toISOString()
        });
      }

      // Save to database for direct AI
      if (supabase && userId) {
        try {
          await supabase.from('chat_history').insert([
            {
              session_id: sessionId,
              user_id: userId,
              role: 'user',
              content: message,
              created_at: new Date().toISOString()
            },
            {
              session_id: sessionId,
              user_id: userId,
              role: 'assistant',
              content: stripMarkdown(aiResponse.content),
              created_at: new Date().toISOString()
            }
          ]);
        } catch (dbError) {
          console.error('Failed to save messages to database:', dbError);
        }
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

    // Test endpoint
    if (path === 'test') {
      return res.status(200).json({ 
        message: 'Backend is working!',
        timestamp: new Date().toISOString(),
        env: {
          hasAnthropic: !!process.env.ANTHROPIC_API_KEY,
          hasGoogleAI: !!process.env.GOOGLE_API_KEY,
          hasTavily: !!process.env.TAVILY_API_KEY
        }
      });
    }

    // Chat endpoint - simplified without complex agents
    if (path === 'chat') {
      if (req.method === 'GET') return res.status(200).json({ status: 'ok' });
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      
      const { message, sessionId, socketId, useAgents, userId } = req.body;
      if (!message || !sessionId) {
        return res.status(400).json({ error: 'Missing message or sessionId' });
      }

      try {
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

      if (!supabase) {
        return res.status(200).json({ data: [] }); // Return empty history if no database
      }

      const { data, error } = await supabase
        .from('chat_history')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      const formatted = (data || []).map((msg, idx) => ({
        id: msg.id || `${sessionId}-${idx}-${msg.role}`,
        content: msg.content,
        role: msg.role,
        created_at: msg.created_at
      }));

      return res.status(200).json({ data: formatted });
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
        const { processCreditReport } = require('./reportProcessor');
        const result = await processCreditReport(filePath);
        
        // Store analysis result in database if needed
        if (supabase && userId) {
          await supabase.from('report_analyses').insert({
            user_id: userId,
            file_path: filePath,
            analysis: result.analysis,
            processed_at: result.processedAt
          });
        }

        return res.status(200).json(result);
      } catch (error) {
        console.error('Report analysis error:', error);
        return res.status(500).json({ error: error.message });
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
                  const { processCreditReport } = require('./reportProcessor');
                  const result = await processCreditReport(filePath);
                  console.log('Triggered report processing from Supabase webhook for file:', filePath);

                  // Optionally store analysis results in DB if supabase client is available
                  if (supabase && userId) {
                    await supabase.from('report_analyses').insert({
                      user_id: userId,
                      file_path: filePath,
                      analysis: result.analysis || result,
                      processed_at: new Date().toISOString()
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
                const { processCreditReport } = require('./reportProcessor');
                await processCreditReport(filePath);
                console.log('Processed storage object via Supabase webhook:', filePath);
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

  } catch (error) {
    console.error(`[API Router] Error handling ${path}:`, error);
    return res.status(500).json({
      error: {
        message: 'Internal server error',
        details: error instanceof Error ? error.message : String(error)
      }
    });
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