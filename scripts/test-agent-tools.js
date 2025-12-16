require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { tools, tavilyTool, createDatabaseTools } = require('../tools');
const { chatWithFallback } = require('../aiUtils');

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const userId = process.argv[2] || 'a2b91a65-12d4-42b0-98fc-1830c1002d2c';

  console.log('Building tools manifest...');

  const globalTools = (tools || []).map(t => ({ name: t.name || t.constructor?.name || 'unnamed', description: t.description || '' }));
  console.log('\nGlobal tools:');
  globalTools.forEach(t => console.log(` - ${t.name}: ${t.description}`));

  const dbTools = createDatabaseTools(supabase, userId);
  console.log('\nDatabase tools:');
  dbTools.forEach(t => console.log(` - ${t.name}: ${t.description}`));

  // Ask the AI supervisor to list the tools and how it would use them
  console.log('\nAsking AI supervisor to list available tools and usage...');

  const system = `You are ConsumerAI supervisor. The following tools are available to you:\n\n` +
    globalTools.map(t => `- ${t.name}: ${t.description}`).join('\n') + '\n' +
    dbTools.map(t => `- ${t.name}: ${t.description}`).join('\n') +
    `\n\nProvide a short numbered list describing when you'd use each tool and an example prompt for the tool.`;

  try {
    const { response } = await chatWithFallback([
      { role: 'system', content: system },
      { role: 'user', content: 'List the tools and give one example use case and example prompt for each.' }
    ]);

    const aiText = (response && (response.content || response)) || String(response || '');
    console.log('\nAI Supervisor Response:\n');
    console.log(aiText);
  } catch (err) {
    console.error('AI call failed:', err.message || err);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
