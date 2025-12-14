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
  userId: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  supabase: Annotation({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
});

// Initialize Google AI with Gemini 2.5 Flash model
let model = null;
if ((process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY) && ChatGoogleGenerativeAI) {
  try {
    model = new ChatGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY,
      model: 'gemini-2.5-flash',
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
    });
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



const prompt = ChatPromptTemplate.fromMessages([
  ['system', systemPrompt],
  new MessagesPlaceholder('messages'),
  ['human', 'Who should act next? Select one of: {options}'],
]);

// AI-powered supervisor using prompt
async function supervisor(state) {
  try {
    const message = state.messages[state.messages.length - 1].content.toLowerCase();
    
    // Priority routing for specific requests
    if (message.includes('track') || message.includes('certified mail') || message.includes('usps')) {
      return { next: 'tracking' };
    }
    // High priority for document analysis
    if (message.includes('analyze') || message.includes('review') || message.includes('my report') ||
        message.includes('credit report') || message.includes('document') || message.includes('uploaded') ||
        message.includes('file') || message.includes('violations') || message.includes('errors') ||
        message.includes('fcra') || message.includes('fdcpa') || message.includes('dispute')) {
      return { next: 'report' };
    }
    if (message.includes('letter') || message.includes('dispute')) {
      return { next: 'letter' };
    }
    if (message.includes('search') || message.includes('find')) {
      return { next: 'search' };
    }
    if (message.includes('legal') || message.includes('law')) {
      return { next: 'legal' };
    }
    if (message.includes('email') || message.includes('send')) {
      return { next: 'email' };
    }
    if (message.includes('calendar') || message.includes('remind')) {
      return { next: 'calendar' };
    }
    
    // Fallback to AI routing if available
    if (model) {
      try {
        const response = await prompt.pipe(model).invoke({
          messages: state.messages,
          options: members.join(', ')
        });
        
        const content = response.content.toLowerCase();
        for (const member of members) {
          if (content.includes(member)) {
            return { next: member };
          }
        }
      } catch (error) {
        console.error('AI routing failed:', error);
      }
    }
    
    return { next: END };
  } catch (error) {
    console.error('Supervisor error:', error);
    return { next: END };
  }
}

// Agent nodes
let TavilySearch, enhancedLegalSearch, sendEmailTool, sendDisputeLetterTool, uspsTrackingTool, genericTrackingTool;

try {
  TavilySearch = require('@langchain/tavily').TavilySearch;
} catch (error) {
  console.warn('TavilySearch not available:', error.message);
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
if (TavilySearch && process.env.TAVILY_API_KEY) {
  try {
    searchTool = new TavilySearch({
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
  const userId = state.userId;
  const supabase = state.supabase;
  
  // Auto-analyze most recent file if user asks about reports/documents
  const msg = message.toLowerCase();
  if ((msg.includes('analyze') || msg.includes('review') || msg.includes('my report') || 
       msg.includes('credit report') || msg.includes('document')) && userId && supabase) {
    
    try {
      // Get user's most recent uploaded file
      const { data: files, error: filesError } = await supabase.storage
        .from('documents')
        .list(userId, { limit: 1, sortBy: { column: 'created_at', order: 'desc' } });
      
      if (files && files.length > 0) {
        const latestFile = files[0];
        const filePath = `${userId}/${latestFile.name}`;
        
        // Process the document
        const { processCreditReport, extractText, downloadFromStorage } = require('../reportProcessor');
        const buffer = await downloadFromStorage(filePath);
        const extractedText = await extractText(buffer, latestFile.name);
        
        // Enhanced analysis with highlighting
        const detailedAnalysis = await callAI([
          new SystemMessage(`You are an expert credit report analyst. Analyze the document and provide:

1. **HIGHLIGHTED VIOLATIONS** - Mark specific violations with 🚨
2. **OUTLINED ERRORS** - List errors with ⚠️ 
3. **ACTIONABLE ITEMS** - Steps to take with ✅
4. **EVIDENCE QUOTES** - Exact text from report with quotation marks

Format your response with clear sections and highlighting.`),
          new HumanMessage(`Analyze this credit report for FCRA/FDCPA violations and errors:\n\n${extractedText}`)
        ]);
        
        // Store analysis in database
        const analysisResult = {
          summary: detailedAnalysis.content.substring(0, 200) + '...',
          detailed_analysis: detailedAnalysis.content,
          violations_found: detailedAnalysis.content.includes('🚨'),
          errors_found: detailedAnalysis.content.includes('⚠️'),
          file_name: latestFile.name,
          extracted_text: extractedText.substring(0, 1000) + '...'
        };
        
        await supabase.from('report_analyses').insert({
          user_id: userId,
          file_path: filePath,
          analysis: analysisResult,
          processed_at: new Date().toISOString()
        });
        
        return {
          messages: [new HumanMessage({ 
            content: `📄 **Analysis of ${latestFile.name}**\n\n${detailedAnalysis.content}\n\n---\n*Analysis saved to your account for future reference.*`, 
            name: 'ReportAgent' 
          })],
        };
      }
    } catch (error) {
      console.error('Auto-analysis error:', error);
    }
  }
  
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
  }
  
  // Check if user wants to analyze a specific file by name
  const analyzeFileMatch = message.match(/analyze file (.+)/i);
  if (analyzeFileMatch && userId && supabase) {
    const fileName = analyzeFileMatch[1].trim();
    try {
      const filePath = `${userId}/${fileName}`;
      const { extractText, downloadFromStorage } = require('../reportProcessor');
      const buffer = await downloadFromStorage(filePath);
      const extractedText = await extractText(buffer, fileName);
      
      // Enhanced analysis with highlighting
      const detailedAnalysis = await callAI([
        new SystemMessage(`Analyze this credit report and highlight violations with 🚨, errors with ⚠️, and action items with ✅. Quote specific text from the report.`),
        new HumanMessage(`Credit report content:\n\n${extractedText}`)
      ]);
      
      return {
        messages: [new HumanMessage({ 
          content: `📄 **Analysis of ${fileName}**\n\n${detailedAnalysis.content}`, 
          name: 'ReportAgent' 
        })],
      };
    } catch (error) {
      return {
        messages: [new HumanMessage({ 
          content: `Error analyzing ${fileName}: ${error.message}`, 
          name: 'ReportAgent' 
        })],
      };
    }
  }
  
  // Show available files if user asks generally
  if (msg.includes('files') || msg.includes('uploaded') || msg.includes('documents')) {
    if (!userId || !supabase) {
      return {
        messages: [new HumanMessage({ 
          content: `I can analyze credit reports and documents. Please upload a file or provide text for analysis.`, 
          name: 'ReportAgent' 
        })],
      };
    }
    
    try {
      const { data: files } = await supabase.storage
        .from('documents')
        .list(userId, { limit: 10, sortBy: { column: 'created_at', order: 'desc' } });
      
      if (files && files.length > 0) {
        let response = `📁 **Your uploaded documents:**\n\n`;
        files.forEach((file, idx) => {
          response += `${idx + 1}. 📄 ${file.name} (${new Date(file.created_at).toLocaleDateString()})\n`;
        });
        response += `\n💡 Say "analyze my report" to automatically analyze your most recent upload, or "analyze file [filename]" for a specific file.`;
        
        return {
          messages: [new HumanMessage({ content: response, name: 'ReportAgent' })],
        };
      } else {
        return {
          messages: [new HumanMessage({ 
            content: `📁 No documents found. Upload a credit report or document for analysis.`, 
            name: 'ReportAgent' 
          })],
        };
      }
    } catch (error) {
      return {
        messages: [new HumanMessage({ 
          content: `Error accessing files: ${error.message}`, 
          name: 'ReportAgent' 
        })],
      };
    }
  }
  
  // Fallback to text analysis for credit-related questions
  try {
    const analysis = await callAI([
      new SystemMessage('You are a credit report analyst. Analyze the provided text for FCRA violations, errors, and provide actionable advice. Use 🚨 for violations, ⚠️ for errors, and ✅ for action items.'),
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
      console.log(`Tracking agent using USPS API for: ${trackingMatch[0]}`);
      const result = await uspsTrackingTool.invoke(trackingMatch[0]);
      return {
        messages: [new HumanMessage({ content: result, name: 'TrackingAgent' })],
      };
    }
    // No tracking number found - ask user for it
    const content = uspsTrackingTool 
      ? 'I can help you track your USPS certified mail! Please provide your tracking number so I can check the status using the USPS API.'
      : 'I can help you track your mail! Please provide your tracking number and I\'ll assist you with tracking information.';
    return {
      messages: [new HumanMessage({ content, name: 'TrackingAgent' })],
    };
  } catch (error) {
    console.error('Tracking agent error:', error);
    return {
      messages: [new HumanMessage({
        content: `I'm having trouble accessing the tracking system right now. Please visit usps.com directly and enter your tracking number for the most up-to-date information.`,
        name: 'TrackingAgent'
      })],
    };
  }
}


// Create workflow
const workflow = new StateGraph(AgentState)
  .addNode('supervisor', supervisor)
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