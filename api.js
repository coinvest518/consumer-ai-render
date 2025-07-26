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



// --- LangChain Agent Socket Callback Handler (New API) ---
// Implements agent step events using the new LangChain JS callback/event API.
// See: https://js.langchain.com/docs/guides/callbacks/

const { AgentExecutor, createOpenAIFunctionsAgent } = require('langchain/agents');
const { CallbackManager } = require('langchain/callbacks');

const { DynamicTool } = require('langchain/tools');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');


// --- Real Tool Integrations (API keys/configs must be set in env) ---
const tools = [
  // Tavily Web Search
  new DynamicTool({
    name: 'search',
    description: 'Web search for legal info',
    func: async (input) => {
      try {
        const tavilyKey = process.env.TAVILY_API_KEY;
        const resp = await axios.post('https://api.tavily.com/search', {
          query: input,
          api_key: tavilyKey
        });
        const top = resp.data?.results?.[0];
        return top ? `${top.title}: ${top.snippet} (${top.url})` : 'No results found.';
      } catch (e) {
        return `Tavily search error: ${e.message}`;
      }
    }
  }),
  // Google Calendar (per-user, secure, Supabase JWT)
  new DynamicTool({
    name: 'calendar',
    description: 'Set reminders, deadlines (per-user, secure)',
    func: async (input, runManager, config) => {
      try {
        // Expect config to include supabaseJwt (from frontend)
        const supabaseJwt = config?.supabaseJwt || (config?.headers && config.headers['authorization']);
        if (!supabaseJwt) {
          throw new Error('Missing Supabase JWT for user authentication.');
        }
        // Verify JWT and get user info from Supabase
        const { data: { user }, error: userError } = await supabase.auth.getUser(supabaseJwt);
        if (userError || !user) {
          throw new Error('Invalid Supabase JWT or user not found.');
        }
        // Fetch Google refresh token from user metadata (must be stored at sign-in)
        const refreshToken = user.user_metadata?.google_refresh_token;
        if (!refreshToken) {
          throw new Error('No Google refresh token found for user. Please reconnect Google.');
        }
        // Set up OAuth2 client with user-specific refresh token
        const oAuth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          process.env.GOOGLE_REDIRECT_URI
        );
        oAuth2Client.setCredentials({ refresh_token: refreshToken });
        const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
        // Parse input for event details (simple demo)
        const event = {
          summary: input,
          start: { dateTime: new Date(Date.now() + 3600000).toISOString() },
          end: { dateTime: new Date(Date.now() + 7200000).toISOString() }
        };
        await calendar.events.insert({ calendarId: 'primary', requestBody: event });
        return `Calendar event created: ${input}`;
      } catch (e) {
        console.error('Google Calendar tool error:', e);
        return `Google Calendar error: ${e.message}`;
      }
    }
  }),
  // Credit Report Analysis (OpenAI-powered)
  new DynamicTool({
    name: 'report',
    description: 'Analyze credit reports (AI-powered)',
    func: async (input) => {
      try {
        // Use OpenAI to analyze the credit report text and return a summary/insights
        const prompt = [
          new SystemMessage("You are a financial expert. Analyze the following credit report and provide a summary of key findings, potential issues, and actionable advice for the consumer. Be clear and concise."),
          new HumanMessage(input)
        ];
        const result = await chatModel.invoke(prompt);
        return result.content;
      } catch (e) {
        return `Credit report analysis error: ${e.message}`;
      }
    }
  }),
  // Dispute Letter Generator (placeholder)
  new DynamicTool({
    name: 'letter',
    description: 'Generate dispute letters',
    func: async (input) => {
      // TODO: Implement real letter generation logic
      return `Dispute letter generated: ${input} (placeholder)`;
    }
  }),
  // Legal Database Lookup (Astra DB + Tavily + OpenAI)
  new DynamicTool({
    name: 'legal',
    description: 'Legal database lookup (Astra DB, Tavily, AI summary)',
    func: async (input) => {
      try {
        // 1. Search Astra DB for relevant legal documents
        const { AstraDB } = require('@datastax/astra-db-ts');
        const astra = new AstraDB();
        // Replace 'legal_docs' and 'content' with your Astra DB collection and field names
        const astraResults = await astra.collection('legal_docs').find({ $text: { $search: input } }).limit(3).toArray();
        let bestDoc = null;
        if (astraResults && astraResults.length > 0) {
          bestDoc = astraResults[0];
        }
        // 2. If no Astra DB result, search Tavily
        let legalInfo = '';
        if (bestDoc) {
          legalInfo = bestDoc.content || JSON.stringify(bestDoc);
        } else {
          const tavilyKey = process.env.TAVILY_API_KEY;
          const resp = await axios.post('https://api.tavily.com/search', {
            query: input,
            api_key: tavilyKey
          });
          const results = resp.data?.results || [];
          if (results.length === 0) {
            return 'No relevant legal information found.';
          }
          const top = results[0];
          legalInfo = `${top.title}\n${top.snippet}\n${top.url}`;
        }
        // 3. Summarize the best result with OpenAI
        const summaryPrompt = [
          new SystemMessage("You are a legal expert. Read the following legal information and answer the user's question in clear, plain language. If the info is insufficient, say so."),
          new HumanMessage(`User question: ${input}\n\nLegal info: ${legalInfo}`)
        ];
        const result = await chatModel.invoke(summaryPrompt);
        return result.content;
      } catch (e) {
        return `Legal lookup error: ${e.message}`;
      }
    }
  }),
  // Nodemailer Email (dynamic recipient)
  new DynamicTool({
    name: 'email',
    description: 'Send email notifications (dynamic recipient)',
    func: async (input) => {
      try {
        // You must set up SMTP credentials in your env
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: process.env.SMTP_PORT,
          secure: process.env.SMTP_SECURE === 'true',
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        });
        // Support input as string or object: { to, text, subject }
        let to, text, subject;
        if (typeof input === 'object' && input !== null) {
          to = input.to || process.env.SMTP_TO || process.env.SMTP_FROM;
          text = input.text || '';
          subject = input.subject || 'ConsumerAI Notification';
        } else {
          to = process.env.SMTP_TO || process.env.SMTP_FROM;
          text = input;
          subject = 'ConsumerAI Notification';
        }
        const info = await transporter.sendMail({
          from: process.env.SMTP_FROM,
          to,
          subject,
          text
        });
        return `Email sent: ${info.messageId}`;
      } catch (e) {
        return `Email error: ${e.message}`;
      }
    }
  }),
  // USPS Tracking 3.0 API (OAuth2 + REST/JSON)
  new DynamicTool({
    name: 'tracking',
    description: 'Track certified mail (USPS Tracking 3.0)',
    func: async (input) => {
      try {
        // 1. Get OAuth2 access token
        const clientId = process.env.USPS_OAUTH_CLIENT_ID;
        const clientSecret = process.env.USPS_OAUTH_CLIENT_SECRET;
        const tokenResp = await axios.post('https://api.usps.com/oauth2/v3/token',
          new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
            scope: 'tracking'
          }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        const accessToken = tokenResp.data.access_token;
        if (!accessToken) throw new Error('Failed to obtain USPS access token');
        // 2. Call USPS Tracking 3.0 REST API
        const trackingResp = await axios.get(
          `https://api.usps.com/tracking/v3/shipments/${encodeURIComponent(input)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        // 3. Parse and return tracking info
        const shipment = trackingResp.data?.shipments?.[0];
        if (!shipment) return 'No tracking information found.';
        const status = shipment.status || 'Unknown';
        const summary = shipment.summary || '';
        return `USPS Tracking Status: ${status}\n${summary}`;
      } catch (e) {
        return `USPS tracking error: ${e.response?.data?.error_description || e.message}`;
      }
    }
  }),
  // Supervisor (real orchestration)
  new DynamicTool({
    name: 'supervisor',
    description: 'Determines if a query needs direct answer or tool/agent orchestration',
    func: async (input) => {
      try {
        // If input is an array, orchestrate as before
        if (Array.isArray(input)) {
          const results = [];
          for (const step of input) {
            const tool = tools.find(t => t.name === step.tool);
            if (!tool) {
              results.push({ tool: step.tool, error: 'Tool not found' });
              continue;
            }
            try {
              const result = await tool.func(step.input);
              results.push({ tool: step.tool, result });
            } catch (e) {
              results.push({ tool: step.tool, error: e.message });
            }
          }
          return results;
        }
        // If input is a string, decide if direct answer or tool is needed
        if (typeof input === 'string') {
          // Use OpenAI to classify and route
          const classifyPrompt = [
            new SystemMessage("You are a supervisor AI. If the user's query is a simple question, answer it directly. If it requires a tool or agent (like search, calendar, report, letter, legal, email, tracking), return a JSON array of steps: [{ tool, input }]."),
            new HumanMessage(input)
          ];
          const result = await chatModel.invoke(classifyPrompt);
          // Try to parse as JSON array of steps
          try {
            const steps = JSON.parse(result.content);
            if (Array.isArray(steps)) {
              // Orchestrate as before
              const results = [];
              for (const step of steps) {
                const tool = tools.find(t => t.name === step.tool);
                if (!tool) {
                  results.push({ tool: step.tool, error: 'Tool not found' });
                  continue;
                }
                try {
                  const toolResult = await tool.func(step.input);
                  results.push({ tool: step.tool, result: toolResult });
                } catch (e) {
                  results.push({ tool: step.tool, error: e.message });
                }
              }
              return results;
            }
          } catch (e) {
            // Not a JSON array, treat as direct answer
            return result.content;
          }
          // Fallback: return as direct answer
          return result.content;
        }
        return 'Supervisor expects a string (user query) or array of steps.';
      } catch (e) {
        return `Supervisor error: ${e.message}`;
      }
    }
  })
];

// Custom callback handler for agent step events
class SocketIOAgentCallbackHandler {
  constructor(socketId, io) {
    this.socketId = socketId;
    this.io = io;
    this.name = 'SocketIOAgentCallbackHandler';
  }

  // Called when the agent takes an action (step)
  async handleAgentAction(action, runId, parentRunId, tags) {
    this.io.to(this.socketId).emit('agent-step', {
      tool: action.tool,
      toolInput: action.toolInput,
      log: action.log,
      runId,
      parentRunId,
      tags
    });
  }

  // Called when the agent finishes
  async handleAgentEnd(output, runId, parentRunId, tags) {
    this.io.to(this.socketId).emit('agent-finish', {
      output,
      runId,
      parentRunId,
      tags
    });
  }

  // Called on error
  async handleAgentError(error, runId, parentRunId, tags) {
    this.io.to(this.socketId).emit('agent-error', {
      error: error.message || String(error),
      runId,
      parentRunId,
      tags
    });
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



    // Chat endpoint with agent thinking and step events
    if (path === 'chat') {
      if (req.method === 'GET') return res.status(200).json({ status: 'ok' });
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { message, sessionId, socketId } = req.body;
      if (!message || !sessionId || !socketId) return res.status(400).json({ error: 'Missing message, sessionId, or socketId' });
      const io = global.io;
      try {
        // Signal thinking started
        io.to(socketId).emit('agent-thinking-start');

        // Set up callback manager and handler for agent step events
        const callbackManager = CallbackManager.fromHandlers({
          handleAgentAction: async (action, runId, parentRunId, tags) => {
            io.to(socketId).emit('agent-step', {
              tool: action.tool,
              toolInput: action.toolInput,
              log: action.log,
              runId,
              parentRunId,
              tags
            });
          },
          handleAgentEnd: async (output, runId, parentRunId, tags) => {
            io.to(socketId).emit('agent-finish', {
              output,
              runId,
              parentRunId,
              tags
            });
          },
          handleAgentError: async (error, runId, parentRunId, tags) => {
            io.to(socketId).emit('agent-error', {
              error: error.message || String(error),
              runId,
              parentRunId,
              tags
            });
          }
        });

        // Create the agent with tools and prompt
        const agent = await createOpenAIFunctionsAgent({
          llm: chatModel,
          tools,
          // Optionally, you can provide a custom prompt here
        });

        // Create the executor
        const agentExecutor = new AgentExecutor({
          agent,
          tools,
          // Optionally, pass input/output keys if needed
        });

        // Run the agent with the callback manager for step events
        const result = await agentExecutor.invoke({
          input: message
        }, {
          callbacks: [callbackManager]
        });

        io.to(socketId).emit('agent-thinking-complete', {
          response: result.output
        });
        return res.status(200).json({ data: {
          message: result.output,
          sessionId,
          messageId: `${Date.now()}-ai`,
          created_at: new Date().toISOString(),
          decisionTrace: {
            usedAgent: result.agentName || null,
            steps: ['Agent executed with tools']
          }
        }});
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
