const axios = require('axios');
const { DynamicTool } = require('@langchain/core/tools');

// USPS OAuth token management
let uspsAccessToken = null;
let tokenExpiry = null;

async function getUSPSAccessToken() {
  if (uspsAccessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return uspsAccessToken;
  }
  
  try {
    const response = await axios.post('https://api.usps.com/oauth2/v3/token', {
      grant_type: 'client_credentials',
      client_id: process.env.USPS_OAUTH_CLIENT_ID,
      client_secret: process.env.USPS_OAUTH_CLIENT_SECRET,
      scope: 'tracking'
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    uspsAccessToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000; // 1 minute buffer
    return uspsAccessToken;
  } catch (error) {
    console.error('USPS OAuth error:', error.message);
    throw new Error('Failed to authenticate with USPS API');
  }
}

// USPS tracking tool
const uspsTrackingTool = new DynamicTool({
  name: "track_usps_mail",
  description: "Track USPS certified mail and package delivery status using tracking number",
  func: async (trackingNumber) => {
    try {
      if (!process.env.USPS_OAUTH_CLIENT_ID || !process.env.USPS_OAUTH_CLIENT_SECRET) {
        return 'USPS tracking is not configured. Please provide your tracking number and visit usps.com to track your package manually.';
      }
      
      const token = await getUSPSAccessToken();
      
      const response = await axios.get(`https://api.usps.com/tracking/v3/tracking/${trackingNumber}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      const trackingData = response.data;
      if (trackingData && trackingData.trackingEvents) {
        const events = trackingData.trackingEvents.map(event => 
          `${event.eventDate} - ${event.eventDescription} at ${event.eventCity}, ${event.eventState}`
        ).join('\n');
        
        return `Tracking ${trackingNumber}:\n${events}`;
      } else {
        return `Tracking number ${trackingNumber} found but no detailed events available. Current status: ${trackingData.status || 'Unknown'}`;
      }
    } catch (error) {
      if (error.response?.status === 404) {
        return `Tracking number ${trackingNumber} not found. Please verify the tracking number is correct.`;
      }
      return `Unable to track ${trackingNumber} at this time. Please try again later or visit usps.com directly.`;
    }
  }
});

// Generic tracking tool (fallback)
const genericTrackingTool = new DynamicTool({
  name: "track_mail_generic",
  description: "Provide tracking guidance when specific tracking tools are unavailable",
  func: async (input) => {
    try {
      let trackingNumber, carrier;
      
      if (typeof input === 'string') {
        // Try to extract tracking number from string
        const match = input.match(/\b[A-Z0-9]{10,}\b/);
        trackingNumber = match ? match[0] : 'N/A';
        carrier = 'USPS';
      } else {
        const parsed = JSON.parse(input);
        trackingNumber = parsed.trackingNumber;
        carrier = parsed.carrier || 'USPS';
      }
      
      return `To track your ${carrier} package ${trackingNumber}:\n\n` +
             `1. Visit ${carrier === 'USPS' ? 'usps.com' : 'the carrier website'}\n` +
             `2. Enter tracking number: ${trackingNumber}\n` +
             `3. View real-time status updates\n\n` +
             `For certified mail, you can also call USPS at 1-800-ASK-USPS (1-800-275-8777) with your tracking number.`;
    } catch (error) {
      return `To track your mail or package:\n\n` +
             `1. Locate your tracking number (usually on your receipt)\n` +
             `2. Visit usps.com for USPS packages\n` +
             `3. Enter the tracking number in the tracking field\n` +
             `4. View delivery status and updates`;
    }
  }
});

module.exports = { uspsTrackingTool, genericTrackingTool, getUSPSAccessToken };