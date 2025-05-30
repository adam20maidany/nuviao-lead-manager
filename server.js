const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
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

// Make supabase globally available
global.supabase = supabase;

// Basic middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Routes - THIS IS THE CRITICAL PART
app.use('/api', require('./routes/api'));
app.use('/webhook', require('./routes/webhooks'));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'Nuviao AI Lead Manager',
    retell_configured: !!(process.env.RETELL_API_KEY && process.env.RETELL_AGENT_ID)
  });
});

// Serve dashboard
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Nuviao AI Lead Manager</title></head>
      <body style="font-family: Arial; padding: 20px; background: #f5f5f5;">
        <div style="max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <h1>🏠 Nuviao AI Lead Manager</h1>
          <p><strong>Status:</strong> ✅ System Online</p>
          <p><strong>AI Agent:</strong> Carl (Retell AI)</p>
          
          <div style="background: #f0f8ff; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3>🎯 Available Endpoints:</h3>
            <p><strong>GHL Bridge:</strong> <code>/webhook/ghl-bridge/bestbuyremodel</code></p>
            <p><strong>Direct Webhook:</strong> <code>/webhook/leads/bestbuyremodel</code></p>
            <p><strong>Health Check:</strong> <code>/health</code></p>
          </div>
          
          <div style="margin-top: 30px; padding: 15px; background: #fff3cd; border-radius: 5px;">
            <h3>📋 System Architecture:</h3>
            <ol>
              <li>GHL receives leads via webhook</li>
              <li>GHL creates contact and sends to Railway bridge</li>
              <li>Railway processes lead and calls Retell AI</li>
              <li>Carl (AI) calls the lead immediately</li>
              <li>Call outcomes update back to GHL</li>
            </ol>
          </div>
        </div>
      </body>
    </html>
  `);
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
  console.log(`🚀 AI Lead Manager running on port ${PORT}`);
  console.log(`📊 Dashboard: Visit your Railway URL`);
  console.log(`🎯 Webhook: ${process.env.RAILWAY_STATIC_URL || 'Your Railway URL'}/webhook/ghl-bridge/bestbuyremodel`);
});
