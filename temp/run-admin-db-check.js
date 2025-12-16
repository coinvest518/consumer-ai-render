const fs = require('fs');

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

loadDotenv();

const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

async function run() {
  const results = { tables: {}, columns: {}, notes: [] };

  // Setup pgPool if available
  let pgPool = null;
  if (process.env.SUPABASE_POSTGRES_URL) {
    pgPool = new Pool({ connectionString: process.env.SUPABASE_POSTGRES_URL, ssl: { rejectUnauthorized: false } });
    results.notes.push('Using SUPABASE_POSTGRES_URL for direct information_schema queries');
  } else if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const url = new URL(process.env.SUPABASE_URL);
      const host = url.hostname;
      const pathname = url.pathname.replace('/', '') || 'postgres';
      pgPool = new Pool({ host, port: 5432, database: pathname, user: 'postgres', password: process.env.SUPABASE_SERVICE_ROLE_KEY, ssl: { rejectUnauthorized: false } });
      results.notes.push('Configured pgPool from SUPABASE_URL fallback');
    } catch (err) {
      results.notes.push('Failed to configure pgPool fallback: ' + err.message);
    }
  } else {
    results.notes.push('No PG connection settings found');
  }

  // Preferred: use pgPool to query information_schema
  const tableNames = ['ocr_artifacts', 'report_analyses'];
  const cols = ['ocr_artifact_id', 'doc_type'];

  if (pgPool) {
    try {
      for (const t of tableNames) {
        try {
          const q = `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS exists`;
          const r = await pgPool.query(q, [t]);
          results.tables[t] = r && r.rows && r.rows[0] && r.rows[0].exists === true;
        } catch (err) {
          results.tables[t] = false;
          results.notes.push(`information_schema query for ${t} failed: ${err.message}`);
        }
      }

      for (const c of cols) {
        try {
          const qc = `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='report_analyses' AND column_name=$1) AS exists`;
          const rc = await pgPool.query(qc, [c]);
          results.columns[c] = rc && rc.rows && rc.rows[0] && rc.rows[0].exists === true;
        } catch (err) {
          results.columns[c] = false;
          results.notes.push(`information_schema query for column ${c} failed: ${err.message}`);
        }
      }

    } catch (err) {
      results.notes.push('pgPool information_schema checks failed: ' + (err.message || err));
    } finally {
      try { await pgPool.end(); } catch (e) {}
    }
  } else {
    // Fallback: use Supabase client
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      results.notes.push('Supabase env vars not set; cannot run fallback checks');
    } else {
      const sup = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      for (const t of tableNames) {
        try {
          const { error } = await sup.from(t).select('id').limit(1);
          results.tables[t] = !error;
          if (error) results.notes.push(`Table ${t} check failed: ${error.message}`);
        } catch (err) {
          results.tables[t] = false;
          results.notes.push(`Table ${t} check error: ${err.message}`);
        }
      }

      try {
        const { error } = await sup.from('report_analyses').select('ocr_artifact_id,doc_type').limit(1);
        results.columns.ocr_artifact_id = !error;
        results.columns.doc_type = !error;
        if (error) results.notes.push(`Column select on report_analyses failed: ${error.message}`);
      } catch (err) {
        results.columns.ocr_artifact_id = false;
        results.columns.doc_type = false;
        results.notes.push(`Column select error: ${err.message}`);
      }
    }
  }

  const out = `# Admin DB Check Results\n\n` +
    `Tables:\n\n- ocr_artifacts: ${results.tables.ocr_artifacts}\n- report_analyses: ${results.tables.report_analyses}\n\nColumns:\n\n- ocr_artifact_id: ${results.columns.ocr_artifact_id}\n- doc_type: ${results.columns.doc_type}\n\nNotes:\n\n` + results.notes.map(n => `- ${n}`).join('\n') + '\n';

  fs.writeFileSync('temp/admin-db-check.md', out);
  console.log('Done. Wrote temp/admin-db-check.md');
  console.log(JSON.stringify(results, null, 2));
}

run().catch((e) => { console.error('ERROR', e.message || e); process.exit(1); });
