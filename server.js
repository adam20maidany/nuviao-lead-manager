const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Debug environment variables
console.log('🔍 Environment check:');
console.log('SUPABASE_URL exists:', !!process.env.SUPABASE_URL);
console.log('RETELL_API_KEY exists:', !!process.env.RETELL_API_KEY);
console.log('RETELL_AGENT_ID exists:', !!process.env.RETELL_AGENT_ID);
console.log('GHL_API_KEY exists:', !!process.env.GHL_API_KEY);
console.log('GHL_LOCATION_ID exists:', !!process.env.GHL_LOCATION_ID);

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
// 🆕 CALENDAR INTEGRATION FUNCTIONS
// ================================

const GHL_BASE_URL = 'https://rest.gohighlevel.com/v1';
const LOCATION_ID = process.env.GHL_LOCATION_ID || process.env.LOCATION_ID || 'llj5AyvYH8kun6U6fX84';
const BUSINESS_HOURS = {
  start: 9, // 9 AM
  end: 17,  // 5 PM
  timezone: 'America/Los_Vegas' // Las Vegas timezone
};

const APPOINTMENT_CONFIG = {
  duration: 60, // 1 hour in minutes
  buffer: 60,   // 1 hour buffer between appointments
  title: 'Estimate' // Will be "Estimate - John Smith"
};

async function makeGHLRequest(endpoint, method = 'GET', body = null) {
  const url = `${GHL_BASE_URL}${endpoint}`;
  
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'  // Add version header for v1 API
    }
  };
  
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }
  
  try {
    console.log(`🔍 Making GHL request to: ${url}`);
    console.log(`🔑 Using API key: ${process.env.GHL_API_KEY ? process.env.GHL_API_KEY.substring(0, 10) + '...' : 'MISSING'}`);
    
    const response = await fetch(url, options);
    const data = await response.json();
    
    console.log(`📡 Response status: ${response.status}`);
    console.log(`📦 Response data:`, data);
    
    if (!response.ok) {
      throw new Error(`GHL API Error: ${response.status} - ${JSON.stringify(data)}`);
    }
    
    return { success: true, data };
  } catch (error) {
    console.error('GHL API Request Failed:', error);
    return { success: false, error: error.message };
  }
}

async function getLocationCalendars() {
  console.log('🔍 Getting calendars via locations endpoint...');
  
  try {
    // First, get all locations (this works!)
    const locationsResult = await makeGHLRequest('/locations');
    
    if (!locationsResult.success) {
      console.error('❌ Failed to get locations:', locationsResult.error);
      return [];
    }
    
    console.log('✅ Got locations data successfully');
    
    // Find our specific location
    const locations = locationsResult.data.locations || [locationsResult.data];
    const targetLocation = locations.find(loc => loc.id === LOCATION_ID) || locations[0];
    
    if (!targetLocation) {
      console.error('❌ Target location not found');
      return [];
    }
    
    console.log('🎯 Using location:', targetLocation.name, targetLocation.id);
    
    // Try location-specific calendar endpoints
    const calendarEndpoints = [
      `/locations/${targetLocation.id}/calendars`,
      `/calendars?locationId=${targetLocation.id}`,
      `/calendars/${targetLocation.id}`,
      `/locations/${targetLocation.id}/calendar`,
    ];
    
    for (const endpoint of calendarEndpoints) {
      try {
        console.log(`🧪 Testing calendar endpoint: ${endpoint}`);
        const result = await makeGHLRequest(endpoint);
        
        if (result.success) {
          console.log(`✅ SUCCESS with: ${endpoint}`);
          console.log(`📅 Calendar data:`, JSON.stringify(result.data, null, 2));
          return result.data.calendars || result.data || [];
        } else {
          console.log(`❌ FAILED ${endpoint}:`, result.error);
        }
      } catch (endpointError) {
        console.log(`💥 ERROR testing ${endpoint}:`, endpointError.message);
      }
    }
    
    console.error('❌ All calendar endpoints failed - trying simple calendars endpoint');
    
    // Last attempt - try simple calendars
    try {
      const simpleResult = await makeGHLRequest('/calendars');
      if (simpleResult.success) {
        console.log('✅ Simple calendars worked:', simpleResult.data);
        return simpleResult.data.calendars || simpleResult.data || [];
      }
    } catch (finalError) {
      console.log('💥 Final calendars attempt failed:', finalError.message);
    }
    
    return [];
    
  } catch (error) {
    console.error('💥 getLocationCalendars error:', error.message);
    return [];
  }
}

async function getCalendarEvents(calendarId, startDate, endDate) {
  const endpoint = `/calendars/${calendarId}/events?startDate=${startDate}&endDate=${endDate}`;
  const result = await makeGHLRequest(endpoint);
  
  if (result.success) {
    return result.data.events || [];
  }
  
  console.error('Failed to get events:', result.error);
  return [];
}

function isBusinessHour(hour, minute = 0) {
  return hour >= BUSINESS_HOURS.start && hour < BUSINESS_HOURS.end;
}

function isWeekday(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5; // Monday = 1, Friday = 5
}

async function getAvailableSlots(calendarId, targetDate) {
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);
  
  const existingEvents = await getCalendarEvents(
    calendarId, 
    startOfDay.toISOString(), 
    endOfDay.toISOString()
  );
  
  const availableSlots = [];
  
  if (!isWeekday(new Date(targetDate))) {
    return availableSlots; // No weekend appointments
  }
  
  for (let hour = BUSINESS_HOURS.start; hour < BUSINESS_HOURS.end; hour++) {
    const slotStart = new Date(targetDate);
    slotStart.setHours(hour, 0, 0, 0);
    
    const slotEnd = new Date(slotStart);
    slotEnd.setMinutes(slotEnd.getMinutes() + APPOINTMENT_CONFIG.duration);
    
    const hasConflict = existingEvents.some(event => {
      const eventStart = new Date(event.startTime);
      const eventEnd = new Date(event.endTime);
      
      const bufferStart = new Date(eventStart);
      bufferStart.setMinutes(bufferStart.getMinutes() - APPOINTMENT_CONFIG.buffer);
      
      const bufferEnd = new Date(eventEnd);
      bufferEnd.setMinutes(bufferEnd.getMinutes() + APPOINTMENT_CONFIG.buffer);
      
      return (slotStart < bufferEnd && slotEnd > bufferStart);
    });
    
    if (!hasConflict) {
      availableSlots.push({
        startTime: slotStart.toISOString(),
        endTime: slotEnd.toISOString(),
        displayTime: slotStart.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        })
      });
    }
  }
  
  return availableSlots;
}

async function findNextAvailableSlots(calendarId, daysAhead = 14) {
  const availableSlots = [];
  const today = new Date();
  
  for (let i = 0; i < daysAhead; i++) {
    const checkDate = new Date(today);
    checkDate.setDate(today.getDate() + i);
    
    const daySlots = await getAvailableSlots(calendarId, checkDate);
    
    if (daySlots.length > 0) {
      availableSlots.push({
        date: checkDate.toDateString(),
        slots: daySlots
      });
    }
    
    if (availableSlots.length >= 5) break;
  }
  
  return availableSlots;
}

async function checkAvailabilityForAI(daysAhead = 7) {
  try {
    const calendars = await getLocationCalendars();
    
    if (calendars.length === 0) {
      throw new Error('No calendars found for location');
    }
    
    const primaryCalendar = calendars[0];
    const availability = await findNextAvailableSlots(primaryCalendar.id, daysAhead);
    
    return {
      success: true,
      calendar: primaryCalendar,
      availability: availability,
      message: `Found ${availability.length} days with available slots`
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function bookEstimateAppointment(appointmentData) {
  try {
    const calendars = await getLocationCalendars();
    
    if (calendars.length === 0) {
      throw new Error('No calendars found for location');
    }
    
    const primaryCalendar = calendars[0];
    
    const {
      clientName,
      clientPhone,
      clientEmail,
      homeAddress,
      estimateType,
      callSummary,
      startTime,
      endTime
    } = appointmentData;
    
    const title = `${APPOINTMENT_CONFIG.title} - ${clientName}`;
    
    const description = `
🏠 ESTIMATE APPOINTMENT

📋 Client Information:
• Name: ${clientName}
• Phone: ${clientPhone}
• Email: ${clientEmail}
• Address: ${homeAddress}

🔨 Estimate Type: ${estimateType}

📞 Call Summary:
${callSummary}

⏰ Scheduled by AI Lead Manager
    `.trim();
    
    const eventData = {
      title,
      description,
      startTime,
      endTime,
      locationId: LOCATION_ID,
      contactId: appointmentData.contactId || null,
      appointmentStatus: 'confirmed'
    };
    
    const result = await makeGHLRequest(`/calendars/${primaryCalendar.id}/events`, 'POST', eventData);
    
    if (result.success) {
      console.log('✅ Appointment booked successfully:', result.data);
      return {
        success: true,
        appointmentId: result.data.id,
        appointment: result.data
      };
    } else {
      console.error('❌ Failed to book appointment:', result.error);
      return {
        success: false,
        error: result.error
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// ================================
// 🆕 NEW CALENDAR ENDPOINTS
// ================================

// Test calendar integration
app.get('/webhook/test-calendar', async (req, res) => {
  try {
    console.log('🧪 Testing calendar integration...');
    console.log('🔑 API Key check:', process.env.GHL_API_KEY ? 'Present' : 'MISSING');
    console.log('📍 Location ID:', LOCATION_ID);
    
    const availability = await checkAvailabilityForAI(3);
    res.json({
      message: 'Calendar integration test',
      availability: availability,
      timestamp: new Date().toISOString(),
      debug: {
        api_key_present: !!process.env.GHL_API_KEY,
        location_id: LOCATION_ID,
        api_key_preview: process.env.GHL_API_KEY ? process.env.GHL_API_KEY.substring(0, 20) + '...' : 'MISSING'
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Calendar test failed',
      details: error.message,
      debug: {
        api_key_present: !!process.env.GHL_API_KEY,
        location_id: LOCATION_ID
      }
    });
  }
});

// Test basic API connection
app.get('/webhook/test-api-basic', async (req, res) => {
  try {
    console.log('🧪 Testing basic GHL API connection...');
    
    // Test basic endpoints to see which ones work
    const testEndpoints = [
      '/ping',
      '/users/me', 
      '/locations',
      '/calendars',
      '/calendars/teams'
    ];
    
    const results = {};
    
    for (const endpoint of testEndpoints) {
      console.log(`🔍 Testing: ${endpoint}`);
      const result = await makeGHLRequest(endpoint);
      results[endpoint] = {
        success: result.success,
        status: result.success ? 'OK' : result.error
      };
    }
    
    res.json({
      message: 'Basic API connection test',
      api_key_format: process.env.GHL_API_KEY ? process.env.GHL_API_KEY.substring(0, 20) + '...' : 'MISSING',
      location_id: LOCATION_ID,
      test_results: results,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      error: 'Basic API test failed',
      details: error.message
    });
  }
});

// Check availability endpoint
app.get('/webhook/availability/bestbuyremodel', async (req, res) => {
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

// Book appointment endpoint
app.post('/webhook/book-appointment/bestbuyremodel', async (req, res) => {
  try {
    console.log('📅 Booking appointment request:', req.body);
    
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

    const bookingResult = await bookEstimateAppointment(appointmentData);

    if (bookingResult.success) {
      console.log(`✅ Appointment booked for ${clientName} at ${startTime.toLocaleString()}`);
      
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

// ================================
// EXISTING ENDPOINTS (UPDATED)
// ================================

// GHL BRIDGE WEBHOOK - WITH CALENDAR INTEGRATION
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

    // Step 2: Create GHL contact via API
    let ghlContact = null;
    if (process.env.GHL_API_KEY && LOCATION_ID) {
      ghlContact = await createGHLContact(leadData);
    }

    // 🆕 Step 3: Check calendar availability
    console.log('📅 Checking calendar availability...');
    const availability = await checkAvailabilityForAI(7);
    
    if (availability.success && availability.availability.length > 0) {
      console.log(`✅ Found ${availability.availability.length} days with available slots`);
      leadData.availability = availability.availability;
    } else {
      console.log('⚠️ No availability found, Carl will handle scheduling manually');
      leadData.availability = [];
    }

    // Step 4: Initiate AI call via Retell with availability
    const callResult = await initiateAICall(leadData, savedLead?.id, ghlContact?.contact?.id);
    
    // Step 5: Send response
    res.json({ 
      success: true, 
      message: 'Lead processed, GHL contact created, availability checked, and AI call initiated',
      railway_lead_id: savedLead?.id,
      ghl_contact_id: ghlContact?.contact?.id,
      call_id: callResult.call_id,
      ghl_contact_created: !!ghlContact,
      availability_slots: availability.success ? availability.availability.length : 0
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
      locationId: LOCATION_ID
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

// Function to initiate AI call via Retell
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
        // 🆕 Include availability for Carl
        calendar_availability: JSON.stringify(leadData.availability || [])
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
        console.log('🎉 Appointment was booked during call!');
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
    location_id: LOCATION_ID,
    calendar_integration: true
  });
});

// Test endpoint
app.get('/webhook/test', (req, res) => {
  res.json({
    message: 'GHL Bridge is working!',
    endpoint: '/webhook/ghl-bridge/bestbuyremodel',
    timestamp: new Date().toISOString(),
    calendar_enabled: true
  });
});

// Simple homepage
app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Nuviao GHL-Railway Bridge</h1>
    <p>Status: ✅ Online</p>
    <p>GHL API: ${process.env.GHL_API_KEY ? '✅ Configured' : '❌ Not Configured'}</p>
    <p>Location ID: ${LOCATION_ID || 'Not Set'}</p>
    <p>📅 Calendar Integration: ✅ Enabled</p>
    <hr>
    <h3>🔗 Available Endpoints:</h3>
    <ul>
      <li><code>POST /webhook/ghl-bridge/bestbuyremodel</code> - Main GHL bridge with calendar</li>
      <li><code>POST /webhook/retell/bestbuyremodel</code> - Retell webhook</li>
      <li><code>POST /webhook/book-appointment/bestbuyremodel</code> - Book appointments</li>
      <li><code>GET /webhook/availability/bestbuyremodel</code> - Check availability</li>
      <li><code>GET /webhook/test-calendar</code> - Test calendar integration</li>
    </ul>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Nuviao Bridge running on port ${PORT}`);
  console.log(`🎯 GHL Bridge ready with API contact creation!`);
  console.log(`📅 Calendar integration enabled!`);
});
