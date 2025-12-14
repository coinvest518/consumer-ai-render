const { uspsTrackingTool, genericTrackingTool } = require('./trackingTools');

async function testTracking() {
  console.log('Testing USPS Tracking Tool...\n');
  
  // Test with a sample tracking number
  const testTrackingNumber = '9400109699937003284409';
  
  try {
    console.log('1. Testing USPS API tracking:');
    const uspsResult = await uspsTrackingTool.invoke(testTrackingNumber);
    console.log('USPS Result:', uspsResult);
    console.log('\n');
  } catch (error) {
    console.log('USPS API Error:', error.message);
    console.log('\n');
  }
  
  try {
    console.log('2. Testing generic tracking guidance:');
    const genericResult = await genericTrackingTool.invoke(testTrackingNumber);
    console.log('Generic Result:', genericResult);
    console.log('\n');
  } catch (error) {
    console.log('Generic tracking error:', error.message);
  }
  
  console.log('3. Environment check:');
  console.log('USPS_OAUTH_CLIENT_ID:', process.env.USPS_OAUTH_CLIENT_ID ? 'Present' : 'Missing');
  console.log('USPS_OAUTH_CLIENT_SECRET:', process.env.USPS_OAUTH_CLIENT_SECRET ? 'Present' : 'Missing');
}

testTracking().catch(console.error);