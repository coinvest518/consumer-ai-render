require('dotenv').config();
const { saveOcrArtifact } = require('./reportProcessor');

(async () => {
  try {
    console.log('Testing OCR artifact save...');
    const testUserId = 'a2b91a65-12d4-42b0-98fc-1830c1002d2c';
    const testPages = [{ page: 1, markdown: '# Test OCR\nSample text' }];
    
    const id = await saveOcrArtifact(testUserId, 'test/path.pdf', 'test.pdf', testPages);
    console.log('✅ OCR artifact saved with ID:', id);
  } catch (err) {
    console.error('❌ Test failed:', err.message);
  }
})();
