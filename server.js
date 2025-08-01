
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const apiHandler = require('./api');

// Rate limiter for API endpoints
const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 30, // Limit each IP to 30 requests per minute
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// Load environment variables
dotenv.config();


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://consumerai.info', 'http://localhost:3000', 'https://consumer-ai-render.onrender.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  }
});
global.io = io;
const PORT = process.env.PORT || 3001;

// CORS configuration
app.use(cors({
  origin: ['https://consumerai.info', 'http://localhost:3000', 'https://consumer-ai-render.onrender.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'user-id', 'stripe-signature'],
  credentials: true
}));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'ConsumerAI API is running',
    timestamp: new Date().toISOString()
  });
});

// Stripe webhooks require the raw request body for signature verification.
// These routes must be defined *before* the global app.use(express.json()).
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  // Adjust the URL for the apiHandler to recognize the route
  req.url = '/stripe-webhook';
  return apiHandler(req, res);
});

app.post('/api/storage/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    // Adjust the URL for the apiHandler to recognize the route
    req.url = '/storage/webhook';
    return apiHandler(req, res);
});

// For all other routes, parse JSON bodies. This must come *after* the raw webhook routes.
app.use(express.json());

// Apply rate limiting to all API routes except webhooks
app.use('/api', apiLimiter, (req, res) => {
  // Skip rate limiting for webhook endpoints
  if (req.url === '/api/stripe-webhook' || req.url === '/api/storage/webhook') {
    return apiHandler(req, res);
  }
  
  // Modify the URL to match what the API handler expects by removing the /api prefix
  req.url = req.url.replace(/^\/api/, '');
  if (req.url === '') req.url = '/';

  return apiHandler(req, res);
});

// Socket.IO connection event (optional, for debugging)
io.on('connection', (socket) => {
  console.log('Socket.IO client connected:', socket.id);
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});
