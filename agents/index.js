const { ChatOpenAI } = require('@langchain/openai');
const { TavilySearchResults } = require('@langchain/community/tools/tavily_search');
const axios = require('axios');
const { DynamicTool } = require('@langchain/core/tools');
const nodemailer = require('nodemailer');

// Initialize model
const model = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4',
  temperature: 0.7,
});

// Initialize tools
const searchTool = new TavilySearchResults({
  maxResults: 5,
  apiKey: process.env.TAVILY_API_KEY,
});

// Email tool
const emailTool = new DynamicTool({
  name: "send_email",
  description: "Send email notifications",
  func: async (input) => {
    const { to, subject, body } = JSON.parse(input);
    const transporter = nodemailer.createTransporter({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, html: body });
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
  if (text.includes('track') || text.includes('mail') || text.includes('delivery')) return 'tracking';
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
  const analysis = await model.invoke([
    { role: 'system', content: 'Analyze credit reports for FCRA violations and errors.' },
    { role: 'user', content: message }
  ]);
  return {
    messages: [{ role: 'assistant', content: analysis.content }],
    toolResults: [{ tool: 'report', result: 'Credit report analyzed' }]
  };
}

async function letterAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  const letter = await model.invoke([
    { role: 'system', content: 'Generate FDCPA/FCRA dispute letters with proper legal formatting.' },
    { role: 'user', content: message }
  ]);
  return {
    messages: [{ role: 'assistant', content: letter.content }],
    toolResults: [{ tool: 'letter', result: 'Dispute letter generated' }]
  };
}

async function calendarAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  const reminder = await model.invoke([
    { role: 'system', content: 'Set legal deadline reminders and calendar events.' },
    { role: 'user', content: message }
  ]);
  return {
    messages: [{ role: 'assistant', content: reminder.content }],
    toolResults: [{ tool: 'calendar', result: 'Reminder set' }]
  };
}

async function legalAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  const { enhancedLegalSearch } = require('../legalSearch');
  const legalInfo = await enhancedLegalSearch(message);
  const response = await model.invoke([
    { role: 'system', content: `Legal context: ${legalInfo}` },
    { role: 'user', content: message }
  ]);
  return {
    messages: [{ role: 'assistant', content: response.content }],
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

async function trackingAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  const tracking = await model.invoke([
    { role: 'system', content: 'Track certified mail and provide delivery updates.' },
    { role: 'user', content: message }
  ]);
  return {
    messages: [{ role: 'assistant', content: tracking.content }],
    toolResults: [{ tool: 'tracking', result: 'Tracking info retrieved' }]
  };
}

// Agent executor
const agents = {
  search: searchAgent,
  report: reportAgent,
  letter: letterAgent,
  calendar: calendarAgent,
  legal: legalAgent,
  email: emailAgent,
  tracking: trackingAgent
};

async function executeAgent(agentType, message) {
  const agent = agents[agentType];
  if (!agent) throw new Error(`Unknown agent: ${agentType}`);
  
  const state = {
    messages: [{ role: 'user', content: message }],
    toolResults: []
  };
  
  return await agent(state);
}

module.exports = { executeAgent, routeAgent };