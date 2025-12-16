const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { chatWithFallback } = require('../aiUtils');
const { TavilySearch } = require('@langchain/tavily');
const axios = require('axios');
const { DynamicTool } = require('@langchain/core/tools');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const nodemailer = require('nodemailer');

// Initialize model with Gemini
const model = new ChatGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY,
  model: 'gemini-2.5-flash',
  temperature: 0.7,
});

// Initialize tools
const searchTool = new TavilySearch({
  maxResults: 5,
  apiKey: process.env.TAVILY_API_KEY,
});

// Email tool
const emailTool = new DynamicTool({
  name: "send_email",
  description: "Send email notifications",
  func: async (input) => {
    const emailUser = process.env.EMAIL_USER || process.env.SMTP_USER;
    const emailPass = process.env.EMAIL_PASS || process.env.SMTP_PASS;
    const emailFrom = process.env.EMAIL_FROM || process.env.SMTP_FROM;
    
    if (!emailUser || !emailPass) {
      throw new Error('Email credentials not configured');
    }
    
    const { to, subject, body } = JSON.parse(input);
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: emailUser, pass: emailPass }
    });
    await transporter.sendMail({ from: emailFrom || emailUser, to, subject, html: body });
    return `Email sent to ${to}`;
  },
});



// Agent router
function routeAgent(message) {
  const text = message.toLowerCase();
  if (text.includes('search') || text.includes('find') || text.includes('look up')) return 'search';
  if (text.includes('report') || text.includes('credit report') || text.includes('analyze')) return 'report';
  if (text.includes('letter') || text.includes('dispute') || text.includes('generate')) return 'letter';
  if (text.includes('calendar') || text.includes('remind') || text.includes('deadline')) return 'calendar';
  if (text.includes('legal') || text.includes('law') || text.includes('case')) return 'legal';
  if (text.includes('email') || text.includes('send') || text.includes('notify')) return 'email';
  return 'search';
}

// Agent nodes
async function searchAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  try {
    const results = await searchTool.invoke(message);
    return {
      messages: [{ role: 'assistant', content: `Search results: ${results}` }],
      toolResults: [{ tool: 'search', result: results }]
    };
  } catch (error) {
    return {
      messages: [{ role: 'assistant', content: `Search failed: ${error.message}` }],
      toolResults: [{ tool: 'search', result: 'Search failed' }]
    };
  }
}

async function reportAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  
  // Check if message contains a file path
  const filePathMatch = message.match(/file_path:\s*(.+)/i);
  if (filePathMatch) {
    const filePath = filePathMatch[1].trim();
    try {
      const { processCreditReport } = require('../reportProcessor');
      const result = await processCreditReport(filePath);
      return {
        messages: [{ role: 'assistant', content: JSON.stringify(result.analysis, null, 2) }],
        toolResults: [{ tool: 'report', result: 'Credit report processed and analyzed' }]
      };
    } catch (error) {
      return {
        messages: [{ role: 'assistant', content: `Error processing credit report: ${error.message}` }],
        toolResults: [{ tool: 'report', result: 'Processing failed' }]
      };
    }
  } else {
    // If supabase and userId are provided, fetch recent analyzed files to give context
    if (state && state.supabase && state.userId) {
      try {
        const { data, error } = await state.supabase
          .from('report_analyses')
          .select('file_name, analysis, processed_at')
          .eq('user_id', state.userId)
          .order('processed_at', { ascending: false })
          .limit(3);

        if (!error && data && data.length > 0) {
          const filesSummary = data.map((f, i) => {
            const shortAnalysis = f.analysis ? JSON.stringify(f.analysis).slice(0, 1000) : 'no analysis';
            const when = f.processed_at || 'unknown';
            return `${i + 1}. ${f.file_name || 'unknown'} (${when})\nAnalysis: ${shortAnalysis}`;
          }).join('\n\n');

          const { response } = await chatWithFallback([
            new SystemMessage(`User recent files context:\n${filesSummary}\n\nAnalyze credit reports for FCRA violations and errors.`),
            new HumanMessage(message)
          ]);
          const content = response && (response.content || response) ? (response.content || response) : '';
          return {
            messages: [{ role: 'assistant', content }],
            toolResults: [{ tool: 'report', result: 'Credit report analyzed with user files' }]
          };
        }
      } catch (err) {
        console.error('reportAgent: failed to fetch user files context:', err && err.message ? err.message : err);
        // fall through to text-only analysis
      }
    }

    // Fallback to text analysis via centralized multi-provider fallback
    const { response } = await chatWithFallback([
      new SystemMessage('Analyze credit reports for FCRA violations and errors.'),
      new HumanMessage(message)
    ]);
    const content = response && (response.content || response) ? (response.content || response) : '';
    return {
      messages: [{ role: 'assistant', content }],
      toolResults: [{ tool: 'report', result: 'Credit report analyzed' }]
    };
  }
}

async function letterAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  const { response } = await chatWithFallback([
    new SystemMessage('Generate FDCPA/FCRA dispute letters with proper legal formatting.'),
    new HumanMessage(message)
  ]);
  const content = response && (response.content || response) ? (response.content || response) : '';
  return {
    messages: [{ role: 'assistant', content }],
    toolResults: [{ tool: 'letter', result: 'Dispute letter generated' }]
  };
}

async function calendarAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  const { response } = await chatWithFallback([
    new SystemMessage('Set legal deadline reminders and calendar events.'),
    new HumanMessage(message)
  ]);
  const content = response && (response.content || response) ? (response.content || response) : '';
  return {
    messages: [{ role: 'assistant', content }],
    toolResults: [{ tool: 'calendar', result: 'Reminder set' }]
  };
}

async function legalAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  const { enhancedLegalSearch } = require('../legalSearch');
  const legalInfo = await enhancedLegalSearch(message);
  const { response } = await chatWithFallback([
    new SystemMessage(`Legal context: ${legalInfo}`),
    new HumanMessage(message)
  ]);
  const content = response && (response.content || response) ? (response.content || response) : '';
  return {
    messages: [{ role: 'assistant', content }],
    toolResults: [{ tool: 'legal', result: 'Legal database searched' }]
  };
}

async function emailAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  try {
    await emailTool.invoke(message);
    return {
      messages: [{ role: 'assistant', content: 'Email sent successfully' }],
      toolResults: [{ tool: 'email', result: 'Email sent' }]
    };
  } catch (error) {
    return {
      messages: [{ role: 'assistant', content: `Email failed: ${error.message}` }],
      toolResults: [{ tool: 'email', result: 'Email failed' }]
    };
  }
}


// Agent executor
const agents = {
  search: searchAgent,
  report: reportAgent,
  letter: letterAgent,
  calendar: calendarAgent,
  legal: legalAgent,
  email: emailAgent,
};

async function executeAgent(agentType, message, opts = {}) {
  const agent = agents[agentType];
  if (!agent) throw new Error(`Unknown agent: ${agentType}`);

  const state = {
    messages: [{ role: 'user', content: message }],
    toolResults: [],
    userId: opts.userId || null,
    supabase: opts.supabase || null
  };

  return await agent(state);
}

module.exports = { executeAgent, routeAgent };