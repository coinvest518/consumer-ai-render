// Test frontend Socket.IO connection
const io = require('socket.io-client');

const userId = 'a2b91a65-12d4-42b0-98fc-1830c1002d2c';

console.log('🔌 Testing Socket.IO connection...\n');

// Connect to your backend
const socket = io('http://localhost:3001', {
  transports: ['websocket', 'polling'],
  upgrade: true,
  rememberUpgrade: true,
  timeout: 20000
});

// Connection events
socket.on('connect', () => {
  console.log('✅ Connected to Socket.IO');
  console.log('Socket ID:', socket.id);

  // Authenticate
  socket.emit('authenticate', { userId });
  console.log('📤 Sent authentication for user:', userId);
});

socket.on('authenticated', (data) => {
  console.log('✅ Authentication successful:', data);

  // Now make an API call to trigger events
  makeTestAPI();
});

socket.on('connection-confirmed', (data) => {
  console.log('📡 Connection confirmed:', data);
});

// Listen for AI events
socket.on('agent-thinking-start', (data) => {
  console.log('🎯 RECEIVED: agent-thinking-start', data);
});

socket.on('agent-step', (data) => {
  console.log('🎯 RECEIVED: agent-step', data);
});

socket.on('agent-thinking-complete', (data) => {
  console.log('🎯 RECEIVED: agent-thinking-complete');
  console.log('Full data object:', JSON.stringify(data, null, 2));
  console.log('Response field exists:', 'response' in data);
  console.log('Response content:', data.response || data.content || 'NO RESPONSE FIELD');
  console.log('Data keys:', Object.keys(data));
});

socket.on('agent-thinking-error', (error) => {
  console.log('❌ RECEIVED: agent-thinking-error', error);
});

// Error handling
socket.on('connect_error', (error) => {
  console.log('❌ Connection error:', error.message);
});

socket.on('disconnect', (reason) => {
  console.log('❌ Disconnected:', reason);
});

// Function to make test API call
function makeTestAPI() {
  console.log('\n📤 Making test API call...');

  const http = require('http');

  const postData = JSON.stringify({
    message: 'hi',
    sessionId: 'test-session-' + Date.now(),
    userId: userId
  });

  const options = {
    hostname: 'localhost',
    port: 3001,
    path: '/api/chat',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'user-id': userId,
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = http.request(options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        console.log('📥 API Response status:', res.statusCode);
        console.log('📥 API Response:', JSON.stringify(result, null, 2));
      } catch (e) {
        console.log('📥 Raw response:', data);
      }
    });
  });

  req.on('error', (error) => {
    console.error('❌ API Request error:', error.message);
  });

  req.write(postData);
  req.end();
}

// Timeout
setTimeout(() => {
  console.log('\n⏰ Test timeout - disconnecting...');
  socket.disconnect();
  process.exit(0);
}, 15000);