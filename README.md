# ConsumerAI Backend

Backend API for ConsumerAI, a mobile-first legal AI assistant for consumer law questions.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with the following variables:
```
PORT=3001
GOOGLE_API_KEY=your_google_api_key_here  # Primary Google AI key for Gemini
# GOOGLE_AI_API_KEY=your_google_api_key_here  # Alternative name (also supported)
TAVILY_API_KEY=your_tavily_api_key
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_email_app_password
USPS_OAUTH_CLIENT_ID=your_usps_client_id
USPS_OAUTH_CLIENT_SECRET=your_usps_client_secret
# Optional: LangSmith for evaluation
LANGSMITH_API_KEY=your_langsmith_api_key_here
LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
```

3. Start the server:
```bash
npm start
```

## API Endpoints

- `GET /health` - Health check endpoint
- `POST /api/chat` - Chat with the AI assistant
- `GET /api/chat/history` - Get chat history
- `GET /api/session` - Get user session
- `POST /api/session` - Create user session
- `POST /api/stripe-webhook` - Handle Stripe webhook events
- `POST /api/storage/upgrade` - Handle storage plan upgrades
- `POST /api/storage/webhook` - Handle storage-related webhook events
- `POST /api/report/analyze` - Analyze credit report files for violations and errors
- `POST /api/agents` - Process agent messages
- `GET /api/user/stats` - Get user statistics and limits
- `GET /api/user/credits` - Get user credit balance
- `GET /api/storage/limits?user_id=<id>` - Get storage limits for a user (returns defaults if none exist)

### Supabase / PostgREST notes

- If you query a table expecting a single JSON object but the database returns zero or multiple rows, PostgREST will return a `PGRST116` error. This often appears as a `406 Not Acceptable` in the browser when the `Accept` header is set to `application/vnd.pgrst.object+json`.
- For client code using `@supabase/supabase-js`, use `.maybeSingle()` instead of `.single()` when a row may not exist, or call the backend endpoint `/api/storage/limits` which returns sensible defaults.
- Avoid treating placeholder env vars (e.g., values starting with `your_` or `changeme`) as configured credentials; the backend will now return friendly messages when integrations are not configured.

### Preventing PGRST116 / 406 errors

- If your frontend calls PostgREST expecting a single JSON object but the row may not exist, you will get `PGRST116` (HTTP 406). To avoid this:
	- Use `.maybeSingle()` on the client (`supabase-js`) or request an array (no `application/vnd.pgrst.object+json` Accept header).
	- Ensure a `storage_limits` row exists for each user. The backend provides `POST /api/storage/ensure` (or `GET /api/storage/ensure?user_id=<id>`) to create a default row if missing.
	- Add a unique constraint on `storage_limits.user_id` in the database to prevent duplicates (recommended migration):

		ALTER TABLE storage_limits ADD CONSTRAINT storage_limits_user_id_unique UNIQUE (user_id);

	- The server also deduplicates multiple rows when detected during processing.

### Supabase Webhooks and Edge Functions

- You can configure Supabase Database Webhooks to call your backend or an Edge Function when rows change (insert/update/delete). To integrate with this backend, set the webhook to POST to `/api/supabase/webhook`.
- For security, set `SUPABASE_WEBHOOK_SECRET` in your environment and add an `Authorization: Bearer $SUPABASE_WEBHOOK_SECRET` header to the webhook configuration.
- The backend will accept common DB webhook payloads (with `{ table, event, record }`) and common storage object events (with `{ eventType, data }`). When a new file is detected, the server will trigger `processCreditReport(filePath)` asynchronously and optionally store the analysis in `report_analyses`.
- If you prefer, you can instead trigger a Supabase Edge Function (e.g., `database-access`) from a DB webhook, and have that function call your backend or perform processing directly.

## Database Setup

Before running the application, you need to set up the required database tables in Supabase:

1. Go to your Supabase project dashboard
2. Navigate to the SQL Editor
3. Run the SQL script from `database-setup.sql` in your project root

This will create the necessary tables:
- `report_analyses` - Stores credit report analysis results (user_id as UUID)
- `storage_limits` - Manages user storage quotas (user_id as UUID, prevents PGRST116 errors)

The script handles:
- UUID user_id columns for proper type safety
- Automatic policy cleanup and recreation
- Column type conversion from TEXT to UUID if needed

## Document Processing & Search

The system now uses optimized document processing:

### Smart Analysis Caching
- **Before**: Re-analyzed documents every time
- **Now**: Checks for recent analyses (< 1 hour old) and reuses them
- **Benefit**: Faster responses, reduced API costs, better user experience

### Semantic Document Search
- **New Feature**: Search your documents by meaning, not just keywords
- **Usage**: "search for identity theft in my documents"
- **Technology**: Google AI embeddings for semantic similarity
- **Fallback**: Text-based search when embeddings unavailable

### Multi-Bucket Support
- **Before**: Hardcoded 'documents' bucket
- **Now**: Tries multiple buckets: 'credit-reports', 'users-file-storage', 'uploads', 'documents'
- **Benefit**: Works with your actual Supabase bucket configuration

### AI-Native Processing
- Uses Google Gemini 2.5 Flash for document understanding
- Structured analysis with violation highlighting (🚨), errors (⚠️), and actions (✅)
- Direct AI analysis without intermediate processing steps

## Deployment

This backend is designed to be deployed to Render.com.