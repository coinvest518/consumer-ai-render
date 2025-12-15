
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');

// Load environment variables FIRST
dotenv.config();

// Log environment variable status (for debugging)
console.log('Environment variables loaded:');
console.log('- GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? 'Set' : 'Not set');
console.log('- GOOGLE_API_KEY value starts with:', process.env.GOOGLE_API_KEY?.substring(0, 10) + '...');
console.log('- SUPABASE_URL:', process.env.SUPABASE_URL ? 'Set' : 'Not set');
console.log('- TAVILY_API_KEY:', process.env.TAVILY_API_KEY ? 'Set' : 'Not set');
console.log('- LANGSMITH_TRACING:', process.env.LANGSMITH_TRACING);

const apiHandler = require('./api');

// Simple rate limiter implementation (fallback)
let rateLimitMap = new Map();

const apiLimiter = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const max = 30; // 30 requests per minute
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
    return next();
  }
  
  const data = rateLimitMap.get(ip);
  if (now > data.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
    return next();
  }
  
  if (data.count >= max) {
    return res.status(429).json({ 
      error: 'Too many requests from this IP, please try again later' 
    });
  }
  
  data.count++;
  next();
};


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['https://consumerai.info', 'http://localhost:3000', 'https://consumer-ai-render.onrender.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
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

// Track connected users by userId -> socketId mapping
const connectedUsers = new Map();
// Helper function to emit events to specific users
global.emitToUser = (userId, event, data) => {
  if (global.connectedUsers && global.io) {
    const socketId = global.connectedUsers.get(userId);
    if (socketId) {
      global.io.to(socketId).emit(event, data);
      return true;
    }
  }
  return false;
};

// Enhanced Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Socket.IO client connected:', socket.id);
  
  // Send connection confirmation
  socket.emit('connection-confirmed', {
    socketId: socket.id,
    timestamp: new Date().toISOString()
  });
  
  // Handle user authentication/identification
  socket.on('authenticate', (data) => {
    const { userId } = data;
    if (userId) {
      connectedUsers.set(userId, socket.id);
      socket.userId = userId;
      console.log(`User ${userId} authenticated on socket ${socket.id}`);
      
      socket.emit('authenticated', {
        userId,
        socketId: socket.id,
        timestamp: new Date().toISOString()
      });
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log('Socket.IO client disconnected:', socket.id, 'Reason:', reason);
    
    // Remove user from connected users map
    if (socket.userId) {
      connectedUsers.delete(socket.userId);
      console.log(`User ${socket.userId} disconnected`);
    }
  });
  
  // Handle connection errors
  socket.on('error', (error) => {
    console.error('Socket.IO error for client', socket.id, ':', error);
  });
  
  // Test event handler
  socket.on('test-connection', (data) => {
    console.log('Test connection received from', socket.id, ':', data);
    socket.emit('test-response', {
      message: 'Connection working!',
      receivedData: data,
      timestamp: new Date().toISOString()
    });
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});
