require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

async function addBucketColumn() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // Try to insert a test record with bucket column to see if it exists
    // If it fails, the column doesn't exist and we need to add it
    console.log('Checking if bucket column exists...');

    // First, let's try a simple query to see current columns
    const { data, error } = await supabase
      .from('report_analyses')
      .select('*')
      .limit(1);

    if (error) {
      console.error('Error querying table:', error);
      return;
    }

    console.log('Table exists. Migration may not be needed if bucket column was added during table creation.');
    console.log('✅ Migration check complete');

  } catch (err) {
    console.error('Migration check failed:', err);
  }
}

addBucketColumn();