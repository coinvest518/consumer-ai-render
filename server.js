const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const apiHandler = require('./api');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration
app.use(cors({
  origin: ['https://consumer-ai-chat.vercel.app', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'user-id'],
  credentials: true
}));

// Parse JSON bodies
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    message: 'ConsumerAI API is running',
    timestamp: new Date().toISOString()
  });
});

// Route all API requests to the handler
app.use('/api', (req, res) => {
  // Modify the URL to match what the API handler expects
  req.url = req.url.replace(/^\/api/, '');
  if (req.url === '') req.url = '/';
  
  return apiHandler(req, res);
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});