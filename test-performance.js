// Quick performance test for the optimized API
const { processMessage } = require('./api');

async function testPerformance() {
  console.log('Testing optimized AI chat performance...\n');
  
  const testMessages = [
    'Hello',
    'What can you do?',
    'Help me with a credit dispute',
    'Hello', // Should use cache
    'What are my rights under FDCPA?'
  ];
  
  for (let i = 0; i < testMessages.length; i++) {
    const message = testMessages[i];
    const start = Date.now();
    
    try {
      console.log(`Test ${i + 1}: "${message}"`);
      const response = await processMessage(message, 'test-session');
      const duration = Date.now() - start;
      
      console.log(`✓ Response (${duration}ms): ${response.message.substring(0, 100)}...`);
      console.log(`  Agent used: ${response.decisionTrace.usedAgent}`);
      console.log(`  Steps: ${response.decisionTrace.steps.join(', ')}\n`);
    } catch (error) {
      console.log(`✗ Error (${Date.now() - start}ms): ${error.message}\n`);
    }
  }
}

if (require.main === module) {
  testPerformance().catch(console.error);
}

module.exports = { testPerformance };