const { createClient } = require('@supabase/supabase-js');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { wrapGoogleGenerativeAI } = require('langsmith/wrappers');
const { ChatGoogle } = require('@langchain/google-gauth');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');
const Stripe = require('stripe');

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
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
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
  } catch (error) {
    console.warn('Supabase client initialization failed:', error.message);
  }
} else {
  console.warn('Supabase configuration not provided - some features will be unavailable');
}

// Initialize Google AI with Gemini 1.5 Flash model
let chatModel = null;
if (process.env.GOOGLE_API_KEY) {
  chatModel = wrapGoogleGenerativeAI(new ChatGoogleGenerativeAI({
    apiKey: process.env.GOOGLE_API_KEY,
    model: 'gemini-1.5-flash',
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
  }));
}

// No backup model - Using Gemini 1.5 Flash as primary

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
      throw new Error('Google AI model not configured - Please ensure you have:\n1. Valid GOOGLE_API_KEY\n2. Enabled Vertex AI API\n3. Proper Google Cloud project setup with billing enabled');
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

// More selective agent detection - only for specific tasks
function detectAgentNeed(message) {
  const msg = message.toLowerCase();
  
  // Only use agents for very specific tasks
  const specificTriggers = [
    'search for', 'find information about', 'look up',
    'generate letter', 'create dispute letter',
    'track package', 'usps tracking',
    'send email', 'email notification',
    'set reminder', 'calendar event'
  ];
  
  return specificTriggers.some(trigger => msg.includes(trigger));
}

// Helper to get or create chat history
function getChatHistory(sessionId) {
  if (!chatSessions.has(sessionId)) {
    chatSessions.set(sessionId, [
      new SystemMessage(
        "You are ConsumerAI, a helpful assistant specialized in consumer rights, " +
        "credit disputes, and financial advice. Be clear, professional, and focused on helping users " +
        "understand their rights and options."
      )
    ]);
  }
  return chatSessions.get(sessionId);
}

// Fast response for common questions
function getQuickResponse(message) {
  const msg = message.toLowerCase();
  
  if (msg.includes('hello') || msg.includes('hi ') || msg.includes('hey')) {
    return 'Hello! I\'m ConsumerAI, your legal assistant for consumer rights and credit disputes. How can I help you today?';
  }
  if (msg.includes('what can you do') || msg.includes('what do you do')) {
    return 'I can help you with consumer rights, credit disputes, FDCPA/FCRA violations, dispute letters, and legal advice. I can also search for information, track packages, and set reminders.';
  }
  if (msg.includes('how are you') || msg.includes('how do you work')) {
    return 'I\'m doing great! I\'m here to help you with consumer law questions and credit disputes. What would you like assistance with?';
  }
  return null;
}

// Smart message processing with agent detection
async function processMessage(message, sessionId, socketId = null, useAgents = null) {
  try {
    // Check for quick responses first
    const quickResponse = getQuickResponse(message);
    if (quickResponse) {
      return {
        message: quickResponse,
        sessionId,
        messageId: `${Date.now()}-ai`,
        created_at: new Date().toISOString(),
        decisionTrace: {
          usedAgent: 'quick',
          steps: ['Quick response']
        }
      };
    }
    
    // Check cache for repeated questions
    const cachedResponse = getCachedResponse(message);
    if (cachedResponse) {
      return {
        message: cachedResponse,
        sessionId,
        messageId: `${Date.now()}-ai`,
        created_at: new Date().toISOString(),
        decisionTrace: {
          usedAgent: 'cached',
          steps: ['Cached response']
        }
      };
    }
    
    const history = getChatHistory(sessionId);
    const userMessage = new HumanMessage(message);
    history.push(userMessage);

    let reasoningSteps = [];
    let usedAgent = 'direct';
    
    // Determine if agents are needed - prefer direct AI
    const needsAgents = useAgents === true || (useAgents !== false && detectAgentNeed(message));
    
    if (needsAgents && graph) {
      reasoningSteps.push('Agent mode activated');
      usedAgent = 'supervisor';
      
      // Emit agent selection
      if (socketId && global.io) {
        global.io.to(socketId).emit('agent-step', {
          tool: 'supervisor',
          toolInput: message,
          log: 'Using supervisor agent',
          timestamp: new Date().toISOString()
        });
      }
      
      // Emit thinking start
      if (socketId && global.io) {
        global.io.to(socketId).emit('agent-thinking-start');
      }

      try {
        // Use supervisor graph with timeout
        const result = await Promise.race([
          graph.invoke({
            messages: [{ role: 'user', content: message }]
          }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Agent timeout')), 10000)
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
        }
        
        reasoningSteps.push('Agent completed successfully');
      } catch (agentError) {
        console.log('Agent failed, falling back to direct AI:', agentError.message);
        reasoningSteps.push('Agent failed, using direct AI response');
        var aiResponse = await processWithRateLimit(() => chatModel.invoke(history));
      }
    } else {
      // Regular chat - direct Google AI
      reasoningSteps.push('Direct AI response');
      var aiResponse = await processWithRateLimit(() => chatModel.invoke(history));
    }
    
    const aiMessage = new AIMessage(aiResponse.content);
    history.push(aiMessage);
    
    // Cache the response for future use
    setCachedResponse(message, aiResponse.content);

    // Emit thinking complete
    if (socketId && global.io) {
      global.io.to(socketId).emit('agent-thinking-complete', {
        response: aiResponse.content
      });
    }

    return {
      message: aiResponse.content,
      sessionId,
      messageId: `${Date.now()}-ai`,
      created_at: new Date().toISOString(),
      decisionTrace: {
        usedAgent,
        steps: reasoningSteps
      }
    };
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

// Main API handler
module.exports = async function handler(req, res) {
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
      
      const { message, sessionId, socketId, useAgents } = req.body;
      if (!message || !sessionId) {
        return res.status(400).json({ error: 'Missing message or sessionId' });
      }

      try {
        const result = await processMessage(message, sessionId, socketId, useAgents);
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

    // Fallback for unhandled paths
    else {
      return res.status(404).json({
        error: { message: `API endpoint /${path} not found`, code: 'NOT_FOUND' }
      });
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
};