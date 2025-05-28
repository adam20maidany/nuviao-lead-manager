const express = require('express');
const cors = require('cors');
const path = require('path');
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
}

// Basic middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Function to initiate AI call
async function initiateAICall(lead) {
  try {
    if (!process.env.RETELL_API_KEY || !process.env.RETELL_AGENT_ID) {
      console.log('⚠️ Retell not configured - skipping AI call');
      return null;
    }

    console.log(`📞 Initiating AI call for ${lead.name} at ${lead.phone}`);
    
    const response = await axios.post('https://api.retellai.com/create-phone-call', {
      from_number: '+17252092232',
      to_number: lead.phone,
      agent_id: process.env.RETELL_AGENT_ID,
      metadata: {
        lead_id: lead.id,
        first_name: lead.name.split(' ')[0],
        last_name: lead.name.split(' ').slice(1).join(' ') || '',
        project_type: lead.custom_fields?.project_type || 'home renovation',
        phone: lead.phone,
        email: lead.email || '',
        project_notes: lead.custom_fields?.message || ''
      }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.RETELL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`✅ AI call initiated! Call ID: ${response.data.call_id}`);
    return response.data;

  } catch (error) {
    console.error('❌ Failed to initiate AI call:', error.response?.data || error.message);
    return null;
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'Nuviao AI Lead Manager',
    retell_configured: !!(process.env.RETELL_API_KEY && process.env.RETELL_AGENT_ID)
  });
});

// Lead webhook with AI calling
app.post('/webhook/leads/bestbuyremodel', async (req, res) => {
  try {
    console.log('📞 Lead received:', req.body);
    
    const leadData = {
      name: req.body.name || req.body.full_name || 'Unknown',
      phone: req.body.phone || req.body.phone_number,
      email: req.body.email,
      source: req.body.source || 'webhook',
      project_type: req.body.project_type || req.body.service || 'general renovation',
      message: req.body.message || req.body.comments || ''
    };

    // Validate required fields
    if (!leadData.name || !leadData.phone) {
      return res.status(400).json({ 
        error: 'Missing required fields: name and phone' 
      });
    }

    let lead = null;

    // Save to database if available
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .insert({
          client_id: 1,
          name: leadData.name,
          phone: leadData.phone,
          email: leadData.email,
          source: leadData.source,
          status: 'new',
          custom_fields: {
            project_type: leadData.project_type,
            message: leadData.message
          }
        })
        .select()
        .single();

      if (error) {
        console.error('Database error:', error);
      } else {
        lead = data;
        console.log(`✅ Lead saved to database: ${lead.id}`);
      }
    }

    // Create lead object for AI call (even if database failed)
    if (!lead) {
      lead = {
        id: Date.now(), // Temporary ID
        name: leadData.name,
        phone: leadData.phone,
        email: leadData.email,
        custom_fields: {
          project_type: leadData.project_type,
          message: leadData.message
        }
      };
    }

    // Initiate AI call
    const callResult = await initiateAICall(lead);
    
    res.json({ 
      success: true, 
      lead_id: lead.id,
      message: 'Lead received and AI call initiated!',
      call_id: callResult?.call_id || null
    });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: 'Failed to process lead' });
  }
});

// Retell webhook to handle call outcomes
app.post('/webhook/retell/bestbuyremodel', async (req, res) => {
  try {
    console.log('🤖 Retell webhook received:', req.body.event_type);
    
    if (req.body.event_type === 'call_ended') {
      const { call_id, call_analysis } = req.body;
      console.log(`📞 Call ${call_id} ended. Analysis:`, call_analysis?.summary || 'No summary');
      
      // Here you could update the lead status based on call outcome
      // For now, just log it
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Retell webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Simple dashboard
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Best Buy Remodel - AI Lead Manager</title></head>
      <body style="font-family: Arial; padding: 20px; background: #f5f5f5;">
        <div style="max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h1>🏠 Best Buy Remodel - AI Lead Manager</h1>
          <p><strong>Status:</strong> ✅ System Online & AI Calling Active</p>
          <p><strong>Agent:</strong> Carl (Retell AI)</p>
          <p><strong>Business Phone:</strong> +1 (725) 209-2232</p>
          
          <div style="background: #f0f8ff; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3>🎯 Your Webhook URL:</h3>
            <code style="background: #e6e6e6; padding: 5px; border-radius: 3px;">${req.protocol}://${req.get('host')}/webhook/leads/bestbuyremodel</code>
          </div>
          
          <h2>🧪 Test Your AI System:</h2>
          <button onclick="sendTest()" style="background: #4CAF50; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px;">Send Test Lead & Trigger AI Call</button>
          <div id="result" style="margin-top: 15px;"></div>
          
          <div style="margin-top: 30px; padding: 15px; background: #fff3cd; border-radius: 5px;">
            <h3>📋 How It Works:</h3>
            <ol>
              <li>Lead comes in via webhook</li>
              <li>System saves lead to database</li>
              <li><strong>Carl (AI) immediately calls the lead</strong></li>
              <li>AI attempts to book in-home consultation</li>
              <li>Follow-ups scheduled if needed</li>
            </ol>
          </div>
        </div>
        
        <script>
          async function sendTest() {
            const button = document.querySelector('button');
            button.disabled = true;
            button.textContent = 'Sending Test Lead...';
            
            try {
              const response = await fetch('/webhook/leads/bestbuyremodel', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                  name: 'John Smith',
                  phone: '555-123-4567',
                  email: 'john@example.com',
                  project_type: 'kitchen remodel',
                  message: 'Looking for a kitchen renovation estimate',
                  source: 'test'
                })
              });
              const result = await response.json();
              
              if (result.success) {
                document.getElementById('result').innerHTML = 
                  '<div style="color: green; background: #d4edda; padding: 10px; border-radius: 5px;">' +
                  '✅ Success! Lead received and AI call initiated!<br>' +
                  'Lead ID: ' + result.lead_id + '<br>' +
                  (result.call_id ? 'Call ID: ' + result.call_id : 'Call will be initiated shortly') +
                  '</div>';
              } else {
                throw new Error(result.error || 'Unknown error');
              }
            } catch (error) {
              document.getElementById('result').innerHTML = 
                '<div style="color: red; background: #f8d7da; padding: 10px; border-radius: 5px;">❌ Error: ' + error.message + '</div>';
            }
            
            button.disabled = false;
            button.textContent = 'Send Test Lead & Trigger AI Call';
          }
        </script>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 AI Lead Manager running on port ${PORT}`);
  console.log(`📊 Dashboard: Visit your Railway URL`);
  console.log(`🎯 Webhook: ${process.env.RAILWAY_STATIC_URL || 'Your Railway URL'}/webhook/leads/bestbuyremodel`);
});
