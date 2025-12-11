const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { TavilySearchResults } = require('@langchain/community/tools/tavily_search');
const { HumanMessage, SystemMessage } = require('@langchain/core/messages');

// Initialize the model with Gemini
const model = new ChatGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY,
  model: 'gemini-1.5-flash',
  temperature: 0.7,
});

// Initialize tools
const searchTool = new TavilySearchResults({
  maxResults: 5,
  apiKey: process.env.TAVILY_API_KEY,
});

// Create agents (simplified approach for Google AI)
async function createLegalAgent() {
  return {
    name: 'legal',
    model,
    tools: [searchTool],
    async invoke(input) {
      const response = await model.invoke([
        new SystemMessage('You are a legal research assistant specializing in consumer law. Use tools to find current legal information and provide accurate guidance.'),
        new HumanMessage(input)
      ]);
      return { content: response.content };
    }
  };
}

async function createSearchAgent() {
  return {
    name: 'search',
    model,
    tools: [searchTool],
    async invoke(input) {
      const searchResults = await searchTool.invoke(input);
      const response = await model.invoke([
        new SystemMessage('You are a research assistant. Use the provided search results to answer user questions accurately.'),
        new HumanMessage(`Search results: ${searchResults}\n\nQuestion: ${input}`)
      ]);
      return { content: response.content };
    }
  };
}

// Agent router
function routeToAgent(message) {
  const legalKeywords = ['legal', 'law', 'rights', 'dispute', 'FDCPA', 'FCRA', 'debt', 'credit', 'consumer'];
  const hasLegalKeyword = legalKeywords.some(keyword =>
    message.toLowerCase().includes(keyword.toLowerCase())
  );

  if (hasLegalKeyword) {
    return 'legal';
  }
  return 'search';
}

module.exports = { createLegalAgent, createSearchAgent, routeToAgent };