require('dotenv').config();
const { processDocument } = require('../reportProcessor');

const filePath = process.argv[2] || 'credit-reports/a2b91a65-12d4-42b0-98fc-1830c1002d2c/1765470627620-f7u5b7gp12a.pdf';
const userId = process.argv[3] || 'a2b91a65-12d4-42b0-98fc-1830c1002d2c';

async function main() {
  console.log('🔎 Running document analysis test for file:', filePath);
  try {
    const res = await processDocument(filePath);
    console.log('\n✅ Analysis result (truncated fields shown):');
    // Print a concise summary for quick inspection
    console.log('Document type:', res.docType);
    console.log('Processed at:', res.processedAt);
    console.log('Extracted text length:', (res.extractedText || '').length);
    if (res.ocrPages) console.log('OCR pages:', res.ocrPages.length);
    console.log('OCR artifact id:', res.ocr_artifact_id || null);
    console.log('\nFull analysis JSON:\n');
    console.log(JSON.stringify(res.analysis, null, 2));
    console.log('\nFull result object (for debugging):\n');
    console.log(JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  }
}

main();