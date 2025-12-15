# ConsumerAI System Instructions

## Overview
This document explains how the AI system is configured to access user data and respond to queries about credit reports.

## Database Access

### Supabase Connection
- **Available to**: All AI agents (supervisor, report, letter, legal, etc.)
- **Access method**: Via `state.supabase` in agent functions
- **User identification**: Via `state.userId` (UUID format)

### Database Schema
```javascript
Table: 'report_analyses'
Columns:
  - user_id (UUID) - User identifier
  - file_name (TEXT) - Name of uploaded file
  - file_path (TEXT) - Storage path to file
  - processed_at (TIMESTAMP) - When file was analyzed
  - analysis (JSONB) - Analysis results with violations/errors
```

### Query Example
```javascript
const { data, error } = await supabase
  .from('report_analyses')
  .select('*')
  .eq('user_id', userId)
  .order('processed_at', { ascending: false })
  .limit(3);
```

## AI System Prompts

### Main System Prompt (api.js - getChatHistory)
The AI receives comprehensive instructions including:
- Database access details (table name, columns, query method)
- Current user files context (automatically fetched)
- Response protocols for file access questions
- Capabilities and limitations

### Supervisor Prompt (supervisor.js)
The supervisor AI knows:
- All agents have database access
- How to route credit report questions to report agent
- Trigger words: "credit report", "analyze", "get my", "access", "see my", etc.
- Database schema and query methods

### Report Agent Prompt (supervisor.js - reportAgent)
The report agent knows:
- Exact database access methods
- Current user's uploaded files
- How to respond when files exist vs. don't exist
- Analysis capabilities (Mistral OCR + Google Gemini)

## Trigger Words for Credit Report Detection

The system detects credit report questions using these keywords:
- **Analysis**: analyze, review, check, examine, look at
- **Possession**: my report, my file, my documents, my uploads
- **Access**: access, get, retrieve, pull up, show me, see my
- **Violations**: violations, errors, disputes, inaccuracies
- **Laws**: FCRA, FDCPA, credit bureau
- **Bureaus**: Equifax, Experian, TransUnion
- **Questions**: "Can you see/get/access my reports?", "Do you have my credit report?", "Did I upload anything?"

## Response Flow

### When User Asks "Can you get my credit reports?"

1. **System checks**: `getUserFilesContext(userId)` fetches user's files from database
2. **AI receives**: File list with names, dates, and analysis status
3. **AI responds**:
   - **If files exist**: "Yes! I can see you uploaded [filename] on [date]. Would you like me to analyze it for FCRA violations?"
   - **If no files**: "I don't see any uploaded files yet. Have you uploaded a credit report? Once you do, I can analyze it for violations and errors."

### When User Says "Get my report"

1. **System routes**: To report agent (via supervisor)
2. **Report agent**: Checks user files context
3. **Response**:
   - **If files exist**: Automatically references most recent file and offers analysis
   - **If no files**: Asks if they've uploaded one yet

## User Context Injection

Every AI request includes:
```
=== CURRENT USER FILES ===
User's recent files:
1. filename.pdf (12/15/2024) - analyzed - 3 violations, 2 errors
2. report2.pdf (12/10/2024) - analyzed - 1 violation, 0 errors
```

This context is:
- Fetched automatically via `getUserFilesContext(userId)`
- Injected into system prompts
- Updated on every request
- Includes file names, dates, and analysis status

## Key Changes Made

1. **Removed quick responses** - AI always has full context
2. **Expanded trigger words** - Better detection of credit report questions
3. **Comprehensive system prompts** - Explicit database access instructions
4. **Response protocols** - Clear rules for when files exist vs. don't exist
5. **User context injection** - Files automatically included in every prompt

## Testing

To verify the system works:

1. **User with files**: Ask "can you get my credit reports?"
   - Expected: AI references specific uploaded files by name and date

2. **User without files**: Ask "can you get my credit reports?"
   - Expected: AI asks if they've uploaded a credit report yet

3. **User asks to analyze**: Say "analyze my report"
   - Expected: AI references most recent file and begins analysis

## Technical Flow

```
User Message → API Handler
  ↓
Check for userId
  ↓
Fetch user files: getUserFilesContext(userId)
  ↓
Inject into system prompt
  ↓
Route to appropriate agent (supervisor decides)
  ↓
Agent receives: state.userId, state.supabase, file context
  ↓
Agent responds with specific file references
  ↓
Response sent to user
```

## Database Query Functions

### getUserFilesContext(userId)
```javascript
// Fetches last 3 files for user
// Returns formatted string with file names, dates, status
// Used in system prompts for context
```

### reportAgent(state)
```javascript
// Receives: state.userId, state.supabase, state.messages
// Queries database for user files
// Analyzes files or provides guidance
// Returns response with specific file references
```

## Important Notes

- **User ID format**: UUID (e.g., "123e4567-e89b-12d3-a456-426614174000")
- **User ID source**: From request body `userId` or header `user-id`
- **File storage**: Supabase storage buckets (users-file-storage, credit-reports, etc.)
- **Analysis caching**: Recent analyses (< 1 hour) are reused to save API costs
- **Multi-bucket support**: System checks multiple storage buckets for files

## Debugging

If AI doesn't recognize user files:
1. Check logs for "getUserFilesContext called with userId"
2. Verify userId is being passed to processMessage()
3. Check Supabase connection logs
4. Verify report_analyses table has data for that user_id
5. Check system prompt includes file context

## Future Improvements

- Add more trigger words as users provide feedback
- Enhance file context with more metadata
- Add file type detection (credit report vs. other documents)
- Implement semantic search for file content
- Add file upload status tracking
