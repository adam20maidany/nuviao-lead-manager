const express = require('express');
const router = express.Router();
const axios = require('axios');

// GHL Bridge - receives contact data from GHL and triggers AI calling
router.post('/ghl-bridge/bestbuyremodel', async (req, res) => {
  try {
    console.log('🔗 GHL Bridge received data:', req.body);
    
    // Extract lead data from GHL
    const leadData = {
      name: req.body.full_name || req.body.firstName + ' ' + req.body.lastName || 'Unknown',
      phone: req.body.phone,
      email: req.body.email,
      source: 'ghl',
      ghl_contact_id: req.body.contact_id || req.body.id
    };

    // Validate required fields
    if (!leadData.name || !leadData.phone) {
      console.error('❌ Missing required fields:', leadData);
      return res.status(400).json({ 
        error: 'Missing required fields: name and phone' 
      });
    }

    console.log(`📞 Processing lead: ${leadData.name} - ${leadData.phone}`);

    // Save lead to Supabase (if available)
    let savedLead = null;
    if (global.supabase) {
      try {
        const { data, error } = await global.supabase
          .from('leads')
          .insert({
            client_id: 1, // Best Buy Remodel
            name: leadData.name,
            phone: leadData.phone,
            email: leadData.email,
            source: leadData.source,
            status: 'new',
            custom_fields: {
              ghl_contact_id: leadData.ghl_contact_id
            }
          })
          .select()
          .single();

        if (error) {
          console.error('Database error:', error);
        } else {
          savedLead = data;
          console.log(`✅ Lead saved to database: ID ${savedLead.id}`);
        }
      } catch (dbError) {
        console.error('Database save failed:', dbError);
      }
    }

    // Initiate AI call via Retell
    const callResult = await initiateAICall(leadData, savedLead?.id);
    
    if (callResult.success) {
      console.log(`✅ AI call initiated successfully for ${leadData.name}`);
      res.json({ 
        success: true, 
        message: 'Lead processed and AI call initiated',
        lead_id: savedLead?.id,
        call_id: callResult.call_id
      });
    } else {
      console.error(`❌ AI call failed for ${leadData.name}:`, callResult.error);
      res.json({ 
        success: false, 
        message: 'Lead saved but AI call failed',
        lead_id: savedLead?.id,
        error: callResult.error
      });
    }

  } catch (error) {
    console.error('❌ GHL Bridge error:', error);
    res.status(500).json({ error: 'Failed to process GHL lead' });
  }
});

// Function to initiate AI call via Retell
async function initiateAICall(leadData, leadId) {
  try {
    if (!process.env.RETELL_API_KEY || !process.env.RETELL_AGENT_ID) {
      return { success: false, error: 'Retell not configured' };
    }

    console.log(`📞 Calling Retell AI for ${leadData.name} at ${leadData.phone}`);
    
    const response = await axios.post('https://api.retellai.com/v2/create-phone-call', {
      from_number: '+17252092232',
      to_number: leadData.phone,
      agent_id: process.env.RETELL_AGENT_ID,
      metadata: {
        lead_id: leadId,
        ghl_contact_id: leadData.ghl_contact_id,
        first_name: leadData.name.split(' ')[0],
        full_name: leadData.name,
        phone: leadData.phone,
        email: leadData.email || ''
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.RETELL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return { 
      success: true, 
      call_id: response.data.call_id 
    };

  } catch (error) {
    return { 
      success: false, 
      error: error.response?.data || error.message 
    };
  }
}

// Retell webhook - handles call outcomes
router.post('/retell/bestbuyremodel', async (req, res) => {
  try {
    console.log('🤖 Retell webhook received:', req.body.event_type);
    
    if (req.body.event_type === 'call_ended') {
      const { call_id, call_analysis, metadata } = req.body;
      
      // Determine call outcome
      const outcome = determineCallOutcome(call_analysis);
      console.log(`📞 Call ${call_id} ended with outcome: ${outcome}`);
      
      // Save call result to database
      if (global.supabase && metadata?.lead_id) {
        await saveCallResult(metadata.lead_id, {
          retell_call_id: call_id,
          outcome: outcome,
          duration: req.body.call_duration || 0,
          transcript: req.body.transcript || '',
          ai_summary: call_analysis?.summary || ''
        });
      }

      // TODO: Update GHL contact with outcome
      // TODO: Schedule follow-up calls if needed
      
      console.log(`✅ Call outcome processed: ${outcome}`);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Retell webhook error:', error);
    res.status(500).json({ error: 'Failed to process call outcome' });
  }
});

// Helper function to determine call outcome
function determineCallOutcome(callAnalysis) {
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
  
  return 'follow_up'; // Default to follow-up
}

// Helper function to save call results
async function saveCallResult(leadId, callData) {
  try {
    await global.supabase
      .from('call_history')
      .insert({
        lead_id: leadId,
        client_id: 1,
        call_type: 'outbound',
        ...callData,
        created_at: new Date().toISOString()
      });
    console.log(`✅ Call result saved for lead ${leadId}`);
  } catch (error) {
    console.error('❌ Failed to save call result:', error);
  }
}

// Test endpoint
router.get('/test', (req, res) => {
  res.json({
    message: 'GHL Bridge is working!',
    endpoint: '/webhook/ghl-bridge/bestbuyremodel',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;
