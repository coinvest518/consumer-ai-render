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
    console.log('[Supervisor] callAI called, model available:', !!model);
    if (!model) {
      console.log('[Supervisor] Model not available, GOOGLE_API_KEY present:', !!process.env.GOOGLE_API_KEY);
      return { content: 'AI service is not configured. Please check your GOOGLE_API_KEY.' };
    }
    
    await delay(100); // Minimal delay for rate limiting
    console.log('[Supervisor] Calling AI model...');
    const result = await Promise.race([
      model.invoke(messages),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('AI timeout')), 20000) // 20 second timeout for AI calls
      )
    ]);
    console.log('[Supervisor] AI call successful');
    return result;
  } catch (error) {
    console.error('[Supervisor] AI request failed:', error.message);
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
- search: Web search and research for consumer law information
- report: Credit report analysis and violation detection
- letter: Generate dispute letters and legal correspondence
- legal: Legal database queries and statute research
- email: Send notifications and follow-up emails
- calendar: Set reminders for legal deadlines
- tracking: Calculate legal timelines and dispute process tracking
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
    console.log('[Supervisor] Routing message:', message);
    console.log('[Supervisor] userId:', state.userId);
    console.log('[Supervisor] supabase available:', !!state.supabase);
    
    // Priority routing for specific requests
    if (message.includes('track') || message.includes('certified mail') || message.includes('usps')) {
      console.log('[Supervisor] Routing to tracking');
      return { next: 'tracking' };
    }
    // High priority for document analysis
    if (message.includes('analyze') || message.includes('review') || message.includes('my report') ||
        message.includes('credit report') || message.includes('document') || message.includes('uploaded') ||
        message.includes('file') || message.includes('violations') || message.includes('errors') ||
        message.includes('fcra') || message.includes('fdcpa') || message.includes('dispute')) {
      console.log('[Supervisor] Routing to report agent');
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
let TavilySearch, enhancedLegalSearch, sendEmailTool, sendDisputeLetterTool;

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
  console.log(`[ReportAgent] Checking message: "${msg}" for analysis keywords`);
  console.log(`[ReportAgent] userId: ${userId}, supabase available: ${!!supabase}`);
  
  if ((msg.includes('analyze') || msg.includes('review') || msg.includes('my report') || 
       msg.includes('credit report') || msg.includes('document')) && userId && supabase) {
    
    console.log(`[ReportAgent] Analysis keywords found, checking for recent analyses...`);
    
    try {
      // FIRST: Check if we already have an analysis for the most recent file
      const { data: existingAnalyses, error: analysesError } = await supabase
        .from('report_analyses')
        .select('*')
        .eq('user_id', userId)
        .order('processed_at', { ascending: false })
        .limit(1);
      
      if (!analysesError && existingAnalyses && existingAnalyses.length > 0) {
        const latestAnalysis = existingAnalyses[0];
        // Check if the analysis is recent (within last hour) and file still exists
        const analysisAge = Date.now() - new Date(latestAnalysis.processed_at).getTime();
        const isRecent = analysisAge < (60 * 60 * 1000); // 1 hour
        
        console.log(`[ReportAgent] Found existing analysis, age: ${analysisAge}ms, isRecent: ${isRecent}`);
        
        if (isRecent) {
          console.log(`[ReportAgent] Returning cached analysis`);
          return {
            messages: [new HumanMessage({ 
              content: `📄 **Recent Analysis Available**\n\n${latestAnalysis.analysis.detailed_analysis || latestAnalysis.analysis.summary}\n\n---\n*Using cached analysis from ${new Date(latestAnalysis.processed_at).toLocaleString()}*`, 
              name: 'ReportAgent' 
            })],
          };
        }
      }
      
      // SECOND: If no recent analysis, get the most recent uploaded file
      // Try multiple buckets like reportProcessor does, but prioritize users-file-storage with credit-reports/ prefix
      console.log(`[ReportAgent] No recent analysis found, searching for uploaded files...`);
      const buckets = ['users-file-storage', 'credit-reports', 'uploads', 'documents'];
      let latestFile = null;
      let latestBucket = null;
      let latestTimestamp = 0;
      
      for (const bucket of buckets) {
        try {
          let listPath = userId;
          
          // For users-file-storage bucket, files are stored under credit-reports/userId/
          if (bucket === 'users-file-storage') {
            listPath = `credit-reports/${userId}`;
          }
          
          console.log(`[ReportAgent] Checking bucket: ${bucket}, path: ${listPath}`);
          
          const { data: files, error: filesError } = await supabase.storage
            .from(bucket)
            .list(listPath, { limit: 1, sortBy: { column: 'created_at', order: 'desc' } });
          
          if (!filesError && files && files.length > 0) {
            const file = files[0];
            const fileTimestamp = new Date(file.created_at).getTime();
            
            console.log(`[ReportAgent] Found file in ${bucket}: ${file.name}, timestamp: ${fileTimestamp}`);
            
            // Check if this is the most recent file across all buckets
            if (fileTimestamp > latestTimestamp) {
              latestFile = file;
              latestBucket = bucket;
              latestTimestamp = fileTimestamp;
              console.log(`[ReportAgent] This is now the latest file`);
            }
          } else {
            console.log(`[ReportAgent] No files found in ${bucket}/${listPath}, error: ${filesError?.message}`);
          }
        } catch (bucketError) {
          console.log(`[ReportAgent] Skipping bucket ${bucket}:`, bucketError.message);
        }
      }
      
      console.log(`[ReportAgent] Bucket search complete. latestFile: ${latestFile?.name || 'null'}, latestBucket: ${latestBucket || 'null'}`);
      
      if (latestFile) {
        // Construct the full file path based on bucket structure
        let filePath;
        if (latestBucket === 'users-file-storage') {
          filePath = `credit-reports/${userId}/${latestFile.name}`;
        } else {
          filePath = `${userId}/${latestFile.name}`;
        }
        
        // Process the document
        const { processCreditReport, extractText, downloadFromStorage } = require('../reportProcessor');
        
        // Try to download from the bucket where we found the file first
        let buffer;
        try {
          const { data, error } = await supabase.storage
            .from(latestBucket)
            .download(filePath);
          
          if (!error && data) {
            buffer = Buffer.from(await data.arrayBuffer());
          } else {
            // Fallback to downloadFromStorage which tries all buckets
            buffer = await downloadFromStorage(filePath);
          }
        } catch (downloadError) {
          console.log(`Direct download from ${latestBucket} failed, trying fallback:`, downloadError.message);
          buffer = await downloadFromStorage(filePath);
        }
        
        const extractedText = await extractText(buffer, latestFile.name);
        console.log(`[ReportAgent] Extracted text length: ${extractedText.length} characters`);
        
        // OPTIMIZED: Use text extraction but limit to reasonable size for API quota
        console.log(`[ReportAgent] Using optimized text-based analysis to avoid quota limits`);
        
        // Limit text to first 50,000 characters to stay within API limits
        const limitedText = extractedText.length > 50000 ? 
          extractedText.substring(0, 50000) + '\n\n[Text truncated for analysis...]' : 
          extractedText;
        
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        
        // Send limited text instead of full PDF to avoid quota issues
        const detailedAnalysis = await model.generateContent([
          `You are an expert credit report analyst. Analyze this credit report text and provide:

1. **HIGHLIGHTED VIOLATIONS** - Mark specific FCRA/FDCPA violations with 🚨
2. **OUTLINED ERRORS** - List errors and inaccuracies with ⚠️ 
3. **ACTIONABLE ITEMS** - Steps the consumer should take with ✅
4. **EVIDENCE QUOTES** - Exact text from the report with quotation marks

Focus on:
- Incorrect information
- Outdated negative items (older than 7 years)
- Identity theft indicators
- FCRA compliance issues
- Credit scoring factors

Be specific and reference exact content from the document. Keep your analysis comprehensive but concise.

CREDIT REPORT TEXT:
${limitedText}`
        ]);
        
        // Store analysis in database
        const analysisText = detailedAnalysis.response.text();
        const analysisResult = {
          summary: analysisText.substring(0, 200) + '...',
          detailed_analysis: analysisText,
          violations_found: analysisText.includes('🚨'),
          errors_found: analysisText.includes('⚠️'),
          file_name: latestFile.name,
          extracted_text: extractedText.substring(0, 1000) + '...'
        };
        
        await supabase.from('report_analyses').insert({
          user_id: userId,
          file_path: filePath,
          bucket: latestBucket,
          analysis: analysisResult,
          processed_at: new Date().toISOString()
        });
        
        return {
          messages: [new HumanMessage({ 
            content: `📄 **Analysis of ${latestFile.name}**\n\n${analysisText}\n\n---\n*Analysis saved to your account for future reference.*`, 
            name: 'ReportAgent' 
          })],
        };
      }
    } catch (error) {
      console.error('[ReportAgent] Auto-analysis error:', error);
    }
  }
  
  console.log(`[ReportAgent] Auto-analysis completed, no file processed. Moving to other checks...`);
  
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
  
  // Check if user wants to search their documents
  const searchMatch = message.match(/search (?:my |for )(.+?)(?: in (?:my )?documents?)?$/i);
  if (searchMatch && userId && supabase) {
    const searchQuery = searchMatch[1].trim();
    try {
      const { searchUserDocuments } = require('../documentSearch');
      const results = await searchUserDocuments(userId, searchQuery, 3);

      if (results.length === 0) {
        return {
          messages: [new HumanMessage({
            content: `🔍 **Document Search Results**\n\nNo documents found containing "${searchQuery}". Try uploading some documents first or rephrase your search.`,
            name: 'ReportAgent'
          })],
        };
      }

      const resultText = results.map((result, index) =>
        `${index + 1}. **${result.file_name}** (Relevance: ${(result.similarity * 100).toFixed(0)}%)\n   ${result.preview}`
      ).join('\n\n');

      return {
        messages: [new HumanMessage({
          content: `🔍 **Document Search Results for "${searchQuery}"**\n\n${resultText}\n\n---\n*Ask me to analyze any of these files for more details.*`,
          name: 'ReportAgent'
        })],
      };
    } catch (error) {
      return {
        messages: [new HumanMessage({
          content: `Error searching documents: ${error.message}`,
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
        .from('credit-reports') // Primary bucket for credit reports
        .list(userId, { limit: 10, sortBy: { column: 'created_at', order: 'desc' } });
      
      if (files && files.length > 0) {
        console.log(`[ReportAgent] Document listing: Found ${files.length} files in credit-reports bucket for user ${userId}`);
        files.forEach((file, idx) => {
          console.log(`[ReportAgent] File ${idx + 1}: ${file.name} (${file.created_at})`);
        });
        
        let response = `📁 **Your uploaded documents:**\n\n`;
        files.forEach((file, idx) => {
          response += `${idx + 1}. 📄 ${file.name} (${new Date(file.created_at).toLocaleDateString()})\n`;
        });
        response += `\n💡 Say "analyze my report" to automatically analyze your most recent upload, or "analyze file [filename]" for a specific file.`;
        
        return {
          messages: [new HumanMessage({ content: response, name: 'ReportAgent' })],
        };
      } else {
        console.log(`[ReportAgent] Document listing: No files found in credit-reports bucket for user ${userId}`);
        return {
          messages: [new HumanMessage({ 
            content: `� **Credit Report Analysis Ready**\n\nI can analyze your uploaded credit reports for FCRA/FDCPA violations, errors, and provide actionable dispute steps.\n\n**To get started:**\n1. Upload a credit report PDF using the upload button\n2. Ask me to "analyze my report" or "check for violations"\n3. I'll use advanced AI to identify issues and create dispute letters\n\n**What I can detect:**\n🚨 FCRA violations (wrong dates, missing info)\n⚠️ Data errors and inaccuracies\n✅ Actionable dispute strategies\n\nUpload a report and I'll analyze it!`, 
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
  
  // Fallback to text analysis for credit-related questions with file context
  try {
    // Get user's file context
    const { getUserFilesContext } = require('../api');
    const filesContext = userId ? await getUserFilesContext(userId) : 'No user ID provided.';
    
    const analysis = await callAI([
      new SystemMessage(`You are ConsumerAI, an expert credit report analyst with full document access capabilities. You CAN access and analyze uploaded credit reports using advanced AI (Mistral OCR + Google Gemini). When users ask about document access, confidently explain your capabilities and reference their specific files.
      
${filesContext}

Be specific about their files when responding. If they have files, mention them by name. If they don't, guide them to upload files.`),
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
  const USPSIntegration = require('../utils/uspsIntegration');
  
  try {
    const { FDCPA_TEMPLATE, FCRA_TEMPLATE } = require('./templates');
    const msg = message.toLowerCase();
    
    let response = "";
    
    // Determine letter type and provide specific guidance
    if (msg.includes('validation') || msg.includes('fdcpa') || msg.includes('debt')) {
      response = `📝 **FDCPA Debt Validation Letter**\n\n`;
      response += `Here's your validation request letter:\n\n`;
      response += `---\n\n`;
      
      // Generate personalized letter
      const letter = await callAI([
        new SystemMessage(`Generate a professional FDCPA debt validation letter. Use this template as a base but personalize it based on the user's situation: ${FDCPA_TEMPLATE}. 
        
        Make it firm but professional. Include all required validation elements. Format it properly for mailing.`),
        new HumanMessage(message)
      ]);
      
      response += letter.content;
      response += `\n\n---\n\n`;
      
      // Add mailing instructions
      const mailingAdvice = USPSIntegration.getMailingRecommendations('FDCPA_validation');
      response += `📮 **How to Send This Letter**:\n`;
      response += `• **Method**: ${mailingAdvice.mailType.toUpperCase()} with return receipt\n`;
      response += `• **Why**: ${mailingAdvice.advice}\n`;
      response += `• **Copies**: Make 3 copies - one for your records, one to send, one backup\n`;
      response += `• **Timeline**: Send within 30 days of first contact\n\n`;
      response += `⏰ **What Happens Next**:\n`;
      response += `• Debt collector must STOP collection until they validate\n`;
      response += `• They have 30 days to provide proper documentation\n`;
      response += `• If they can't validate, they must remove it from your credit\n`;
      response += `• Keep your certified mail receipt as proof!`;
    }
    
    else if (msg.includes('credit') || msg.includes('fcra') || msg.includes('bureau')) {
      response = `📊 **FCRA Credit Report Dispute Letter**\n\n`;
      response += `Here's your credit dispute letter:\n\n`;
      response += `---\n\n`;
      
      const letter = await callAI([
        new SystemMessage(`Generate a professional FCRA credit dispute letter. Use this template as a base: ${FCRA_TEMPLATE}. 
        
        Personalize it based on the specific credit report errors mentioned. Be specific about what's wrong and why. Include request for investigation and removal.`),
        new HumanMessage(message)
      ]);
      
      response += letter.content;
      response += `\n\n---\n\n`;
      
      const mailingAdvice = USPSIntegration.getMailingRecommendations('FCRA_dispute');
      response += `📮 **Sending Your Dispute**:\n`;
      response += `• **Best Method**: ${mailingAdvice.mailType.toUpperCase()} mail\n`;
      response += `• **Alternative**: Online dispute (but keep records!)\n`;
      response += `• **Include**: Copies of supporting documents (NEVER originals)\n`;
      response += `• **Send To**: All three credit bureaus if the error appears on multiple reports\n\n`;
      response += `📅 **Timeline**:\n`;
      response += `• Credit bureaus have 30 days to investigate\n`;
      response += `• They must provide results within 5 days of completion\n`;
      response += `• If they can't verify, they must delete the item`;
    }
    
    else if (msg.includes('cease') || msg.includes('stop') || msg.includes('harassment')) {
      response = `🛑 **Cease & Desist Letter**\n\n`;
      response += `Here's your cease and desist letter:\n\n`;
      response += `---\n\n`;
      
      const letter = await callAI([
        new SystemMessage(`Generate a firm but professional cease and desist letter under the FDCPA. The letter should:
        1. Reference FDCPA Section 805(c)
        2. Clearly state they must stop all communication
        3. Specify exceptions (legal notices only)
        4. Be dated and include account information if provided
        5. Be professional but firm in tone`),
        new HumanMessage(message)
      ]);
      
      response += letter.content;
      response += `\n\n---\n\n`;
      
      const mailingAdvice = USPSIntegration.getMailingRecommendations('cease_desist');
      response += `⚠️ **CRITICAL - How to Send**:\n`;
      response += `• **MUST use**: ${mailingAdvice.mailType.toUpperCase()} mail with return receipt\n`;
      response += `• **Why**: ${mailingAdvice.advice}\n`;
      response += `• **Keep**: The certified mail receipt as legal proof\n\n`;
      response += `🚨 **Important Warnings**:\n`;
      response += `• This doesn't make the debt disappear\n`;
      response += `• They can still sue you\n`;
      response += `• Any contact after this letter is an FDCPA violation\n`;
      response += `• Document any violations for potential lawsuit`;
    }
    
    else {
      // General letter assistance
      response = `📝 **Letter Writing Assistant**\n\n`;
      response += `I can help you create powerful dispute letters! What type do you need?\n\n`;
      response += `🛡️ **FDCPA Validation Letter**:\n`;
      response += `• Use when debt collectors first contact you\n`;
      response += `• Forces them to prove you owe the debt\n`;
      response += `• Stops collection during validation period\n\n`;
      response += `📊 **FCRA Credit Dispute Letter**:\n`;
      response += `• Use for errors on your credit report\n`;
      response += `• Forces credit bureaus to investigate\n`;
      response += `• Can remove negative items if unverifiable\n\n`;
      response += `🛑 **Cease & Desist Letter**:\n`;
      response += `• Use to stop harassment from collectors\n`;
      response += `• Legally stops most communication\n`;
      response += `• Must be sent certified mail to be effective\n\n`;
      response += `💡 **Just tell me**: \n`;
      response += `• What type of letter you need\n`;
      response += `• Your specific situation\n`;
      response += `• Any account details or errors to address\n\n`;
      response += `I'll create a personalized, legally sound letter for you!`;
    }
    
    return {
      messages: [new HumanMessage({ content: response, name: 'LetterAgent' })],
    };
  } catch (error) {
    return {
      messages: [new HumanMessage({ 
        content: `I'm having trouble generating letters right now, but here are the key templates you need:\n\n📝 **Quick Templates**:\n• FDCPA Validation: "I dispute this debt and request validation per 15 USC 1692g"\n• FCRA Dispute: "I dispute the following items on my credit report..."\n• Cease & Desist: "Per FDCPA 805(c), stop all communication except legal notices"\n\n📮 **Always send via CERTIFIED MAIL** for legal protection! What specific letter do you need help with?`, 
        name: 'LetterAgent' 
      })],
    };
  }
}

async function legalAgent(state) {
  const message = state.messages[state.messages.length - 1].content;
  const ConsumerLawDeadlines = require('../utils/consumerLawDeadlines');
  
  try {
    const msg = message.toLowerCase();
    let response = "";
    
    // Handle specific consumer law scenarios
    if (msg.includes('statute of limitations') || msg.includes('sol') || msg.includes('too old')) {
      response = `⚖️ **Statute of Limitations (SOL) - Your Shield Against Old Debts**\n\n`;
      response += `The SOL is like an expiration date on debts. Here's what you need to know:\n\n`;
      response += `📅 **Common SOL Periods**:\n`;
      response += `• Credit cards: 3-6 years (varies by state)\n`;
      response += `• Medical debt: 3-6 years\n`;
      response += `• Auto loans: 4-6 years\n`;
      response += `• Student loans: No SOL (federal)\n\n`;
      response += `🚨 **CRITICAL**: Don't make payments on old debts! This can restart the SOL clock.\n\n`;
      response += `💡 **If contacted about old debt**: Ask for validation and check the SOL. If expired, you have a strong defense.`;
      
      // If they mention a specific date, calculate SOL
      const dateMatch = message.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})|(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/);
      if (dateMatch) {
        const solInfo = ConsumerLawDeadlines.calculateSOL(dateMatch[0]);
        response += `\n\n📊 **Your SOL Calculation**:\n`;
        response += `• Original debt date: ${solInfo.originalDebtDate}\n`;
        response += `• SOL expires: ${solInfo.solExpirationDate}\n`;
        response += `• ${solInfo.advice}`;
      }
    }
    
    else if (msg.includes('fdcpa') || msg.includes('debt collector') || msg.includes('harassment')) {
      response = `🛡️ **FDCPA - Your Rights Against Debt Collectors**\n\n`;
      response += `The Fair Debt Collection Practices Act protects you from abusive collectors:\n\n`;
      response += `🚫 **They CANNOT**:\n`;
      response += `• Call before 8 AM or after 9 PM\n`;
      response += `• Call you at work if you tell them not to\n`;
      response += `• Use profanity or threats\n`;
      response += `• Contact family/friends about your debt\n`;
      response += `• Continue calling after you request validation\n\n`;
      response += `✅ **You CAN**:\n`;
      response += `• Request debt validation (within 30 days)\n`;
      response += `• Tell them to stop calling (cease & desist)\n`;
      response += `• Sue for violations ($1,000 + attorney fees)\n\n`;
      response += `📝 **Action Steps**:\n`;
      response += `1. Send validation request via certified mail\n`;
      response += `2. Document all violations (dates, times, what was said)\n`;
      response += `3. Keep records of all communications`;
    }
    
    else if (msg.includes('fcra') || msg.includes('credit report') || msg.includes('credit bureau')) {
      response = `📊 **FCRA - Your Credit Report Rights**\n\n`;
      response += `The Fair Credit Reporting Act gives you powerful rights:\n\n`;
      response += `🔍 **Free Credit Reports**:\n`;
      response += `• One free report per year from each bureau\n`;
      response += `• Additional free reports after disputes\n`;
      response += `• Get them at annualcreditreport.com (official site)\n\n`;
      response += `⚡ **Dispute Process**:\n`;
      response += `• Credit bureaus have 30 days to investigate\n`;
      response += `• Must provide results within 5 days of completion\n`;
      response += `• If they can't verify, they must delete it\n\n`;
      response += `💰 **Violations Can Pay**:\n`;
      response += `• Actual damages + attorney fees\n`;
      response += `• Statutory damages up to $1,000\n`;
      response += `• Punitive damages for willful violations\n\n`;
      response += `🎯 **Pro Tips**:\n`;
      response += `• Dispute online AND by certified mail\n`;
      response += `• Include supporting documentation\n`;
      response += `• Follow up if no response in 30 days`;
    }
    
    else if (msg.includes('validation') || msg.includes('prove') || msg.includes('verify')) {
      response = `📋 **Debt Validation - Make Them Prove It**\n\n`;
      response += `Debt validation is your first line of defense:\n\n`;
      response += `📝 **What to Request**:\n`;
      response += `• Original signed contract/agreement\n`;
      response += `• Complete payment history\n`;
      response += `• Proof they own the debt\n`;
      response += `• License to collect in your state\n`;
      response += `• Calculation of current balance\n\n`;
      response += `⏰ **Timeline**:\n`;
      response += `• You have 30 days from first contact\n`;
      response += `• They must stop collection during validation\n`;
      response += `• Send your request via certified mail\n\n`;
      response += `🎯 **What Usually Happens**:\n`;
      response += `• Many collectors can't provide proper validation\n`;
      response += `• They often just send a computer printout (not enough!)\n`;
      response += `• If they can't validate, they must stop collection`;
    }
    
    else if (msg.includes('cease') || msg.includes('stop calling') || msg.includes('harassment')) {
      response = `🛑 **Cease & Desist - Stop the Calls**\n\n`;
      response += `You have the right to tell debt collectors to stop contacting you:\n\n`;
      response += `📧 **How to Do It**:\n`;
      response += `• Send a written cease & desist letter\n`;
      response += `• Use certified mail with return receipt\n`;
      response += `• Keep copies of everything\n\n`;
      response += `⚖️ **Legal Effect**:\n`;
      response += `• They can only contact you to confirm they'll stop\n`;
      response += `• Or to notify you of specific legal action\n`;
      response += `• Any other contact is an FDCPA violation\n\n`;
      response += `💡 **Important Note**:\n`;
      response += `• This doesn't make the debt go away\n`;
      response += `• They can still sue you\n`;
      response += `• But they must stop the phone harassment\n\n`;
      response += `🎯 **Strategy**: Use this when collectors are abusive or you need time to plan your response.`;
    }
    
    else {
      // Fallback to enhanced legal search with conversational response
      const legalInfo = await enhancedLegalSearch(message);
      const aiResponse = await callAI([
        new SystemMessage(`You are a friendly consumer law expert. Use this legal context: ${legalInfo}. 
        
        Provide practical, actionable advice in a conversational tone. Use emojis and formatting to make it engaging. 
        Focus on what the user can actually DO, not just legal theory. Include specific steps and deadlines when relevant.`),
        new HumanMessage(message)
      ]);
      response = aiResponse.content;
    }
    
    // Add helpful footer
    if (!response.includes('💡 Need help with')) {
      response += `\n\n💡 **Need help with specific deadlines or next steps?** Just ask! I can calculate exact dates and help you plan your strategy.`;
    }
    
    return {
      messages: [new HumanMessage({ content: response, name: 'LegalAgent' })],
    };
  } catch (error) {
    return {
      messages: [new HumanMessage({ 
        content: `I'm having trouble accessing legal databases right now, but I can still help! Consumer law basics: \n\n• FDCPA protects against debt collector abuse\n• FCRA gives you credit report rights\n• Always request validation within 30 days\n• Send important letters via certified mail\n\nWhat specific situation are you dealing with? I can provide targeted advice! 💪`, 
        name: 'LegalAgent' 
      })],
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
  const ConsumerLawDeadlines = require('../utils/consumerLawDeadlines');

  try {
    const msg = message.toLowerCase();

    // Handle questions about mailing dispute letters
    if (msg.includes('should i send') || msg.includes('how to send') || msg.includes('certified mail') ||
        msg.includes('mail letter') || msg.includes('send dispute')) {

      let response = `📬 **Dispute Letter Mailing Guide**\n\n`;
      response += `For maximum legal protection, always send dispute letters via **Certified Mail with Return Receipt**:\n\n`;
      response += `✅ **Required for FCRA Disputes** (15 U.S.C. § 1681i)\n`;
      response += `✅ **Required for FDCPA Validation** (15 U.S.C. § 1692g)\n\n`;
      response += `**Why Certified Mail?**\n`;
      response += `• Provides proof of mailing date\n`;
      response += `• Proves delivery (green card returned)\n`;
      response += `• Required for legal disputes\n`;
      response += `• Courts accept as evidence\n\n`;
      response += `**Timeline Tracking**: Once you mail your letter, I can help you calculate all legal deadlines and response times.`;

      return {
        messages: [new HumanMessage({ content: response, name: 'TrackingAgent' })],
      };
    }

    // Handle timeline calculations based on user input
    if (msg.includes('mailed') || msg.includes('sent') || msg.includes('when did') ||
        msg.includes('timeline') || msg.includes('deadline') || msg.includes('days left')) {

      // Try to extract dates from the message
      const dateMatch = message.match(/(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}|\d{2,4}[-\/]\d{1,2}[-\/]\d{1,2})/);
      const today = new Date();

      if (dateMatch) {
        const mailingDate = new Date(dateMatch[0]);
        if (!isNaN(mailingDate.getTime())) {
          let response = `📅 **Legal Timeline Calculation**\n\n`;
          response += `Based on your mailing date: **${mailingDate.toLocaleDateString()}**\n\n`;

          // Determine if it's FCRA or FDCPA based on context
          if (msg.includes('credit') || msg.includes('fcra') || msg.includes('bureau') ||
              msg.includes('equifax') || msg.includes('experian') || msg.includes('transunion')) {

            const deadlines = ConsumerLawDeadlines.calculateFCRADeadlines(mailingDate.toISOString().split('T')[0], 'certified');
            response += `⚖️ **FCRA Credit Dispute Deadlines**:\n\n`;
            response += `📅 **Day 1**: Letter mailed (${mailingDate.toLocaleDateString()})\n`;
            response += `📅 **Day 5**: Acknowledgment required (${deadlines.acknowledgmentDeadline})\n`;
            response += `📅 **Day 30**: Investigation completed (${deadlines.investigationDeadline})\n`;
            response += `📅 **Day 45**: Results provided (${deadlines.resultsDeadline})\n\n`;

            // Calculate days remaining
            const daysSinceMailing = Math.floor((today - mailingDate) / (1000 * 60 * 60 * 24));
            const daysToInvestigation = 30 - daysSinceMailing;
            const daysToResults = 45 - daysSinceMailing;

            response += `⏰ **Time Remaining**:\n`;
            if (daysToInvestigation > 0) {
              response += `• Investigation deadline: **${daysToInvestigation} days left**\n`;
            } else {
              response += `• Investigation: **OVERDUE** (${Math.abs(daysToInvestigation)} days past deadline)\n`;
            }
            if (daysToResults > 0) {
              response += `• Results deadline: **${daysToResults} days left**\n`;
            } else {
              response += `• Results: **OVERDUE** (${Math.abs(daysToResults)} days past deadline)\n`;
            }

          } else if (msg.includes('debt') || msg.includes('fdpca') || msg.includes('collection') ||
                     msg.includes('collector') || msg.includes('validation')) {

            const deadlines = ConsumerLawDeadlines.calculateFDCPADeadlines(mailingDate.toISOString().split('T')[0], true);
            response += `⚖️ **FDCPA Debt Collection Deadlines**:\n\n`;
            response += `📅 **Day 1**: Validation request mailed (${mailingDate.toLocaleDateString()})\n`;
            response += `📅 **Day 5**: Acknowledgment required (${deadlines.acknowledgmentDate})\n`;
            response += `📅 **Day 30**: Validation provided (${deadlines.validationDeadline})\n\n`;

            // Calculate days remaining
            const daysSinceMailing = Math.floor((today - mailingDate) / (1000 * 60 * 60 * 24));
            const daysToValidation = 30 - daysSinceMailing;

            response += `⏰ **Time Remaining**:\n`;
            if (daysToValidation > 0) {
              response += `• Validation deadline: **${daysToValidation} days left**\n`;
            } else {
              response += `• Validation: **OVERDUE** (${Math.abs(daysToValidation)} days past deadline)\n`;
            }

            response += `🚫 **Collection Activity**: Must cease within 5 days if validation not provided\n`;
          }

          response += `\n💡 **Important Notes**:\n`;
          response += `• Keep your certified mail receipt and green return card\n`;
          response += `• Document all communications and dates\n`;
          response += `• If deadlines are missed, you may have additional legal remedies\n`;
          response += `• Always follow up if no response received`;

          return {
            messages: [new HumanMessage({ content: response, name: 'TrackingAgent' })],
          };
        }
      }

      // No date found, ask for mailing information
      let response = `📅 **Dispute Timeline Tracking**\n\n`;
      response += `To calculate your legal deadlines, I need to know:\n\n`;
      response += `1. **When did you mail your dispute letter?** (provide the date)\n`;
      response += `2. **Was it sent certified mail?** (required for legal disputes)\n`;
      response += `3. **What type of dispute?** (credit report or debt collection)\n\n`;
      response += `Example: "I mailed my credit dispute letter on 12/10/2025 via certified mail"\n\n`;
      response += `Once you provide this information, I'll calculate all the legal response times and tell you how much time you have left.`;

      return {
        messages: [new HumanMessage({ content: response, name: 'TrackingAgent' })],
      };
    }

    // Default response for general tracking questions
    let response = `📬 **Consumer Law Mail & Timeline Guidance**\n\n`;
    response += `I help you understand the legal requirements and timelines for consumer disputes:\n\n`;
    response += `**FCRA Credit Disputes**:\n`;
    response += `• Mail via Certified Mail (required)\n`;
    response += `• 5 days: Acknowledgment\n`;
    response += `• 30 days: Investigation completed\n`;
    response += `• 45 days: Results provided\n\n`;
    response += `**FDCPA Debt Collection**:\n`;
    response += `• Mail validation request via Certified Mail\n`;
    response += `• 5 days: Collection activity must stop\n`;
    response += `• 30 days: Validation provided\n\n`;
    response += `Tell me when you mailed your letter and what type of dispute, and I'll calculate your specific deadlines and time remaining.`;

    return {
      messages: [new HumanMessage({ content: response, name: 'TrackingAgent' })],
    };

  } catch (error) {
    console.error('[TrackingAgent] Error:', error);
    return {
      messages: [new HumanMessage({
        content: `I encountered an error calculating timelines. Please provide your mailing date and dispute type, and I'll help you understand the legal deadlines.`,
        name: 'TrackingAgent'
      })],
    };
  }
}
      let disputeType = 'FDCPA_validation';
      if (msg.includes('credit') || msg.includes('fcra')) disputeType = 'FCRA_dispute';
      if (msg.includes('cease') || msg.includes('stop')) disputeType = 'cease_desist';
      
      const recommendations = USPSIntegration.getMailingRecommendations(disputeType);
      const timeframes = USPSIntegration.estimateDeliveryTimeframes(recommendations.mailType);
      
      let response = `📮 **Mailing Strategy for Your Dispute**\n\n`;
      response += `**Recommended Method**: ${recommendations.mailType.toUpperCase()} with return receipt\n`;
      response += `**Why**: ${recommendations.advice}\n\n`;
      response += `⏰ **Estimated Delivery**: ${timeframes.estimatedDelivery.earliest} to ${timeframes.estimatedDelivery.latest}\n`;
      response += `${timeframes.legalAdvice}\n\n`;
      response += `📋 **Important**: ${recommendations.template}`;
      
      return {
        messages: [new HumanMessage({ content: response, name: 'TrackingAgent' })],
      };
    }
    
    // Handle deadline calculations without tracking numbers
    if (msg.includes('deadline') || msg.includes('when') || msg.includes('how long')) {
      let response = `⏰ **Consumer Law Deadlines**\n\n`;
      
      if (msg.includes('fdcpa') || msg.includes('debt')) {
        response += `**FDCPA Validation Requests**:\n`;
        response += `• You have **30 days** from first contact to request validation\n`;
        response += `• Debt collector must **stop collection** during validation period\n`;
        response += `• Send via **certified mail** for proof of delivery\n\n`;
        response += `💡 **Pro Tip**: The 30-day clock starts when you RECEIVE their notice, not when they send it.`;
      } else if (msg.includes('fcra') || msg.includes('credit')) {
        response += `**FCRA Credit Disputes**:\n`;
        response += `• Credit bureaus have **30 days** to investigate\n`;
        response += `• Extended to **45 days** if you provide additional info\n`;
        response += `• Must provide results within **5 days** of completion\n\n`;
        response += `💡 **Pro Tip**: Online disputes are valid, but certified mail provides better documentation.`;
      } else {
        response += `I can help you calculate specific deadlines! Tell me:\n`;
        response += `• Is this for FDCPA (debt collection) or FCRA (credit report)?\n`;
        response += `• When did you receive their notice or when do you plan to send your dispute?\n`;
        response += `• Did you send it certified mail?`;
      }
      
      return {
        messages: [new HumanMessage({ content: response, name: 'TrackingAgent' })],
      };
    }
    
    // Default helpful response
    const content = `📬 **I'm your mail tracking and deadline assistant!**\n\n` +
      `I can help you with:\n` +
      `• 📦 **Track certified mail** - Just give me your tracking number\n` +
      `• ⏰ **Calculate legal deadlines** - For FDCPA and FCRA disputes\n` +
      `• 📮 **Mailing advice** - Best practices for legal documents\n` +
      `• 🎯 **Strategy tips** - When and how to send dispute letters\n\n` +
      `**What would you like help with?** Try saying:\n` +
      `• "Track my certified mail [tracking number]"\n` +
      `• "When is my FDCPA deadline?"\n` +
      `• "Should I send this certified mail?"\n` +
      `• "How long do credit bureaus have to respond?"`;
    
    return {
      messages: [new HumanMessage({ content, name: 'TrackingAgent' })],
    };
  } catch (error) {
    console.error('Tracking agent error:', error);
    return {
      messages: [new HumanMessage({
        content: `I'm having trouble right now, but I can still help! Visit https://tools.usps.com for tracking, and remember: certified mail is your best friend for legal disputes. Keep those receipts! 📋`,
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

module.exports = { graph, AgentState, reportAgent };