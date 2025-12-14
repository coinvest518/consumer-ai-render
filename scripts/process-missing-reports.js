require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const testUserId = process.env.TEST_USER_ID || 'a2b91a65-12d4-42b0-98fc-1830c1002d2c';

async function backfillStorageLimits() {
  console.log('Backfilling storage_limits.user_id_new where missing...');
  const { data: rows, error } = await supabase
    .from('storage_limits')
    .select('id,user_id,user_id_new')
    .is('user_id_new', null)
    .not('user_id', 'is', null)
    .limit(1000);

  if (error) throw error;
  if (!rows || rows.length === 0) {
    console.log('No storage_limits rows need backfill');
    return 0;
  }

  let updated = 0;
  for (const r of rows) {
    const { error: uErr } = await supabase
      .from('storage_limits')
      .update({ user_id_new: r.user_id })
      .eq('id', r.id);
    if (uErr) console.error('Failed to update', r.id, uErr.message);
    else {
      updated++;
      console.log('Updated storage_limits', r.id);
    }
  }
  return updated;
}

async function processMissingReportsForUser(userId) {
  const buckets = ['credit-reports', 'users-file-storage', 'uploads', 'documents'];
  const { processCreditReport } = require('../reportProcessor');
  let processed = 0;

  for (const bucket of buckets) {
    console.log(`Listing files in bucket '${bucket}' for user: ${userId}`);
    try {
      const { data: files, error: listError } = await supabase.storage
        .from(bucket)
        .list(userId, { limit: 1000, sortBy: { column: 'created_at', order: 'asc' } });

      if (listError) {
        console.warn(`Cannot list bucket '${bucket}': ${listError.message}`);
        continue;
      }

      if (!files || files.length === 0) {
        console.log(`No files found for user in bucket '${bucket}'`);
        continue;
      }

      for (const f of files) {
        const filePath = `${userId}/${f.name}`;

        // Check if an analysis exists
        const { data: existing, error: eErr } = await supabase
          .from('report_analyses')
          .select('id')
          .eq('file_path', filePath)
          .limit(1);

        if (eErr) {
          console.error('Failed to query report_analyses for', filePath, eErr.message);
          continue;
        }

        if (existing && existing.length > 0) {
          console.log('Analysis already exists for', f.name, `(bucket: ${bucket})`);
          continue;
        }

        try {
          console.log('Processing', f.name, `(bucket: ${bucket})`);
          const result = await processCreditReport(filePath);
          const analysis = result.analysis || result;
          const processedAt = result.processedAt || new Date().toISOString();

          const { error: insErr } = await supabase.from('report_analyses').insert({
            user_id: userId,
            file_path: filePath,
            analysis: analysis,
            processed_at: processedAt
          });

          if (insErr) {
            console.error('Failed to insert analysis for', f.name, insErr.message);
          } else {
            processed++;
            console.log('Inserted analysis for', f.name);
          }
        } catch (err) {
          console.error('Processing failed for', f.name, err.message);
        }
      }
    } catch (err) {
      console.error(`Error listing bucket '${bucket}':`, err.message);
    }
  }

  return { processed };
}

(async () => {
  try {
    const updated = await backfillStorageLimits();
    console.log('Storage limits backfilled count:', updated);

    const { processed } = await processMissingReportsForUser(testUserId);
    console.log('Reports processed:', processed);

    // Summary check
    const { data: analyses } = await supabase
      .from('report_analyses')
      .select('id,file_path,processed_at')
      .eq('user_id', testUserId)
      .order('processed_at', { ascending: false })
      .limit(10);

    console.log('Recent analyses for user:', analyses || []);
  } catch (error) {
    console.error('Script failed:', error.message);
    process.exit(1);
  }
})();