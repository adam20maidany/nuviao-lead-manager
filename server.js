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

// GHL BRIDGE WEBHOOK - ALL IN ONE
app.post('/webhook/ghl-bridge/bestbuyremodel', async (req, res) => {
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
    let callResult = { success: false, error: 'Retell not configured' };
    
    if (process.env.RETELL_API_KEY && process.env.RETELL_AGENT_ID) {
      try {
        console.log(`📞 Calling Retell AI for ${leadData.name} at ${leadData.phone}`);
        
        const response = await axios.post('https://api.retellai.com/v2/create-phone-call', {
          from_number: '+17252092232',
          to_number: leadData.phone,
          agent_id: process.env.RETELL_AGENT_ID,
          metadata: {
            lead_id: savedLead?.id,
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

        callResult = { 
          success: true, 
          call_id: response.data.call_id 
        };
        console.log(`✅ AI call initiated successfully: ${response.data.call_id}`);

      } catch (error) {
        callResult = { 
          success: false, 
          error: error.response?.data || error.message 
        };
        console.error(`❌ AI call failed:`, callResult.error);
      }
    }
    
    if (callResult.success) {
      res.json({ 
        success: true, 
        message: 'Lead processed and AI call initiated',
        lead_id: savedLead?.id,
        call_id: callResult.call_id
      });
    } else {
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

// RETELL WEBHOOK
app.post('/webhook/retell/bestbuyremodel', async (req, res) => {
  try {
    console.log('🤖 Retell webhook received:', req.body.event_type);
    
    if (req.body.event_type === 'call_ended') {
      const { call_id, call_analysis } = req.body;
      
      // Determine call outcome
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
    service: 'Nuviao GHL-Railway Bridge'
  });
});

// Simple homepage
app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Nuviao GHL-Railway Bridge</h1>
    <p>Status: ✅ Online</p>
    <p>GHL Bridge Endpoint: <code>/webhook/ghl-bridge/bestbuyremodel</code></p>
    <p>Health Check: <code>/health</code></p>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Nuviao Bridge running on port ${PORT}`);
  console.log(`🎯 GHL Bridge ready at: /webhook/ghl-bridge/bestbuyremodel`);
});
