require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { createDatabaseTools } = require('./tools');

// Test database tools with AI
async function testDatabaseTools() {
  console.log('=== Testing Database Tools ===\n');

  // Initialize Supabase
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Get a real user ID from database
  console.log('Finding a user with uploaded files...');
  const { data: users } = await supabase
    .from('report_analyses')
    .select('user_id')
    .limit(1);
  
  if (!users || users.length === 0) {
    console.log('❌ No users with files found in database');
    return;
  }
  
  const testUserId = users[0].user_id;
  console.log(`✅ Using user ID: ${testUserId}\n`);

  console.log('\n1. Testing get_user_files tool directly...');
  const dbTools = createDatabaseTools(supabase, testUserId);
  
  if (dbTools.length === 0) {
    console.log('❌ No tools created - check supabase and userId');
    return;
  }

  console.log(`✅ Created ${dbTools.length} database tools`);
  dbTools.forEach(tool => console.log(`   - ${tool.name}: ${tool.description}`));

  // Test tool directly
  console.log('\n2. Calling get_user_files tool...');
  try {
    const result = await dbTools[0].func({});
    console.log('Result:', result);
  } catch (error) {
    console.log('Error:', error.message);
  }

  // Test with AI
  console.log('\n3. Testing AI with database tools...');
  // Use centralized fallback for AI testing and call database tool directly to verify
  const { chatWithFallback } = require('./aiUtils');

  const messages = [
    new SystemMessage(
      'You are ConsumerAI. You have database tools to query user files. ' +
      'When user asks about their files, check the database and respond concisely.'
    ),
    new HumanMessage('Can you get my credit reports?')
  ];

  console.log('Sending message to AI: "Can you get my credit reports?"');
  try {
    const { response } = await chatWithFallback(messages);
    const content = response && (response.content || response) ? (response.content || response) : '';
    console.log('\nAI Response:');
    console.log('Content:', content);
  } catch (error) {
    console.log('❌ Error:', error.message);
  }

  // Also test the DB tool directly
  console.log('\nTesting DB tool directly:');
  try {
    const result = await dbTools[0].func({});
    console.log('DB tool result:', result);
  } catch (error) {
    console.log('DB tool error:', error.message);
  }

  console.log('\n=== Test Complete ===');
}

testDatabaseTools().catch(console.error);
