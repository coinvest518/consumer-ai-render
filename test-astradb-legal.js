require('dotenv').config();

const { scrapeAndAnalyze } = require('./legalSearch');

async function testScrape() {
  const url = 'https://www.justice.gov/jm/jm-4-5000-tort-litigation';
  console.log(`Testing scrape and analysis of: ${url}`);

  try {
    const result = await scrapeAndAnalyze(url);
    console.log('Scraped content length:', result.content.length);
    console.log('Analysis length:', result.analysis.length);
    console.log('Saved to DB:', result.saved);
    console.log('\n=== SCRAPED CONTENT PREVIEW ===');
    console.log(result.content.substring(0, 1000) + '...');
    console.log('\n=== ANALYSIS ===');
    console.log(result.analysis);
  } catch (error) {
    console.error('Error:', error);
  }
}

testScrape();