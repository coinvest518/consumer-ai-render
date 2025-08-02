// Test OpenAI API key
const { ChatOpenAI } = require('@langchain/openai');

async function testOpenAI() {
  try {
    console.log('Testing OpenAI API key...');
    console.log('API Key exists:', !!process.env.OPENAI_API_KEY);
    console.log('API Key prefix:', process.env.OPENAI_API_KEY?.substring(0, 10) + '...');
    
    const model = new ChatOpenAI({
      openAIApiKey: process.env.OPENAI_API_KEY,
      modelName: 'gpt-3.5-turbo', // Use cheaper model for testing
      temperature: 0.7,
    });
    
    const response = await model.invoke([{ role: 'user', content: 'Hello' }]);
    console.log('OpenAI Response:', response.content);
    console.log('✅ OpenAI API key is working!');
  } catch (error) {
    console.error('❌ OpenAI API Error:', error.message);
    if (error.message.includes('429')) {
      console.log('💡 This is a quota/billing issue, not a code issue');
    }
  }
}

testOpenAI();