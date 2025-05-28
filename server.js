const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Debug ALL environment variables
console.log('🔍 All Environment Variables:');
console.log('PORT:', process.env.PORT);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('SUPABASE_URL exists:', !!process.env.SUPABASE_URL);
console.log('SUPABASE_ANON_KEY exists:', !!process.env.SUPABASE_ANON_KEY);

// Basic middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'Nuviao AI Lead Manager',
    env_vars: {
      supabase_url: !!process.env.SUPABASE_URL,
      supabase_key: !!process.env.SUPABASE_ANON_KEY
    }
  });
});

// Simple webhook (no database for now)
app.post('/webhook/leads/bestbuyremodel', (req, res) => {
  console.log('📞 Lead received:', req.body);
  res.json({ 
    success: true, 
    message: 'Lead received successfully!',
    lead_data: req.body
  });
});

// Simple dashboard
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Best Buy Remodel - Lead Manager</title></head>
      <body style="font-family: Arial; padding: 20px;">
        <h1>🏠 Best Buy Remodel - Lead Manager</h1>
        <p><strong>Status:</strong> ✅ System Online</p>
        <p><strong>Webhook URL:</strong> <code>${req.protocol}://${req.get('host')}/webhook/leads/bestbuyremodel</code></p>
        
        <h2>Test Your Webhook:</h2>
        <button onclick="sendTest()">Send Test Lead</button>
        <div id="result"></div>
        
        <script>
          async function sendTest() {
            try {
              const response = await fetch('/webhook/leads/bestbuyremodel', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                  name: 'John Smith',
                  phone: '555-123-4567',
                  email: 'john@example.com',
                  project_type: 'kitchen remodel'
                })
              });
              const result = await response.json();
              document.getElementById('result').innerHTML = '<p style="color: green;">✅ ' + result.message + '</p>';
            } catch (error) {
              document.getElementById('result').innerHTML = '<p style="color: red;">❌ Error: ' + error.message + '</p>';
            }
          }
        </script>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
