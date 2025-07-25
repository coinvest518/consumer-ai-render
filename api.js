const { createClient } = require('@supabase/supabase-js');
const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, AIMessage, SystemMessage } = require('@langchain/core/messages');
const Stripe = require('stripe');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// Initialize OpenAI Chat Model
const chatModel = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4',
  temperature: 0.7,
});

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16'
});

// Memory storage for chat sessions
const chatSessions = new Map();

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

// Process a message and build decision trace
async function processMessage(message, sessionId) {
  try {
    const history = getChatHistory(sessionId);
    const userMessage = new HumanMessage(message);
    history.push(userMessage);

    // Decision trace logic: check for agent/tool keywords
    let usedAgent = null;
    let reasoningSteps = [];
    if (message.includes('[Agent Request:')) {
      // Extract agent name from message
      const agentMatch = message.match(/\[Agent Request:\s*(\w+)\]/);
      usedAgent = agentMatch ? agentMatch[1] : null;
      reasoningSteps.push(`Agent "${usedAgent}" selected based on user input.`);
    } else {
      reasoningSteps.push('No agent/tool used. Answered directly by AI.');
    }

    reasoningSteps.push('Message added to history.');
    const aiResponse = await chatModel.invoke(history);
    const aiMessage = new AIMessage(aiResponse.content);
    history.push(aiMessage);
    reasoningSteps.push('AI model generated response.');

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
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { userId, storageBytes: storageBytesStr, files: filesStr, plan } = session.metadata || {};
      const storageBytes = parseInt(storageBytesStr || '0');
      const files = parseInt(filesStr || '0');

      if (!userId || !storageBytes || !files || !plan) {
        throw new Error('Missing required metadata in Stripe session for storage upgrade');
      }
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

// --- LangChain Agent Socket Callback Handler ---
const { BaseCallbackHandler } = require('langchain/callbacks');

class ThinkingCallbackHandler extends BaseCallbackHandler {
  constructor(socketId, io) {
    super();
    this.socketId = socketId;
    this.io = io;
    this.stepCounter = 0;
  }

  async handleAgentAction(action, runId) {
    const step = {
      id: this.stepCounter++,
      type: 'processing',
      title: `Using ${action.tool}`,
      description: `Executing: ${action.toolInput}`,
      details: {
        tool: action.tool,
        input: action.toolInput,
        log: action.log
      },
      timestamp: new Date().toLocaleTimeString()
    };
    this.io.to(this.socketId).emit('agent-step', step);
  }

  async handleToolEnd(output, runId) {
    const step = {
      id: this.stepCounter++,
      type: 'completed',
      title: 'Tool Execution Complete',
      description: `Result: ${output.substring(0, 100)}...`,
      details: output,
      timestamp: new Date().toLocaleTimeString()
    };
    this.io.to(this.socketId).emit('agent-step', step);
  }

  async handleLLMStart(llm, prompts, runId) {
    const step = {
      id: this.stepCounter++,
      type: 'planning',
      title: 'Agent Planning',
      description: 'Analyzing request and planning approach',
      details: prompts[0].substring(0, 500) + '...',
      timestamp: new Date().toLocaleTimeString()
    };
    this.io.to(this.socketId).emit('agent-step', step);
  }

  async handleChainStart(chain, inputs, runId) {
    const step = {
      id: this.stepCounter++,
      type: 'searching',
      title: 'Processing Chain',
      description: `Starting ${chain.id || 'unknown'} chain`,
      details: inputs,
      timestamp: new Date().toLocaleTimeString()
    };
    this.io.to(this.socketId).emit('agent-step', step);
  }
}

// Main API handler
module.exports = async function handler(req, res) {
  // CORS headers are handled by the cors middleware in server.js
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const path = req.url.split('?')[0].replace(/^\//, '') || '';
  console.log(`[API Router] Routing request to: ${path}`);

  try {
    // Stripe webhook endpoint
    if (path === 'stripe-webhook') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const sig = req.headers['stripe-signature'];
      try {
        const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
        res.status(200).json({ received: true }); // Respond immediately
        processStripeEvent(event); // Process in the background
      } catch (err) {
        console.error(`Webhook signature verification failed.`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }
      return; // Stop further execution
    }

    // Storage webhook endpoint
    else if (path === 'storage/webhook') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const sig = req.headers['stripe-signature'];
      try {
        const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
        res.status(200).json({ received: true }); // Respond immediately
        processStorageEvent(event); // Process in the background
      } catch (err) {
        console.error('Storage webhook signature verification failed:', err.message);
        return res.status(400).json({ error: err.message });
      }
      return; // Stop further execution
    }

    // Chat endpoint with agent thinking events
    if (path === 'chat') {
      if (req.method === 'GET') return res.status(200).json({ status: 'ok' });
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { message, sessionId, socketId } = req.body;
      if (!message || !sessionId || !socketId) return res.status(400).json({ error: 'Missing message, sessionId, or socketId' });
      const io = global.io;
      try {
        // Signal thinking started
        io.to(socketId).emit('agent-thinking-start');

        // Attach callback handler to agent (replace with your agent logic if needed)
        const thinkingCallback = new ThinkingCallbackHandler(socketId, io);

        // If you have a custom agent, use it here. Otherwise, fallback to processMessage
        // Example: const agent = await createAgent({ callbacks: [thinkingCallback], ... });
        // const result = await agent.call({ input: message });

        // For now, just call processMessage and emit complete (no step events)
        const responseData = await processMessage(message, sessionId);

        io.to(socketId).emit('agent-thinking-complete', {
          response: responseData.message
        });
        return res.status(200).json({ data: responseData });
      } catch (error) {
        io.to(socketId).emit('agent-thinking-error', error.message);
        return res.status(500).json({ error: error.message });
      }
    }

    // Chat history endpoint
    if (path === 'chat/history') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const sessionId = req.query.sessionId || req.headers['x-session-id'];
      if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

      // Query Supabase for chat history for this session
      const { data, error } = await supabase
        .from('chat_history')
        .select('*')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      // Format for frontend
      const formatted = (data || []).map((msg, idx) => ({
        id: msg.id || `${sessionId}-${idx}-${msg.role}`,
        content: msg.content,
        role: msg.role,
        created_at: msg.created_at
      }));

      return res.status(200).json({ data: formatted });
    }

    // Fallback for any unhandled paths
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
