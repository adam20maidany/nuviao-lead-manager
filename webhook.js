const express = require('express');
const router = express.Router();
const LeadProcessor = require('../services/LeadProcessor');
const CallOrchestrator = require('../services/CallOrchestrator');
const RetellService = require('../services/RetellService');
const logger = require('../utils/logger');

const leadProcessor = new LeadProcessor();
const callOrchestrator = new CallOrchestrator();
const retellService = new RetellService();

// ===========================================
// GHL-to-Railway Bridge (NEW HYBRID SYSTEM)
// ===========================================

// Main GHL bridge endpoint - receives leads from GHL workflows
router.post('/ghl-bridge/bestbuyremodel', async (req, res) => {
  try {
    console.log('🔗 GHL bridge received:', req.body);
    
    // Format GHL contact data for our system
    const leadData = {
      name: req.body.full_name || req.body.first_name + ' ' + req.body.last_name || 'Unknown',
      phone: req.body.phone,
      email: req.body.email,
      source: req.body.source || 'ghl',
      project_type: req.body.project_type || req.body.custom_fields?.project_type || 'home renovation',
      message: req.body.message || req.body.notes || '',
      ghl_contact_id: req.body.contact_id || req.body.id // Save GHL contact ID for updates
    };

    // Validate required fields
    if (!leadData.name || !leadData.phone) {
      return res.status(400).json({ 
        error: 'Missing required fields: name and phone' 
      });
    }

    // Process the lead in Railway system
    const lead = await leadProcessor.processLead(leadData, 1); // Client ID 1 = Best Buy Remodel
    
    // Schedule immediate AI call
    await callOrchestrator.scheduleOutboundCall(lead.id, 'high');
    
    console.log(`✅ GHL lead processed: ${lead.name} - AI call scheduled`);
    
    res.json({ 
      success: true, 
      lead_id: lead.id,
      railway_lead_id: lead.id,
      ghl_contact_id: leadData.ghl_contact_id,
      message: 'Lead received from GHL and AI call scheduled!'
    });

  } catch (error) {
    console.error('❌ GHL bridge error:', error);
    res.status(500).json({ error: 'Failed to process GHL lead' });
  }
});

// ===========================================
// LEGACY ENDPOINTS (Keep for backup/testing)
// ===========================================

// Original direct webhook - Best Buy Remodel (keep as backup)
router.post('/leads/bestbuyremodel', async (req, res) => {
  try {
    console.log('📞 Direct lead received for Best Buy Remodel:', req.body);
    
    const leadData = {
      name: req.body.name || req.body.full_name || req.body.first_name + ' ' + req.body.last_name,
      phone: req.body.phone || req.body.phone_number,
      email: req.body.email,
      source: req.body.source || 'direct_webhook',
      project_type: req.body.project_type || req.body.service || 'general renovation',
      message: req.body.message || req.body.comments || ''
    };

    // Validate required fields
    if (!leadData.name || !leadData.phone) {
      return res.status(400).json({ 
        error: 'Missing required fields: name and phone' 
      });
    }

    // Process the lead
    const lead = await leadProcessor.processLead(leadData, 1);
    
    // Schedule immediate AI call
    await callOrchestrator.scheduleOutboundCall(lead.id, 'high');
    
    console.log(`✅ Direct lead processed: ${lead.name} - AI call scheduled`);
    
    res.json({ 
      success: true, 
      lead_id: lead.id,
      message: 'Lead received and AI call scheduled'
    });

  } catch (error) {
    console.error('❌ Direct webhook error:', error);
    res.status(500).json({ error: 'Failed to process lead' });
  }
});

// ===========================================
// RETELL AI WEBHOOKS
// ===========================================

// Retell AI webhook - handles call outcomes
router.post('/retell/bestbuyremodel', async (req, res) => {
  try {
    const webhookData = req.body;
    console.log('🤖 Retell webhook received:', webhookData.event_type);
    
    if (webhookData.event_type === 'call_ended') {
      const { call_id, call_analysis, metadata } = webhookData;
      
      // Extract outcome from AI analysis
      const outcome = extractCallOutcome(call_analysis);
      
      console.log(`📞 Call ${call_id} ended with outcome: ${outcome}`);
      
      // Update call record in Railway
      await updateCallRecord(call_id, {
        outcome,
        transcript: webhookData.transcript || '',
        ai_summary: call_analysis?.summary || '',
        duration: webhookData.call_duration || 0,
        recording_url: webhookData.recording_url || '',
        status: 'completed'
      });
      
      // TODO: Update GHL contact with call outcome
      if (metadata?.ghl_contact_id) {
        await updateGHLContact(metadata.ghl_contact_id, outcome);
      }
      
      // Process follow-up logic
      await processFollowUpLogic(call_id, outcome);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Retell webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ===========================================
// TEST ENDPOINTS
// ===========================================

// Test GHL bridge endpoint
router.get('/test/ghl-bridge', (req, res) => {
  res.json({
    message: 'GHL Bridge is live!',
    ghl_webhook_url: `${req.protocol}://${req.get('host')}/webhook/ghl-bridge/bestbuyremodel`,
    test_payload: {
      full_name: 'John Smith',
      phone: '+15551234567',
      email: 'john@example.com',
      source: 'ghl_test',
      project_type: 'kitchen remodel',
      message: 'Testing GHL to Railway bridge'
    }
  });
});

// Test direct webhook endpoint
router.get('/test/bestbuyremodel', (req, res) => {
  res.json({
    message: 'Best Buy Remodel webhook is live!',
    webhook_url: `${req.protocol}://${req.get('host')}/webhook/leads/bestbuyremodel`,
    test_payload: {
      name: 'John Smith',
      phone: '555-123-4567',
      email: 'john@example.com',
      source: 'website',
      project_type: 'kitchen remodel',
      message: 'Looking for kitchen renovation quote'
    }
  });
});

// ===========================================
// HELPER FUNCTIONS
// ===========================================

function extractCallOutcome(callAnalysis) {
  if (!callAnalysis || !callAnalysis.summary) {
    return 'no_answer';
  }
  
  const summary = callAnalysis.summary.toLowerCase();
  
  // Check for appointment booking keywords
  if (summary.includes('appointment') || 
      summary.includes('scheduled') || 
      summary.includes('booked') ||
      summary.includes('estimate') ||
      summary.includes('consultation')) {
    return 'booked';
  }
  
  // Check for definitive rejection
  if (summary.includes('not interested') || 
      summary.includes('no thank you') ||
      summary.includes('remove') ||
      summary.includes('stop calling')) {
    return 'dead';
  }
  
  // Check for callback/follow-up requests
  if (summary.includes('call back') || 
      summary.includes('follow up') ||
      summary.includes('later') ||
      summary.includes('busy')) {
    return 'follow_up';
  }
  
  // Check for interest/consideration
  if (summary.includes('thinking') || 
      summary.includes('consider') ||
      summary.includes('maybe') ||
      summary.includes('interested')) {
    return 'in_progress';
  }
  
  // Default to follow_up for unclear outcomes
  return 'follow_up';
}

async function updateCallRecord(retellCallId, updates) {
  try {
    await global.supabase
      .from('call_history')
      .update(updates)
      .eq('retell_call_id', retellCallId);
  } catch (error) {
    console.error('Failed to update call record:', error);
  }
}

async function updateGHLContact(ghlContactId, outcome) {
  try {
    // TODO: Implement GHL API call to update contact
    console.log(`🔄 Would update GHL contact ${ghlContactId} with outcome: ${outcome}`);
    
    // This will use GHL API to update the contact with call outcome
    // We'll implement this in the next step
  } catch (error) {
    console.error('Failed to update GHL contact:', error);
  }
}

async function processFollowUpLogic(callId, outcome) {
  try {
    // TODO: Implement follow-up scheduling based on outcome
    console.log(`📅 Processing follow-up for outcome: ${outcome}`);
    
    // This will schedule follow-up calls based on the outcome
    // We'll implement this in the next step
  } catch (error) {
    console.error('Failed to process follow-up logic:', error);
  }
}

module.exports = router;
