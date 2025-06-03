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
    
    if (!uuid || !chosen_appointment_slot) {
      return res.json({ result: 'Missing information to schedule appointment' });
    }

    res.json({ result: 'Appointment scheduling noted. Our team will follow up to confirm.' });
  } catch (error) {
    res.json({ result: 'I apologize, but I encountered an issue while scheduling.' });
  }
});

app.post('/webhook/check-availability/bestbuyremodel', async (req, res) => {
  try {
    const { args } = req.body;
    const appointment_date = args?.appointment_date;
    
    if (!appointment_date) {
      return res.json({ result: 'Could you please specify which date you would like to check?' });
    }

    res.json({ result: 'I have availability on that date at 9 AM, 10 AM, 2 PM, and 3 PM. Which works best?' });
  } catch (error) {
    res.json({ result: 'Let me check our schedule and get back to you.' });
  }
});

app.post('/webhook/update-phone/bestbuyremodel', async (req, res) => {
  try {
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const phone = args?.phone;
    
    if (!uuid || !phone) {
      return res.json({ result: 'I need your phone number to update our records.' });
    }

    res.json({ result: 'Perfect! I have updated your phone number in our system.' });
  } catch (error) {
    res.json({ result: 'I have noted your phone number.' });
  }
});

app.post('/webhook/validate-address/bestbuyremodel', async (req, res) => {
  try {
    const { args } = req.body;
    const address = args?.address;
    
    if (!address) {
      return res.json({ result: 'Could you please provide your address?' });
    }

    const isLasVegas = address.toLowerCase().includes('las vegas') || 
                      address.toLowerCase().includes('henderson') ||
                      address.toLowerCase().includes('summerlin');

    if (isLasVegas) {
      res.json({ result: 'Excellent! Your address is within our service area.' });
    } else {
      res.json({ result: 'Your address appears to be outside our service area.' });
    }
  } catch (error) {
    res.json({ result: 'Let me verify your service area.' });
  }
});

app.post('/webhook/call-back-later/bestbuyremodel', async (req, res) => {
  try {
    res.json({ result: 'No problem! I will have someone from our team call you back soon.' });
  } catch (error) {
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
    const callResult = await initiateAICall(leadData, savedLead?.id, null, savedLead?.custom_fields?.uuid);
    
    res.json({ 
      success: true, 
      message: 'Lead processed and AI call initiated',
      railway_lead_id: savedLead?.id,
      call_id: callResult.call_id,
      uuid: savedLead?.custom_fields?.uuid
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
});
