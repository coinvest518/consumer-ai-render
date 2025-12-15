// AI utilities for fallback chat functionality
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { HumanMessage, SystemMessage, AIMessage } = require('@langchain/core/messages');
const { Mistral } = require('@mistralai/mistralai');

// Initialize models
let chatModel = null;
let mistralClient = null;
let hfClient = null;
let muleRouterClient = null;

// Initialize Google AI
const googleApiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY;
if (googleApiKey) {
  try {
    chatModel = new ChatGoogleGenerativeAI({
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
  } catch (error) {
    console.error('Failed to initialize Google AI model:', error.message);
  }
}

// Initialize Mistral
const mistralApiKey = process.env.MISTRAL_API_KEY;
if (mistralApiKey) {
  try {
    mistralClient = new Mistral({ apiKey: mistralApiKey });
  } catch (error) {
    console.error('Failed to initialize Mistral AI client:', error.message);
  }
}

// Initialize Hugging Face
const hfApiKey = process.env.HF_TOKEN;
if (hfApiKey) {
  try {
    const { OpenAI } = require('openai');
    hfClient = new OpenAI({
      baseURL: 'https://router.huggingface.co/v1',
      apiKey: hfApiKey,
    });
  } catch (error) {
    console.error('Failed to initialize Hugging Face Inference client:', error.message);
  }
}

// Initialize MuleRouter (Qwen)
const muleRouterApiKey = process.env.MULEROUTER_API_KEY;
if (muleRouterApiKey) {
  try {
    const { OpenAI } = require('openai');
    muleRouterClient = new OpenAI({
      baseURL: 'https://api.mulerouter.com/v1',
      apiKey: muleRouterApiKey,
    });
  } catch (error) {
    console.error('Failed to initialize MuleRouter (Qwen) client:', error.message);
  }
}

// Fallback chat function: prefer Mistral → Hugging Face → MuleRouter → Google
async function chatWithFallback(messages) {
  // 1) Mistral
  if (mistralClient) {
    try {
      console.log('Attempting chat with Mistral (primary)');
      const mistralMessages = messages.map(msg => {
        if (msg instanceof SystemMessage) return { role: 'system', content: msg.content };
        if (msg instanceof HumanMessage) return { role: 'user', content: msg.content };
        if (msg instanceof AIMessage) return { role: 'assistant', content: msg.content };
        return { role: 'user', content: msg.content };
      });

      const mistralResponse = await mistralClient.chat.complete({
        model: 'mistral-small-latest',
        messages: mistralMessages,
        temperature: 0.7,
        max_tokens: 2048,
        stream: false
      });

      const content = mistralResponse.choices?.[0]?.message?.content || 'No content from Mistral.';
      console.log('Mistral response successful');
      return { response: { content }, model: 'mistral' };
    } catch (error) {
      console.warn('Mistral failed, continuing fallbacks:', error.message);
    }
  }

  // 2) Hugging Face
  if (hfClient) {
    try {
      console.log('Attempting chat with Hugging Face (secondary)');
      const hfMessages = messages.map(msg => {
        if (msg instanceof SystemMessage) return { role: 'system', content: msg.content };
        if (msg instanceof HumanMessage) return { role: 'user', content: msg.content };
        if (msg instanceof AIMessage) return { role: 'assistant', content: msg.content };
        return { role: 'user', content: msg.content };
      });

      const hfResponse = await hfClient.chat.completions.create({
        model: 'meta-llama/Llama-3.2-3B-Instruct',
        messages: hfMessages,
        temperature: 0.7,
        max_tokens: 2048,
        stream: false
      });

      const content = hfResponse.choices?.[0]?.message?.content || 'No content from HuggingFace.';
      console.log('Hugging Face response successful');
      return { response: { content }, model: 'huggingface' };
    } catch (error) {
      console.warn('Hugging Face failed, continuing fallbacks:', error.message);
    }
  }

  // 3) MuleRouter (Qwen)
  if (muleRouterClient) {
    try {
      console.log('Attempting chat with MuleRouter (Qwen) (tertiary)');
      const muleMessages = messages.map(msg => {
        if (msg instanceof SystemMessage) return { role: 'system', content: msg.content };
        if (msg instanceof HumanMessage) return { role: 'user', content: msg.content };
        if (msg instanceof AIMessage) return { role: 'assistant', content: msg.content };
        return { role: 'user', content: msg.content };
      });

      const muleResponse = await muleRouterClient.chat.completions.create({
        model: 'qwen/qwen-2.5-coder-32b-instruct',
        messages: muleMessages,
        temperature: 0.7,
        max_tokens: 2048,
        stream: false
      });

      const content = muleResponse.choices?.[0]?.message?.content || 'No content from MuleRouter.';
      console.log('MuleRouter response successful');
      return { response: { content }, model: 'mulerouter-qwen' };
    } catch (error) {
      console.warn('MuleRouter failed, continuing fallbacks:', error.message);
    }
  }

  // 4) Google Gemini (last resort)
  if (chatModel) {
    try {
      console.log('Attempting chat with Google Gemini (last resort)');
      const response = await chatModel.invoke(messages);
      console.log('Google Gemini response successful');
      return { response, model: 'google-gemini' };
    } catch (error) {
      console.warn('Google Gemini failed as last resort:', error.message);
    }
  }

  throw new Error('All AI providers failed. Check API keys and quotas.');
}

module.exports = { chatWithFallback };