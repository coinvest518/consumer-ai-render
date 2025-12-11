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

## Deployment

This backend is designed to be deployed to Render.com.