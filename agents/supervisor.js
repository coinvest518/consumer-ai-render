const { StateGraph, Annotation, END, START } = require('@langchain/langgraph');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { z } = require('zod');

// Import dependencies
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');

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

// Initialize Google AI with Gemini 1.5 Flash model
let model = null;
if (process.env.GOOGLE_API_KEY && ChatGoogleGenerativeAI) {
  try {
    model = wrapGoogleGenerativeAI(new ChatGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY,
      model: 'gemini-1.5-flash',
      temperature: 0.7,
      maxRetries: 2,
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
    }));
  } catch (error) {
    console.warn('Failed to initialize ChatGoogleGenerativeAI:', error.message);
  }
}

// AI call with Google model
async function callAI(messages) {
  try {
    if (!model) {
      return { content: 'AI service is not configured. Please check your GOOGLE_API_KEY.' };
    }
    
    await delay(100); // Minimal delay for rate limiting
    return await model.invoke(messages);
  } catch (error) {
    console.error('Google AI request failed:', error.message);
    return { content: `AI service unavailable: ${error.message}` };
  }
}

// Simple delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// Fast supervisor with single-step routing
function simpleSupervisor(state) {
  const message = state.messages[state.messages.length - 1].content.toLowerCase();
  
  // Direct routing - no loops, single agent call
  if (message.includes('search') || message.includes('find')) return { next: 'search' };
  if (message.includes('report') || message.includes('credit')) return { next: 'report' };
  if (message.includes('letter') || message.includes('dispute')) return { next: 'letter' };
  if (message.includes('legal') || message.includes('law')) return { next: 'legal' };
  if (message.includes('email') || message.includes('send')) return { next: 'email' };
  if (message.includes('calendar') || message.includes('remind')) return { next: 'calendar' };
  if (message.includes('track') || message.includes('mail')) return { next: 'tracking' };
  
  // Always end after one agent call
  return { next: END };
}

// Agent nodes
let TavilySearchResults, enhancedLegalSearch, sendEmailTool, sendDisputeLetterTool, uspsTrackingTool, genericTrackingTool;

try {
  TavilySearchResults = require('@langchain/community/tools/tavily_search').TavilySearchResults;
} catch (error) {
  console.warn('TavilySearchResults not available:', error.message);
}

try {
  enhancedLegalSearch = require('../legalSearch').enhancedLegalSearch;
} catch (error) {
  console.warn('enhancedLegalSearch not available:', error.message);
  enhancedLegalSearch = async (query) => `Legal search unavailable: ${query}`;
}

try {
  const emailTools = require('../emailTools');
  sendEmailTool = emailTools.sendEmailTool;
  sendDisputeLetterTool = emailTools.sendDisputeLetterTool;
} catch (error) {
  console.warn('Email tools not available:', error.message);
}

try {
  const trackingTools = require('../trackingTools');
  uspsTrackingTool = trackingTools.uspsTrackingTool;
  genericTrackingTool = trackingTools.genericTrackingTool;
} catch (error) {
  console.warn('Tracking tools not available:', error.message);
}

let searchTool = null;
if (TavilySearchResults && process.env.TAVILY_API_KEY) {
  try {
    searchTool = new TavilySearchResults({
      maxResults: 5,
      apiKey: process.env.TAVILY_API_KEY,
    });
  } catch (error) {
    console.warn('Failed to initialize search tool:', error.message);
  }
}

async function searchAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  try {
    if (searchTool) {
      const results = await searchTool.invoke(message);
      return {
        messages: [new HumanMessage({ content: `Search results: ${results}`, name: 'SearchAgent' })],
      };
    } else {
      return {
        messages: [new HumanMessage({ content: `Search unavailable. Query: ${message}`, name: 'SearchAgent' })],
      };
    }
  } catch (error) {
    return {
      messages: [new HumanMessage({ content: `Search failed: ${error.message}`, name: 'SearchAgent' })],
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
        messages: [new HumanMessage({ content: JSON.stringify(result.analysis, null, 2), name: 'ReportAgent' })],
      };
    } catch (error) {
      return {
        messages: [new HumanMessage({ content: `Error processing credit report: ${error.message}`, name: 'ReportAgent' })],
      };
    }
  } else {
    // Fallback to text analysis
    try {
      const analysis = await callAI([
        new SystemMessage('Analyze credit reports for FCRA violations and errors.'),
        new HumanMessage(message)
      ]);
      return {
        messages: [new HumanMessage({ content: analysis.content, name: 'ReportAgent' })],
      };
    } catch (error) {
      return {
        messages: [new HumanMessage({ content: `Credit report analysis unavailable: ${error.message}`, name: 'ReportAgent' })],
      };
    }
  }
}

async function letterAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  try {
    const { FDCPA_TEMPLATE, FCRA_TEMPLATE } = require('./templates');
    
    const letter = await callAI([
      new SystemMessage(`Generate FDCPA/FCRA dispute letters. Use these templates: ${FDCPA_TEMPLATE.substring(0, 200)}...`),
      new HumanMessage(message)
    ]);
    return {
      messages: [new HumanMessage({ content: letter.content, name: 'LetterAgent' })],
    };
  } catch (error) {
    return {
      messages: [new HumanMessage({ content: `Letter generation unavailable: ${error.message}`, name: 'LetterAgent' })],
    };
  }
}

async function legalAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  try {
    const legalInfo = await enhancedLegalSearch(message);
    const response = await callAI([
      new SystemMessage(`Legal context: ${legalInfo}`),
      new HumanMessage(message)
    ]);
    return {
      messages: [new HumanMessage({ content: response.content, name: 'LegalAgent' })],
    };
  } catch (error) {
    return {
      messages: [new HumanMessage({ content: `Legal search unavailable: ${error.message}`, name: 'LegalAgent' })],
    };
  }
}

async function emailAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  try {
    // Try to parse email request
    if (message.includes('send') && message.includes('email')) {
      if (sendEmailTool) {
        const result = await sendEmailTool.invoke(message);
        return {
          messages: [new HumanMessage({ content: result, name: 'EmailAgent' })],
        };
      } else {
        return {
          messages: [new HumanMessage({ content: 'Email service not configured', name: 'EmailAgent' })],
        };
      }
    } else if (message.includes('dispute') && message.includes('letter')) {
      if (sendDisputeLetterTool) {
        const result = await sendDisputeLetterTool.invoke(message);
        return {
          messages: [new HumanMessage({ content: result, name: 'EmailAgent' })],
        };
      } else {
        return {
          messages: [new HumanMessage({ content: 'Dispute letter service not configured', name: 'EmailAgent' })],
        };
      }
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
  try {
    const reminder = await callAI([
      new SystemMessage('Set legal deadline reminders and calendar events.'),
      new HumanMessage(message)
    ]);
    return {
      messages: [new HumanMessage({ content: reminder.content, name: 'CalendarAgent' })],
    };
  } catch (error) {
    return {
      messages: [new HumanMessage({ content: `Calendar service unavailable: ${error.message}`, name: 'CalendarAgent' })],
    };
  }
}

async function trackingAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  try {
    // Extract tracking number if present
    const trackingMatch = message.match(/\b[A-Z0-9]{10,}\b/);
    if (trackingMatch && uspsTrackingTool) {
      const result = await uspsTrackingTool.invoke(trackingMatch[0]);
      return {
        messages: [new HumanMessage({ content: result, name: 'TrackingAgent' })],
      };
    } else if (genericTrackingTool) {
      const result = await genericTrackingTool.invoke(JSON.stringify({ trackingNumber: 'N/A', carrier: 'USPS' }));
      return {
        messages: [new HumanMessage({ content: result, name: 'TrackingAgent' })],
      };
    } else {
      return {
        messages: [new HumanMessage({ content: 'Tracking service not configured', name: 'TrackingAgent' })],
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

// Direct edges to END - no loops back to supervisor
members.forEach((member) => {
  workflow.addEdge(member, END);
});

workflow.addConditionalEdges(
  'supervisor',
  (x) => x.next,
);

workflow.addEdge(START, 'supervisor');

const graph = workflow.compile({
  recursionLimit: 3 // Minimal steps to prevent loops
});

module.exports = { graph, AgentState };