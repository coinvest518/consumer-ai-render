const { createClient } = require('@supabase/supabase-js');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const { Mistral } = require('@mistralai/mistralai');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize Mistral client for OCR
const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});

let chatWithFallback;
try {
  chatWithFallback = require('./temp/aiUtils').chatWithFallback;
} catch (error) {
  console.warn('Failed to load ./temp/aiUtils, trying ./aiUtils:', error.message);
  try {
    chatWithFallback = require('./aiUtils').chatWithFallback;
  } catch (fallbackError) {
    console.error('Failed to load aiUtils from both locations:', fallbackError.message);
    // Provide a minimal fallback function
    chatWithFallback = async (messages) => {
      throw new Error('AI utilities not available - check aiUtils.js file');
    };
  }
}

/**
 * Download file from Supabase storage
 * @param {string} filePath - Path to file in storage
 * @returns {Promise<Buffer>} - File buffer
 */
async function downloadFromStorage(filePath) {
  try {
    // Try buckets in order of likelihood based on actual structure
    const buckets = ['users-file-storage', 'credit-reports', 'uploads', 'documents'];
    
    for (const bucket of buckets) {
      try {
        console.log(`Trying to download from ${bucket}: ${filePath}`);
        const { data, error } = await supabase.storage
          .from(bucket)
          .download(filePath);

        if (!error && data) {
          console.log(`✅ Successfully downloaded from ${bucket}`);
          return Buffer.from(await data.arrayBuffer());
        }
      } catch (bucketError) {
        console.log(`❌ Failed to download from ${bucket}:`, bucketError.message);
      }
    }
    
    throw new Error(`File not found in any storage bucket: ${filePath}`);
  } catch (error) {
    console.error('Error downloading file:', error);
    throw new Error(`Failed to download file: ${error.message}`);
  }
}

/**
 * Extract text from PDF using Mistral OCR
 * @param {Buffer} buffer - PDF buffer
 * @returns {Promise<string>} - Extracted text
 */
async function extractTextFromPDF(buffer) {
  try {
    console.log('🔍 Extracting text from PDF using Mistral OCR, buffer size:', buffer.length);

    // Convert buffer to base64 data URL for Mistral
    const base64Data = buffer.toString('base64');
    const dataUrl = `data:application/pdf;base64,${base64Data}`;

    console.log('📤 Sending PDF to Mistral OCR...');

    // Use Mistral OCR API
    const ocrResponse = await mistral.ocr.process({
      model: "mistral-ocr-latest",
      document: {
        type: "document_url",
        documentUrl: dataUrl
      }
    });

    console.log('✅ Mistral OCR completed, pages processed:', ocrResponse.pages?.length || 0);

    // Combine all pages' markdown content
    const extractedText = ocrResponse.pages
      .map(page => page.markdown)
      .join('\n\n');

    // Return both the extracted text and the raw OCR pages for layout/evidence
    return { extractedText, ocrPages: ocrResponse.pages };

    console.log('📝 Extracted text length:', extractedText.length);

    if (!extractedText || extractedText.trim().length < 10) {
      throw new Error('Mistral OCR returned insufficient text from PDF');
    }

    return extractedText;

  } catch (error) {
    console.error('❌ Mistral OCR error:', error);
    // Fallback to original pdf-parse method
    console.log('🔄 Falling back to pdf-parse...');
    try {
      const data = await pdfParse(buffer);
      console.log('📄 PDF-parse fallback: pages:', data.numpages, 'text length:', data.text.length);
      return { extractedText: data.text, ocrPages: null };
    } catch (fallbackError) {
      console.error('❌ Fallback also failed:', fallbackError);
      throw new Error(`OCR failed: ${error.message}`);
    }
  }
}

/**
 * Extract text from image using Tesseract OCR
 * @param {Buffer} buffer - Image buffer
 * @returns {Promise<string>} - Extracted text
 */
async function extractTextFromImage(buffer, fileName) {
  console.log('⚠️ Local OCR not available in deployment environment');

  // Since local OCR libraries are not supported in Render,
  // return a helpful error message instead of crashing
  return `Unable to extract text from ${fileName}. The document appears to be image-based or scanned.

Please try uploading a text-based PDF or contact support for assistance with document processing.

For credit report analysis, we recommend:
1. Using digital credit reports from your credit bureau
2. Ensuring your PDF contains selectable text (not just images)
3. Contacting support if you need help with scanned documents`;
}

/**
 * Determine if file is PDF or image and extract text
 * @param {Buffer} buffer - File buffer
 * @param {string} fileName - Original file name
 * @returns {Promise<string>} - Extracted text
 */
async function extractText(buffer, fileName) {
  const ext = path.extname(fileName).toLowerCase();

  if (ext === '.pdf') {
    try {
      // First try regular PDF text extraction
      const pdfResult = await extractTextFromPDF(buffer);
      if (pdfResult && pdfResult.extractedText && pdfResult.extractedText.trim().length > 100) {
        return pdfResult; // Return object { extractedText, ocrPages }
      }
      
      // If PDF text extraction failed or returned very little text,
      // it might be a scanned PDF - try OCR (images)
      console.log('PDF text extraction yielded insufficient text, trying OCR...');
      const imgText = await extractTextFromImage(buffer, fileName);
      return { extractedText: imgText, ocrPages: null };
    } catch (pdfError) {
      console.log('PDF extraction failed, trying OCR:', pdfError.message);
      // Fallback to OCR for scanned PDFs
      const imgText = await extractTextFromImage(buffer, fileName);
      return { extractedText: imgText, ocrPages: null };
    }
  }
}

/**
 * Classify the document type using heuristics and LLM fallback
 * @param {string} text
 * @returns {Promise<string>} - one of: 'credit-report', 'debt-letter', 'cfpb-complaint', 'unknown'
 */
async function classifyDocumentType(text) {
  if (!text || text.length < 50) return 'unknown';

  const lowered = text.toLowerCase();
  // Heuristics
  if (/\b(experian|transunion|equifax|credit report|credit bureau)\b/.test(lowered)) return 'credit-report';
  if (/\b(collection agency|validation notice|debt collector|fdcpa|account number|balance due)\b/.test(lowered)) return 'debt-letter';
  if (/\b(consumer complaint|cfpb complaint|complaint filed|consumerfinance.gov)\b/.test(lowered)) return 'cfpb-complaint';

  // Fallback to LLM few-shot classification
  try {
    const system = `You are a document classifier. Return ONLY one token indicating document type from: credit-report, debt-letter, cfpb-complaint, other`;
    const { response } = await chatWithFallback([
      new SystemMessage(system),
      new HumanMessage("Classify this document and return only the type token (no extra text):\n\n" + (text.substring(0, 2000)))
    ]);
    const txt = (response.content || response).trim().toLowerCase();
    if (txt.includes('credit')) return 'credit-report';
    if (txt.includes('debt')) return 'debt-letter';
    if (txt.includes('cfpb') || txt.includes('complaint')) return 'cfpb-complaint';
    return 'other';
  } catch (err) {
    console.warn('Document classification LLM failed, defaulting to other:', err.message);
    return 'other';
  }
}

/**
 * Analyze debt collection letters for key fields using an LLM and validate output
 */
async function analyzeDebtLetter(text) {
  const systemPrompt = `You are an expert at reading debt collection letters and extracting structured data. Return ONLY JSON matching the debt-letter schema. Include creditor_name, date_received (YYYY-MM-DD if possible), account_id_masked, balance_claimed, validation_notice_present (boolean), validation_notice_text (string if present), evidence (array of quotes), recommended_actions (array of strings), severity (low|medium|high).`;

  try {
    const { response } = await chatWithFallback([
      new SystemMessage(systemPrompt),
      new HumanMessage(`Extract from this document:
\n${text.substring(0, 80000)}`)
    ]);

    let analysisText = (response.content || response) ? String(response.content || response).trim() : '';
    analysisText = analysisText.replace(/```json\n?|\n?```/g, '').trim();

    let parsed = null;
    try { parsed = JSON.parse(analysisText); } catch (err) {
      const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    }

    // Validate against debt-letter schema
    const { validate } = require('./utils/ajvValidate');
    if (parsed) {
      const { valid, errors } = validate('debt-letter.schema.json', parsed);
      parsed._validation = { valid, errors };
      return parsed;
    }

    return { summary: analysisText, _validation: { valid: false, errors: ['Parsing failed'] } };
  } catch (error) {
    console.error('Error analyzing debt letter:', error.message);
    return { summary: 'Analysis failed', error: error.message };
  }
}

async function analyzeGenericDocument(text) {
  const systemPrompt = `You are a consumer law analyst. Given this document, return JSON with keys: summary, issues (array of {type, description, evidence}), recommended_actions (array of strings). Return ONLY JSON.`;
  try {
    const { response } = await chatWithFallback([
      new SystemMessage(systemPrompt),
      new HumanMessage(`Analyze this document:\n\n${text.substring(0, 80000)}`)
    ]);
    let analysisText = (response.content || response) ? String(response.content || response).trim() : '';
    analysisText = analysisText.replace(/```json\n?|\n?```/g, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(analysisText); } catch (err) {
      const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    }
    return parsed || { summary: analysisText };
  } catch (err) {
    console.error('Generic analysis error:', err.message);
    return { summary: 'Analysis failed', error: err.message };
  }
}

/**
 * General document processing entrypoint: detects type, analyzes, and returns metadata
 */
async function processDocument(filePath, userId = null) {
  try {
    const buffer = await downloadFromStorage(filePath);
    const { extractedText, ocrPages } = await extractText(buffer, filePath);
    // persist full OCR artifact if we have a userId and an OCR result
    let ocr_artifact_id = null;
    if (userId && ocrPages) {
      try {
        const saved = await saveOcrArtifact(userId, filePath, path.basename(filePath), ocrPages);
        // saveOcrArtifact returns the inserted row id
        ocr_artifact_id = saved || null;
      } catch (err) {
        console.warn('Failed to save OCR artifact:', err.message);
      }
    }

    const docTypeFromEmbedding = await classifyWithEmbeddings(extractedText);
    let docType = docTypeFromEmbedding || (await classifyDocumentType(extractedText));

    let analysis = null;
    if (docType === 'credit-report') {
      analysis = await analyzeText(extractedText);
    } else if (docType === 'debt-letter') {
      analysis = await analyzeDebtLetter(extractedText);
    } else if (docType === 'cfpb-complaint') {
      analysis = await analyzeGenericDocument(extractedText);
    } else {
      analysis = await analyzeGenericDocument(extractedText);
    }

    return {
      filePath,
      extractedText,
      ocrPages: ocrPages || null,
      ocr_artifact_id,
      docType,
      analysis,
      processedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error processing document:', error.message);
    return { filePath, error: error.message, processedAt: new Date().toISOString() };
  }
}

/**
 * Save full OCR artifact to Supabase table `ocr_artifacts`
 */
async function saveOcrArtifact(userId, filePath, fileName, ocrPages) {
  if (!supabase) throw new Error('Supabase client not initialized');
  const { data, error } = await supabase.from('ocr_artifacts').insert([{ user_id: userId, file_path: filePath, file_name: fileName, ocr_pages: ocrPages }]).select('id').limit(1);
  if (error) throw error;
  if (Array.isArray(data) && data.length > 0) return data[0].id;
  if (data && data.id) return data.id;
  return null;
}

/**
 * Add a labeled sample to document_embeddings table (computes embedding)
 */
async function addLabeledSample(userId, label, snippet, filePath = null) {
  const { getEmbedding } = require('./utils/embeddings');
  const embedding = await getEmbedding(snippet);
  if (!embedding) throw new Error('Failed to compute embedding');
  if (!supabase) throw new Error('Supabase client not initialized');
  try {
    const { data, error } = await supabase.from('document_embeddings').insert([{ user_id: userId, file_path: filePath, label, embedding }]);
    if (error) {
      // Permission or RLS issues are common during local tests
      const msg = (error && error.message) ? error.message : JSON.stringify(error);
      // If permission error, fallback to storing in document_labels table which often has more permissive policies
      if ((error && (error.code === '42501' || (error.message && error.message.toLowerCase().includes('permission')))) || msg.toLowerCase().includes('permission')) {
        console.warn('document_embeddings insert failed due to permissions. Falling back to document_labels. Error:', msg);
        const meta = { fallback_reason: 'permission', original_error: msg };
        const { data: lblData, error: lblErr } = await supabase.from('document_labels').insert([{ user_id: userId, label, snippet, metadata: meta }]);
        if (lblErr) throw new Error(`Failed to insert fallback label: ${lblErr.message || JSON.stringify(lblErr)}`);
        return { fallback: true, table: 'document_labels', inserted: lblData };
      }
      throw new Error(`Supabase insert failed: ${msg}`);
    }
    return { fallback: false, table: 'document_embeddings', inserted: data };
  } catch (err) {
    // Provide guidance for common permission issues
    if (err.message && err.message.toLowerCase().includes('permission')) {
      throw new Error('Permission denied when inserting into document_embeddings. Ensure the SQL migration has been applied and your environment is using a Supabase service role key (SUPABASE_SERVICE_ROLE_KEY) for server-side operations.');
    }
    throw err;
  }
}

/**
 * Classify using nearest neighbors in document_embeddings (returns label or null)
 */
async function classifyWithEmbeddings(text, k = 5, minScore = 0.7) {
  try {
    const { getEmbedding } = require('./utils/embeddings');
    const queryEmb = await getEmbedding(text);
    if (!queryEmb) return null;

    if (!supabase) return null;
    const { data, error } = await supabase.from('document_embeddings').select('id,label,embedding').limit(500);
    if (error || !data) return null;

    // compute cosine similarity
    function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
    function norm(a) { return Math.sqrt(dot(a, a)); }
    const qnorm = norm(queryEmb);

    const scored = data.map(row => {
      const emb = row.embedding;
      const score = qnorm && emb ? dot(queryEmb, emb) / (qnorm * norm(emb)) : 0;
      return { id: row.id, label: row.label, score };
    }).sort((a,b)=>b.score-a.score).slice(0,k);

    if (scored.length === 0) return null;
    const top = scored[0];
    if (top.score >= minScore) return top.label;

    // Weighted vote
    const votes = {};
    for (const s of scored) {
      votes[s.label] = (votes[s.label] || 0) + Math.max(0, s.score);
    }
    const winner = Object.keys(votes).sort((a,b)=>votes[b]-votes[a])[0];
    return winner || null;
  } catch (err) {
    console.warn('Embedding classifier failed:', err.message);
    return null;
  }
}

/**
 * Analyze extracted text for errors and violations using LLM(s) (prefer Mistral)
 * @param {string} text - Extracted text
 * @returns {Promise<Object>} - Structured analysis
 */
async function analyzeText(text) {
  // Handle empty or very short text
  if (!text || text.trim().length < 50) {
    return {
      summary: "Insufficient text for analysis - PDF may be image-based or corrupted",
      violations: [],
      errors: [{
        type: "extraction_error",
        description: "Could not extract readable text from the document",
        evidence: "Text length: " + (text?.length || 0) + " characters"
      }],
      overall_score: "unknown",
      needs_ocr: true
    };
  }

  // Truncate text to fit within AI token limits (approx 100k characters for 128k tokens)
  const maxLength = 80000;
  const truncatedText = text.length > maxLength ? 
    text.substring(0, maxLength) + '\n\n[Text truncated for analysis due to length...]' : 
    text;
  
  console.log(`Analyzing text of length: ${truncatedText.length} characters (original: ${text.length})`);

  const systemPrompt = `You are a credit report analysis expert. Analyze this ENTIRE credit report text and return ONLY a JSON object.

CRITICAL ANALYSIS REQUIREMENTS:
1. PERSONAL INFO: List ALL names, addresses, SSNs, DOBs found. If multiple versions exist, flag as identity issues.
2. COLLECTION ACCOUNTS: Identify ANY account marked as "collection", "charged off", "sent to collections", or with collection agency names.
3. INQUIRIES: Count and categorize ALL inquiries as hard pulls vs soft pulls. Show exact counts.
4. ACCOUNT DETAILS: Extract complete info for EVERY account (name, number, balance, status, payment history).
5. VIOLATIONS: Identify specific FCRA/FDCPA violations with exact evidence quotes.

Extract and analyze ALL information including:
- Every account name, number, creditor, balance, status
- All collection agencies and their contact information  
- All personal information (names, addresses, SSN, DOB)
- All inquiries with dates and purposes
- All violations and errors

Return ONLY this JSON structure:
{
  "summary": "Comprehensive summary highlighting key issues and total counts",
  "personal_info_analysis": {
    "names_found": ["List every name variation found"],
    "addresses_found": ["List every address found"],
    "ssn_variations": ["List any SSN variations"],
    "dob_variations": ["List any DOB variations"],
    "identity_issues": [
      {"type": "multiple_names|multiple_addresses|ssn_mismatch|dob_mismatch", "description": "Details", "evidence": "Exact quote", "severity": "high/medium/low"}
    ]
  },
  "inquiry_analysis": {
    "total_hard_pulls": 0,
    "total_soft_pulls": 0,
    "hard_pull_details": [
      {"creditor_name": "Name", "date": "Date", "purpose": "Purpose", "evidence": "Quote"}
    ],
    "soft_pull_details": [
      {"creditor_name": "Name", "date": "Date", "purpose": "Purpose", "evidence": "Quote"}
    ],
    "inquiry_issues": [
      {"issue_type": "too_many_hard_pulls|unauthorized_inquiry|old_inquiry", "description": "Details", "evidence": "Quote", "severity": "high/medium/low"}
    ]
  },
  "collection_accounts_analysis": {
    "total_collections_found": 0,
    "collection_accounts": [
      {
        "original_creditor": "Original creditor name",
        "collection_agency": "Collection agency name and contact info",
        "account_number": "Full or partial account number",
        "original_balance": "Original amount owed",
        "current_balance": "Current balance",
        "date_opened": "Date account opened",
        "date_of_first_delinquency": "DOFD if available",
        "status": "Current status (collection, charged off, etc.)",
        "payment_history": "Payment history details",
        "fdcpa_violations": [
          {"violation": "Specific FDCPA violation", "evidence": "Quote", "severity": "high/medium/low"}
        ],
        "fcra_violations": [
          {"violation": "Specific FCRA violation", "evidence": "Quote", "severity": "high/medium/low"}
        ],
        "recommended_action": "Specific action to take"
      }
    ]
  },
  "regular_accounts": [
    {"account_name": "Creditor name", "account_number": "Number", "account_type": "Credit card/loan/etc", "status": "Status", "balance": "Balance", "credit_limit": "Limit", "payment_history": "History", "issues": ["List any issues"], "evidence": "Quotes"}
  ],
  "fcra_violations": [
    {
      "violation_type": "inaccurate_reporting|outdated_info|unverified_info|mixed_files|etc",
      "description": "Detailed violation description",
      "affected_accounts": ["List of affected account names"],
      "evidence": "Exact quotes from report",
      "cra_responsible": "Equifax/Experian/TransUnion if identifiable",
      "severity": "high/medium/low",
      "dispute_strategy": "How to dispute this violation"
    }
  ],
  "overall_assessment": {
    "total_accounts": 0,
    "total_collections": 0,
    "total_hard_inquiries": 0,
    "total_soft_inquiries": 0,
    "total_violations_found": 0,
    "credit_score_impact": "high/medium/low negative impact",
    "overall_risk_level": "clean/minor_issues/significant_issues/serious_violations",
    "priority_actions": ["Top 3 most important actions to take immediately"]
  },
  "dispute_letters_needed": [
    {
      "type": "account_investigation|personal_info_correction|fcra_violation|fdpca_complaint",
      "target": "CRA name or creditor name",
      "accounts_involved": ["Account names"],
      "evidence_needed": ["What evidence to include"],
      "timeline": "How long to wait for response"
    }
  ]
}

IMPORTANT INSTRUCTIONS:
- Count EVERY inquiry and categorize as hard/soft pull based on context
- Identify ALL collection accounts even if not explicitly labeled (look for charged off, collection agency names, etc.)
- List EVERY name/address variation found - multiple versions indicate identity issues
- Extract complete account details including balances, limits, payment history
- Provide exact quotes as evidence for every finding
- Be thorough - analyze every section of the credit report
- Return ONLY the JSON object with no additional text`;

  try {
      const { response, model: analysis_model } = await chatWithFallback([
        new SystemMessage(systemPrompt),
        new HumanMessage(`Analyze this credit report text:\n\n${truncatedText}`)
      ]);

      // Parse the JSON response and capture raw snippet + model
      const analysisText = (response && (response.content || response)) ? String(response.content || response).trim() : '';
      const rawSnippet = analysisText.substring(0, 2000);
      console.log('🤖 AI Response received, length:', analysisText.length, 'chars');

      // Remove markdown code blocks if present
      let jsonText = analysisText.replace(/```json\n?|\n?```/g, '').trim();
      
      // Handle cases where JSON is wrapped in extra quotes or has escape characters
      if (jsonText.startsWith('"') && jsonText.endsWith('"')) {
        jsonText = jsonText.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }

      let parsed = null;
      try {
        parsed = JSON.parse(jsonText);
        console.log('✅ JSON parsed successfully');
      } catch (parseError) {
        console.error('❌ JSON parse error, trying to extract...');
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[0]);
            console.log('✅ JSON extracted and parsed');
          } catch (secondParseError) {
            console.error('❌ Cannot parse JSON:', secondParseError.message);
          }
        }
      }

      // If parsed, attempt to fill missing sections with one targeted follow-up prompt
      if (parsed) {
        // Annotate with metadata
        parsed._raw_response_snippet = rawSnippet;
        parsed._analysis_models = [analysis_model || null];

        const fieldMap = {
          'personalinfoanalysis': 'personal_info_issues',
          'inquiryanalysis': 'inquiries',
          'collectionaccountsanalysis': 'collection_accounts',
          'regularaccounts': 'account_issues',
          'overallassessment': 'overall_assessment',
          'disputelettersneeded': 'dispute_letters_needed'
        };
        
        for (const [camel, snake] of Object.entries(fieldMap)) {
          if (parsed[camel] && !parsed[snake]) {
            parsed[snake] = parsed[camel];
            delete parsed[camel];
          }
        }

        // Ensure all required fields exist (pre-merge defaults)
        parsed.summary = parsed.summary || 'Analysis completed';
        parsed.personal_info_issues = parsed.personal_info_issues || [];
        parsed.account_issues = parsed.account_issues || [];
        parsed.collection_accounts = parsed.collection_accounts || [];
        parsed.inquiries = parsed.inquiries || [];
        parsed.fcra_violations = parsed.fcra_violations || [];
        parsed.overall_assessment = parsed.overall_assessment || {
          credit_score_impact: 'unknown',
          total_accounts_affected: 0,
          total_violations_found: 0,
          overall_risk_level: 'unknown',
          priority_actions: []
        };
        parsed.dispute_letters_needed = parsed.dispute_letters_needed || [];

        // Compute missing required sections
        const required = ['personal_info_issues','account_issues','collection_accounts','inquiries','fcra_violations','overall_assessment','dispute_letters_needed'];
        const missing = required.filter(k => {
          const v = parsed[k];
          if (!v) return true;
          if (Array.isArray(v)) return v.length === 0;
          if (typeof v === 'object') return Object.keys(v).length === 0;
          return false;
        });

        parsed._missing_sections = missing;

        // If some sections are missing, perform ONE targeted follow-up query to retrieve them
        if (missing.length > 0) {
          try {
            console.log('🔁 Missing sections detected:', missing.join(', '), '- requesting targeted follow-up');
            const followupPrompt = `The previous JSON response omitted or left empty the following sections: ${missing.join(', ')}. Return ONLY a JSON object containing these fields populated (use same field names as earlier response). Include evidence quotes where possible.`;
            const { response: followResp, model: followModel } = await chatWithFallback([
              new SystemMessage(systemPrompt),
              new HumanMessage(followupPrompt + '\n\n' + truncatedText)
            ]);

            const followText = (followResp && (followResp.content || followResp)) ? String(followResp.content || followResp).trim() : '';
            const followJsonText = followText.replace(/```json\n?|\n?```/g, '').trim();
            let followParsed = null;
            try { followParsed = JSON.parse(followJsonText); } catch (e) {
              const m = followJsonText.match(/\{[\s\S]*\}/);
              if (m) {
                try { followParsed = JSON.parse(m[0]); } catch (e2) { followParsed = null; }
              }
            }

            if (followParsed) {
              // Normalize camelCase fields from follow-up and merge into parsed
              for (const [camel, snake] of Object.entries(fieldMap)) {
                if (followParsed[camel] && !followParsed[snake]) {
                  followParsed[snake] = followParsed[camel];
                  delete followParsed[camel];
                }
              }

              for (const key of Object.keys(followParsed)) {
                if (required.includes(key)) {
                  // If originally empty, replace with follow-up result
                  parsed[key] = followParsed[key] || parsed[key];
                } else {
                  parsed[key] = parsed[key] || followParsed[key];
                }
              }

              parsed._analysis_models.push(followModel || null);
              parsed._raw_response_snippet = (parsed._raw_response_snippet || '') + '\n\n[followup_snippet]\n' + followText.substring(0, 2000);

              // Recompute missing sections
              const missingAfter = required.filter(k => {
                const v = parsed[k];
                if (!v) return true;
                if (Array.isArray(v)) return v.length === 0;
                if (typeof v === 'object') return Object.keys(v).length === 0;
                return false;
              });
              parsed._missing_sections = missingAfter;
              console.log('🔍 After follow-up, missing sections:', parsed._missing_sections);
            } else {
              console.warn('⚠️ Follow-up parsing failed or returned no JSON');
            }
          } catch (err) {
            console.warn('⚠️ Follow-up request failed:', err.message);
          }
        }

        console.log('📊 Field Counts: personal_info=' + parsed.personal_info_issues.length + ' account_issues=' + parsed.account_issues.length + ' inquiries=' + parsed.inquiries.length + ' collections=' + parsed.collection_accounts.length + ' fcra=' + parsed.fcra_violations.length + ' disputes=' + parsed.dispute_letters_needed.length);
        
        return parsed;
      }

    // Fallback: return a structured response wrapping raw AI output
    return {
      summary: analysisText.substring(0, 500) || "Analysis completed but parsing encountered issues",
      personal_info_issues: [],
      account_issues: [],
      collection_accounts: [],
      inquiries: [],
      fcra_violations: [],
      overall_assessment: {
        credit_score_impact: "unknown",
        total_accounts_affected: 0,
        total_violations_found: 0,
        overall_risk_level: "unknown",
        priority_actions: []
      },
      dispute_letters_needed: [],
      _parsing_failed: true
    };
  } catch (error) {
    console.error('❌ Error analyzing text:', error.message);
    return {
      summary: "Analysis encountered a technical error. Please try again.",
      personal_info_issues: [],
      account_issues: [],
      collection_accounts: [],
      inquiries: [],
      fcra_violations: [],
      overall_assessment: {
        credit_score_impact: "unknown",
        total_accounts_affected: 0,
        total_violations_found: 0,
        overall_risk_level: "unknown",
        priority_actions: []
      },
      dispute_letters_needed: [],
      _error: error.message
    };
  }
}

/**
 * Process a credit report file from storage
 * @param {string} filePath - Path to file in storage
 * @returns {Promise<Object>} - Complete analysis
 */
async function processCreditReport(filePath, userId = null) {
  // Backwards-compatible wrapper that calls the general processor
  // Accept optional userId so OCR artifacts can be saved when available
  const res = await processDocument(filePath, userId);
  // Ensure docType is credit-report (or warn)
  if (res.docType && res.docType !== 'credit-report') {
    console.warn(`processCreditReport: detected docType=${res.docType} for ${filePath}`);
  }
  return res;
}

module.exports = {
  processCreditReport,
  processDocument,
  downloadFromStorage,
  extractText,
  analyzeText,
  classifyDocumentType,
  analyzeDebtLetter,
  analyzeGenericDocument,
  saveOcrArtifact,
  addLabeledSample,
  classifyWithEmbeddings
};
