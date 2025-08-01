const { ChatOpenAI } = require('@langchain/openai');
const { AgentExecutor, createOpenAIFunctionsAgent } = require('langchain/agents');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { tools } = require('./tools');

// Initialize the model
const model = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  modelName: 'gpt-4',
  temperature: 0.7,
});

// Agent prompts
const legalAgentPrompt = ChatPromptTemplate.fromMessages([
  ["system", "You are a legal research assistant specializing in consumer law. Use tools to find current legal information and provide accurate guidance."],
  ["human", "{input}"],
  new MessagesPlaceholder("agent_scratchpad"),
]);

const searchAgentPrompt = ChatPromptTemplate.fromMessages([
  ["system", "You are a research assistant. Use web search to find current, relevant information to answer user questions."],
  ["human", "{input}"],
  new MessagesPlaceholder("agent_scratchpad"),
]);

// Create agents
async function createLegalAgent() {
  const agent = await createOpenAIFunctionsAgent({
    llm: model,
    tools,
    prompt: legalAgentPrompt,
  });
  
  return new AgentExecutor({
    agent,
    tools,
    verbose: false,
  });
}

async function createSearchAgent() {
  const agent = await createOpenAIFunctionsAgent({
    llm: model,
    tools: [tools[0]], // Only Tavily search
    prompt: searchAgentPrompt,
  });
  
  return new AgentExecutor({
    agent,
    tools: [tools[0]],
    verbose: false,
  });
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