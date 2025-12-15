require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function testFileListing() {
  const userId = 'a2b91a65-12d4-42b0-98fc-1830c1002d2c'; // From your example

  console.log('🧪 Testing file listing logic...\n');

  // Test the new logic: check users-file-storage with credit-reports/ prefix
  const buckets = ['users-file-storage', 'credit-reports', 'uploads', 'documents'];
  let latestFile = null;
  let latestBucket = null;
  let latestTimestamp = 0;

  for (const bucket of buckets) {
    try {
      let listPath = userId;

      // For users-file-storage bucket, files are stored under credit-reports/userId/
      if (bucket === 'users-file-storage') {
        listPath = `credit-reports/${userId}`;
      }

      console.log(`🔍 Checking bucket: ${bucket}, path: ${listPath}`);

      const { data: files, error: filesError } = await supabase.storage
        .from(bucket)
        .list(listPath, { limit: 5, sortBy: { column: 'created_at', order: 'desc' } });

      if (filesError) {
        console.log(`  ❌ Error listing ${bucket}:`, filesError.message);
        continue;
      }

      if (!files || files.length === 0) {
        console.log(`  📂 No files in ${bucket}/${listPath}`);
        continue;
      }

      console.log(`  📄 Found ${files.length} files in ${bucket}/${listPath}:`);
      files.forEach((file, index) => {
        const fileTimestamp = new Date(file.created_at).getTime();
        console.log(`    ${index + 1}. ${file.name} (${new Date(file.created_at).toLocaleString()})`);

        // Check if this is the most recent file
        if (fileTimestamp > latestTimestamp) {
          latestFile = file;
          latestBucket = bucket;
          latestTimestamp = fileTimestamp;
        }
      });

    } catch (bucketError) {
      console.log(`  ❌ Exception checking ${bucket}:`, bucketError.message);
    }
  }

  console.log('\n🏆 Latest file found:');
  if (latestFile) {
    console.log(`  Bucket: ${latestBucket}`);
    console.log(`  File: ${latestFile.name}`);
    console.log(`  Created: ${new Date(latestFile.created_at).toLocaleString()}`);

    // Construct the full file path
    let filePath;
    if (latestBucket === 'users-file-storage') {
      filePath = `credit-reports/${userId}/${latestFile.name}`;
    } else {
      filePath = `${userId}/${latestFile.name}`;
    }
    console.log(`  Full path: ${filePath}`);

    // Test download
    console.log('\n📥 Testing download...');
    try {
      const { data, error } = await supabase.storage
        .from(latestBucket)
        .download(filePath);

      if (error) {
        console.log(`  ❌ Download failed:`, error.message);
      } else {
        const buffer = Buffer.from(await data.arrayBuffer());
        console.log(`  ✅ Download successful: ${buffer.length} bytes`);
      }
    } catch (downloadError) {
      console.log(`  ❌ Download exception:`, downloadError.message);
    }

  } else {
    console.log('  ❌ No files found in any bucket');
  }
}

testFileListing().catch(console.error);