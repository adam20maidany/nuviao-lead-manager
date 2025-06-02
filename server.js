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
// 🆕 GOOGLE CALENDAR OAUTH ROUTES
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
// 🆕 GOOGLE CALENDAR API ENDPOINTS
// ================================

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

// Check availability endpoint
app.get('/webhook/availability/bestbuyremodel', async (req, res) => {
  try {
    if (!googleTokens) {
      return res.status(401).json({
        success: false,
        error: 'Google Calendar not authorized',
        authUrl: getAuthUrl()
      });
    }
    
    const daysAhead = parseInt(req.query.days) || 7;
    const availability = await checkAvailabilityWithGoogle(googleTokens, daysAhead);
    
    res.json(availability);
  } catch (error) {
    console.error('❌ Availability check error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to check availability' 
    });
  }
});

// Book appointment endpoint
app.post('/webhook/book-appointment/bestbuyremodel', async (req, res) => {
  try {
    if (!googleTokens) {
      return res.status(401).json({
        success: false,
        error: 'Google Calendar not authorized',
        authUrl: getAuthUrl()
      });
    }
    
    console.log('📅 Booking Google Calendar appointment:', req.body);
    
    const {
      clientName,
      clientPhone,
      clientEmail,
      homeAddress,
      estimateType,
      callSummary,
      selectedTimeSlot,
      ghlContactId
    } = req.body;

    if (!clientName || !clientPhone || !selectedTimeSlot) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: clientName, clientPhone, selectedTimeSlot'
      });
    }

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

    const bookingResult = await bookAppointmentWithGoogle(googleTokens, appointmentData);

    if (bookingResult.success) {
      console.log(`✅ Google Calendar appointment booked for ${clientName} at ${startTime.toLocaleString()}`);
      
      // Update lead status in database
      if (global.supabase && req.body.lead_id) {
        try {
          await global.supabase
            .from('leads')
            .update({ 
              status: 'appointment_booked',
              appointment_time: startTime.toISOString(),
              calendar_provider: 'Google Calendar'
            })
            .eq('id', req.body.lead_id);
        } catch (dbError) {
          console.error('Failed to update lead status:', dbError);
        }
      }

      res.json({
        success: true,
        message: 'Appointment booked successfully in Google Calendar',
        appointmentId: bookingResult.appointmentId,
        appointmentTime: startTime.toLocaleString(),
        calendarLink: bookingResult.calendarLink
      });
    } else {
      console.error('❌ Failed to book Google Calendar appointment:', bookingResult.error);
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

// ================================
// EXISTING ENDPOINTS (UPDATED)
// ================================

// GHL BRIDGE WEBHOOK - WITH GOOGLE CALENDAR INTEGRATION
app.post('/webhook/ghl-bridge/bestbuyremodel', async (req, res) => {
  try {
    console.log('🔗 GHL Bridge received data:', req.body);
    
    // Extract lead data
    const leadData = {
      name: req.body.full_name || req.body.firstName + ' ' + req.body.lastName || 'Unknown',
      phone: req.body.phone,
      email: req.body.email,
      source: req.body.source || 'ghl',
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
              original_ghl_contact_id: leadData.ghl_contact_id
            }
          })
          .select()
          .single();

        if (error && error.code !== '23505') { // Ignore duplicate key errors
          console.error('Database error:', error);
        } else if (data) {
          savedLead = data;
          console.log(`✅ Lead saved to Railway database: ID ${savedLead.id}`);
        }
      } catch (dbError) {
        console.error('Database save failed:', dbError);
      }
    }

    // Step 2: Create GHL contact via API (keep this working)
    let ghlContact = null;
    if (process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID) {
      ghlContact = await createGHLContact(leadData);
    }

    // 🆕 Step 3: Check Google Calendar availability (if authorized)
    let availability = { success: false, availability: [] };
    if (googleTokens) {
      console.log('📅 Checking Google Calendar availability...');
      availability = await checkAvailabilityWithGoogle(googleTokens, 7);
      
      if (availability.success && availability.availability.length > 0) {
        console.log(`✅ Found ${availability.availability.length} days with available slots`);
        leadData.availability = availability.availability;
      } else {
        console.log('⚠️ No availability found, Carl will handle scheduling manually');
        leadData.availability = [];
      }
    } else {
      console.log('⚠️ Google Calendar not authorized - Carl will get manual scheduling');
      leadData.availability = [];
    }

    // Step 4: Initiate AI call via Retell with availability
    const callResult = await initiateAICall(leadData, savedLead?.id, ghlContact?.contact?.id);
    
    // Step 5: Send response
    res.json({ 
      success: true, 
      message: 'Lead processed, GHL contact created, calendar checked, and AI call initiated',
      railway_lead_id: savedLead?.id,
      ghl_contact_id: ghlContact?.contact?.id,
      call_id: callResult.call_id,
      ghl_contact_created: !!ghlContact,
      calendar_authorized: !!googleTokens,
      availability_slots: availability.success ? availability.availability.length : 0
    });

  } catch (error) {
    console.error('❌ GHL Bridge error:', error);
    res.status(500).json({ error: 'Failed to process GHL lead' });
  }
});

// Function to create GHL contact via API (unchanged)
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
}

// Function to initiate AI call via Retell (updated with Google Calendar data)
async function initiateAICall(leadData, railwayLeadId, ghlContactId) {
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
        first_name: leadData.name.split(' ')[0],
        full_name: leadData.name,
        phone: leadData.phone,
        email: leadData.email || '',
        // 🆕 Include Google Calendar availability for Carl
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
      const { call_id, call_analysis } = req.body;
      
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
        console.log('🎉 Appointment was booked during call via Google Calendar!');
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Retell webhook error:', error);
    res.status(500).json({ error: 'Failed to process call outcome' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'Nuviao GHL-Railway Bridge',
    ghl_api_configured: !!process.env.GHL_API_KEY,
    location_id: process.env.GHL_LOCATION_ID,
    google_calendar_configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    google_calendar_authorized: !!googleTokens,
    calendar_integration: 'Google Calendar'
  });
});

// Test endpoint
app.get('/webhook/test', (req, res) => {
  res.json({
    message: 'GHL Bridge is working!',
    endpoint: '/webhook/ghl-bridge/bestbuyremodel',
    timestamp: new Date().toISOString(),
    calendar_enabled: true,
    calendar_provider: 'Google Calendar',
    google_authorized: !!googleTokens
  });
});

// Simple homepage
app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Nuviao GHL-Railway Bridge</h1>
    <p>Status: ✅ Online</p>
    <p>GHL API: ${process.env.GHL_API_KEY ? '✅ Configured' : '❌ Not Configured'}</p>
    <p>Location ID: ${process.env.GHL_LOCATION_ID || 'Not Set'}</p>
    <p>📅 Calendar Integration: ✅ Google Calendar</p>
    <p>🔑 Google Calendar Auth: ${googleTokens ? '✅ Authorized' : '❌ Not Authorized'}</p>
    <hr>
    <h3>🔗 Available Endpoints:</h3>
    <ul>
      <li><code>POST /webhook/ghl-bridge/bestbuyremodel</code> - Main GHL bridge with Google Calendar</li>
      <li><code>POST /webhook/retell/bestbuyremodel</code> - Retell webhook</li>
      <li><code>POST /webhook/book-appointment/bestbuyremodel</code> - Book Google Calendar appointments</li>
      <li><code>GET /webhook/availability/bestbuyremodel</code> - Check Google Calendar availability</li>
      <li><code>GET /webhook/test-google-calendar</code> - Test Google Calendar integration</li>
      <li><code>GET /auth/google</code> - Get Google OAuth authorization URL</li>
    </ul>
    ${!googleTokens ? '<p><strong>⚠️ Please authorize Google Calendar: <a href="/auth/google">Click Here</a></strong></p>' : ''}
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Nuviao Bridge running on port ${PORT}`);
  console.log(`🎯 GHL Bridge ready with API contact creation!`);
  console.log(`📅 Google Calendar integration enabled!`);
  if (!googleTokens) {
    console.log(`⚠️ Visit /auth/google to authorize Google Calendar access`);
  }
});
