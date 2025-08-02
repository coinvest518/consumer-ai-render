// Instructions to re-enable tools once OpenAI quota is fixed

// 1. Fix OpenAI API key/billing
// 2. Uncomment these lines in api.js:
//    aiResponse = await chatModel.invoke(history);

// 3. Uncomment in agents/supervisor.js:
//    const results = await searchTool.invoke(message);

// 4. Re-enable embedding in legalSearch.js:
//    return actual embedding generation

console.log('Tools are disabled to prevent quota errors');
console.log('Fix OpenAI billing first, then re-enable functionality');