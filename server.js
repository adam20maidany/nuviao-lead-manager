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

// 🆕 Import Smart Callback Algorithm
const { 
  SmartCallbackPredictor,
  initializeCallback,
  getOptimalCallTimes,
  recordCall
} = require('./smart-callback-algorithm');

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
// 🆕 SMART CALLBACK ENDPOINTS
// ================================

// Get AI-predicted optimal call times for a lead
app.get('/webhook/optimal-call-times/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const daysAhead = parseInt(req.query.days) || 3;
    
    console.log(`🧠 Getting optimal call times for lead ${leadId}`);
    
    const predictor = new SmartCallbackPredictor();
    const predictions = await predictor.predictOptimalCallTimes(leadId, daysAhead);
    
    res.json({
      success: true,
      lead_id: leadId,
      predictions: predictions,
      total_days: predictions.length
    });
    
  } catch (error) {
    console.error('❌ Optimal call times error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get optimal call times'
    });
  }
});

// Schedule smart callbacks for a lead
app.post('/webhook/schedule-smart-callbacks/bestbuyremodel', async (req, res) => {
  try {
    const { leadId, initialOutcome, maxCallbacksPerDay } = req.body;
    
    if (!leadId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: leadId'
      });
    }
    
    console.log(`🧠 Scheduling smart callbacks for lead ${leadId}, outcome: ${initialOutcome}`);
    
    const result = await initializeCallback(leadId, initialOutcome || 'no_answer');
    
    res.json(result);
    
  } catch (error) {
    console.error('❌ Schedule smart callbacks error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to schedule smart callbacks'
    });
  }
});

// Get pending callbacks from the queue
app.get('/webhook/callback-queue', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const futureTime = new Date();
    futureTime.setMinutes(futureTime.getMinutes() + 30); // Next 30 minutes
    
    const { data, error } = await global.supabase
      .from('callback_queue')
      .select(`
        *,
        leads (
          id,
          name,
          phone,
          email,
          custom_fields
        )
      `)
      .eq('status', 'scheduled')
      .gte('scheduled_time', now)
      .lte('scheduled_time', futureTime.toISOString())
      .order('predicted_score', { ascending: false });
    
    if (error) throw error;
    
    res.json({
      success: true,
      pending_callbacks: data || [],
      count: data?.length || 0
    });
    
  } catch (error) {
    console.error('❌ Get callback queue error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get callback queue'
    });
  }
});

// Update callback with actual outcome (for learning)
app.post('/webhook/update-callback-outcome/bestbuyremodel', async (req, res) => {
  try {
    const { callbackId, actualOutcome, callDuration, retellCallId } = req.body;
    
    if (!callbackId || !actualOutcome) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: callbackId and actualOutcome'
      });
    }
    
    console.log(`🎯 Updating callback ${callbackId} with outcome: ${actualOutcome}`);
    
    const predictor = new SmartCallbackPredictor();
    const accuracyResult = await predictor.updatePredictionAccuracy(callbackId, actualOutcome);
    
    // Also update the callback record
    const { error } = await global.supabase
      .from('callback_queue')
      .update({
        status: 'completed',
        actual_outcome: actualOutcome,
        retell_call_id: retellCallId,
        completed_at: new Date().toISOString()
      })
      .eq('id', callbackId);
    
    if (error) throw error;
    
    res.json({
      success: true,
      message: 'Callback outcome updated successfully',
      prediction_accuracy: accuracyResult?.accuracy
    });
    
  } catch (error) {
    console.error('❌ Update callback outcome error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update callback outcome'
    });
  }
});

// ================================
// 🚀 RETELL CUSTOM FUNCTIONS (FIXED)
// ================================

// 1. Schedule Lead (Google Calendar Integration)
app.post('/webhook/schedule-lead/bestbuyremodel', async (req, res) => {
  try {
    console.log('📅 Schedule Lead called:', req.body);
    
    // Extract from call metadata and function args
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const chosen_appointment_slot = args?.chosen_appointment_slot;
    const additional_information = args?.additional_information;
    
    if (!uuid || !chosen_appointment_slot) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: UUID and chosen_appointment_slot'
      });
    }

    // Convert YYYY-mm-dd hh:mm:ss to ISO timestamp
    const appointmentDate = new Date(chosen_appointment_slot.replace(' ', 'T') + ':00.000Z');
    const endDate = new Date(appointmentDate);
    endDate.setHours(endDate.getHours() + 1);

    // Get lead information from metadata or database
    let leadInfo = {
      clientName: call?.metadata?.full_name || 'Lead ' + uuid.substring(0, 8),
      clientPhone: call?.metadata?.phone || 'Unknown',
      clientEmail: call?.metadata?.email || 'unknown@email.com',
      homeAddress: 'Address to be confirmed',
      estimateType: 'General Estimate'
    };

    // Try to get additional lead info from Supabase
    if (global.supabase) {
      try {
        const { data, error } = await global.supabase
          .from('leads')
          .select('*')
          .eq('custom_fields->uuid', uuid)
          .single();
        
        if (data) {
          leadInfo = {
            clientName: data.name || leadInfo.clientName,
            clientPhone: data.phone || leadInfo.clientPhone,
            clientEmail: data.email || leadInfo.clientEmail,
            homeAddress: data.custom_fields?.full_address || leadInfo.homeAddress,
            estimateType: data.custom_fields?.project_type || leadInfo.estimateType
          };
        }
      } catch (dbError) {
        console.log('Note: Could not fetch lead details from database');
      }
    }

    const appointmentData = {
      ...leadInfo,
      callSummary: additional_information || 'Scheduled via AI call',
      startTime: appointmentDate.toISOString(),
      endTime: endDate.toISOString()
    };

    // Book in Google Calendar if available
    if (googleTokens) {
      const bookingResult = await bookAppointmentWithGoogle(googleTokens, appointmentData);
      
      if (bookingResult.success) {
        console.log(`✅ Google Calendar appointment booked for ${leadInfo.clientName}`);
        
        // Update lead status in database
        if (global.supabase) {
          try {
            await global.supabase
              .from('leads')
              .update({ 
                status: 'appointment_booked',
                appointment_time: appointmentDate.toISOString()
              })
              .eq('custom_fields->uuid', uuid);
          } catch (dbError) {
            console.error('Failed to update lead status:', dbError);
          }
        }

        res.json({
          result: `Appointment scheduled successfully for ${appointmentDate.toLocaleString()} with ${leadInfo.clientName}`
        });
      } else {
        res.json({
          result: 'Failed to book appointment: ' + bookingResult.error
        });
      }
    } else {
      res.json({
        result: 'Appointment noted - Google Calendar not authorized'
      });
    }

  } catch (error) {
    console.error('❌ Schedule lead error:', error);
    res.json({
      result: 'Failed to schedule appointment'
    });
  }
});

// 2. Check Schedule Availability (Google Calendar Integration)
app.post('/webhook/check-availability/bestbuyremodel', async (req, res) => {
  try {
    console.log('📅 Check availability called:', req.body);
    
    const { args } = req.body;
    const appointment_date = args?.appointment_date;
    
    if (!appointment_date) {
      return res.json({
        result: 'Please provide a date to check availability'
      });
    }

    if (googleTokens) {
      // Check Google Calendar availability for specific date
      const availability = await checkAvailabilityWithGoogle(googleTokens, 1);
      
      if (availability.success) {
        // Filter for the requested date
        const requestedDate = new Date(appointment_date);
        const availableDay = availability.availability.find(day => {
          const dayDate = new Date(day.date);
          return dayDate.toDateString() === requestedDate.toDateString();
        });

        if (availableDay && availableDay.slots.length > 0) {
          const slotsText = availableDay.slots.map(slot => slot.displayTime).join(', ');
          res.json({
            result: `Available times on ${appointment_date}: ${slotsText}`
          });
        } else {
          res.json({
            result: `No availability on ${appointment_date}. Please choose another date.`
          });
        }
      } else {
        res.json({
          result: 'Unable to check calendar availability'
        });
      }
    } else {
      res.json({
        result: `Available times on ${appointment_date}: 9:00 AM, 10:00 AM, 11:00 AM, 2:00 PM, 3:00 PM`
      });
    }

  } catch (error) {
    console.error('❌ Check availability error:', error);
    res.json({
      result: 'Failed to check availability'
    });
  }
});

// 3. Update Lead Phone Number
app.post('/webhook/update-phone/bestbuyremodel', async (req, res) => {
  try {
    console.log('📞 Update phone called:', req.body);
    
    // Extract from call metadata and function args
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const phone = args?.phone;
    
    if (!uuid || !phone) {
      return res.json({
        result: 'Missing information to update phone number'
      });
    }

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ phone: phone })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
        res.json({ result: 'Failed to update phone number in database' });
      } else {
        res.json({ result: 'Phone number updated successfully' });
      }
    } else {
      res.json({ result: 'Phone number update noted' });
    }

  } catch (error) {
    console.error('❌ Update phone error:', error);
    res.json({ result: 'Failed to update phone number' });
  }
});

// 4. Validate Lead Address
app.post('/webhook/validate-address/bestbuyremodel', async (req, res) => {
  try {
    console.log('📍 Validate address called:', req.body);
    
    const { args } = req.body;
    const address = args?.address;
    
    if (!address) {
      return res.json({
        result: 'Please provide an address to validate'
      });
    }

    // Simple validation - check if it contains Las Vegas area
    const isLasVegas = address.toLowerCase().includes('las vegas') || 
                      address.toLowerCase().includes('henderson') ||
                      address.toLowerCase().includes('summerlin') ||
                      /89\d{3}/.test(address); // Las Vegas ZIP codes

    if (isLasVegas) {
      res.json({
        result: 'Address is within our service area'
      });
    } else {
      res.json({
        result: 'Address is outside our service area. We serve Las Vegas, Henderson, and Summerlin areas.'
      });
    }

  } catch (error) {
    console.error('❌ Validate address error:', error);
    res.json({ result: 'Failed to validate address' });
  }
});

// 5. Call Lead Back Later
app.post('/webhook/call-back-later/bestbuyremodel', async (req, res) => {
  try {
    console.log('⏰ Call back later called:', req.body);
    
    // Extract from call metadata and function args
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const proposed_callback_time = args?.proposed_callback_time;
    
    if (!uuid) {
      return res.json({
        result: 'Unable to schedule callback - missing lead information'
      });
    }

    // Get lead ID from UUID
    let leadId = null;
    if (global.supabase) {
      const { data } = await global.supabase
        .from('leads')
        .select('id')
        .eq('custom_fields->uuid', uuid)
        .single();
      leadId = data?.id;
    }

    // Record the callback request and schedule smart callbacks
    if (leadId) {
      await recordCall(leadId, {
        callTime: new Date().toISOString(),
        outcome: 'callback_requested',
        duration: 0,
        notes: `Callback requested for: ${proposed_callback_time}`
      });

      // Schedule smart callbacks using AI predictions
      await initializeCallback(leadId, 'callback_requested');
    }

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ 
          status: 'callback_scheduled',
          callback_time: proposed_callback_time 
        })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
      }
    }

    res.json({
      result: `Smart callbacks scheduled successfully. We'll call you back soon!`
    });

  } catch (error) {
    console.error('❌ Call back later error:', error);
    res.json({ result: 'Failed to schedule callback' });
  }
});

// 6. Mark Wrong Number
app.post('/webhook/mark-wrong-number/bestbuyremodel', async (req, res) => {
  try {
    console.log('❌ Mark wrong number called:', req.body);
    
    // Extract from call metadata
    const { call } = req.body;
    const uuid = call?.metadata?.uuid;
    
    if (!uuid) {
      return res.json({
        result: 'Unable to mark wrong number - missing lead information'
      });
    }

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ status: 'wrong_number' })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
      }
    }

    res.json({
      result: 'Lead marked as wrong number'
    });

  } catch (error) {
    console.error('❌ Mark wrong number error:', error);
    res.json({ result: 'Failed to mark wrong number' });
  }
});

// 7. Update Lead Address
app.post('/webhook/update-address/bestbuyremodel', async (req, res) => {
  try {
    console.log('📍 Update address called:', req.body);
    
    // Extract from call metadata and function args
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const address = args?.address;
    const city = args?.city;
    const state = args?.state;
    const zip = args?.zip;
    
    if (!uuid || !address || !city || !state || !zip) {
      return res.json({
        result: 'Missing address information to update'
      });
    }

    const fullAddress = `${address}, ${city}, ${state} ${zip}`;

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ 
          custom_fields: {
            full_address: fullAddress,
            street_address: address,
            city: city,
            state: state,
            zip_code: zip
          }
        })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
        res.json({ result: 'Failed to update address in database' });
      } else {
        res.json({ 
          result: `Address updated successfully: ${fullAddress}`
        });
      }
    } else {
      res.json({ result: 'Address update noted' });
    }

  } catch (error) {
    console.error('❌ Update address error:', error);
    res.json({ result: 'Failed to update address' });
  }
});

// 8. Lead Is Mobile Home
app.post('/webhook/mobile-home/bestbuyremodel', async (req, res) => {
  try {
    console.log('🏠 Mobile home called:', req.body);
    
    // Extract from call metadata
    const { call } = req.body;
    const uuid = call?.metadata?.uuid;
    
    if (!uuid) {
      return res.json({
        result: 'Unable to process mobile home status - missing lead information'
      });
    }

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ status: 'mobile_home_declined' })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
      }
    }

    res.json({
      result: 'Unfortunately, we do not service mobile or manufactured homes'
    });

  } catch (error) {
    console.error('❌ Mobile home error:', error);
    res.json({ result: 'Failed to process mobile home status' });
  }
});

// 9. Lead Outside Area
app.post('/webhook/outside-area/bestbuyremodel', async (req, res) => {
  try {
    console.log('🌍 Outside area called:', req.body);
    
    // Extract from call metadata
    const { call } = req.body;
    const uuid = call?.metadata?.uuid;
    
    if (!uuid) {
      return res.json({
        result: 'Unable to process service area status - missing lead information'
      });
    }

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ status: 'outside_service_area' })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
      }
    }

    res.json({
      result: 'Unfortunately, your location is outside our service area'
    });

  } catch (error) {
    console.error('❌ Outside area error:', error);
    res.json({ result: 'Failed to process service area status' });
  }
});

// 10. Lead Not Interested
app.post('/webhook/not-interested/bestbuyremodel', async (req, res) => {
  try {
    console.log('❌ Not interested called:', req.body);
    
    // Extract from call metadata
    const { call } = req.body;
    const uuid = call?.metadata?.uuid;
    
    if (!uuid) {
      return res.json({
        result: 'Unable to process interest status - missing lead information'
      });
    }

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ status: 'not_interested' })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
      }
    }

    res.json({
      result: 'Thank you for your time. We understand you are not interested at this time.'
    });

  } catch (error) {
    console.error('❌ Not interested error:', error);
    res.json({ result: 'Failed to process interest status' });
  }
});

// 11. Transfer Call
app.post('/webhook/transfer-call/bestbuyremodel', async (req, res) => {
  try {
    console.log('📞 Transfer call requested:', req.body);
    
    res.json({
      result: 'Transferring you to a human representative now'
    });

  } catch (error) {
    console.error('❌ Transfer call error:', error);
    res.json({ result: 'Failed to transfer call' });
  }
});

// 12. Update Lead First Name
app.post('/webhook/update-first-name/bestbuyremodel', async (req, res) => {
  try {
    console.log('👤 Update first name called:', req.body);
    
    // Extract from call metadata and function args
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const first_name = args?.first_name;
    
    if (!uuid || !first_name) {
      return res.json({
        result: 'Missing information to update first name'
      });
    }

    if (global.supabase) {
      // Get current name to update properly
      const { data: currentLead } = await global.supabase
        .from('leads')
        .select('name')
        .eq('custom_fields->uuid', uuid)
        .single();
      
      let newFullName = first_name;
      if (currentLead && currentLead.name) {
        const nameParts = currentLead.name.split(' ');
        if (nameParts.length > 1) {
          newFullName = first_name + ' ' + nameParts.slice(1).join(' ');
        }
      }

      const { error } = await global.supabase
        .from('leads')
        .update({ name: newFullName })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
        res.json({ result: 'Failed to update first name in database' });
      } else {
        res.json({ 
          result: `First name updated successfully to ${first_name}`
        });
      }
    } else {
      res.json({ result: 'First name update noted' });
    }

  } catch (error) {
    console.error('❌ Update first name error:', error);
    res.json({ result: 'Failed to update first name' });
  }
});

// 13. Update Lead Last Name
app.post('/webhook/update-last-name/bestbuyremodel', async (req, res) => {
  try {
    console.log('👤 Update last name called:', req.body);
    
    // Extract from call metadata and function args
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const last_name = args?.last_name;
    
    if (!uuid || !last_name) {
      return res.json({
        result: 'Missing information to update last name'
      });
    }

    if (global.supabase) {
      // Get current name to update properly
      const { data: currentLead } = await global.supabase
        .from('leads')
        .select('name')
        .eq('custom_fields->uuid', uuid)
        .single();
      
      let newFullName = last_name;
      if (currentLead && currentLead.name) {
        const nameParts = currentLead.name.split(' ');
        newFullName = nameParts[0] + ' ' + last_name;
      }

      const { error } = await global.supabase
        .from('leads')
        .update({ name: newFullName })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
        res.json({ result: 'Failed to update last name in database' });
      } else {
        res.json({ 
          result: `Last name updated successfully to ${last_name}`
        });
      }
    } else {
      res.json({ result: 'Last name update noted' });
    }

  } catch (error) {
    console.error('❌ Update last name error:', error);
    res.json({ result: 'Failed to update last name' });
  }
});

// 14. Update Lead Email
app.post('/webhook/update-email/bestbuyremodel', async (req, res) => {
  try {
    console.log('📧 Update email called:', req.body);
    
    // Extract from call metadata and function args
    const { call, args } = req.body;
    const uuid = call?.metadata?.uuid;
    const email = args?.email;
    
    if (!uuid || !email) {
      return res.json({
        result: 'Missing information to update email'
      });
    }

    if (global.supabase) {
      const { error } = await global.supabase
        .from('leads')
        .update({ email: email })
        .eq('custom_fields->uuid', uuid);
      
      if (error) {
        console.error('Database update error:', error);
        res.json({ result: 'Failed to update email in database' });
      } else {
        res.json({ result: 'Email updated successfully' });
      }
    } else {
      res.json({ result: 'Email update noted' });
    }

  } catch (error) {
    console.error('❌ Update email error:', error);
    res.json({ result: 'Failed to update email' });
  }
});

// 15. End Call
app.post('/webhook/end-call/bestbuyremodel', async (req, res) => {
  try {
    console.log('📞 End call called:', req.body);
    
    const { args } = req.body;
    const execution_message = args?.execution_message || 'Thank you for your time. Have a great day!';
    
    res.json({
      result: execution_message
    });

  } catch (error) {
    console.error('❌ End call error:', error);
    res.json({ result: 'Call ended' });
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
              original_ghl_contact_id: leadData.ghl_contact_id,
              uuid: require('crypto').randomUUID() // Generate UUID for Retell functions
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
    const callResult = await initiateAICall(leadData, savedLead?.id, ghlContact?.contact?.id, savedLead?.custom_fields?.uuid);
    
    // Step 5: Send response
    res.json({ 
      success: true, 
      message: 'Lead processed, GHL contact created, calendar checked, and AI call initiated',
      railway_lead_id: savedLead?.id,
      ghl_contact_id: ghlContact?.contact?.id,
      call_id: callResult.call_id,
      ghl_contact_created: !!ghlContact,
      calendar_authorized: !!googleTokens,
      availability_slots: availability.success ? availability.availability.length : 0,
      uuid: savedLead?.custom_fields?.uuid
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

// Function to initiate AI call via Retell (updated with Google Calendar data and UUID)
async function initiateAICall(leadData, railwayLeadId, ghlContactId, uuid) {
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
        uuid: uuid, // 🆕 Add UUID for function calls
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
      const { call_id, call_analysis, metadata } = req.body;
      
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
      
      // 🆕 Record call outcome for AI learning
      if (metadata?.uuid && global.supabase) {
        try {
          // Get lead ID from UUID
          const { data: lead } = await global.supabase
            .from('leads')
            .select('id')
            .eq('custom_fields->uuid', metadata.uuid)
            .single();
          
          if (lead) {
            await recordCall(lead.id, {
              callTime: new Date().toISOString(),
              outcome: outcome,
              duration: req.body.call_duration || 0,
              notes: call_analysis?.summary || ''
            });

            // If call failed, schedule smart callbacks
            const callbackTriggers = ['no_answer', 'follow_up'];
            if (callbackTriggers.includes(outcome)) {
              await initializeCallback(lead.id, outcome);
              console.log(`🧠 Smart callbacks scheduled for lead ${lead.id}`);
            }
          }
        } catch (error) {
          console.error('❌ Failed to process call outcome for AI:', error);
        }
      }
      
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

// ================================
// LEGACY GOOGLE CALENDAR ENDPOINTS
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

// Manual appointment booking (for testing)
app.post('/webhook/book-appointment/bestbuyremodel', async (req, res) => {
  try {
    if (!googleTokens) {
      return res.status(401).json({
        success: false,
        error: 'Google Calendar not authorized',
        authUrl: getAuthUrl()
      });
    }
    
    console.log('📅 Manual booking request:', req.body);
    
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
      console.log(`✅ Manual appointment booked for ${clientName}`);

      res.json({
        success: true,
        message: 'Appointment booked successfully in Google Calendar',
        appointmentId: bookingResult.appointmentId,
        appointmentTime: startTime.toLocaleString(),
        calendarLink: bookingResult.calendarLink
      });
    } else {
      console.error('❌ Failed to book manual appointment:', bookingResult.error);
      res.status(500).json({
        success: false,
        error: bookingResult.error
      });
    }

  } catch (error) {
    console.error('❌ Manual appointment booking error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to book appointment' 
    });
  }
});

// ================================
// HEALTH AND STATUS ENDPOINTS
// ================================

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
    calendar_integration: 'Google Calendar',
    retell_functions: 'Active - 15 endpoints'
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
    google_authorized: !!googleTokens,
    retell_functions: 15
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
    <p>🤖 Retell Functions: ✅ 15 Active Endpoints</p>
    <hr>
    <h3>🔗 Retell AI Function Endpoints:</h3>
    <ul>
      <li><code>POST /webhook/schedule-lead/bestbuyremodel</code> - Schedule appointment (Google Calendar)</li>
      <li><code>POST /webhook/check-availability/bestbuyremodel</code> - Check calendar availability</li>
      <li><code>POST /webhook/update-phone/bestbuyremodel</code> - Update lead phone</li>
      <li><code>POST /webhook/validate-address/bestbuyremodel</code> - Validate lead address</li>
      <li><code>POST /webhook/call-back-later/bestbuyremodel</code> - Schedule callback</li>
      <li><code>POST /webhook/mark-wrong-number/bestbuyremodel</code> - Mark wrong number</li>
      <li><code>POST /webhook/update-address/bestbuyremodel</code> - Update lead address</li>
      <li><code>POST /webhook/mobile-home/bestbuyremodel</code> - Mark mobile home</li>
      <li><code>POST /webhook/outside-area/bestbuyremodel</code> - Mark outside area</li>
      <li><code>POST /webhook/not-interested/bestbuyremodel</code> - Mark not interested</li>
      <li><code>POST /webhook/transfer-call/bestbuyremodel</code> - Transfer call</li>
      <li><code>POST /webhook/update-first-name/bestbuyremodel</code> - Update first name</li>
      <li><code>POST /webhook/update-last-name/bestbuyremodel</code> - Update last name</li>
      <li><code>POST /webhook/update-email/bestbuyremodel</code> - Update email</li>
      <li><code>POST /webhook/end-call/bestbuyremodel</code> - End call</li>
    </ul>
    <hr>
    <h3>🔗 System Endpoints:</h3>
    <ul>
      <li><code>POST /webhook/ghl-bridge/bestbuyremodel</code> - Main GHL bridge</li>
      <li><code>POST /webhook/retell/bestbuyremodel</code> - Retell webhook</li>
      <li><code>GET /webhook/test-google-calendar</code> - Test Google Calendar</li>
      <li><code>GET /auth/google</code> - Google OAuth authorization</li>
    </ul>
    ${!googleTokens ? '<p><strong>⚠️ Please authorize Google Calendar: <a href="/auth/google">Click Here</a></strong></p>' : ''}
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Nuviao Bridge running on port ${PORT}`);
  console.log(`🎯 GHL Bridge ready with API contact creation!`);
  console.log(`📅 Google Calendar integration enabled!`);
  console.log(`🤖 Retell AI functions: 15 endpoints active`);
  if (!googleTokens) {
    console.log(`⚠️ Visit /auth/google to authorize Google Calendar access`);
  }
});
