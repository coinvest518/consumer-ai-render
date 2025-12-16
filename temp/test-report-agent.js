require('dotenv').config();

(async () => {
  try {
    const supabase = require('@supabase/supabase-js').createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { reportAgent } = require('./agents/supervisor');

    console.log('Calling reportAgent directly with test user...');
    const res = await reportAgent({ messages: [{ content: 'analyze my report' }], userId: 'a2b91a65-12d4-42b0-98fc-1830c1002d2c', supabase });
    console.log('ReportAgent result:', JSON.stringify(res, null, 2).substring(0, 1000));
  } catch (err) {
    console.error('Test failed:', err.message || err);
  }
})();