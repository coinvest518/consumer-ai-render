const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function query() {
  const session = process.argv[2] || 'persist-test-1';
  try {
    const { data, error } = await supabase
      .from('chat_history')
      .select('*')
      .eq('session_id', session)
      .order('created_at', { ascending: false })
      .limit(20);

    console.log(JSON.stringify({ session, rows: data || [], error }, null, 2));
  } catch (err) {
    console.error('Query error:', err);
  }
}

query();