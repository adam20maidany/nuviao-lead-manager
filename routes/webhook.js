const express = require('express');
const router = express.Router();
const axios = require('axios');

// Import the new calendar functions
const { 
  checkAvailabilityForAI, 
  bookEstimateAppointment 
} = require('./ghl-calendar');

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

    // 🆕 NEW: Check calendar availability before calling
    console.log('📅 Checking calendar availability...');
    const availability = await checkAvailabilityForAI(7); // Check next 7 days
    
    if (availability.success && availability.availability.length > 0) {
      console.log(`✅ Found ${availability.availability.length} days with available slots`);
      
      // Add availability to metadata for Carl to use during the call
      leadData.availability = availability.availability;
    } else {
      console.log('⚠️ No availability found, Carl will handle scheduling manually');
      leadData.availability = [];
    }

    // Initiate AI call via Retell with availability data
    const callResult = await initiateAICall(leadData, savedLead?.id);
    
    if (callResult.success) {
      console.log(`✅ AI call initiated successfully for ${leadData.name}`);
      res.json({ 
        success: true, 
        message: 'Lead processed and AI call initiated',
        lead_id: savedLead?.id,
        call_id: callResult.call_id,
        availability: availability.success ? availability.availability.length : 0
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
    
    // 🆕 NEW: Include availability data in metadata for Carl
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
        email: leadData.email || '',
        // 🆕 NEW: Add availability for Carl to reference
        calendar_availability: JSON.stringify(leadData.availability || [])
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

// 🆕 NEW: Endpoint for Carl to book appointments during calls
router.post('/book-appointment/bestbuyremodel', async (req, res) => {
  try {
    console.log('📅 Booking appointment request:', req.body);
    
    const {
      clientName,
      clientPhone,
      clientEmail,
      homeAddress,
      estimateType,
      callSummary,
      selectedTimeSlot, // Format: "2024-06-03T10:00:00.000Z"
      ghlContactId
    } = req.body;

    // Validate required fields
    if (!clientName || !clientPhone || !selectedTimeSlot) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: clientName, clientPhone, selectedTimeSlot'
      });
    }

    // Calculate end time (1 hour later)
    const startTime = new Date(selectedTimeSlot);
    const endTime = new Date(startTime);
    endTime.setHours(endTime.getHours() + 1);

    const appointmentData = {
      clientName,
      clientPhone,
      clientEmail: clientEmail || '',
      homeAddress: homeAddress || 'Address to be confirmed',
      estimateType: estimateType || 'General Estimate',
      callSummary: callSummary || 'Scheduled via AI call',
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      contactId: ghlContactId
    };

    // Book the appointment
    const bookingResult = await bookEstimateAppointment(appointmentData);

    if (bookingResult.success) {
      console.log(`✅ Appointment booked for ${clientName} at ${startTime.toLocaleString()}`);
      
      // 🆕 TODO: Update lead status in database
      if (global.supabase && req.body.lead_id) {
        try {
          await global.supabase
            .from('leads')
            .update({ 
              status: 'appointment_booked',
              appointment_time: startTime.toISOString()
            })
            .eq('id', req.body.lead_id);
        } catch (dbError) {
          console.error('Failed to update lead status:', dbError);
        }
      }

      res.json({
        success: true,
        message: 'Appointment booked successfully',
        appointmentId: bookingResult.appointmentId,
        appointmentTime: startTime.toLocaleString()
      });
    } else {
      console.error('❌ Failed to book appointment:', bookingResult.error);
      res.status(500).json({
        success: false,
        error: bookingResult.error
      });
    }

  } catch (error) {
    console.error('❌ Appointment booking error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to book appointment' 
    });
  }
});

// 🆕 NEW: Endpoint to check availability (for real-time during calls)
router.get('/availability/bestbuyremodel', async (req, res) => {
  try {
    const daysAhead = parseInt(req.query.days) || 7;
    const availability = await checkAvailabilityForAI(daysAhead);
    
    res.json(availability);
  } catch (error) {
    console.error('❌ Availability check error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to check availability' 
    });
  }
});

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

      // 🆕 UPDATED: Enhanced outcome detection for appointments
      if (outcome === 'booked') {
        console.log('🎉 Appointment was booked during call!');
        // The booking should have been handled during the call via /book-appointment endpoint
      }
      
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
    timestamp: new Date().toISOString(),
    calendar_enabled: true // 🆕 NEW: Indicates calendar integration is active
  });
});

// 🆕 NEW: Test calendar endpoint
router.get('/test-calendar', async (req, res) => {
  try {
    const availability = await checkAvailabilityForAI(3);
    res.json({
      message: 'Calendar integration test',
      availability: availability,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Calendar test failed',
      details: error.message
    });
  }
});

module.exports = router;
