const { StateGraph, Annotation, END, START } = require('@langchain/langgraph');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { z } = require('zod');

// Import dependencies
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { chatWithFallback } = require('../aiUtils');

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

// AI call using unified fallback (Mistral/HF/MuleRouter then Google)
async function callAI(messages) {
  try {
    console.log('[Supervisor] callAI called, using unified fallback');
    await delay(100); // Minimal delay for rate limiting
    console.log('[Supervisor] Calling chatWithFallback...');

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('AI timeout')), 30000));
    const responseObj = await Promise.race([chatWithFallback(messages), timeoutPromise]);

    // chatWithFallback returns { response, model }
    if (responseObj && responseObj.response) {
      console.log('[Supervisor] AI call successful with model:', responseObj.model);
      return responseObj.response;
    }

    console.warn('[Supervisor] chatWithFallback returned unexpected result:', responseObj);
    return { content: 'AI service returned unexpected response format.' };
  } catch (error) {
    console.error('[Supervisor] AI request failed:', error.message);
    return { content: `AI service unavailable: ${error.message}` };
  }
}

// Simple delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Format analysis as HTML for frontend display
function formatAnalysisAsHTML(analysis) {
  if (!analysis) return 'No analysis available';
  
  const escapeHtml = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  let html = `<div class="credit-analysis">`;
  
  // Executive Summary
  html += `<div class="executive-summary">`;
  html += `<h2>Executive Summary</h2>`;
  html += `<p>${escapeHtml(analysis.summary || 'Analysis completed')}</p>`;
  html += `</div>`;
  
  // Personal Information Issues
  if (analysis.personal_info_issues?.length > 0 || analysis.personalinfoanalysis?.identityissues?.length > 0) {
    const issues = analysis.personal_info_issues || analysis.personalinfoanalysis?.identityissues || [];
    html += `<div class="personal-issues">`;
    html += `<h2>Personal Information Issues</h2>`;
    issues.forEach(issue => {
      const severity = issue.severity || 'medium';
      html += `<div class="issue-item ${severity}">`;
      html += `<h3>${escapeHtml(issue.type || 'Issue')} <span class="severity ${severity}">${severity.toUpperCase()}</span></h3>`;
      html += `<p><strong>Issue:</strong> ${escapeHtml(issue.description || '')}</p>`;
      if (issue.evidence) html += `<p class="evidence"><strong>Evidence:</strong> ${escapeHtml(issue.evidence)}</p>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  
  // Account Issues
  if (analysis.account_issues?.length > 0 || analysis.regularaccounts?.length > 0) {
    const accounts = analysis.account_issues || analysis.regularaccounts || [];
    html += `<div class="account-issues">`;
    html += `<h2>Account Issues (${accounts.length})</h2>`;
    accounts.slice(0, 10).forEach(account => {
      const severity = account.severity || 'medium';
      html += `<div class="account-item">`;
      html += `<h3>${escapeHtml(account.account_name || account.accountname || 'Unknown Account')}</h3>`;
      html += `<p><strong>Account #:</strong> ${escapeHtml(account.account_number || account.accountnumber || 'Not specified')}</p>`;
      html += `<p><strong>Status:</strong> ${escapeHtml(account.status || 'Unknown')} <span class="severity ${severity}">${severity.toUpperCase()}</span></p>`;
      html += `<p><strong>Issue:</strong> ${escapeHtml(account.issue_type || account.issuetype || account.description || '')}</p>`;
      if (account.evidence) html += `<p class="evidence">${escapeHtml(account.evidence)}</p>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  
  // Collection Accounts
  if (analysis.collection_accounts?.length > 0 || analysis.collectionaccountsanalysis?.collectionaccounts?.length > 0) {
    const collections = analysis.collection_accounts || analysis.collectionaccountsanalysis?.collectionaccounts || [];
    html += `<div class="collection-accounts">`;
    html += `<h2>Collection Accounts</h2>`;
    collections.slice(0, 5).forEach(account => {
      html += `<div class="collection-item">`;
      html += `<h3>${escapeHtml(account.collection_agency || account.collectionagency || 'Unknown Agency')}</h3>`;
      html += `<p><strong>Original Creditor:</strong> ${escapeHtml(account.original_creditor || account.originalcreditor || 'Not specified')}</p>`;
      html += `<p><strong>Balance:</strong> ${escapeHtml(account.current_balance || account.currentbalance || 'Not specified')}</p>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  
  // FCRA Violations
  if (analysis.fcra_violations?.length > 0 || analysis.fcraviolations?.length > 0) {
    const violations = analysis.fcra_violations || analysis.fcraviolations || [];
    html += `<div class="fcra-violations">`;
    html += `<h2>FCRA Violations (${violations.length})</h2>`;
    violations.slice(0, 5).forEach(violation => {
      const severity = violation.severity || 'medium';
      html += `<div class="violation-item ${severity}">`;
      html += `<h3>${escapeHtml(violation.violation_type || violation.violationtype || 'Violation')} <span class="severity ${severity}">${severity.toUpperCase()}</span></h3>`;
      html += `<p><strong>Description:</strong> ${escapeHtml(violation.description || '')}</p>`;
      if (violation.evidence) html += `<p class="evidence"><strong>Evidence:</strong> ${escapeHtml(violation.evidence)}</p>`;
      html += `<p><strong>Strategy:</strong> ${escapeHtml(violation.dispute_strategy || violation.disputestrategy || '')}</p>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  
  // Overall Assessment
  const overall = analysis.overall_assessment || analysis.overallassessment || {};
  html += `<div class="overall-assessment">`;
  html += `<h2>Overall Assessment</h2>`;
  html += `<div class="assessment-grid">`;
  html += `<div class="metric"><strong>Risk Level:</strong> ${escapeHtml(overall.overall_risk_level || overall.overallrisklevel || 'unknown')}</div>`;
  html += `<div class="metric"><strong>Credit Impact:</strong> ${escapeHtml(overall.credit_score_impact || overall.creditscoreimpact || 'unknown')}</div>`;
  html += `<div class="metric"><strong>Accounts Affected:</strong> ${overall.total_accounts_affected || overall.totalaccountsaffected || 0}</div>`;
  html += `</div>`;
  
  if (overall.priority_actions?.length > 0 || overall.priorityactions?.length > 0) {
    const actions = overall.priority_actions || overall.priorityactions || [];
    html += `<h3>Priority Actions:</h3><ul>`;
    actions.slice(0, 5).forEach(action => {
      html += `<li>${escapeHtml(action)}</li>`;
    });
    html += `</ul>`;
  }
  html += `</div>`;
  
  // Suggested Dispute Letters
  if (analysis.dispute_letters_needed?.length > 0 || analysis.disputelettersneeded?.length > 0) {
    const letters = analysis.dispute_letters_needed || analysis.disputelettersneeded || [];
    html += `<div class="dispute-letters">`;
    html += `<h2>Suggested Dispute Letters</h2>`;
    letters.slice(0, 5).forEach(letter => {
      html += `<div class="letter-item">`;
      html += `<h3>${escapeHtml(letter.type || 'Letter')} • Target: ${escapeHtml(letter.target || 'Unknown')}</h3>`;
      if (letter.accounts_involved?.length > 0 || letter.accountsinvolved?.length > 0) {
        const accounts = letter.accounts_involved || letter.accountsinvolved || [];
        html += `<p><strong>Accounts:</strong> ${accounts.map(escapeHtml).join(', ')}</p>`;
      }
      if (letter.evidence_needed?.length > 0 || letter.evidenceneeded?.length > 0) {
        const evidence = letter.evidence_needed || letter.evidenceneeded || [];
        html += `<p><strong>Evidence Required:</strong> ${evidence.map(escapeHtml).join(', ')}</p>`;
      }
      html += `<p><strong>Timeline:</strong> ${escapeHtml(letter.timeline || 'Within 30 days')}</p>`;
      html += `</div>`;
    });
    html += `</div>`;
  }
  
  html += `</div>`;
  return html;
}

// Define agents
const members = ['search', 'report', 'letter', 'legal', 'email', 'calendar'];

// Supervisor prompt focused on consumer law (FCRA & FDCPA)
const systemPrompt = `CONSUMERAI SUPERVISOR - Consumer law specialist

You coordinate a small set of agents focused on consumer credit law (FCRA & FDCPA).

Agent capabilities and context:
- ` + "state.supabase" + `: Supabase client for DB access
- ` + "state.userId" + `: Authenticated user's UUID
- Utilities available: require('../utils/consumerLawDeadlines') for deadline calculations

Routing summary:
- 'report' for document/report analysis and uploaded files
- 'letter' for dispute/validation/cease & desist letters
- 'legal' for statutes, deadlines, mailed timelines, SOL, and legal rights
- 'search' for general research

When asked about mailing dates or timelines, calculate exact deadlines using the consumerLawDeadlines utility and provide concise next steps. Keep responses factual, cite dates, and avoid unnecessary legalese.`;



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
    // High priority for document analysis - ONLY for specific analysis requests
    if ((message.includes('analyze my') || message.includes('review my') || message.includes('my report')) ||
        (message.includes('analyze') && (message.includes('report') || message.includes('document') || message.includes('uploaded'))) ||
        (message.includes('review') && (message.includes('report') || message.includes('document') || message.includes('uploaded')))) {
      console.log('[Supervisor] Routing to report agent');
      return { next: 'report' };
    }

    // General questions about credit reports should go to legal agent
    if (message.includes('credit report') || message.includes('errors') || message.includes('violations') ||
        message.includes('fcra') || message.includes('fdcpa') || message.includes('dispute')) {
      console.log('[Supervisor] Routing to legal for general credit question');
      return { next: 'legal' };
    }

    // Timeline/mailing questions should be handled by `legal`
    if (message.includes('mailed') || message.includes('sent') || message.includes('certified mail') ||
        message.includes('timeline') || message.includes('deadline') || message.includes('days left') || message.includes('when did')) {
      console.log('[Supervisor] Routing to legal for timeline/mailing question');
      return { next: 'legal' };
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
    
    // Fallback to AI routing using centralized fallback
    try {
      const { chatWithFallback } = require('../aiUtils');
      const routingMessages = [
        new SystemMessage(systemPrompt),
        ...state.messages,
        new HumanMessage(`Who should act next? Select one of: ${members.join(', ')}`)
      ];
      const { response } = await chatWithFallback(routingMessages);
      const content = response && (response.content || response) ? String(response.content || response).toLowerCase() : '';
      for (const member of members) {
        if (content.includes(member)) return { next: member };
      }
    } catch (error) {
      console.error('AI routing failed:', error);
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

        // If we have a completed analysis and it's recent, return it immediately
        if (latestAnalysis.analysis && latestAnalysis.analysis.summary) {
          const analysisAge = Date.now() - new Date(latestAnalysis.processed_at).getTime();
          const isRecent = analysisAge < (60 * 60 * 1000); // 1 hour

          console.log(`[ReportAgent] Found existing analysis, age: ${analysisAge}ms, isRecent: ${isRecent}`);

          if (isRecent) {
            console.log(`[ReportAgent] Returning cached analysis`);
            // If we have an OCR artifact id, fetch a small evidence snippet
            let evidenceNote = '';
            if (latestAnalysis.ocr_artifact_id && state.supabase) {
              try {
                const { data: ocrRows } = await state.supabase.from('ocr_artifacts').select('ocr_pages').eq('id', latestAnalysis.ocr_artifact_id).limit(1);
                if (ocrRows && ocrRows.length > 0 && ocrRows[0].ocr_pages && ocrRows[0].ocr_pages.length > 0) {
                  const firstPage = ocrRows[0].ocr_pages[0];
                  const snippet = (firstPage && (firstPage.text || firstPage.markdown)) ? ((firstPage.text || firstPage.markdown).substring(0, 400)) : null;
                  if (snippet) evidenceNote = `\n\n**Evidence (excerpt):**\n${snippet}...`;
                }
              } catch (e) {
                console.warn('[ReportAgent] Failed to fetch OCR evidence:', e.message || e);
              }
            }

            return {
              messages: [new HumanMessage({ 
                content: `📄 **Recent Analysis Available**\n\n${latestAnalysis.analysis.detailed_analysis || latestAnalysis.analysis.summary}${evidenceNote}\n\n---\n*Using cached analysis from ${new Date(latestAnalysis.processed_at).toLocaleString()}*`, 
                name: 'ReportAgent' 
              })],
            };
          }
        }

        // If there is a database entry but no completed analysis yet, try to process that exact file first
        if (!latestAnalysis.analysis) {
          console.log(`[ReportAgent] Found DB entry with pending analysis for file: ${latestAnalysis.file_name || latestAnalysis.file_path}. Attempting to process it now.`);
          try {
            let candidatePath = latestAnalysis.file_path || latestAnalysis.file_name;

            // If file_path isn't fully qualified, attempt to construct likely paths
            if (candidatePath && !candidatePath.includes('/') && candidatePath.endsWith('.pdf')) {
              // Try 'credit-reports/<userId>/<file_name>' then '<userId>/<file_name>'
              const tryPaths = [`credit-reports/${userId}/${candidatePath}`, `${userId}/${candidatePath}`, candidatePath];
              for (const p of tryPaths) {
                try {
                  const { data, error } = await supabase.storage.from('users-file-storage').download(p);
                  if (!error && data) {
                    // Found the file in users-file-storage at this path
                    const { processCreditReport } = require('../reportProcessor');
                    const result = await processCreditReport(p);
                    if (!result.error) {
                      const analysis = result.analysis;
                      console.log(`[ReportAgent] DB-pending file processed successfully: ${p}`);
                      return {
                        messages: [new HumanMessage({ content: formatAnalysisAsHTML(analysis), name: 'ReportAgent' })],
                      };
                    }
                  }
                } catch (e) {
                  // Ignore and try next path
                }
              }
            } else if (candidatePath) {
              // If candidatePath already looks like a path, attempt direct processing
              const { processCreditReport } = require('../reportProcessor');
              const result = await processCreditReport(candidatePath);
              if (!result.error) {
                const analysis = result.analysis;
                console.log(`[ReportAgent] DB-pending file processed successfully: ${candidatePath}`);
                return {
                  messages: [new HumanMessage({ content: formatAnalysisAsHTML(analysis), name: 'ReportAgent' })],
                };
              }
            }
          } catch (dbProcessError) {
            console.error(`[ReportAgent] Failed to process DB-pending file:`, dbProcessError.message || dbProcessError);
          }

          console.log(`[ReportAgent] Found file but no analysis - will continue searching storage and attempt processing`);
        }
      }
      
      // SECOND: If no recent analysis, get the most recent uploaded file
      // Search all buckets and all possible paths for this user
      console.log(`[ReportAgent] No recent analysis found, searching for uploaded files...`);
      const buckets = ['users-file-storage', 'credit-reports', 'uploads', 'documents'];
      let latestFile = null;
      let latestBucket = null;
      let latestTimestamp = 0;
      let latestFilePath = null;
      
      for (const bucket of buckets) {
        try {
          console.log(`[ReportAgent] Checking bucket: ${bucket}`);
          
          // Try multiple possible paths for this user
          const possiblePaths = [
            userId,
            `credit-reports/${userId}`,
            `uploads/${userId}`,
            `documents/${userId}`,
            '', // root level
            `credit-reports`,
            `uploads`,
            `documents`
          ];
          
          for (const listPath of possiblePaths) {
            try {
              console.log(`[ReportAgent] Trying path: ${listPath}`);
              
              const { data: files, error: filesError } = await supabase.storage
                .from(bucket)
                .list(listPath, { limit: 10, sortBy: { column: 'created_at', order: 'desc' } });
              
              if (!filesError && files && files.length > 0) {
                console.log(`[ReportAgent] Found ${files.length} files in ${bucket}/${listPath}`);
                
                for (const file of files) {
                  // Check if this file belongs to this user (by filename or metadata)
                  const fileName = file.name.toLowerCase();
                  const belongsToUser = fileName.includes(userId) || 
                                       fileName.includes(userId.substring(0, 8)) ||
                                       listPath.includes(userId);
                  
                  if (belongsToUser) {
                    const fileTimestamp = new Date(file.created_at).getTime();
                    
                    console.log(`[ReportAgent] Found user file: ${file.name}, timestamp: ${fileTimestamp}`);
                    
                    // Check if this is the most recent file
                    if (fileTimestamp > latestTimestamp) {
                      latestFile = file;
                      latestBucket = bucket;
                      latestTimestamp = fileTimestamp;
                      latestFilePath = listPath ? `${listPath}/${file.name}` : file.name;
                      console.log(`[ReportAgent] This is now the latest file: ${latestFilePath}`);
                    }
                  }
                }
              }
            } catch (pathError) {
              console.log(`[ReportAgent] Path ${listPath} failed:`, pathError.message);
            }
          }
        } catch (bucketError) {
          console.log(`[ReportAgent] Skipping bucket ${bucket}:`, bucketError.message);
        }
      }
      
      console.log(`[ReportAgent] Search complete. Latest file: ${latestFile?.name || 'none'}, bucket: ${latestBucket}, path: ${latestFilePath}`);
      
      if (latestFile) {
        // Use the file path we already determined
        const filePath = latestFilePath;
        
        console.log(`[ReportAgent] Processing file: ${latestBucket}/${filePath}`);
        
        // Process the document using the centralized processor
        const { processCreditReport } = require('../reportProcessor');
        
        const result = await processCreditReport(filePath);
        
        if (result.error) {
          throw new Error(`Processing failed: ${result.error}`);
        }
        
        const analysis = result.analysis;
        console.log(`[ReportAgent] Analysis completed using model: ${analysis.meta?.model || 'unknown'}`);
        
        // Return the full analysis immediately
        const response = {
          messages: [new HumanMessage({ 
            content: formatAnalysisAsHTML(analysis), 
            name: 'ReportAgent' 
          })],
        };
        
        // Save analysis to database asynchronously (don't block return)
        (async () => {
          try {
            await supabase.from('report_analyses').insert({
              user_id: userId,
              file_path: filePath,
              bucket: latestBucket,
              ocr_artifact_id: result.ocr_artifact_id || null,
              analysis: {
                summary: analysis.summary?.headline || analysis.summary || 'Analysis completed',
                detailed_analysis: JSON.stringify(analysis),
                violations_found: (analysis.violations?.length || 0) > 0,
                errors_found: (analysis.errors?.length || 0) > 0,
                file_name: latestFile.name,
                extracted_text: result.extractedText?.substring(0, 1000) + '...' || ''
              },
              processed_at: new Date().toISOString()
            });
          } catch (saveError) {
            console.error('[ReportAgent] Failed to save analysis:', saveError);
          }
        })();
        
        return response;
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
        messages: [new HumanMessage({ content: formatAnalysisAsHTML(result.analysis, null, 2), name: 'ReportAgent' })],
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
  
  // Fallback to text analysis for credit-related questions
  try {
    // Only get file context if user is asking about their files specifically
    let filesContext = '';
    if (msg.includes('my') && (msg.includes('file') || msg.includes('report') || msg.includes('document'))) {
      const { getUserFilesContext } = require('../api');
      filesContext = userId ? await getUserFilesContext(userId) : 'No user ID provided.';
      console.log('[ReportAgent] User files context:', filesContext);
    }
    
    const systemPrompt = filesContext ? 
      `=== CREDIT REPORT ANALYST SYSTEM ===

You are ConsumerAI's credit report specialist.

=== CURRENT USER FILES ===
${filesContext}

=== RESPONSE PROTOCOL ===
When user asks about their reports: Reference the files above and offer to analyze them.
When user asks general questions: Provide helpful information about credit law and your capabilities.

=== YOUR CAPABILITIES ===
• Analyze credit reports for FCRA/FDCPA violations
• Detect errors, outdated items, identity theft
• Provide actionable dispute steps
• Generate dispute letters

Be helpful and specific about what you can do.` :
      `You are ConsumerAI, a professional legal assistant specializing in consumer rights and credit law.

Your capabilities:
• Analyze credit reports for FCRA/FDCPA violations
• Detect errors, outdated items, identity theft
• Generate dispute letters
• Calculate legal deadlines
• Provide actionable legal advice

Be professional, helpful, and focus on actionable information.`;

    const analysis = await callAI([
      new SystemMessage(systemPrompt),
      new HumanMessage(message)
    ]);
    return {
      messages: [new HumanMessage({ content: analysis.content, name: 'ReportAgent' })],
    };
  } catch (error) {
    console.error('[ReportAgent] Fallback analysis error:', error);
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
    
    // Handle mailing/timeline deadline questions (use consumerLawDeadlines)
    if (msg.includes('mailed') || msg.includes('sent') || msg.includes('certified mail') ||
        msg.includes('timeline') || msg.includes('deadline') || msg.includes('days left') || msg.includes('when did')) {
      const dateMatch = message.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})|(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/);
      if (dateMatch) {
        const mailingDate = dateMatch[0];
        // Determine whether this is a credit (FCRA) or debt (FDCPA) question
        if (msg.includes('credit') || msg.includes('fcra') || msg.includes('bureau') || msg.includes('equifax') || msg.includes('experian') || msg.includes('transunion')) {
          const deadlines = ConsumerLawDeadlines.calculateFCRADeadlines(mailingDate, msg.includes('certified') ? 'certified' : 'mail');
          response = `📅 FCRA Timeline based on mailing date ${mailingDate}\n\n`;
          response += `• Investigation deadline: ${deadlines.investigationDeadline}\n`;
          response += `• Extended deadline (if applicable): ${deadlines.extendedDeadline}\n`;
          response += `• Results deadline: ${deadlines.resultsDeadline}\n`;
          response += `\n${deadlines.advice}`;
        } else {
          const fd = ConsumerLawDeadlines.calculateFDCPADeadlines(mailingDate, msg.includes('certified'));
          response = `📅 FDCPA Timeline based on mailing date ${mailingDate}\n\n`;
          response += `• Collector validation notice deadline: ${fd.validationNoticeDeadline}\n`;
          response += `• Consumer validation period (you have until): ${fd.consumerValidationDeadline}\n`;
          response += `• Effective deadline (with delivery buffer): ${fd.effectiveDeadline}\n`;
          response += `\n${fd.advice}`;
        }
        return { messages: [new HumanMessage({ content: response, name: 'LegalAgent' })] };
      } else {
        response = `📅 To calculate deadlines I need the mailing date. Example: "I mailed my dispute on 12/10/2025 via certified mail".`;
        return { messages: [new HumanMessage({ content: response, name: 'LegalAgent' })] };
      }
    }
    
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

// trackingAgent removed - timeline & mailing guidance handled by legalAgent and supervisor outputs


// Create workflow
const workflow = new StateGraph(AgentState)
  .addNode('supervisor', supervisor)
  .addNode('search', searchAgent)
  .addNode('report', reportAgent)
  .addNode('letter', letterAgent)
  .addNode('legal', legalAgent)
  .addNode('email', emailAgent)
  .addNode('calendar', calendarAgent);

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