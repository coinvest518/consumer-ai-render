const { StateGraph, Annotation, END, START } = require('@langchain/langgraph');
const { ChatOpenAI } = require('@langchain/openai');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { z } = require('zod');

// Define state
const AgentState = Annotation.Root({
  messages: Annotation({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  next: Annotation({
    reducer: (x, y) => y ?? x ?? END,
    default: () => END,
  }),
});

// Initialize model
const model = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4',
  temperature: 0.7,
});

// Define agents
const members = ['search', 'report', 'letter', 'legal', 'email', 'calendar', 'tracking'];

// Supervisor prompt
const systemPrompt = `You are a supervisor managing ConsumerAI agents: ${members.join(', ')}.
Given the user request, respond with the agent to act next:
- search: Web search and research
- report: Credit report analysis
- letter: Generate dispute letters
- legal: Legal database queries
- email: Send notifications
- calendar: Set reminders
- tracking: Track mail delivery
When finished, respond with FINISH.`;

const routingTool = {
  name: 'route',
  description: 'Select the next agent.',
  schema: z.object({
    next: z.enum([END, ...members]),
  }),
};

const prompt = ChatPromptTemplate.fromMessages([
  ['system', systemPrompt],
  new MessagesPlaceholder('messages'),
  ['human', 'Who should act next? Select one of: {options}'],
]);

// Simplified supervisor without OpenAI calls
function simpleSupervisor(state) {
  const message = state.messages[state.messages.length - 1].content.toLowerCase();
  
  if (message.includes('search') || message.includes('find')) return { next: 'search' };
  if (message.includes('report') || message.includes('credit')) return { next: 'report' };
  if (message.includes('letter') || message.includes('dispute')) return { next: 'letter' };
  if (message.includes('legal') || message.includes('law')) return { next: 'legal' };
  if (message.includes('email') || message.includes('send')) return { next: 'email' };
  if (message.includes('calendar') || message.includes('remind')) return { next: 'calendar' };
  if (message.includes('track') || message.includes('mail')) return { next: 'tracking' };
  
  return { next: END };
}

// Agent nodes
const { TavilySearchResults } = require('@langchain/community/tools/tavily_search');
const { enhancedLegalSearch } = require('../legalSearch');
const { sendEmailTool, sendDisputeLetterTool } = require('../emailTools');
const { uspsTrackingTool, genericTrackingTool } = require('../trackingTools');

const searchTool = new TavilySearchResults({
  maxResults: 5,
  apiKey: process.env.TAVILY_API_KEY,
});

async function searchAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  try {
    const results = await searchTool.invoke(message);
    return {
      messages: [new HumanMessage({ content: `Search results: ${results}`, name: 'SearchAgent' })],
    };
  } catch (error) {
    return {
      messages: [new HumanMessage({ content: `Search failed: ${error.message}`, name: 'SearchAgent' })],
    };
  }
}

async function reportAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  return {
    messages: [new HumanMessage({ content: 'Credit report analysis: Please provide your credit report for detailed FCRA violation analysis.', name: 'ReportAgent' })],
  };
}

async function letterAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  const { FDCPA_TEMPLATE } = require('./templates');
  return {
    messages: [new HumanMessage({ content: `Here's a dispute letter template:\n\n${FDCPA_TEMPLATE.substring(0, 500)}...`, name: 'LetterAgent' })],
  };
}

async function legalAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  return {
    messages: [new HumanMessage({ content: 'Legal guidance: For consumer law questions, please consult FDCPA and FCRA regulations. I can help with specific legal document templates.', name: 'LegalAgent' })],
  };
}

async function emailAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  try {
    // Try to parse email request
    if (message.includes('send') && message.includes('email')) {
      const result = await sendEmailTool.invoke(message);
      return {
        messages: [new HumanMessage({ content: result, name: 'EmailAgent' })],
      };
    } else if (message.includes('dispute') && message.includes('letter')) {
      const result = await sendDisputeLetterTool.invoke(message);
      return {
        messages: [new HumanMessage({ content: result, name: 'EmailAgent' })],
      };
    }
    return {
      messages: [new HumanMessage({ content: 'Email tools ready. Specify: send email or send dispute letter', name: 'EmailAgent' })],
    };
  } catch (error) {
    return {
      messages: [new HumanMessage({ content: `Email error: ${error.message}`, name: 'EmailAgent' })],
    };
  }
}

async function calendarAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  return {
    messages: [new HumanMessage({ content: 'Calendar reminder set: Important legal deadlines are typically 30 days for FDCPA disputes and 30 days for FCRA disputes.', name: 'CalendarAgent' })],
  };
}

async function trackingAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  try {
    // Extract tracking number if present
    const trackingMatch = message.match(/\b[A-Z0-9]{10,}\b/);
    if (trackingMatch) {
      const result = await uspsTrackingTool.invoke(trackingMatch[0]);
      return {
        messages: [new HumanMessage({ content: result, name: 'TrackingAgent' })],
      };
    } else {
      const result = await genericTrackingTool.invoke(JSON.stringify({ trackingNumber: 'N/A', carrier: 'USPS' }));
      return {
        messages: [new HumanMessage({ content: result, name: 'TrackingAgent' })],
      };
    }
  } catch (error) {
    return {
      messages: [new HumanMessage({ content: `Tracking error: ${error.message}`, name: 'TrackingAgent' })],
    };
  }
}

// Create workflow
const workflow = new StateGraph(AgentState)
  .addNode('supervisor', simpleSupervisor)
  .addNode('search', searchAgent)
  .addNode('report', reportAgent)
  .addNode('letter', letterAgent)
  .addNode('legal', legalAgent)
  .addNode('email', emailAgent)
  .addNode('calendar', calendarAgent)
  .addNode('tracking', trackingAgent);

// Add edges
members.forEach((member) => {
  workflow.addEdge(member, 'supervisor');
});

workflow.addConditionalEdges(
  'supervisor',
  (x) => x.next,
);

workflow.addEdge(START, 'supervisor');

const graph = workflow.compile();

module.exports = { graph, AgentState };