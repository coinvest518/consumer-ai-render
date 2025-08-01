const { TavilySearchResults } = require('@langchain/community/tools/tavily_search');
const { DynamicTool } = require('@langchain/core/tools');

// Initialize Tavily search tool
const tavilyTool = new TavilySearchResults({
  maxResults: 5,
  apiKey: process.env.TAVILY_API_KEY,
});

// Legal case lookup tool
const legalCaseTool = new DynamicTool({
  name: "legal_case_lookup",
  description: "Search for specific legal cases, statutes, or regulations",
  func: async (query) => {
    try {
      const searchQuery = `legal case ${query} consumer law FDCPA FCRA`;
      const results = await tavilyTool.invoke(searchQuery);
      return results;
    } catch (error) {
      return `Error searching legal cases: ${error.message}`;
    }
  },
});

// Consumer rights tool
const consumerRightsTool = new DynamicTool({
  name: "consumer_rights_search",
  description: "Search for current consumer rights information and recent legal updates",
  func: async (query) => {
    try {
      const searchQuery = `consumer rights ${query} 2024 legal updates`;
      const results = await tavilyTool.invoke(searchQuery);
      return results;
    } catch (error) {
      return `Error searching consumer rights: ${error.message}`;
    }
  },
});

// Credit dispute tool
const creditDisputeTool = new DynamicTool({
  name: "credit_dispute_info",
  description: "Get current information about credit dispute processes and requirements",
  func: async (query) => {
    try {
      const searchQuery = `credit dispute ${query} FCRA process 2024`;
      const results = await tavilyTool.invoke(searchQuery);
      return results;
    } catch (error) {
      return `Error searching credit dispute info: ${error.message}`;
    }
  },
});

const tools = [tavilyTool, legalCaseTool, consumerRightsTool, creditDisputeTool];

module.exports = { tools, tavilyTool };