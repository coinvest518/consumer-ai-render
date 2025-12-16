// Quick fix for the frontend .join() error
// Add this defensive programming to your chat response handling

// Example of safe response processing
function safeProcessChatResponse(response) {
  try {
    // Ensure response exists
    if (!response) {
      console.warn('No response received');
      return '';
    }

    // Handle different response structures safely
    const message = response.message || response.data?.message || '';
    
    // If you're processing arrays, always check they exist
    const steps = response.decisionTrace?.steps || [];
    const safeSteps = Array.isArray(steps) ? steps.join(' → ') : '';
    
    // If you're processing violations/errors arrays
    const violations = response.analysis?.violations || [];
    const errors = response.analysis?.errors || [];
    
    const violationsList = Array.isArray(violations) ? violations.join(', ') : '';
    const errorsList = Array.isArray(errors) ? errors.join(', ') : '';
    
    return {
      message,
      steps: safeSteps,
      violations: violationsList,
      errors: errorsList
    };
    
  } catch (error) {
    console.error('Error processing chat response:', error);
    return { message: 'Error processing response', steps: '', violations: '', errors: '' };
  }
}

// Example of safe Socket.IO event handling
function setupSafeSocketHandlers(socket) {
  socket.on('agent-step', (data) => {
    try {
      const steps = (data?.steps || []);
      const safeSteps = Array.isArray(steps) ? steps.join(' → ') : '';
      console.log('Agent steps:', safeSteps);
    } catch (error) {
      console.error('Error in agent-step handler:', error);
    }
  });
  
  socket.on('analysis-complete', (data) => {
    try {
      const violations = (data?.analysis?.violations || []);
      const errors = (data?.analysis?.errors || []);
      
      const violationCount = Array.isArray(violations) ? violations.length : 0;
      const errorCount = Array.isArray(errors) ? errors.length : 0;
      
      console.log(`Analysis complete: ${violationCount} violations, ${errorCount} errors`);
    } catch (error) {
      console.error('Error in analysis-complete handler:', error);
    }
  });
}

// Export for use in your frontend
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { safeProcessChatResponse, setupSafeSocketHandlers };
}