const http = require('http');

async function testAgent() {
  const userId = 'a2b91a65-12d4-42b0-98fc-1830c1002d2c'; // Same userId from test-file-listing.js
  const message = 'analyze my report'; // This should trigger the reportAgent

  try {
    console.log('🧪 Testing agent with message:', message);
    console.log('User ID:', userId);

    const postData = JSON.stringify({
      message: message,
      sessionId: 'test-session-' + Date.now(),
      useAgents: true,
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

    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            console.log('Response status:', res.statusCode);
            console.log('Response data:', JSON.stringify(result, null, 2));
            resolve(result);
          } catch (e) {
            console.log('Raw response:', data);
            resolve(data);
          }
        });
      });

      req.on('error', (error) => {
        console.error('Request failed:', error.message);
        reject(error);
      });

      req.write(postData);
      req.end();
    });

  } catch (error) {
    console.error('Test failed:', error.message);
  }
}

testAgent();