const fs = require('fs');
const http = require('http');

function loadDotenv() {
  const p = '.env';
  if (!fs.existsSync(p)) return;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#') || line.indexOf('=') === -1) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

async function request(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  loadDotenv();

  const sessionId = process.argv[2] || 'persist-test-1';
  const userId = process.argv[3] || 'a2b91a65-12d4-42b0-98fc-1830c1002d2c';
  const message = 'E2E persistence test ' + new Date().toISOString();

  console.log('Posting chat message...', { sessionId, userId });
  const post = await request({
    hostname: 'localhost', port: 3001, path: '/api/chat', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-mode': 'true' }  // Add test mode header to skip user validation
  }, { message, sessionId, userId });

  console.log('POST result status:', post.status);
  console.log('POST result body:', JSON.stringify(post.body, null, 2));

  console.log('\nFetching chat history for session:', sessionId);
  const get = await request({ hostname: 'localhost', port: 3001, path: `/api/chat/history?sessionId=${encodeURIComponent(sessionId)}`, method: 'GET' });
  console.log('GET status:', get.status);
  console.log('GET body:', JSON.stringify(get.body, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
