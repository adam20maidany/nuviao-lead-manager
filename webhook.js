const express = require('express');
const router = express.Router();

// Universal Lead Webhook - Best Buy Remodel
router.post('/leads/bestbuyremodel', async (req, res) => {
  try {
    console.log('📞 New lead received for Best Buy Remodel:', req.body);
    
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

    // Create lead in database
    const { data: lead, error } = await global.supabase
      .from('leads')
      .insert({
        client_id: 1, // Best Buy Remodel
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
      return res.status(500).json({ error: 'Failed to save lead' });
    }
    
    console.log(`✅ Lead processed successfully: ${lead.name} - ${lead.phone}`);
    
    res.json({ 
      success: true, 
      lead_id: lead.id,
      message: 'Lead received and will be called shortly'
    });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: 'Failed to process lead' });
  }
});

// Test webhook endpoint
router.get('/test/bestbuyremodel', (req, res) => {
  res.json({
    message: 'Best Buy Remodel webhook is live!',
    webhook_url: `${req.protocol}://${req.get('host')}/webhook/leads/bestbuyremodel`,
    test_payload: {
      name: 'John Smith',
      phone: '555-123-4567',
      email: 'john@example.com',
      source: 'website',
      project_type: 'kitchen remodel',
      message: 'Looking for kitchen renovation quote'
    }
  });
});

module.exports = router;