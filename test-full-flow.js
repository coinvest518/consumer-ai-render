require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const sup = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  
  // Check if report_analyses has ocr_artifact_id column
  const { data, error } = await sup.from('report_analyses').select('id,ocr_artifact_id,doc_type').limit(1);
  console.log('report_analyses with ocr_artifact_id:', JSON.stringify({ error: error?.message, data }, null, 2));
  
  // Check ocr_artifacts table
  const { data: ocrData, error: ocrError } = await sup.from('ocr_artifacts').select('*').limit(1);
  console.log('\nocr_artifacts data:', JSON.stringify({ error: ocrError?.message, count: ocrData?.length }, null, 2));
})();
