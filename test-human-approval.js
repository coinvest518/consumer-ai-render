const axios = require('axios');

// Test the human approval endpoint (now just emits socket events)
async function testHumanApproval() {
  try {
    const response = await axios.post('http://localhost:3000/api/human-approve', {
      approvalId: 'test-approval-123',
      approved: true,
      feedback: 'User approved credit report analysis'
    });

    console.log('Human approval response:', response.data);
    console.log('Socket event emitted to notify AI/user');
  } catch (error) {
    console.error('Error testing human approval:', error.response?.data || error.message);
  }
}

testHumanApproval();