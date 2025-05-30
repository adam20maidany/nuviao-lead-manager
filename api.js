const express = require('express');
const router = express.Router();
const moment = require('moment-timezone');

// Dashboard stats endpoint
router.get('/dashboard/stats', async (req, res) => {
  try {
    const clientId = 1; // Best Buy Remodel
    const today = moment().tz('America/Los_Angeles').format('YYYY-MM-DD');
    
    // Get basic stats
    const { data: leads } = await global.supabase
      .from('leads')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });
    
    const { data: calls } = await global.supabase
      .from('call_history')
      .select('*, leads(name, phone)')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });
    
    // Calculate stats
    const totalLeads = leads?.length || 0;
    const callsToday = calls?.filter(call => 
      moment(call.created_at).tz('America/Los_Angeles').format('YYYY-MM-DD') === today
    ).length || 0;
    
    const bookingsToday = calls?.filter(call => 
      call.outcome === 'booked' && 
      moment(call.created_at).tz('America/Los_Angeles').format('YYYY-MM-DD') === today
    ).length || 0;
    
    const totalCalls = calls?.length || 0;
    const totalBookings = calls?.filter(call => call.outcome === 'booked').length || 0;
    const conversionRate = totalCalls > 0 ? Math.round((totalBookings / totalCalls) * 100) : 0;
    
    // Recent data
    const recentLeads = leads?.slice(0, 10) || [];
    const recentCalls = calls?.slice(0, 10).map(call => ({
      ...call,
      lead_name: call.leads?.name || 'Unknown',
      lead_phone: call.leads?.phone || 'Unknown'
    })) || [];
    
    res.json({
      total_leads: totalLeads,
      calls_today: callsToday,
      bookings_today: bookingsToday,
      conversion_rate: conversionRate,
      recent_leads: recentLeads,
      recent_calls: recentCalls
    });
    
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to load dashboard stats' });
  }
});

module.exports = router;
