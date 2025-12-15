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
  const model = new ChatGoogleGenerativeAI({
    apiKey: process.env.GOOGLE_API_KEY,
    model: 'gemini-2.5-flash',
    temperature: 0.7
  });

  const modelWithTools = model.bindTools(dbTools);

  const messages = [
    new SystemMessage(
      'You are ConsumerAI. You have database tools to query user files. ' +
      'When user asks about their files, use get_user_files tool to check database.'
    ),
    new HumanMessage('Can you get my credit reports?')
  ];

  console.log('Sending message to AI: "Can you get my credit reports?"');
  
  try {
    const response = await modelWithTools.invoke(messages);
    console.log('\nAI Response:');
    console.log('Content:', response.content);
    console.log('Tool Calls:', response.tool_calls);
    
    if (response.tool_calls && response.tool_calls.length > 0) {
      console.log('\n✅ AI called tools!');
      response.tool_calls.forEach(call => {
        console.log(`   - Tool: ${call.name}`);
        console.log(`   - Args: ${JSON.stringify(call.args)}`);
      });
    } else {
      console.log('\n⚠️ AI did not call any tools');
    }
  } catch (error) {
    console.log('❌ Error:', error.message);
  }

  console.log('\n=== Test Complete ===');
}

testDatabaseTools().catch(console.error);
