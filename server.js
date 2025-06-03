const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Import Google Calendar integration
const { 
  getAuthUrl, 
  getTokensFromCode, 
  checkAvailabilityWithGoogle, 
  bookAppointmentWithGoogle 
} = require('./google-calendar');

// Import Smart Callback Algorithm
const { 
  SmartCallbackPredictor,
  initializeCallback,
  getOptimalCallTimes,
  recordCall
} = require('./smart-callback-algorithm');

// Debug environment variables
console.log('🔍 Environment check:');
console.log('SUPABASE_URL exists:', !!process.env.SUPABASE_URL);
console.log('RETELL_API_KEY exists:', !!process.env.RETELL_API_KEY);
console.log('RETELL_AGENT_ID exists:', !!process.env.RETELL_AGENT_ID);
console.log('GHL_API_KEY exists:', !!process.env.GHL_API_KEY);
console.log('GHL_LOCATION_ID exists:', !!process.env.GHL_LOCATION_ID);
console.log('GOOGLE_CLIENT_ID exists:', !!process.env.GOOGLE_CLIENT_ID);
console.log('GOOGLE_CLIENT_SECRET exists:', !!process.env.GOOGLE_CLIENT_SECRET);

// Store Google tokens temporarily (in production, use database)
let googleTokens = null;

// Initialize Supabase
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
  console.log('✅ Supabase initialized');
  global.supabase = supabase;
}

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ================================
// GOOGLE CALENDAR OAUTH ROUTES
// ================================

// Step 1: Get Google OAuth authorization URL
app.get('/auth/google', (req, res) => {
  try {
    const authUrl = getAuthUrl();
    console.log('🔗 Google OAuth URL generated');
    res.json({
      success: true,
      authUrl: authUrl,
      message: 'Visit this URL to authorize Google Calendar access'
    });
  } catch (error) {
    console.error('❌ Error generating auth URL:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Step 2: Handle Google OAuth callback
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.status(400).send('Authorization code not provided');
  }
  
  try {
    console.log('🔑 Processing Google OAuth callback...');
    const result = await getTokensFromCode(code);
    
    if (result.success) {
      // Store tokens (in production, save to database)
      googleTokens = result.tokens;
      console.log('✅ Google Calendar access authorized successfully!');
      
      res.send(`
        <h1>✅ Google Calendar Authorization Successful!</h1>
        <p>You can now close this window.</p>
        <p>Your AI Lead Manager now has access to Google Calendar!</p>
        <script>window.close();</script>
      `);
    } else {
      console.error('❌ Token exchange failed:', result.error);
      res.status(500).send('Authorization failed: ' + result.error);
    }
  } catch (error) {
    console.error('❌ OAuth callback error:', error);
    res.status(500).send('Authorization error: ' + error.message);
  }
});

// ================================
// SMART CALLBACK ENDPOINTS
// ================================

// Get AI-predicted optimal call times for a lead
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
    res.status(500).json({
      success: false,
      error: 'Failed to get optimal call times'
    });
  }
});

// Schedule smart callbacks for a lead
app.post('/webhook/schedule-smart-callbacks/bestbuyremodel', async (req, res) => {
  try {
    const { leadId, initialOutcome, maxCallbacksPerDay } = req.body;
    
    if (!leadId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: leadId'
      });
    }
    
    console.log(`🧠 Scheduling smart callbacks for lead ${leadId}, outcome: ${initialOutcome}`);
    
    const result = await initializeCallback(leadId, initialOutcome || 'no_answer');
    
    res.json(result);
    
  } catch (error) {
    console.error('❌ Schedule smart callbacks error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to schedule smart callbacks'
    });
  }
});

// Get pending callbacks from the queue
app.get('/webhook/callback-queue', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const futureTime = new Date();
    futureTime.setMinutes(futureTime.getMinutes() + 30); // Next 30 minutes
    
    const { data, error } = await global.supabase
      .from('callback_queue')
      .select(`
        *,
        leads (
          id,
          name,
          phone,
          email,
          custom_fields
        )
      `)
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
    res.status(500).json({
      success: false,
      error: 'Failed to get callback queue'
    });
  }
});

// Update callback with actual outcome (for learning)
app.post('/webhook/update-callback-outcome/bestbuyremodel', async (req, res) => {
  try {
    const { callbackId, actualOutcome, callDuration, retellCallId } = req.body;
    
    if (!callbackId || !actualOutcome) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: callbackId and actualOutcome'
      });
    }
    
    console.log(`🎯 Updating callback ${callbackId} with outcome: ${actualOutcome}`);
    
    const predictor = new SmartCallbackPredictor();
    const accuracyResult = await predictor.updatePredictionAccuracy(callbackId, actualOutcome);
    
    // Also update the callback record
    const { error } = await global.supabase
      .from('callback_queue')
      .update({
        status: 'completed',
        actual_outcome: actualOutcome,
        retell_call_id: retellCallId,
        completed_at: new Date().toISOString()
      })
      .eq('id', callbackId);
    
    if (error) throw error;
    
    res.json({
      success: true,
      message: 'Callback outcome updated successfully',
      prediction_accuracy: accuracyResult?.accuracy
    });
    
  } catch (error) {
    console.error('❌ Update callback outcome error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update callback outcome'
    });
  }
});

// ================================
// RETELL CUSTOM FUNCTIONS
// ================================

// 1. Schedule Lead (Google Calendar Integration)
app.post('/webhook/schedule-lead/bestbuyremodel', async (req, res) => {
  try {
    console.log('📅 Schedule Lead called:', req.body);
    
    // Extract from call metadata and function args
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const chosen_appointment_slot = args?.chosen_appointment_slot;
    const additional_information = args?.additional_information;
    
    if (!uuid || !chosen_appointment_slot) {
      return res.json({
        result: 'Missing information to schedule appointment'
      });
    }

    // Convert YYYY-mm-dd hh:mm:ss to ISO timestamp
    const appointmentDate = new Date(chosen_appointment_slot.replace(' ', 'T') + ':00.000Z');
    const endDate = new Date(appointmentDate);
    endDate.setHours(endDate.getHours() + 1);

    // Get lead information from metadata
    let leadInfo = {
      clientName: call?.metadata?.full_name || 'Lead ' + uuid.substring(0, 8),
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

    // Book in Google Calendar if available
    if (googleTokens) {
      const bookingResult = await bookAppointmentWithGoogle(googleTokens, appointmentData);
      
      if (bookingResult.success) {
        console.log(`✅ Google Calendar appointment booked for ${leadInfo.clientName}`);
        
        // Update lead status in database
        if (global.supabase) {
          try {
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
          result: `Perfect! I've scheduled your appointment for ${appointmentDate.toLocaleDateString('en-US', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          })} at ${appointmentDate.toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit', 
            hour12: true 
          })}. You'll receive a calendar invitation shortly.`
        });
      } else {
        res.json({
          result: 'I encountered an issue scheduling the appointment. Let me transfer you to someone who can help.'
        });
      }
    } else {
      res.json({
        result: 'I have noted your preferred appointment time. Our team will call you back to confirm.'
      });
    }

  } catch (error) {
    console.error('❌ Schedule lead error:', error);
    res.json({
      result: 'I apologize, but I encountered an issue while scheduling. Let me transfer you to our team.'
    });
  }
});

// 2. Check Schedule Availability
app.post('/webhook/check-availability/bestbuyremodel', async (req, res) => {
  try {
    console.log('📅 Check availability called:', req.body);
    
    const { args } = req.body;
    const appointment_date = args?.appointment_date;
    
    if (!appointment_date) {
      return res.json({
        result: 'Could you please specify which date you would like to check availability for?'
      });
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
        res.json({
          result: 'Let me check our schedule and get back to you on availability.'
        });
      }
    } else {
      res.json({
        result: `I have availability on ${new Date(appointment_date).toLocaleDateString('en-US', { 
          weekday: 'long', 
          month: 'long', 
          day: 'numeric' 
        })} at nine A M, ten A M, eleven A M, two P M, and three P M. Which time works best for you?`
      });
    }

  } catch (error) {
    console.error('❌ Check availability error:', error);
    res.json({
      result: 'Let me check our schedule and get back to you on availability.'
    });
  }
});

// 3. Update Lead Phone Number
app.post('/webhook/update-phone/bestbuyremodel', async (req, res) => {
  try {
    console.log('📞 Update phone called:', req.body);
    
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const phone = args?.phone;
    
    if (!uuid || !phone) {
      return res.json({
        result: 'I need your phone number to update our records.'
      });
    }

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ phone: phone })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
        res.json({ result: 'I\'ve noted your email and our team will update our records.' });
      } else {
        res.json({ result: `Perfect! I've updated your email in our system.` });
      }
    } else {
      res.json({ result: `Got it! I've noted your email.` });
    }

  } catch (error) {
    console.error('❌ Update email error:', error);
    res.json({ result: 'I\'ve noted your email.' });
  }
});

// 15. End Call
app.post('/webhook/end-call/bestbuyremodel', async (req, res) => {
  try {
    console.log('📞 End call called:', req.body);
    
    const { args } = req.body;
    const execution_message = args?.execution_message || 'Thank you for your time. Have a great day!';
    
    res.json({
      result: execution_message
    });

  } catch (error) {
    console.error('❌ End call error:', error);
    res.json({ result: 'Thank you for your time. Have a great day!' });
  }
});

// ================================
// EXISTING ENDPOINTS
// ================================

// GHL BRIDGE WEBHOOK
app.post('/webhook/ghl-bridge/bestbuyremodel', async (req, res) => {
  try {
    console.log('🔗 GHL Bridge received data:', req.body);
    
    // Extract lead data
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

    // Validate required fields
    if (!leadData.name || !leadData.phone) {
      console.error('❌ Missing required fields:', leadData);
      return res.status(400).json({ 
        error: 'Missing required fields: name and phone' 
      });
    }

    console.log(`📞 Processing lead: ${leadData.name} - ${leadData.phone}`);

    // Step 1: Save lead to Railway database
    let savedLead = null;
    if (global.supabase) {
      try {
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

        if (error && error.code !== '23505') {
          console.error('Database error:', error);
        } else if (data) {
          savedLead = data;
          console.log(`✅ Lead saved to Railway database: ID ${savedLead.id}`);
        }
      } catch (dbError) {
        console.error('Database save failed:', dbError);
      }
    }

    // Step 2: Create GHL contact via API
    let ghlContact = null;
    if (process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID) {
      ghlContact = await createGHLContact(leadData);
    }

    // Step 3: Check Google Calendar availability
    let availability = { success: false, availability: [] };
    if (googleTokens) {
      console.log('📅 Checking Google Calendar availability...');
      availability = await checkAvailabilityWithGoogle(googleTokens, 7);
      
      if (availability.success && availability.availability.length > 0) {
        console.log(`✅ Found ${availability.availability.length} days with available slots`);
        leadData.availability = availability.availability;
      } else {
        console.log('⚠️ No availability found');
        leadData.availability = [];
      }
    } else {
      console.log('⚠️ Google Calendar not authorized');
      leadData.availability = [];
    }

    // Step 4: Initiate AI call via Retell
    const callResult = await initiateAICall(leadData, savedLead?.id, ghlContact?.contact?.id, savedLead?.custom_fields?.uuid);
    
    // Step 5: Send response
    res.json({ 
      success: true, 
      message: 'Lead processed and AI call initiated',
      railway_lead_id: savedLead?.id,
      ghl_contact_id: ghlContact?.contact?.id,
      call_id: callResult.call_id,
      uuid: savedLead?.custom_fields?.uuid
    });

  } catch (error) {
    console.error('❌ GHL Bridge error:', error);
    res.status(500).json({ error: 'Failed to process GHL lead' });
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
    return null;
  }
}

// Function to initiate AI call via Retell
async function initiateAICall(leadData, railwayLeadId, ghlContactId, uuid) {
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
        railway_lead_id: railwayLeadId,
        ghl_contact_id: ghlContactId,
        uuid: uuid,
        first_name: leadData.name.split(' ')[0],
        last_name: leadData.name.split(' ').slice(1).join(' ') || '',
        full_name: leadData.name,
        phone: leadData.phone,
        email: leadData.email || '',
        project_type: leadData.project_type || 'General Inquiry',
        project_notes: leadData.project_notes || 'Lead inquiry',
        full_address: leadData.full_address || 'Address to be confirmed',
        calendar_availability: JSON.stringify(leadData.availability || []),
        calendar_provider: 'Google Calendar'
      }
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
      
      if (outcome === 'booked') {
        console.log('🎉 Appointment was booked during call!');
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

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'Nuviao GHL-Railway Bridge',
    google_calendar_authorized: !!googleTokens,
    retell_functions: 'Active - 15 endpoints'
  });
});

// Test endpoint
app.get('/webhook/test', (req, res) => {
  res.json({
    message: 'GHL Bridge is working!',
    timestamp: new Date().toISOString(),
    google_authorized: !!googleTokens,
    retell_functions: 15
  });
});

// Simple homepage
app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Nuviao GHL-Railway Bridge</h1>
    <p>Status: ✅ Online</p>
    <p>📅 Calendar Integration: ✅ Google Calendar</p>
    <p>🔑 Google Calendar Auth: ${googleTokens ? '✅ Authorized' : '❌ Not Authorized'}</p>
    <p>🤖 Retell Functions: ✅ 15 Active Endpoints</p>
    ${!googleTokens ? '<p><strong>⚠️ Please authorize Google Calendar: <a href="/auth/google">Click Here</a></strong></p>' : ''}
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Nuviao Bridge running on port ${PORT}`);
  console.log(`📅 Google Calendar integration enabled!`);
  console.log(`🤖 Retell AI functions: 15 endpoints active`);
  if (!googleTokens) {
    console.log(`⚠️ Visit /auth/google to authorize Google Calendar access`);
  }
});('Database update error:', error);
        res.json({ result: 'I noted your phone number and our team will update our records.' });
      } else {
        res.json({ result: `Perfect! I've updated your phone number in our system.` });
      }
    } else {
      res.json({ result: `Got it! I've noted your phone number.` });
    }

  } catch (error) {
    console.error('❌ Update phone error:', error);
    res.json({ result: 'I\'ve noted your phone number and our team will update our records.' });
  }
});

// 4. Validate Lead Address
app.post('/webhook/validate-address/bestbuyremodel', async (req, res) => {
  try {
    console.log('📍 Validate address called:', req.body);
    
    const { args } = req.body;
    const address = args?.address;
    
    if (!address) {
      return res.json({
        result: 'Could you please provide your address so I can verify we service your area?'
      });
    }

    const isLasVegas = address.toLowerCase().includes('las vegas') || 
                      address.toLowerCase().includes('henderson') ||
                      address.toLowerCase().includes('summerlin') ||
                      /89\d{3}/.test(address);

    if (isLasVegas) {
      res.json({
        result: 'Excellent! Your address is within our service area.'
      });
    } else {
      res.json({
        result: 'I apologize, but your address appears to be outside our service area. We serve Las Vegas, Henderson, and Summerlin.'
      });
    }

  } catch (error) {
    console.error('❌ Validate address error:', error);
    res.json({ result: 'Let me verify your service area and get back to you.' });
  }
});

// 5. Call Lead Back Later
app.post('/webhook/call-back-later/bestbuyremodel', async (req, res) => {
  try {
    console.log('⏰ Call back later called:', req.body);
    
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const proposed_callback_time = args?.proposed_callback_time;
    
    if (global.supabase && uuid) {
      const { error } = await global.supabase
        .from('leads')
        .update({ 
          status: 'callback_scheduled',
          callback_time: proposed_callback_time 
        })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
      }
    }

    if (proposed_callback_time) {
      const callbackDate = new Date(proposed_callback_time);
      res.json({
        result: `Perfect! I'll have someone call you back on ${callbackDate.toLocaleDateString('en-US', { 
          weekday: 'long', 
          month: 'long', 
          day: 'numeric' 
        })}. Have a great day!`
      });
    } else {
      res.json({
        result: 'No problem! I\'ll have someone from our team call you back soon. Thank you!'
      });
    }

  } catch (error) {
    console.error('❌ Call back later error:', error);
    res.json({ result: 'I\'ll make sure our team follows up with you soon.' });
  }
});

// 6. Mark Wrong Number
app.post('/webhook/mark-wrong-number/bestbuyremodel', async (req, res) => {
  try {
    console.log('❌ Mark wrong number called:', req.body);
    
    const { call } = req.body;
    const uuid = call?.metadata?.uuid;
    
    if (global.supabase && uuid) {
      const { error } = await global.supabase
        .from('leads')
        .update({ status: 'wrong_number' })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
      }
    }

    res.json({
      result: 'I apologize for calling the wrong number. We\'ll update our records. Have a great day!'
    });

  } catch (error) {
    console.error('❌ Mark wrong number error:', error);
    res.json({ result: 'Sorry for the inconvenience.' });
  }
});

// 7. Update Lead Address
app.post('/webhook/update-address/bestbuyremodel', async (req, res) => {
  try {
    console.log('📍 Update address called:', req.body);
    
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const address = args?.address;
    const city = args?.city;
    const state = args?.state;
    const zip = args?.zip;
    
    if (!uuid || !address || !city || !state || !zip) {
      return res.json({
        result: 'I need your complete address to update our records.'
      });
    }

    const fullAddress = `${address}, ${city}, ${state} ${zip}`;

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ 
          custom_fields: {
            full_address: fullAddress,
            street_address: address,
            city: city,
            state: state,
            zip_code: zip
          }
        })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
        res.json({ result: 'I\'ve noted your address and our team will update our records.' });
      } else {
        res.json({ 
          result: `Perfect! I've updated your address in our system.`
        });
      }
    } else {
      res.json({ result: `Got it! I've noted your address.` });
    }

  } catch (error) {
    console.error('❌ Update address error:', error);
    res.json({ result: 'I\'ve noted your address and our team will update our records.' });
  }
});

// 8. Lead Is Mobile Home
app.post('/webhook/mobile-home/bestbuyremodel', async (req, res) => {
  try {
    console.log('🏠 Mobile home called:', req.body);
    
    const { call } = req.body;
    const uuid = call?.metadata?.uuid;
    
    if (global.supabase && uuid) {
      const { error } = await global.supabase
        .from('leads')
        .update({ status: 'mobile_home_declined' })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
      }
    }

    res.json({
      result: 'I understand you have a mobile home. Unfortunately, we specialize in traditional homes and don\'t service mobile or manufactured homes.'
    });

  } catch (error) {
    console.error('❌ Mobile home error:', error);
    res.json({ result: 'Unfortunately, we don\'t service mobile homes at this time.' });
  }
});

// 9. Lead Outside Area
app.post('/webhook/outside-area/bestbuyremodel', async (req, res) => {
  try {
    console.log('🌍 Outside area called:', req.body);
    
    const { call } = req.body;
    const uuid = call?.metadata?.uuid;
    
    if (global.supabase && uuid) {
      const { error } = await global.supabase
        .from('leads')
        .update({ status: 'outside_service_area' })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
      }
    }

    res.json({
      result: 'I apologize, but your location is outside our service area. We serve Las Vegas, Henderson, and Summerlin.'
    });

  } catch (error) {
    console.error('❌ Outside area error:', error);
    res.json({ result: 'Unfortunately, your location is outside our service area.' });
  }
});

// 10. Lead Not Interested
app.post('/webhook/not-interested/bestbuyremodel', async (req, res) => {
  try {
    console.log('❌ Not interested called:', req.body);
    
    const { call } = req.body;
    const uuid = call?.metadata?.uuid;
    
    if (global.supabase && uuid) {
      const { error } = await global.supabase
        .from('leads')
        .update({ status: 'not_interested' })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
      }
    }

    res.json({
      result: 'I completely understand. Thank you for your time and have a wonderful day!'
    });

  } catch (error) {
    console.error('❌ Not interested error:', error);
    res.json({ result: 'I understand. Thank you for your time!' });
  }
});

// 11. Transfer Call
app.post('/webhook/transfer-call/bestbuyremodel', async (req, res) => {
  try {
    console.log('📞 Transfer call requested:', req.body);
    
    res.json({
      result: 'Let me transfer you to one of our specialists. Please hold for just a moment.'
    });

  } catch (error) {
    console.error('❌ Transfer call error:', error);
    res.json({ result: 'Let me get you connected with someone who can help.' });
  }
});

// 12. Update Lead First Name
app.post('/webhook/update-first-name/bestbuyremodel', async (req, res) => {
  try {
    console.log('👤 Update first name called:', req.body);
    
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const first_name = args?.first_name;
    
    if (!uuid || !first_name) {
      return res.json({
        result: 'I need your first name to update our records.'
      });
    }

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ name: first_name })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
        res.json({ result: 'I\'ve noted your first name and our team will update our records.' });
      } else {
        res.json({ 
          result: `Perfect! I've updated your first name in our system.`
        });
      }
    } else {
      res.json({ result: `Got it! I've noted your first name.` });
    }

  } catch (error) {
    console.error('❌ Update first name error:', error);
    res.json({ result: 'I\'ve noted your first name.' });
  }
});

// 13. Update Lead Last Name
app.post('/webhook/update-last-name/bestbuyremodel', async (req, res) => {
  try {
    console.log('👤 Update last name called:', req.body);
    
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const last_name = args?.last_name;
    
    if (!uuid || !last_name) {
      return res.json({
        result: 'I need your last name to update our records.'
      });
    }

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ name: last_name })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
        res.json({ result: 'I\'ve noted your last name and our team will update our records.' });
      } else {
        res.json({ 
          result: `Perfect! I've updated your last name in our system.`
        });
      }
    } else {
      res.json({ result: `Got it! I've noted your last name.` });
    }

  } catch (error) {
    console.error('❌ Update last name error:', error);
    res.json({ result: 'I\'ve noted your last name.' });
  }
});

// 14. Update Lead Email
app.post('/webhook/update-email/bestbuyremodel', async (req, res) => {
  try {
    console.log('📧 Update email called:', req.body);
    
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const email = args?.email;
    
    if (!uuid || !email) {
      return res.json({
        result: 'I need your email address to update our records.'
      });
    }

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ email: email })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error
