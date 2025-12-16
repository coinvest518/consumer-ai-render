const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function testDatabaseAccess() {
  console.log('🔍 Testing AI Agent Database Access...\n');
  
  const tables = [
    'disputes',
    'certified_mail', 
    'complaints',
    'calendar_events',
    'report_analyses',
    'storage_limits',
    'chat_history',
    'user_metrics'
  ];

  const results = {};

  for (const table of tables) {
    try {
      console.log(`Testing ${table}...`);
      
      // Test SELECT access
      const { data, error, count } = await supabase
        .from(table)
        .select('*', { count: 'exact' })
        .limit(1);

      if (error) {
        results[table] = {
          accessible: false,
          error: error.message,
          code: error.code
        };
        console.log(`❌ ${table}: ${error.message}`);
      } else {
        results[table] = {
          accessible: true,
          rowCount: count,
          hasData: data && data.length > 0,
          sampleColumns: data && data.length > 0 ? Object.keys(data[0]) : 'No data to show columns'
        };
        console.log(`✅ ${table}: Accessible (${count} rows)`);
      }
    } catch (err) {
      results[table] = {
        accessible: false,
        error: err.message,
        type: 'exception'
      };
      console.log(`❌ ${table}: Exception - ${err.message}`);
    }
  }

  console.log('\n📊 Summary:');
  console.log('='.repeat(50));
  
  Object.entries(results).forEach(([table, result]) => {
    const status = result.accessible ? '✅' : '❌';
    const info = result.accessible 
      ? `${result.rowCount} rows` 
      : result.error;
    console.log(`${status} ${table.padEnd(20)} | ${info}`);
  });

  return results;
}

// Export for use in API endpoint
module.exports = { testDatabaseAccess };

// Run if called directly
if (require.main === module) {
  testDatabaseAccess().catch(console.error);
}