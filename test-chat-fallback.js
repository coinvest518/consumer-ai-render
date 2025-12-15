const axios = require('axios');

// Test the chat endpoint with Mistral fallback
async function testChatWithFallback() {
  try {
    console.log('Testing chat with potential Mistral fallback...');

    const response = await axios.post('http://localhost:3000/api/chat', {
      message: "Hello, can you tell me about consumer protection laws?",
      sessionId: "test-fallback",
      userId: "test-user"
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    console.log('Chat response:', response.data);
    console.log('AI Model used:', response.data.usedModel || 'Unknown');
    console.log('Message:', response.data.message?.substring(0, 100) + '...');
  } catch (error) {
    console.error('Error testing chat:', error.response?.data || error.message);
  }
}

testChatWithFallback();