// Simple buttons for your frontend - copy these into your React components

// Button 1: Mark Mail as Delivered
const MailDeliveredButton = ({ mailId, userId }) => {
  const handleClick = async () => {
    const response = await fetch('/api/user-actions/update-mail-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: userId,
        mailId: mailId,
        status: 'delivered',
        deliveryDate: new Date().toISOString()
      })
    });
    
    if (response.ok) {
      alert('✅ Mail delivered! Reminders set automatically.');
      window.location.reload(); // Refresh to show updates
    } else {
      alert('❌ Error updating mail status');
    }
  };

  return (
    <button onClick={handleClick} style={{
      backgroundColor: '#22c55e',
      color: 'white',
      padding: '8px 16px',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer'
    }}>
      📬 Mark as Delivered
    </button>
  );
};

// Button 2: Auto Generate Follow-up
const AutoFollowupButton = ({ disputeId, userId }) => {
  const handleClick = async () => {
    const confirmed = confirm('Generate follow-up letter? This costs 5 credits.');
    if (!confirmed) return;
    
    const response = await fetch('/api/user-actions/auto-followup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: userId,
        disputeId: disputeId
      })
    });
    
    const result = await response.json();
    if (result.success) {
      alert(`✅ Follow-up sent! ${result.creditsRemaining} credits left.`);
    } else {
      alert(`❌ ${result.error}`);
    }
  };

  return (
    <button onClick={handleClick} style={{
      backgroundColor: '#3b82f6',
      color: 'white',
      padding: '8px 16px',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer'
    }}>
      🤖 Auto Follow-up (5 credits)
    </button>
  );
};

export { MailDeliveredButton, AutoFollowupButton };