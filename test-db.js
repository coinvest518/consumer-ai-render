require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const sup = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  try {
    const a = await sup.from('ocr_artifacts').select('id').limit(1);
    console.log('OCR_ARTIFACTS:', JSON.stringify({ error: a.error ? a.error.message : null, dataCount: a.data ? a.data.length : null }));
    
    const b = await sup.from('report_analyses').select('id').limit(1);
    console.log('REPORT_ANALYSES:', JSON.stringify({ error: b.error ? b.error.message : null, dataCount: b.data ? b.data.length : null }));
    
    const c = await sup.from('report_analyses').select('ocr_artifact_id,doc_type').limit(1);
    console.log('REPORT_ANALYSES_COLS:', JSON.stringify({ error: c.error ? c.error.message : null, dataCount: c.data ? c.data.length : null }));
  } catch (e) {
    console.error('EX', e.message || e);
  }
})();
