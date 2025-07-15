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

// Process a message
async function processMessage(message, sessionId) {
  try {
    // Get chat history for the session
    const history = getChatHistory(sessionId);
    
    // Add user message to history
    const userMessage = new HumanMessage(message);
    history.push(userMessage);
    
    // Get AI response using OpenAI
    const aiResponse = await chatModel.invoke(history);
    
    // Add AI response to history
    const aiMessage = new AIMessage(aiResponse.content);
    history.push(aiMessage);
    
    return {
      message: aiResponse.content,
      sessionId,
      messageId: `${Date.now()}-ai`,
      created_at: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error processing message:', error);
    throw error;
  }
}

// Storage plan definitions
const STORAGE_PLANS = {
  basic: {
    price: 500, // $5.00
    storage: 1073741824, // 1GB
    files: 200
  },
  pro: {
    price: 1000, // $10.00
    storage: 5368709120, // 5GB
    files: 1000
  },
  enterprise: {
    price: 2500, // $25.00
    storage: 21474836480, // 20GB
    files: 5000
  }
};

// Main API handler
module.exports = async function handler(req, res) {
  // Set CORS headers
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, user-id, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Get the path from the URL
  const path = req.url.split('?')[0].replace(/^\//, '') || '';
  
  console.log(`[API Router] Routing request to: ${path}`);
  
  try {
    // Chat endpoint
    if (path === 'chat') {
      if (req.method === 'GET') {
        return res.status(200).json({ status: 'ok' });
      }
      
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
      }
      
      const { message, sessionId } = req.body;
      
      if (!message || !sessionId) {
        return res.status(400).json({ error: 'Missing message or sessionId' });
      }
      
      const responseData = await processMessage(message, sessionId);
      
      return res.status(200).json({
        data: responseData
      });
    }
    
    // Chat history endpoint
    else if (path === 'chat/history') {
      if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
      }
      
      // Get user ID from the header or query parameter
      const userId = req.headers['user-id'] || req.query.userId;
      
      if (!userId) {
        return res.status(400).json({ error: 'Missing user ID' });
      }
      
      // Fetch chat history from Supabase
      const { data: chatHistory, error } = await supabase
        .from('chat_history')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      
      if (error) {
        return res.status(500).json({ error: 'Failed to retrieve chat history' });
      }
      
      // Transform data to match frontend expectations
      const transformedHistory = chatHistory.map(chat => ({
        id: chat.id,
        sessionId: chat.session_id,
        timestamp: chat.created_at,
        messages: [
          {
            id: `${chat.id}-user`,
            role: 'user',
            content: chat.message,
            timestamp: chat.created_at
          },
          {
            id: `${chat.id}-assistant`,
            role: 'assistant', 
            content: chat.response,
            timestamp: chat.created_at
          }
        ],
        createdAt: chat.created_at,
        updatedAt: chat.updated_at || chat.created_at,
        _id: chat.id
      }));
      
      return res.status(200).json({
        data: transformedHistory
      });
    }
    
    // Session endpoint
    else if (path === 'session') {
      if (req.method === 'GET') {
        const userId = req.headers['user-id'] || req.query.userId;
        
        if (!userId) {
          return res.status(400).json({ error: 'Missing user ID' });
        }
        
        // Get user profile from Supabase
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .single();
        
        if (error && error.code !== 'PGRST116') {
          return res.status(500).json({ error: 'Failed to fetch user session' });
        }
        
        const sessionData = {
          id: userId,
          userId: userId,
          created: profile?.created_at || new Date().toISOString(),
          lastActive: new Date().toISOString(),
          messageCount: profile?.questions_asked || 0,
          isPro: profile?.is_pro || false
        };
        
        return res.status(200).json({
          data: sessionData
        });
      }
      
      if (req.method === 'POST') {
        const { userId, email } = req.body;
        
        if (!userId) {
          return res.status(400).json({ error: 'Missing user ID' });
        }
        
        // Check if a profile already exists
        let { data: profile, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .single();
        
        if (error && error.code === 'PGRST116') {
          // Create new profile
          const { data: newProfile, error: insertError } = await supabase
            .from('profiles')
            .insert({
              id: userId,
              email: email || `user_${userId}@temp.com`,
              questions_asked: 0,
              questions_remaining: 5,
              is_pro: false
            })
            .select()
            .single();
          
          if (insertError) {
            return res.status(500).json({ error: 'Failed to create session' });
          }
          
          profile = newProfile;
        } else if (error) {
          return res.status(500).json({ error: 'Failed to create session' });
        }
        
        const newSession = {
          id: userId,
          userId: userId,
          created: profile.created_at,
          lastActive: new Date().toISOString(),
          messageCount: profile.questions_asked
        };
        
        return res.status(201).json({
          data: newSession
        });
      }
      
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    // Stripe webhook endpoint
    else if (path === 'stripe-webhook') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
      }
      
      const sig = req.headers['stripe-signature'];
      
      try {
        const event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET || ''
        );
        
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const userId = session.metadata?.userId;
          
          if (userId) {
            // Get current metrics
            const { data: metrics, error: metricsError } = await supabase
              .from('user_metrics')
              .select('*')
              .eq('user_id', userId)
              .single();
            
            if (metricsError && metricsError.code !== 'PGRST116') {
              throw metricsError;
            }
            
            const currentMetrics = metrics || {
              user_id: userId,
              daily_limit: 5,
              chats_used: 0,
              is_pro: false,
              last_updated: new Date().toISOString()
            };
            
            // Update metrics with additional credits
            await supabase
              .from('user_metrics')
              .upsert({
                ...currentMetrics,
                daily_limit: currentMetrics.daily_limit + 50,
                last_purchase: new Date().toISOString(),
                last_updated: new Date().toISOString()
              });
            
            // Record the purchase
            await supabase
              .from('purchases')
              .insert([{
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
          }
        }
        
        return res.json({ received: true });
      } catch (err) {
        return res.status(400).send(
          `Webhook Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    
    // Storage upgrade endpoint
    else if (path === 'storage/upgrade') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'Method not allowed' } });
      }
      
      const { userId, plan } = req.body;
      
      if (!userId || !plan) {
        return res.status(400).json({ error: { message: 'Missing required fields' } });
      }
      
      // Type check the plan parameter
      if (!['basic', 'pro', 'enterprise'].includes(plan)) {
        return res.status(400).json({ error: { message: 'Invalid plan' } });
      }
      
      const typedPlan = plan;
      
      // Create Stripe checkout session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `ConsumerAI ${typedPlan.charAt(0).toUpperCase() + typedPlan.slice(1)} Storage Plan`,
                description: `Upgrade to ${STORAGE_PLANS[typedPlan].storage / 1073741824}GB storage and ${STORAGE_PLANS[typedPlan].files} files`,
              },
              unit_amount: STORAGE_PLANS[typedPlan].price,
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: `${req.headers.origin}/dashboard?success=true`,
        cancel_url: `${req.headers.origin}/dashboard?canceled=true`,
        metadata: {
          userId,
          plan: typedPlan,
          storageBytes: STORAGE_PLANS[typedPlan].storage.toString(),
          files: STORAGE_PLANS[typedPlan].files.toString()
        }
      });
      
      // Record the transaction
      const { error } = await supabase
        .from('storage_transactions')
        .insert([{
          user_id: userId,
          amount_cents: STORAGE_PLANS[typedPlan].price,
          storage_added_bytes: STORAGE_PLANS[typedPlan].storage,
          files_added: STORAGE_PLANS[typedPlan].files,
          stripe_session_id: session.id,
          status: 'pending'
        }]);
      
      if (error) throw error;
      
      return res.status(200).json({ 
        url: session.url,
        sessionId: session.id
      });
    }
    
    // Storage webhook endpoint
    else if (path === 'storage/webhook') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'Method not allowed' } });
      }
      
      const sig = req.headers['stripe-signature'];
      
      try {
        const event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET || ''
        );
        
        // Handle the event
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          
          // Get the metadata
          const userId = session.metadata?.userId;
          const storageBytes = parseInt(session.metadata?.storageBytes || '0');
          const files = parseInt(session.metadata?.files || '0');
          const plan = session.metadata?.plan;
          
          if (!userId || !storageBytes || !files || !plan) {
            throw new Error('Missing metadata in Stripe session');
          }
          
          // Update the transaction
          const { error: txError } = await supabase
            .from('storage_transactions')
            .update({
              status: 'completed',
              completed_at: new Date().toISOString()
            })
            .eq('stripe_session_id', session.id);
          
          if (txError) throw txError;
          
          // Get current storage limits
          const { data: currentLimits, error: limitsError } = await supabase
            .from('storage_limits')
            .select('*')
            .eq('user_id', userId)
            .single();
          
          if (limitsError && limitsError.code !== 'PGRST116') throw limitsError;
          
          // Update or insert storage limits
          if (currentLimits) {
            const { error: updateError } = await supabase
              .from('storage_limits')
              .update({
                max_storage_bytes: currentLimits.max_storage_bytes + storageBytes,
                max_files: currentLimits.max_files + files,
                is_premium: true,
                tier_name: plan,
                updated_at: new Date().toISOString()
              })
              .eq('user_id', userId);
            
            if (updateError) throw updateError;
          } else {
            const { error: insertError } = await supabase
              .from('storage_limits')
              .insert([{
                user_id: userId,
                max_storage_bytes: storageBytes,
                max_files: files,
                is_premium: true,
                tier_name: plan
              }]);
            
            if (insertError) throw insertError;
          }
        }
        
        return res.status(200).json({ received: true });
      } catch (error) {
        console.error('Error processing webhook:', error);
        return res.status(400).json({ error: error.message });
      }
    }
    
    // Agents endpoint
    else if (path === 'agents' || path === 'agents/process') {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
      }

      const { message, sessionId } = req.body;

      if (!message || !sessionId) {
        return res.status(400).json({ error: 'Missing message or sessionId' });
      }

      // Process the message
      const responseData = await processMessage(message, sessionId);

      // Return in the expected format
      return res.status(200).json({
        data: responseData
      });
    }
    
    // Health check endpoint
    else if (path === '' || path === 'health') {
      return res.status(200).json({
        status: 'ok',
        message: 'API is running',
        timestamp: new Date().toISOString()
      });
    }
    
    // Not found
    else {
      return res.status(404).json({
        error: {
          message: `API endpoint /${path} not found`,
          code: 'NOT_FOUND'
        }
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