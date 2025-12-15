const { TavilySearch } = require('@langchain/tavily');
const { DynamicTool } = require('@langchain/core/tools');

// Initialize Tavily search tool
const tavilyTool = new TavilySearch({
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

// Database access tools for AI agents
function createDatabaseTools(supabase, userId) {
  if (!supabase || !userId) return [];

  const getUserFilesTool = new DynamicTool({
    name: 'get_user_files',
    description: 'Query database to get user uploaded credit report files with names, dates, and analysis status',
    func: async () => {
      const { data, error } = await supabase
        .from('report_analyses')
        .select('file_name, file_path, processed_at, analysis')
        .eq('user_id', userId)
        .order('processed_at', { ascending: false })
        .limit(10);

      if (error) return `Error: ${error.message}`;
      if (!data || data.length === 0) return 'No files found. User has not uploaded any credit reports yet.';

      return data.map((f, i) => {
        const v = f.analysis?.violations?.length || 0;
        const e = f.analysis?.errors?.length || 0;
        const s = f.analysis ? 'analyzed' : 'processing';
        const d = new Date(f.processed_at).toLocaleDateString();
        return `${i + 1}. ${f.file_name} (${d}) - ${s} - ${v} violations, ${e} errors`;
      }).join('\n');
    }
  });

  const getFileAnalysisTool = new DynamicTool({
    name: 'get_file_analysis',
    description: 'Get detailed analysis of specific credit report file by name',
    func: async (fileName) => {
      const { data, error } = await supabase
        .from('report_analyses')
        .select('*')
        .eq('user_id', userId)
        .ilike('file_name', `%${fileName}%`)
        .order('processed_at', { ascending: false })
        .limit(1)
        .single();

      if (error) return `File "${fileName}" not found.`;
      if (!data.analysis) return `File "${data.file_name}" still processing.`;

      return data.analysis.detailed_analysis || data.analysis.summary || JSON.stringify(data.analysis, null, 2);
    }
  });

  return [getUserFilesTool, getFileAnalysisTool];
}

const tools = [tavilyTool, legalCaseTool, consumerRightsTool, creditDisputeTool];

module.exports = { tools, tavilyTool };