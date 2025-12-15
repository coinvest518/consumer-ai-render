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

    function doPost(data) {
      return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
            catch (e) { resolve({ status: res.statusCode, data: body }); }
          });
        });
        req.on('error', (err) => reject(err));
        req.write(data);
        req.end();
      });
    }

    console.log('Sending initial request...');
    let res = await doPost(postData);
    console.log('Initial response status:', res.status);
    console.log('Initial response message:', res.data?.data?.message || JSON.stringify(res.data));

    const processingRegex = /processing|still processing|not yet complete/i;
    const analysisRegex = /Analysis of|HIGHLIGHTED VIOLATIONS|violations|errors|Actionable items/i;

    const start = Date.now();
    const timeoutMs = 2 * 60 * 1000; // 2 minutes
    let attempts = 0;

    while (Date.now() - start < timeoutMs) {
      attempts++;
      const msg = res.data?.data?.message || '';
      if (analysisRegex.test(msg)) {
        console.log('Analysis received after', attempts, 'attempt(s):');
        console.log(msg);
        return;
      }

      if (processingRegex.test(msg)) {
        console.log('File still processing — polling again in 8s (attempt', attempts, ')');
        await new Promise(r => setTimeout(r, 8000));
        res = await doPost(postData);
        console.log('Poll response:', res.data?.data?.message || JSON.stringify(res.data));
        continue;
      }

      const maybeFile = (res.data?.data?.message || '').match(/(\d{13}[-_a-z0-9]+\.pdf)/i);
      if (maybeFile) {
        const fileName = maybeFile[1];
        console.log('Found uploaded filename in response:', fileName, '- attempting direct process by sending file_path command');
        const forceData = JSON.stringify({
          message: `file_path: ${userId}/${fileName}`,
          sessionId: 'test-session-force-' + Date.now(),
          useAgents: true,
          userId: userId
        });
        res = await doPost(forceData);
        console.log('Force process response:', res.data?.data?.message || JSON.stringify(res.data));
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      console.log('Final response (no processing/analysis indicator):', res.data);
      break;
    }

    console.log('Polling finished or timed out. Last response:', res.data?.data?.message || JSON.stringify(res.data));

  } catch (error) {
    console.error('Test failed:', error.message || error);
  }
}

testAgent();