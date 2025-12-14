const io = require('socket.io-client');

// Test Socket.IO connection
const socket = io('http://localhost:3001', {
  transports: ['websocket', 'polling']
});

socket.on('connect', () => {
  console.log('✅ Connected to server with socket ID:', socket.id);
  
  // Test connection
  socket.emit('test-connection', { message: 'Hello from test client!' });
});

socket.on('connection-confirmed', (data) => {
  console.log('✅ Connection confirmed:', data);
});

socket.on('test-response', (data) => {
  console.log('✅ Test response received:', data);
});

socket.on('agent-step', (data) => {
  console.log('🤖 Agent step:', data);
});

socket.on('agent-thinking-start', () => {
  console.log('🧠 Agent thinking started');
});

socket.on('agent-thinking-complete', (data) => {
  console.log('✅ Agent thinking complete:', data);
});

socket.on('agent-thinking-error', (error) => {
  console.log('❌ Agent thinking error:', error);
});

socket.on('disconnect', (reason) => {
  console.log('❌ Disconnected:', reason);
});

socket.on('connect_error', (error) => {
  console.log('❌ Connection error:', error.message);
});

// Keep the connection alive for testing
setTimeout(() => {
  console.log('Closing connection...');
  socket.disconnect();
  process.exit(0);
}, 5000);