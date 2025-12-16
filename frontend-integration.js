// Frontend integration examples for automation triggers

// 1. Simple button to mark mail as delivered
const MailTrackingButton = ({ mailId, userId }) => {
  const handleMarkDelivered = async () => {
    try {
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
      
      const result = await response.json();
      if (result.success) {
        alert('✅ Mail marked as delivered! Deadlines created automatically.');
        // Refresh the page or update state
        window.location.reload();
      }
    } catch (error) {
      alert('❌ Error updating mail status');
    }
  };

  return (
    <button onClick={handleMarkDelivered} className="btn-primary">
      📬 Mark as Delivered
    </button>
  );
};

// 2. Auto follow-up button
const AutoFollowUpButton = ({ disputeId, userId }) => {
  const handleAutoFollowUp = async () => {
    try {
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
        alert(`✅ Follow-up letter sent! ${result.creditsRemaining} credits remaining.`);
      } else {
        alert(`❌ ${result.error}`);
      }
    } catch (error) {
      alert('❌ Error generating follow-up');
    }
  };

  return (
    <button onClick={handleAutoFollowUp} className="btn-secondary">
      🤖 Auto-Generate Follow-Up (5 credits)
    </button>
  );
};

// 3. Set reminder button
const SetReminderButton = ({ userId }) => {
  const handleSetReminder = async () => {
    const title = prompt('Reminder title:');
    const days = prompt('Days from now:');
    
    if (title && days) {
      try {
        const response = await fetch('/api/user-actions/set-reminder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: userId,
            title: title,
            days: parseInt(days),
            description: 'User-created reminder'
          })
        });
        
        const result = await response.json();
        if (result.success) {
          alert(`✅ Reminder set for ${new Date(result.reminderDate).toLocaleDateString()}`);
        }
      } catch (error) {
        alert('❌ Error setting reminder');
      }
    }
  };

  return (
    <button onClick={handleSetReminder} className="btn-outline">
      ⏰ Set Reminder
    </button>
  );
};

// 4. Get user timeline
const TimelineComponent = ({ userId }) => {
  const [events, setEvents] = useState([]);
  
  useEffect(() => {
    const fetchTimeline = async () => {
      try {
        const response = await fetch(`/api/user-actions/get-timeline?userId=${userId}`);
        const result = await response.json();
        setEvents(result.events || []);
      } catch (error) {
        console.error('Error fetching timeline:', error);
      }
    };
    
    fetchTimeline();
  }, [userId]);

  return (
    <div className="timeline">
      <h3>📅 Upcoming Deadlines</h3>
      {events.map(event => (
        <div key={event.id} className="timeline-item">
          <strong>{event.title}</strong>
          <p>{event.description}</p>
          <small>{new Date(event.event_date).toLocaleDateString()}</small>
        </div>
      ))}
    </div>
  );
};

// Export components for use in your app
export { 
  MailTrackingButton, 
  AutoFollowUpButton, 
  SetReminderButton, 
  TimelineComponent 
};