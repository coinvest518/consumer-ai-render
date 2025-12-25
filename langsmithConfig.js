/**
 * LangSmith Configuration and Initialization
 * 
 * This module initializes LangSmith tracing for all LangChain operations.
 * LangSmith provides observability, tracing, and debugging capabilities.
 * 
 * Environment variables required:
 * - LANGSMITH_API_KEY: Your LangSmith API key (starts with 'lsv2_')
 * - LANGSMITH_ENDPOINT: https://api.smith.langchain.com (default)
 * - LANGSMITH_PROJECT: consumer-ai-project
 * - LANGSMITH_TRACING: true (must be 'true' or 'true' string)
 * - LANGSMITH_WORKSPACE_ID: Your workspace ID (for org-scoped keys)
 */

const dotenv = require('dotenv');

// Load environment variables first
dotenv.config();

// Initialize LangSmith tracing
function initializeLangSmith() {
  const {
    LANGSMITH_API_KEY,
    LANGSMITH_ENDPOINT,
    LANGSMITH_PROJECT,
    LANGSMITH_TRACING,
    LANGSMITH_WORKSPACE_ID
  } = process.env;

  console.log('\n📊 LangSmith Configuration Status:');
  console.log('  - LANGSMITH_API_KEY:', LANGSMITH_API_KEY ? '✅ Set' : '❌ Missing');
  console.log('  - LANGSMITH_ENDPOINT:', LANGSMITH_ENDPOINT ? `✅ Set (${LANGSMITH_ENDPOINT})` : '⚠️  Using default (https://api.smith.langchain.com)');
  console.log('  - LANGSMITH_PROJECT:', LANGSMITH_PROJECT ? `✅ Set (${LANGSMITH_PROJECT})` : '❌ Missing');
  console.log('  - LANGSMITH_TRACING:', LANGSMITH_TRACING ? `✅ Enabled (${LANGSMITH_TRACING})` : '❌ Disabled');
  console.log('  - LANGSMITH_WORKSPACE_ID:', LANGSMITH_WORKSPACE_ID ? '✅ Set' : '⚠️  Optional (required for org-scoped keys)');

  // Validate required settings
  if (!LANGSMITH_API_KEY) {
    console.error('❌ ERROR: LANGSMITH_API_KEY is not set. LangSmith tracing will NOT work.');
    console.error('   Please add LANGSMITH_API_KEY to your .env file');
    return false;
  }

  if (LANGSMITH_TRACING !== 'true') {
    console.warn('⚠️  WARNING: LANGSMITH_TRACING is not set to "true". Tracing may not be enabled.');
    console.warn('   Please set LANGSMITH_TRACING=true in your .env file');
    return false;
  }

  if (!LANGSMITH_PROJECT) {
    console.error('❌ ERROR: LANGSMITH_PROJECT is not set. Please add it to your .env file');
    return false;
  }

  console.log('✅ LangSmith configuration is valid\n');
  return true;
}

// Set up LangSmith tracing for LangChain models
async function configureTracingForModels(model) {
  if (!model) {
    console.warn('⚠️  Model is null - cannot configure tracing');
    return model;
  }

  // LangChain models automatically use LangSmith when environment variables are set
  // If LANGSMITH_TRACING=true and LANGSMITH_API_KEY are set, tracing is automatically enabled
  
  console.log('✅ Model configured for LangSmith tracing (automatic via environment variables)');
  return model;
}

// Wrap functions for manual tracing (for custom code outside LangChain)
function createLangSmithRunConfig(name, description = '', metadata = {}) {
  return {
    run_name: name,
    description,
    metadata: {
      ...metadata,
      component: 'consumer-ai',
      service: 'credit-report-analysis'
    },
    tags: ['consumer-ai', 'credit-analysis', name.toLowerCase()]
  };
}

// Example of how to use LangSmith with custom functions
async function traceFunctionWithLangSmith(functionName, asyncFn, ...args) {
  if (process.env.LANGSMITH_TRACING !== 'true') {
    // If tracing is disabled, just run the function
    return await asyncFn(...args);
  }

  try {
    const { Client } = require('langsmith');
    const client = new Client();
    
    return await client.runWithTracing(asyncFn, {
      name: functionName,
      run_type: 'llm',
      inputs: { args: args.length > 0 ? args : {} }
    });
  } catch (error) {
    console.error(`Error with LangSmith tracing for ${functionName}:`, error.message);
    // Fallback: run without tracing
    return await asyncFn(...args);
  }
}

// Initialize on module load
const langSmithReady = initializeLangSmith();

module.exports = {
  initializeLangSmith,
  configureTracingForModels,
  createLangSmithRunConfig,
  traceFunctionWithLangSmith,
  langSmithReady
};
