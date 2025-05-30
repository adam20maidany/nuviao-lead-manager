const axios = require('axios');

class RetellService {
  constructor() {
    this.apiKey = process.env.RETELL_API_KEY;
    this.agentId = process.env.RETELL_AGENT_ID;
    this.baseURL = 'https://api.retellai.com/v2';
  }

  async initiateCall(callData) {
    try {
      console.log(`📞 Initiating Retell call to ${callData.customer_number}`);
      
      const response = await axios.post(`${this.baseURL}/create-phone-call`, {
        from_number: callData.from_number,
        to_number: callData.customer_number,
        agent_id: this.agentId,
        metadata: callData.metadata || {}
      }, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      console.log(`✅ Retell call initiated: ${response.data.call_id}`);
      return response.data;

    } catch (error) {
      console.error('❌ Retell call failed:', error.response?.data || error.message);
      throw error;
    }
  }

  extractOutcome(callAnalysis) {
    if (!callAnalysis?.summary) return 'no_answer';
    
    const summary = callAnalysis.summary.toLowerCase();
    
    if (summary.includes('appointment') || summary.includes('scheduled') || summary.includes('booked')) {
      return 'booked';
    }
    if (summary.includes('not interested') || summary.includes('no thank you')) {
      return 'dead';
    }
    if (summary.includes('call back') || summary.includes('later')) {
      return 'follow_up';
    }
    
    return 'follow_up';
  }
}

module.exports = RetellService;