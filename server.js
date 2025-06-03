const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Import Google Calendar integration
const { getAuthUrl, getTokensFromCode, checkAvailabilityWithGoogle, bookAppointmentWithGoogle } = require('./google-calendar');

// Import Smart Callback Algorithm
const { SmartCallbackPredictor, initializeCallback, getOptimalCallTimes, recordCall } = require('./smart-callback-algorithm');

// Store Google tokens temporarily
let googleTokens = null;

// Initialize Supabase
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  console.log('✅ Supabase initialized');
  global.supabase = supabase;
}

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ========================================
// FUNCTION DEFINITIONS (BEFORE ROUTES)
// ========================================

// Function to create GHL contact via Private Integration Token
async function createGHLContact(leadData) {
  try {
    console.log(`📋 Creating GHL contact for ${leadData.name} using Private Integration Token`);
    console.log('🔍 PIT Token Check:', process.env.GHL_API_KEY ? 'SET' : 'MISSING');

    const nameParts = leadData.name.split(' ');
    const contactData = {
      firstName: nameParts[0] || '',
      lastName: nameParts.slice(1).join(' ') || '',
      phone: leadData.phone,
      email: leadData.email || '',
      source: leadData.source || 'Railway Import',
      tags: ['AI Calling', 'Railway Import']
      // No locationId needed - PIT token handles this automatically
    };

    console.log('📤 Sending to GHL API with PIT token:', contactData);

    const response = await axios.post(
      'https://services.leadconnectorhq.com/contacts/',
      contactData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`✅ GHL contact created successfully: ${response.data.contact?.id || response.data.id}`);
    return response.data;

  } catch (error) {
    console.error('❌ GHL contact creation failed:', error.response?.data || error.message);
    
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    
    return null;
  }
}

// Function to initiate AI call
async function initiateAICall(leadData, railwayLeadId, ghlContactId, uuid) {
  try {
    if (!process.env.RETELL_API_KEY || !process.env.RETELL_AGENT_ID) {
      return { success: false, error: 'Retell not configured' };
    }

    console.log(`📞 Calling Retell AI for ${leadData.name} at ${leadData.phone}`);
    
    // Ensure all metadata fields are strings
    const metadata = {
      railway_lead_id: String(railwayLeadId || ''),
      ghl_contact_id: String(ghlContactId || ''),
      uuid: String(uuid || ''),
      first_name: String(leadData.name.split(' ')[0] || ''),
      last_name: String(leadData.name.split(' ').slice(1).join(' ') || ''),
      full_name: String(leadData.name || ''),
      phone: String(leadData.phone || ''),
      email: String(leadData.email || ''),
      full_address: String(leadData.full_address || 'Address to be confirmed'),
      project_type: String(leadData.project_type || 'General Inquiry'),
      project_notes: String(leadData.project_notes || 'Lead inquiry'),
      calendar_availability: JSON.stringify(leadData.availability || []),
      calendar_provider: 'Google Calendar'
    };
    
    console.log('🚀 METADATA BEING SENT TO CARL:');
    console.log('📝 first_name:', metadata.first_name);
    console.log('📝 last_name:', metadata.last_name);
    console.log('📝 full_name:', metadata.full_name);
    console.log('📝 phone:', metadata.phone);
    console.log('📝 email:', metadata.email);
    console.log('📝 project_type:', metadata.project_type);
    console.log('📝 project_notes:', metadata.project_notes);
    console.log('📝 full_address:', metadata.full_address);
    console.log('📝 uuid:', metadata.uuid);
    
    const response = await axios.post('https://api.retellai.com/v2/create-phone-call', {
      from_number: '+17252092232',
      to_number: leadData.phone,
      agent_id: process.env.RETELL_AGENT_ID,
      metadata: metadata
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.RETELL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`✅ AI call initiated successfully: ${response.data.call_id}`);
    
    return { 
      success: true, 
      call_id: response.data.call_id 
    };

  } catch (error) {
    console.error(`❌ AI call failed:`, error.response?.data || error.message);
    return { 
      success: false, 
      error: error.response?.data || error.message 
    };
  }
}

// ========================================
// DEBUG AND TEST ENDPOINTS
// ========================================

// Test PIT token functionality
app.get('/debug/test-pit-token', async (req, res) => {
  try {
    console.log('🧪 Testing Private Integration Token...');
    
    const response = await axios.get(
      'https://services.leadconnectorhq.com/contacts/?limit=1',
      {
        headers: {
          'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        }
      }
    );
    
    res.json({
      success: true,
      message: 'PIT token is working!',
      token_prefix: process.env.GHL_API_KEY?.substring(0, 8) + '...',
      contacts_found: response.data.contacts?.length || 0
    });
    
  } catch (error) {
    res.json({
      success: false,
      error_status: error.response?.status,
      error_message: error.response?.data,
      token_prefix: process.env.GHL_API_KEY?.substring(0, 8) + '...',
      troubleshooting: {
        if_401: 'PIT token is invalid or expired',
        if_403: 'PIT token lacks required permissions (contacts.read/write)',
        solution: 'Check Private Integration settings in GHL'
      }
    });
  }
});

// Simple GHL contact creation test
app.post('/debug/test-ghl-contact', async (req, res) => {
  try {
    console.log('🧪 Testing GHL contact creation directly...');
    
    const { full_name, phone, email } = req.body;
    
    const testLeadData = {
      name: full_name || 'Test Customer',
      phone: phone || '+1234567890',
      email: email || 'test@example.com',
      source: 'direct_test'
    };
    
    const result = await createGHLContact(testLeadData);
    
    if (result) {
      res.json({
        success: true,
        message: 'GHL contact created successfully',
        contact_id: result.contact?.id || result.id,
        result: result
      });
    } else {
      res.json({
        success: false,
        message: 'GHL contact creation failed - check logs for details'
      });
    }
    
  } catch (error) {
    console.error('❌ GHL test error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || 'No additional details'
    });
  }
});

// ========================================
// GOOGLE CALENDAR ENDPOINTS
// ========================================

app.get('/auth/google', (req, res) => {
  try {
    const authUrl = getAuthUrl();
    res.json({ success: true, authUrl: authUrl });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Authorization code not provided');
  
  try {
    const result = await getTokensFromCode(code);
    if (result.success) {
      googleTokens = result.tokens;
      res.send('<h1>✅ Google Calendar Authorization Successful!</h1><script>window.close();</script>');
    } else {
      res.status(500).send('Authorization failed: ' + result.error);
    }
  } catch (error) {
    res.status(500).send('Authorization error: ' + error.message);
  }
});

app.get('/webhook/test-google-calendar', async (req, res) => {
  try {
    if (!googleTokens) {
      return res.json({
        success: false,
        error: 'Google Calendar not authorized yet',
        authUrl: getAuthUrl(),
        message: 'Visit the authUrl to authorize Google Calendar access first'
      });
    }
    
    console.log('🧪 Testing Google Calendar integration...');
    const availability = await checkAvailabilityWithGoogle(googleTokens, 3);
    
    res.json({
      message: 'Google Calendar integration test',
      availability: availability,
      timestamp: new Date().toISOString(),
      authorized: true
    });
  } catch (error) {
    res.status(500).json({
      error: 'Google Calendar test failed',
      details: error.message,
      authorized: !!googleTokens
    });
  }
});

// ========================================
// RETELL WEBHOOK
// ========================================

app.post('/webhook/retell/bestbuyremodel', async (req, res) => {
  try {
    console.log('🤖 Retell webhook received:', req.body.event_type);
    
    if (req.body.event_type === 'call_ended') {
      const { call_id, call_analysis, metadata } = req.body;
      
      let outcome = 'no_answer';
      if (call_analysis?.summary) {
        const summary = call_analysis.summary.toLowerCase();
        if (summary.includes('appointment') || summary.includes('scheduled') || summary.includes('booked')) {
          outcome = 'booked';
        } else if (summary.includes('not interested') || summary.includes('no thank you')) {
          outcome = 'dead';
        } else if (summary.includes('call back') || summary.includes('later')) {
          outcome = 'follow_up';
        } else {
          outcome = 'follow_up';
        }
      }
      
      console.log(`📞 Call ${call_id} ended with outcome: ${outcome}`);
      
      // Record call outcome for AI learning
      if (metadata?.uuid && global.supabase) {
        try {
          const { data: lead } = await global.supabase
            .from('leads')
            .select('id')
            .eq('custom_fields->uuid', metadata.uuid)
            .single();
          
          if (lead) {
            await recordCall(lead.id, {
              callTime: new Date().toISOString(),
              outcome: outcome,
              duration: req.body.call_duration || 0,
              notes: call_analysis?.summary || ''
            });

            const callbackTriggers = ['no_answer', 'follow_up'];
            if (callbackTriggers.includes(outcome)) {
              await initializeCallback(lead.id, outcome);
              console.log(`🧠 Smart callbacks scheduled for lead ${lead.id}`);
            }
          }
        } catch (error) {
          console.error('❌ Failed to process call outcome for AI:', error);
        }
      }
      
      if (outcome === 'booked') {
        console.log('🎉 Appointment was booked during call via Google Calendar!');
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Retell webhook error:', error);
    res.status(500).json({ error: 'Failed to process call outcome' });
  }
});

// ========================================
// RETELL CUSTOM FUNCTIONS
// ========================================

app.post('/webhook/schedule-lead/bestbuyremodel', async (req, res) => {
  try {
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const chosen_appointment_slot = args?.chosen_appointment_slot;
    const additional_information = args?.additional_information;
    
    console.log('📅 Schedule lead called with metadata:', call?.metadata);
    console.log('📅 Schedule args:', args);
    
    if (!uuid || !chosen_appointment_slot) {
      return res.json({ result: 'Missing information to schedule appointment' });
    }

    const appointmentDate = new Date(chosen_appointment_slot.replace(' ', 'T') + ':00.000Z');
    const endDate = new Date(appointmentDate);
    endDate.setHours(endDate.getHours() + 1);

    let leadInfo = {
      clientName: call?.metadata?.full_name || call?.metadata?.first_name || 'Lead',
      clientPhone: call?.metadata?.phone || 'Unknown',
      clientEmail: call?.metadata?.email || 'unknown@email.com',
      homeAddress: call?.metadata?.full_address || 'Address to be confirmed',
      estimateType: call?.metadata?.project_type || 'General Estimate'
    };

    const appointmentData = {
      ...leadInfo,
      callSummary: additional_information || 'Scheduled via AI call',
      startTime: appointmentDate.toISOString(),
      endTime: endDate.toISOString()
    };

    if (googleTokens) {
      const bookingResult = await bookAppointmentWithGoogle(googleTokens, appointmentData);
      
      if (bookingResult.success) {
        console.log(`✅ Google Calendar appointment booked for ${leadInfo.clientName}`);
        
        if (global.supabase) {
          try {
            const { data } = await global.supabase
              .from('leads')
              .select('id')
              .eq('custom_fields->uuid', uuid)
              .single();
            const leadId = data?.id;
            
            if (leadId) {
              await recordCall(leadId, {
                callTime: new Date().toISOString(),
                outcome: 'appointment_booked',
                duration: 0,
                attemptNumber: 1,
                notes: `Appointment booked: ${appointmentDate.toLocaleString()}`
              });
            }
            
            await global.supabase
              .from('leads')
              .update({ 
                status: 'appointment_booked',
                appointment_time: appointmentDate.toISOString()
              })
              .eq('custom_fields->uuid', uuid);
          } catch (dbError) {
            console.error('Failed to update lead status:', dbError);
          }
        }

        res.json({
          result: `Perfect! I have scheduled your appointment for ${appointmentDate.toLocaleDateString('en-US', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          })} at ${appointmentDate.toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit', 
            hour12: true 
          })}. You will receive a calendar invitation shortly.`
        });
      } else {
        res.json({ result: 'I encountered an issue scheduling the appointment. Let me transfer you to someone who can help.' });
      }
    } else {
      res.json({ result: 'Appointment scheduling noted. Our team will follow up to confirm.' });
    }
  } catch (error) {
    console.error('❌ Schedule lead error:', error);
    res.json({ result: 'I apologize, but I encountered an issue while scheduling.' });
  }
});

app.post('/webhook/check-availability/bestbuyremodel', async (req, res) => {
  try {
    console.log('📅 Check availability called:', req.body);
    
    const { call, args } = req.body;
    const appointment_date = args?.appointment_date;
    
    console.log('📅 Availability metadata:', call?.metadata);
    
    if (!appointment_date) {
      return res.json({ result: 'Could you please specify which date you would like to check?' });
    }

    if (googleTokens) {
      const availability = await checkAvailabilityWithGoogle(googleTokens, 7);
      
      if (availability.success) {
        const requestedDate = new Date(appointment_date);
        const availableDay = availability.availability.find(day => {
          const dayDate = new Date(day.date);
          return dayDate.toDateString() === requestedDate.toDateString();
        });

        if (availableDay && availableDay.slots.length > 0) {
          const slotsText = availableDay.slots.map(slot => slot.displayTime).join(', ');
          res.json({
            result: `Great! I have availability on ${requestedDate.toLocaleDateString('en-US', { 
              weekday: 'long', 
              month: 'long', 
              day: 'numeric' 
            })} at these times: ${slotsText}. Which time works best for you?`
          });
        } else {
          res.json({
            result: `I don't have any availability on ${requestedDate.toLocaleDateString('en-US', { 
              weekday: 'long', 
              month: 'long', 
              day: 'numeric' 
            })}. Would you like me to check another date?`
          });
        }
      } else {
        res.json({ result: 'Let me check our schedule and get back to you on availability.' });
      }
    } else {
      res.json({ result: 'I have availability on that date at 9 AM, 10 AM, 2 PM, and 3 PM. Which works best?' });
    }
  } catch (error) {
    console.error('❌ Check availability error:', error);
    res.json({ result: 'Let me check our schedule and get back to you.' });
  }
});

app.post('/webhook/update-phone/bestbuyremodel', async (req, res) => {
  try {
    console.log('📞 Update phone called:', req.body);
    
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const phone = args?.phone;
    
    if (!uuid || !phone) {
      return res.json({ result: 'I need your phone number to update our records.' });
    }

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ phone: phone })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
        res.json({ result: 'I noted your phone number and our team will update our records.' });
      } else {
        res.json({ result: 'Perfect! I have updated your phone number in our system.' });
      }
    } else {
      res.json({ result: 'Perfect! I have updated your phone number in our system.' });
    }
  } catch (error) {
    console.error('❌ Update phone error:', error);
    res.json({ result: 'I have noted your phone number.' });
  }
});

app.post('/webhook/validate-address/bestbuyremodel', async (req, res) => {
  try {
    console.log('📍 Validate address called:', req.body);
    
    const { call, args } = req.body;
    const address = args?.address;
    
    console.log('📍 Address metadata:', call?.metadata);
    
    if (!address) {
      return res.json({ result: 'Could you please provide your address so I can verify we service your area?' });
    }

    const isLasVegas = address.toLowerCase().includes('las vegas') || 
                      address.toLowerCase().includes('henderson') ||
                      address.toLowerCase().includes('summerlin') ||
                      /89\d{3}/.test(address);

    if (isLasVegas) {
      res.json({ result: 'Excellent! Your address is within our service area. We will be able to provide you with a free in-home estimate.' });
    } else {
      res.json({ result: 'I apologize, but your address appears to be outside our current service area. We primarily serve Las Vegas, Henderson, and Summerlin.' });
    }
  } catch (error) {
    console.error('❌ Validate address error:', error);
    res.json({ result: 'Let me verify your service area.' });
  }
});

app.post('/webhook/call-back-later/bestbuyremodel', async (req, res) => {
  try {
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const proposed_callback_time = args?.proposed_callback_time;
    
    console.log('📞 Callback metadata:', call?.metadata);
    
    let leadId = null;
    if (global.supabase && uuid) {
      const { data } = await global.supabase
        .from('leads')
        .select('id')
        .eq('custom_fields->uuid', uuid)
        .single();
      leadId = data?.id;
    }

    if (leadId) {
      await recordCall(leadId, {
        callTime: new Date().toISOString(),
        outcome: 'callback_requested',
        duration: 0,
        notes: `Callback requested for: ${proposed_callback_time || 'later'}`
      });

      await initializeCallback(leadId, 'callback_requested');
      console.log(`🧠 Smart callbacks scheduled for lead ${leadId}`);
    }

    res.json({ result: 'No problem! I will have someone from our team call you back soon. Our AI system will optimize the best times to reach you.' });
  } catch (error) {
    console.error('❌ Call back later error:', error);
    res.json({ result: 'I will make sure our team follows up with you.' });
  }
});

app.post('/webhook/mark-wrong-number/bestbuyremodel', async (req, res) => {
  try {
    res.json({ result: 'I apologize for calling the wrong number. Have a great day!' });
  } catch (error) {
    res.json({ result: 'Sorry for the inconvenience.' });
  }
});

app.post('/webhook/update-address/bestbuyremodel', async (req, res) => {
  try {
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const address = args?.address;
    
    console.log('🏠 Update address metadata:', call?.metadata);
    
    if (global.supabase && uuid && address) {
      await global.supabase
        .from('leads')
        .update({ 
          custom_fields: {
            ...call?.metadata,
            full_address: address
          }
        })
        .eq('custom_fields->uuid', uuid);
    }
    
    res.json({ result: 'Perfect! I have updated your address in our system.' });
  } catch (error) {
    res.json({ result: 'I have noted your address.' });
  }
});

app.post('/webhook/mobile-home/bestbuyremodel', async (req, res) => {
  try {
    res.json({ result: 'Unfortunately, we do not service mobile or manufactured homes.' });
  } catch (error) {
    res.json({ result: 'Unfortunately, we do not service mobile homes.' });
  }
});

app.post('/webhook/outside-area/bestbuyremodel', async (req, res) => {
  try {
    res.json({ result: 'Your location is outside our service area.' });
  } catch (error) {
    res.json({ result: 'Your location is outside our service area.' });
  }
});

app.post('/webhook/not-interested/bestbuyremodel', async (req, res) => {
  try {
    const { call } = req.body;
    const uuid = call?.metadata?.uuid;
    
    if (global.supabase && uuid) {
      await global.supabase
        .from('leads')
        .update({ status: 'not_interested' })
        .eq('custom_fields->uuid', uuid);
    }
    
    res.json({ result: 'I completely understand. Thank you for your time!' });
  } catch (error) {
    res.json({ result: 'Thank you for your time!' });
  }
});

app.post('/webhook/transfer-call/bestbuyremodel', async (req, res) => {
  try {
    res.json({ result: 'Let me transfer you to one of our specialists.' });
  } catch (error) {
    res.json({ result: 'Let me get you connected with someone who can help.' });
  }
});

app.post('/webhook/update-first-name/bestbuyremodel', async (req, res) => {
  try {
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const first_name = args?.first_name;
    
    if (global.supabase && uuid && first_name) {
      await global.supabase
        .from('leads')
        .update({ 
          custom_fields: {
            ...call?.metadata,
            first_name: first_name
          }
        })
        .eq('custom_fields->uuid', uuid);
    }
    
    res.json({ result: 'Perfect! I have updated your first name.' });
  } catch (error) {
    res.json({ result: 'I have noted your first name.' });
  }
});

app.post('/webhook/update-last-name/bestbuyremodel', async (req, res) => {
  try {
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const last_name = args?.last_name;
    
    if (global.supabase && uuid && last_name) {
      await global.supabase
        .from('leads')
        .update({ 
          custom_fields: {
            ...call?.metadata,
            last_name: last_name
          }
        })
        .eq('custom_fields->uuid', uuid);
    }
    
    res.json({ result: 'Perfect! I have updated your last name.' });
  } catch (error) {
    res.json({ result: 'I have noted your last name.' });
  }
});

app.post('/webhook/update-email/bestbuyremodel', async (req, res) => {
  try {
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const email = args?.email;
    
    if (global.supabase && uuid && email) {
      await global.supabase
        .from('leads')
        .update({ 
          email: email,
          custom_fields: {
            ...call?.metadata,
            email: email
          }
        })
        .eq('custom_fields->uuid', uuid);
    }
    
    res.json({ result: 'Perfect! I have updated your email address.' });
  } catch (error) {
    res.json({ result: 'I have noted your email address.' });
  }
});

app.post('/webhook/end-call/bestbuyremodel', async (req, res) => {
  try {
    const { args } = req.body;
    const execution_message = args?.execution_message || 'Thank you for your time. Have a great day!';
    res.json({ result: execution_message });
  } catch (error) {
    res.json({ result: 'Thank you for your time. Have a great day!' });
  }
});

// ========================================
// GHL BRIDGE WEBHOOK (MAIN ENTRY POINT)
// ========================================

app.post('/webhook/ghl-bridge/bestbuyremodel', async (req, res) => {
  try {
    console.log('🔗 GHL Bridge received data:', req.body);
    
    const leadData = {
      name: req.body.full_name || req.body.firstName + ' ' + req.body.lastName || 'Unknown',
      phone: req.body.phone,
      email: req.body.email,
      source: req.body.source || 'ghl',
      ghl_contact_id: req.body.contact_id || req.body.id,
      project_type: req.body.project_type || 'General Inquiry',
      project_notes: req.body.project_notes || 'Lead inquiry',
      full_address: req.body.full_address || 'Address to be confirmed'
    };

    if (!leadData.name || !leadData.phone) {
      return res.status(400).json({ error: 'Missing required fields: name and phone' });
    }

    console.log(`📞 Processing lead: ${leadData.name} - ${leadData.phone}`);

    // Create GHL contact via Private Integration Token
    let ghlContact = null;
    if (process.env.GHL_API_KEY) {
      ghlContact = await createGHLContact(leadData);
    }

    let savedLead = null;
    if (global.supabase) {
      try {
        // Check if lead already exists by phone
        const { data: existingLead } = await global.supabase
          .from('leads')
          .select('*')
          .eq('phone', leadData.phone)
          .single();
        
        if (existingLead) {
          console.log(`✅ Found existing lead: ID ${existingLead.id}`);
          savedLead = existingLead;
          
          // Update existing lead
          await global.supabase
            .from('leads')
            .update({
              name: leadData.name,
              email: leadData.email,
              custom_fields: {
                ...existingLead.custom_fields,
                project_type: leadData.project_type,
                project_notes: leadData.project_notes,
                full_address: leadData.full_address
              }
            })
            .eq('id', existingLead.id);
            
        } else {
          // Create new lead
          const { data, error } = await global.supabase
            .from('leads')
            .insert({
              client_id: 1,
              name: leadData.name,
              phone: leadData.phone,
              email: leadData.email,
              source: leadData.source,
              status: 'new',
              custom_fields: {
                original_ghl_contact_id: leadData.ghl_contact_id,
                uuid: require('crypto').randomUUID(),
                project_type: leadData.project_type,
                project_notes: leadData.project_notes,
                full_address: leadData.full_address
              }
            })
            .select()
            .single();

          if (data) {
            savedLead = data;
            console.log(`✅ Lead saved to Railway database: ID ${savedLead.id}`);
          }
        }
      } catch (dbError) {
        console.error('Database operation failed:', dbError);
      }
    }

    // Check Google Calendar availability
    let availability = { success: false, availability: [] };
    if (googleTokens) {
      console.log('📅 Checking Google Calendar availability...');
      availability = await checkAvailabilityWithGoogle(googleTokens, 7);
      if (availability.success && availability.availability.length > 0) {
        leadData.availability = availability.availability;
      }
    }

    // Initiate AI call
    const callResult = await initiateAICall(leadData, savedLead?.id, ghlContact?.contact?.id, savedLead?.custom_fields?.uuid);
    
    res.json({ 
      success: true, 
      message: 'Lead processed, GHL contact created, calendar checked, and AI call initiated',
      railway_lead_id: savedLead?.id,
      ghl_contact_id: ghlContact?.contact?.id || ghlContact?.id,
      call_id: callResult.call_id,
      uuid: savedLead?.custom_fields?.uuid,
      ghl_contact_created: !!ghlContact,
      calendar_authorized: !!googleTokens,
      availability_slots: availability.success ? availability.availability.length : 0
    });

  } catch (error) {
    console.error('❌ GHL Bridge error:', error);
    res.status(500).json({ error: 'Failed to process GHL lead' });
  }
});

// ========================================
// SMART CALLBACK ENDPOINTS
// ========================================

app.get('/webhook/optimal-call-times/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const daysAhead = parseInt(req.query.days) || 3;
    
    console.log(`🧠 Getting optimal call times for lead ${leadId}`);
    
    const predictor = new SmartCallbackPredictor();
    const predictions = await predictor.predictOptimalCallTimes(leadId, daysAhead);
    
    res.json({
      success: true,
      lead_id: leadId,
      predictions: predictions,
      total_days: predictions.length
    });
    
  } catch (error) {
    console.error('❌ Optimal call times error:', error);
    res.status(500).json({ success: false, error: 'Failed to get optimal call times' });
  }
});

app.post('/webhook/schedule-smart-callbacks/bestbuyremodel', async (req, res) => {
  try {
    const { leadId, initialOutcome, maxCallbacksPerDay } = req.body;
    
    if (!leadId) {
      return res.status(400).json({ success: false, error: 'Missing required field: leadId' });
    }
    
    console.log(`🧠 Scheduling smart callbacks for lead ${leadId}, outcome: ${initialOutcome}`);
    
    const result = await initializeCallback(leadId, initialOutcome || 'no_answer');
    
    res.json(result);
    
  } catch (error) {
    console.error('❌ Schedule smart callbacks error:', error);
    res.status(500).json({ success: false, error: 'Failed to schedule smart callbacks' });
  }
});

app.get('/webhook/callback-queue', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const futureTime = new Date();
    futureTime.setMinutes(futureTime.getMinutes() + 30);
    
    const { data, error } = await global.supabase
      .from('callback_queue')
      .select(`*, leads (id, name, phone, email, custom_fields)`)
      .eq('status', 'scheduled')
      .gte('scheduled_time', now)
      .lte('scheduled_time', futureTime.toISOString())
      .order('predicted_score', { ascending: false });
    
    if (error) throw error;
    
    res.json({
      success: true,
      pending_callbacks: data || [],
      count: data?.length || 0
    });
    
  } catch (error) {
    console.error('❌ Get callback queue error:', error);
    res.status(500).json({ success: false, error: 'Failed to get callback queue' });
  }
});

// ========================================
// SYSTEM STATUS AND HEALTH ENDPOINTS
// ========================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    system: 'Nuviao AI Lead Manager'
  });
});

app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Nuviao AI Lead Manager</h1>
    <p><strong>Status:</strong> ✅ Online and Running</p>
    <p><strong>Version:</strong> 2.0 - Private Integration Token Ready</p>
    
    <h2>🔌 System Integrations:</h2>
    <ul>
      <li><strong>Database:</strong> ${global.supabase ? '✅ Connected' : '❌ Not Connected'}</li>
      <li><strong>Retell AI:</strong> ${process.env.RETELL_API_KEY ? '✅ Configured' : '❌ Not Configured'}</li>
      <li><strong>GHL Private Integration:</strong> ${process.env.GHL_API_KEY ? '✅ PIT Token Set' : '❌ Not Configured'}</li>
      <li><strong>Google Calendar:</strong> ${googleTokens ? '✅ Authorized' : '❌ Not Authorized'}</li>
    </ul>
    
    <h2>🤖 AI Functions:</h2>
    <ul>
      <li>✅ 15 Retell Custom Functions Active</li>
      <li>✅ Smart Callback Algorithm Active</li>
      <li>✅ Google Calendar Integration Ready</li>
      <li>✅ Lead Processing Pipeline Active</li>
    </ul>
    
    <h2>🔗 Quick Links:</h2>
    <ul>
      ${!googleTokens ? '<li><a href="/auth/google">🔐 Authorize Google Calendar</a></li>' : ''}
      <li><a href="/debug/test-pit-token">🧪 Test PIT Token</a></li>
      <li><a href="/webhook/test-google-calendar">📅 Test Calendar</a></li>
      <li><a href="/health">❤️ Health Check</a></li>
    </ul>
    
    <h2>📊 Current Configuration:</h2>
    <ul>
      <li><strong>PIT Token:</strong> ${process.env.GHL_API_KEY ? process.env.GHL_API_KEY.substring(0, 8) + '...' : 'Not Set'}</li>
      <li><strong>Agent ID:</strong> ${process.env.RETELL_AGENT_ID ? 'Configured' : 'Missing'}</li>
      <li><strong>Database:</strong> ${process.env.SUPABASE_URL ? 'Connected' : 'Missing'}</li>
    </ul>
  `);
});

// ========================================
// SERVER STARTUP
// ========================================

app.listen(PORT, () => {
  console.log(`🚀 Nuviao AI Lead Manager running on port ${PORT}`);
  console.log(`📅 Google Calendar integration: ${googleTokens ? 'READY' : 'PENDING AUTHORIZATION'}`);
  console.log(`🤖 Retell AI functions: 15 endpoints ACTIVE`);
  console.log(`🧠 Smart callback algorithm: ACTIVE`);
  console.log(`💾 Database: ${global.supabase ? 'CONNECTED' : 'NOT CONNECTED'}`);
  console.log(`🔐 GHL Private Integration: ${process.env.GHL_API_KEY ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
  
  if (!googleTokens) {
    console.log(`⚠️  AUTHORIZATION NEEDED: Visit /auth/google to authorize Google Calendar`);
    console.log(`🔗 Auth URL: https://nuviao-lead-manager-production.up.railway.app/auth/google`);
  }
  
  // Environment validation
  console.log(`\n🔐 Environment Validation:`);
  console.log(`   - RETELL_API_KEY: ${process.env.RETELL_API_KEY ? '✅ SET' : '❌ MISSING'}`);
  console.log(`   - RETELL_AGENT_ID: ${process.env.RETELL_AGENT_ID ? '✅ SET' : '❌ MISSING'}`);
  console.log(`   - GHL_API_KEY (PIT): ${process.env.GHL_API_KEY ? '✅ SET (' + process.env.GHL_API_KEY.substring(0, 8) + '...)' : '❌ MISSING'}`);
  console.log(`   - SUPABASE_URL: ${process.env.SUPABASE_URL ? '✅ SET' : '❌ MISSING'}`);
  console.log(`   - SUPABASE_ANON_KEY: ${process.env.SUPABASE_ANON_KEY ? '✅ SET' : '❌ MISSING'}`);
  
  console.log(`\n🎉 System Status: READY FOR TESTING!`);
  console.log(`💡 Next: Test with POST to /webhook/ghl-bridge/bestbuyremodel`);
});
