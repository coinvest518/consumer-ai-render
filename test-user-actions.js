// Test the new user action endpoints
async function testUserActions() {
  console.log('🧪 Testing User Action Endpoints...\n');
  
  const testUserId = 'test-user-123';
  const baseUrl = 'http://localhost:3001/api';
  
  try {
    // Test 1: Mail letter tracking
    console.log('1. Testing mail letter tracking...');
    const mailResponse = await fetch(`${baseUrl}/user-actions/mailed-letter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: testUserId,
        letterType: 'FCRA Dispute',
        mailedDate: '2024-12-15',
        recipient: 'Equifax'
      })
    });
    
    if (mailResponse.ok) {
      const result = await mailResponse.json();
      console.log('✅ Mail tracking works:', result.message);
    } else {
      console.log('❌ Mail tracking failed');
    }
    
    // Test 2: Set reminder
    console.log('\n2. Testing set reminder...');
    const reminderResponse = await fetch(`${baseUrl}/user-actions/set-reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: testUserId,
        title: 'Check credit report',
        days: 7,
        description: 'Weekly credit report check'
      })
    });
    
    if (reminderResponse.ok) {
      const result = await reminderResponse.json();
      console.log('✅ Reminder works:', result.message);
    } else {
      console.log('❌ Reminder failed');
    }
    
    // Test 3: Get timeline
    console.log('\n3. Testing get timeline...');
    const timelineResponse = await fetch(`${baseUrl}/user-actions/get-timeline?userId=${testUserId}`);
    
    if (timelineResponse.ok) {
      const result = await timelineResponse.json();
      console.log('✅ Timeline works:', `${result.events.length} events found`);
    } else {
      console.log('❌ Timeline failed');
    }
    
  } catch (error) {
    console.error('Test error:', error.message);
  }
}

// Run test if server is running
testUserActions();