const { createClient } = require('@supabase/supabase-js')

async function main() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment')
    process.exit(2)
  }

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  })

  const testSession = process.argv[2] || 'persist-test-1'
  const testUser = process.argv[3] || '11111111-1111-1111-1111-111111111111'

  const now = new Date().toISOString()
  const row = {
    user_id: testUser,
    session_id: testSession,
    message: `Test insert at ${now}`,
    role: 'user',
    metadata: { test: true }
  }

  console.log('Inserting row into chat_history:', { session_id: testSession, user_id: testUser })
  const { data: insertData, error: insertError } = await supabase
    .from('chat_history')
    .insert([row])
    .select()

  if (insertError) {
    console.error('Insert error:', insertError)
  } else {
    console.log('Insert returned:', insertData)
  }

  console.log('Querying rows for session:', testSession)
  const { data, error } = await supabase
    .from('chat_history')
    .select('*')
    .eq('session_id', testSession)
    .order('created_at', { ascending: false })
    .limit(10)

  if (error) {
    console.error('Select error:', error)
    process.exit(3)
  }

  console.log(`Rows for session ${testSession}:`, data)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
