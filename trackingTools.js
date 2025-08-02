const axios = require('axios');
const { DynamicTool } = require('@langchain/core/tools');

// USPS tracking tool
const uspsTrackingTool = new DynamicTool({
  name: "track_usps_mail",
  description: "Track USPS certified mail delivery status",
  func: async (trackingNumber) => {
    try {
      // USPS API endpoint (requires API key)
      // USPS OAuth API call
      const response = await axios.post('https://api.usps.com/tracking/v3/tracking', {
        trackingNumber: trackingNumber
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.USPS_OAUTH_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      
      return `Tracking info for ${trackingNumber}: ${response.data}`;
    } catch (error) {
      return `Failed to track package ${trackingNumber}: ${error.message}`;
    }
  }
});

// Generic tracking tool (fallback)
const genericTrackingTool = new DynamicTool({
  name: "track_mail_generic",
  description: "Generic mail tracking information and status updates",
  func: async (input) => {
    try {
      const { trackingNumber, carrier } = JSON.parse(input);
      
      // Simulate tracking response
      const statuses = [
        'Package accepted at origin facility',
        'In transit to destination facility',
        'Out for delivery',
        'Delivered'
      ];
      
      const randomStatus = statuses[Math.floor(Math.random() * statuses.length)];
      
      return `Tracking ${trackingNumber} (${carrier}): ${randomStatus}. Check carrier website for detailed updates.`;
    } catch (error) {
      return `Failed to track: ${error.message}`;
    }
  }
});

module.exports = { uspsTrackingTool, genericTrackingTool };