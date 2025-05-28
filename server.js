const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Debug environment variables
console.log('🔍 Environment check:');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? 'SET' : 'MISSING');
console.log('SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? 'SET' : 'MISSING');

// Basic middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Supabase only if environment variables exist
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
  console.log('✅ Supabase initialized');
} else {
  console.log('⚠️ Supabase not initialized - missing environment variables');
}

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'Nuviao AI Lead Manager',
    supabase_connected: !!supabase
  });
});

// Simple webhook for testing
app.post('/webhook/leads/bestbuyremodel', async (req, res) => {
  try {
    console.log('📞 Lead received:', req.body);
    
    if (supabase) {
      // Try to save to database
      const { data, error } = await supabase
        .from('leads')
        .insert({
          client_id: 1,
          name: req.body.name || 'Test Lead',
          phone: req.body.phone || '555-123-4567',
          email: req.body.email,
          source: req.body.source || 'webhook',
          status: 'new'
        })
        .select()
        .single();
      
      if (error) {
        console.error('Database error:', error);
        return res.json({ success: true, message: 'Lead received but not saved to database', error: error.message });
      }
      
      console.log('✅ Lead saved to database:', data.id);
      res.json({ success: true, message: 'Lead received and saved!', lead_id: data.id });
    } else {
      res.json({ success: true, message: 'Lead received (database not connected)' });
    }
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.json({ success: false, error: error.message });
  }
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Dashboard: Visit your Railway URL`);
  console.log(`🎯 Webhook: Visit your Railway URL/webhook/leads/bestbuyremodel`);
});
