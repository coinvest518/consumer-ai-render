// USPS Integration for Real Tracking and Delivery Confirmation
const axios = require('axios');

class USPSIntegration {
  constructor() {
    this.clientId = process.env.USPS_OAUTH_CLIENT_ID;
    this.clientSecret = process.env.USPS_OAUTH_CLIENT_SECRET;
    this.isTesting = process.env.USPS_TESTING === 'true';
    this.baseURL = this.isTesting 
      ? 'https://api-cat.usps.com' 
      : 'https://api.usps.com';
  }

  // Get OAuth token for USPS API
  async getAccessToken() {
    try {
      const response = await axios.post(`${this.baseURL}/oauth2/v3/token`, {
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'tracking'
      }, {
        headers: { 'Content-Type': 'application/json' }
      });
      return response.data.access_token;
    } catch (error) {
      console.error('USPS OAuth error:', error.message);
      return null;
    }
  }

  // Track a package and get delivery confirmation
  async trackPackage(trackingNumber) {
    if (!this.clientId || !this.clientSecret) {
      return {
        error: "USPS credentials not configured",
        fallback: `Visit https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`
      };
    }

    try {
      const token = await this.getAccessToken();
      if (!token) throw new Error('Failed to get USPS access token');

      const response = await axios.get(`${this.baseURL}/tracking/v3/tracking/${trackingNumber}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const trackingInfo = response.data;
      return this.formatTrackingResponse(trackingInfo);
    } catch (error) {
      return {
        error: error.message,
        fallback: `Visit https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
        advice: "For legal disputes, certified mail provides the best proof of delivery."
      };
    }
  }

  // Format tracking response for consumer law context
  formatTrackingResponse(trackingInfo) {
    const events = trackingInfo.trackingEvents || [];
    const latestEvent = events[0];
    
    let legalAdvice = "";
    let deliveryConfirmed = false;
    let deliveryDate = null;

    if (latestEvent) {
      const status = latestEvent.eventType?.toLowerCase();
      deliveryDate = latestEvent.eventDate;
      
      if (status?.includes('delivered')) {
        deliveryConfirmed = true;
        legalAdvice = "✅ **Delivery Confirmed!** This is solid proof for your dispute timeline. Save this tracking info.";
      } else if (status?.includes('attempted')) {
        legalAdvice = "⚠️ Delivery attempted but not completed. The legal clock may not have started yet.";
      } else if (status?.includes('transit')) {
        legalAdvice = "📦 Package in transit. Delivery confirmation will start your legal deadlines.";
      }
    }

    return {
      trackingNumber: trackingInfo.trackingNumber,
      status: latestEvent?.eventType || 'Unknown',
      deliveryDate,
      deliveryConfirmed,
      events: events.map(event => ({
        date: event.eventDate,
        time: event.eventTime,
        status: event.eventType,
        location: event.eventCity + ', ' + event.eventState
      })),
      legalAdvice,
      nextSteps: deliveryConfirmed 
        ? "Now that delivery is confirmed, calculate your response deadlines based on the delivery date."
        : "Keep monitoring. Your legal deadlines start when the recipient receives the mail."
    };
  }

  // Calculate delivery timeframes for legal planning
  static estimateDeliveryTimeframes(mailType = 'certified') {
    const today = new Date();
    
    const timeframes = {
      'certified': {
        minDays: 1,
        maxDays: 3,
        description: "Certified Mail with tracking and signature confirmation"
      },
      'priority': {
        minDays: 1,
        maxDays: 3,
        description: "Priority Mail with tracking"
      },
      'first_class': {
        minDays: 1,
        maxDays: 5,
        description: "First-Class Mail (no tracking)"
      },
      'registered': {
        minDays: 3,
        maxDays: 10,
        description: "Registered Mail (most secure, slowest)"
      }
    };

    const selected = timeframes[mailType] || timeframes['certified'];
    
    return {
      mailType,
      estimatedDelivery: {
        earliest: new Date(today.getTime() + selected.minDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        latest: new Date(today.getTime() + selected.maxDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      },
      description: selected.description,
      legalAdvice: mailType === 'certified' 
        ? "✅ Best choice for legal disputes - provides tracking and delivery confirmation"
        : "⚠️ Consider certified mail for important legal documents to ensure proof of delivery"
    };
  }

  // Generate mailing recommendations for consumer law
  static getMailingRecommendations(disputeType) {
    const recommendations = {
      'FDCPA_validation': {
        mailType: 'certified',
        returnReceipt: true,
        advice: "Send FDCPA validation requests via certified mail with return receipt. This provides proof of delivery and starts the 30-day validation period.",
        template: "Use our FDCPA validation letter template and keep copies of everything."
      },
      'FCRA_dispute': {
        mailType: 'certified',
        returnReceipt: true,
        advice: "Credit bureau disputes should be sent certified mail. Online disputes are also valid but certified mail provides better documentation.",
        template: "Include copies of supporting documents, never originals."
      },
      'cease_desist': {
        mailType: 'certified',
        returnReceipt: true,
        advice: "Cease and desist letters MUST be sent certified mail to be legally effective under FDCPA.",
        template: "Keep the certified mail receipt as proof of your request."
      }
    };

    return recommendations[disputeType] || recommendations['FDCPA_validation'];
  }
}

module.exports = USPSIntegration;