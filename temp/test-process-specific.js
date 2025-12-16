(async () => {
  try {
    const { processCreditReport } = require('./reportProcessor');
    const filePath = 'credit-reports/a2b91a65-12d4-420b-98fc-1830c1002d2c/1765468526191-c8l0wxbcrbi.pdf';
    console.log('Processing specific file path:', filePath);
    const result = await processCreditReport(filePath);
    console.log('Result:', JSON.stringify(result.analysis || result, null, 2).substring(0, 1000));
  } catch (err) {
    console.error('Error:', err.message || err);
  }
})();