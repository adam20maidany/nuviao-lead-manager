const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Import Google Calendar integration
const { getAuthUrl, getTokensFromCode, checkAvailabilityWithGoogle, bookAppointmentWithGoogle }

// RETELL WEBHOOK
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
          // Get lead ID from UUID
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

            // If call failed, schedule smart callbacks
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

// Test Google Calendar integration
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

// Function to create GHL contact via API
async function createGHLContact(leadData) {
  try {
    console.log(`📋 Creating GHL contact for ${leadData.name}`);

    const nameParts = leadData.name.split(' ');
    const contactData = {
      firstName: nameParts[0] || '',
      lastName: nameParts.slice(1).join(' ') || '',
      phone: leadData.phone,
      email: leadData.email || '',
      source: leadData.source,
      tags: ['AI Calling', 'Railway Import'],
      locationId: process.env.GHL_LOCATION_ID
    };

    console.log('📤 Sending to GHL API:', contactData);

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

    console.log(`✅ GHL contact created successfully: ${response.data.contact.id}`);
    return response.data;

  } catch (error) {
    console.error('❌ GHL contact creation failed:', error.response?.data || error.message);
    
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    
    return null;
  }
} = require('./google-calendar');

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

// Google Calendar OAuth
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

// Retell Custom Functions
app.post('/webhook/schedule-lead/bestbuyremodel', async (req, res) => {
  try {
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const chosen_appointment_slot = args?.chosen_appointment_slot;
    const additional_information = args?.additional_information;
    
    if (!uuid || !chosen_appointment_slot) {
      return res.json({ result: 'Missing information to schedule appointment' });
    }

    const appointmentDate = new Date(chosen_appointment_slot.replace(' ', 'T') + ':00.000Z');
    const endDate = new Date(appointmentDate);
    endDate.setHours(endDate.getHours() + 1);

    let leadInfo = {
      clientName: call?.metadata?.full_name || 'Lead',
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
        
        // Record successful appointment booking
        let leadId = null;
        if (global.supabase) {
          try {
            const { data } = await global.supabase
              .from('leads')
              .select('id')
              .eq('custom_fields->uuid', uuid)
              .single();
            leadId = data?.id;
            
            if (leadId) {
              await recordCall(leadId, {
                callTime: new Date().toISOString(),
                outcome: 'appointment_booked',
                duration: 0,
                attemptNumber: 1,
                notes: `Appointment booked: ${appointmentDate.toLocaleString()}`
              });
            }
            
            // Update lead status
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
    
    const { args } = req.body;
    const appointment_date = args?.appointment_date;
    
    if (!appointment_date) {
      return res.json({ result: 'Could you please specify which date you would like to check?' });
    }

    if (googleTokens) {
      // Create GHL contact via API
    let ghlContact = null;
    if (process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID) {
      ghlContact = await createGHLContact(leadData);
    }

    // Check Google Calendar availability for specific date
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
    
    const { args } = req.body;
    const address = args?.address;
    
    if (!address) {
      return res.json({ result: 'Could you please provide your address so I can verify we service your area?' });
    }

    // Simple validation - check if it contains Las Vegas area
    const isLasVegas = address.toLowerCase().includes('las vegas') || 
                      address.toLowerCase().includes('henderson') ||
                      address.toLowerCase().includes('summerlin') ||
                      /89\d{3}/.test(address); // Las Vegas ZIP codes

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
    
    // Get lead ID for smart callback scheduling
    let leadId = null;
    if (global.supabase && uuid) {
      const { data } = await global.supabase
        .from('leads')
        .select('id')
        .eq('custom_fields->uuid', uuid)
        .single();
      leadId = data?.id;
    }

    // Record the callback request and schedule smart callbacks
    if (leadId) {
      await recordCall(leadId, {
        callTime: new Date().toISOString(),
        outcome: 'callback_requested',
        duration: 0,
        notes: `Callback requested for: ${proposed_callback_time || 'later'}`
      });

      // Schedule smart callbacks using AI predictions
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
    res.json({ result: 'Perfect! I have updated your first name.' });
  } catch (error) {
    res.json({ result: 'I have noted your first name.' });
  }
});

app.post('/webhook/update-last-name/bestbuyremodel', async (req, res) => {
  try {
    res.json({ result: 'Perfect! I have updated your last name.' });
  } catch (error) {
    res.json({ result: 'I have noted your last name.' });
  }
});

app.post('/webhook/update-email/bestbuyremodel', async (req, res) => {
  try {
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

// GHL Bridge Webhook
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
      ghl_contact_id: ghlContact?.contact?.id,
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

// Function to initiate AI call
async function initiateAICall(leadData, railwayLeadId, ghlContactId, uuid) {
  try {
    if (!process.env.RETELL_API_KEY || !process.env.RETELL_AGENT_ID) {
      return { success: false, error: 'Retell not configured' };
    }

    console.log(`📞 Calling Retell AI for ${leadData.name} at ${leadData.phone}`);
    
    const metadata = {
      railway_lead_id: railwayLeadId,
      ghl_contact_id: ghlContactId,
      uuid: uuid,
      first_name: leadData.name.split(' ')[0],
      last_name: leadData.name.split(' ').slice(1).join(' ') || '',
      full_address: leadData.full_address || 'Address to be confirmed',
      project_notes: leadData.project_notes || 'Lead inquiry',
      phone: leadData.phone,
      project_type: leadData.project_type || 'General Inquiry', 
      email: leadData.email || '',
      full_name: leadData.name,
      calendar_availability: JSON.stringify(leadData.availability || []),
      calendar_provider: 'Google Calendar'
    };
    
    console.log('🚀 METADATA BEING SENT TO CARL:');
    console.log('first_name:', metadata.first_name);
    console.log('last_name:', metadata.last_name);
    console.log('phone:', metadata.phone);
    console.log('email:', metadata.email);
    console.log('project_type:', metadata.project_type);
    console.log('uuid:', metadata.uuid);
    
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

// Smart Callback Endpoints
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

// Test endpoints
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Nuviao GHL-Railway Bridge</h1>
    <p>Status: ✅ Online</p>
    <p>Google Calendar Auth: ${googleTokens ? '✅ Authorized' : '❌ Not Authorized'}</p>
    ${!googleTokens ? '<p><a href="/auth/google">Authorize Google Calendar</a></p>' : ''}
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Nuviao Bridge running on port ${PORT}`);
  console.log(`📅 Google Calendar integration enabled!`);
  console.log(`🤖 Retell AI functions: 15 endpoints active`);
  
  if (!googleTokens) {
    console.log(`⚠️ Google Calendar NOT AUTHORIZED - Visit /auth/google to authorize`);
    console.log(`🔗 Authorization URL: https://nuviao-lead-manager-production.up.railway.app/auth/google`);
  } else {
    console.log(`✅ Google Calendar AUTHORIZED and ready!`);
  }
});
