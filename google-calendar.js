// google-calendar.js - Google Calendar Integration for AI Lead Manager
const { google } = require('googleapis');

// Google Calendar Configuration
const GOOGLE_CONFIG = {
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:8080/auth/google/callback',
  calendarId: 'primary' // Use primary calendar, or set specific calendar ID
};

// Business Hours Configuration (same as before)
const BUSINESS_HOURS = {
  start: 9, // 9 AM
  end: 17,  // 5 PM (17:00)
  timezone: 'America/Los_Angeles' // Las Vegas timezone
};

const APPOINTMENT_CONFIG = {
  duration: 60, // 1 hour in minutes
  buffer: 60,   // 1 hour buffer between appointments
  title: 'Estimate' // Will be "Estimate - John Smith"
};

// ================================
// 1. OAuth 2.0 Setup Functions
// ================================

function createOAuth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_CONFIG.clientId,
    GOOGLE_CONFIG.clientSecret,
    GOOGLE_CONFIG.redirectUri
  );
}

function getAuthUrl() {
  const oauth2Client = createOAuth2Client();
  
  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events'
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent' // Force consent to get refresh token
  });

  return authUrl;
}

async function getTokensFromCode(code) {
  const oauth2Client = createOAuth2Client();
  
  try {
    const { tokens } = await oauth2Client.getToken(code);
    return { success: true, tokens };
  } catch (error) {
    console.error('Error getting tokens:', error);
    return { success: false, error: error.message };
  }
}

function createAuthorizedClient(tokens) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

// ================================
// 2. Calendar Helper Functions
// ================================

function isBusinessHour(hour, minute = 0) {
  return hour >= BUSINESS_HOURS.start && hour < BUSINESS_HOURS.end;
}

function isWeekday(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5; // Monday = 1, Friday = 5
}

async function getCalendarEvents(oauth2Client, startDate, endDate) {
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  
  try {
    const response = await calendar.events.list({
      calendarId: GOOGLE_CONFIG.calendarId,
      timeMin: startDate,
      timeMax: endDate,
      singleEvents: true,
      orderBy: 'startTime',
    });
    
    return response.data.items || [];
  } catch (error) {
    console.error('Error fetching calendar events:', error);
    return [];
  }
}

async function getAvailableSlots(oauth2Client, targetDate) {
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);
  
  // Get existing events for the day
  const existingEvents = await getCalendarEvents(
    oauth2Client,
    startOfDay.toISOString(),
    endOfDay.toISOString()
  );
  
  const availableSlots = [];
  
  // Check if it's a weekday
  if (!isWeekday(new Date(targetDate))) {
    return availableSlots; // No weekend appointments
  }
  
  // Generate all possible time slots for the day
  for (let hour = BUSINESS_HOURS.start; hour < BUSINESS_HOURS.end; hour++) {
    // Create slot time in Las Vegas timezone
    const slotStart = new Date(targetDate);
    slotStart.setHours(hour, 0, 0, 0);
    
    const slotEnd = new Date(slotStart);
    slotEnd.setMinutes(slotEnd.getMinutes() + APPOINTMENT_CONFIG.duration);
    
    // Check if this slot conflicts with existing events (including buffer)
    const hasConflict = existingEvents.some(event => {
      const eventStart = new Date(event.start.dateTime || event.start.date);
      const eventEnd = new Date(event.end.dateTime || event.end.date);
      
      // Add buffer time around existing events
      const bufferStart = new Date(eventStart);
      bufferStart.setMinutes(bufferStart.getMinutes() - APPOINTMENT_CONFIG.buffer);
      
      const bufferEnd = new Date(eventEnd);
      bufferEnd.setMinutes(bufferEnd.getMinutes() + APPOINTMENT_CONFIG.buffer);
      
      // Check for overlap with buffer zone
      return (slotStart < bufferEnd && slotEnd > bufferStart);
    });
    
    if (!hasConflict) {
      // Create proper Las Vegas time display
      const displayHour = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const displayTime = `${displayHour}:00 ${ampm}`;
      
      availableSlots.push({
        startTime: slotStart.toISOString(),
        endTime: slotEnd.toISOString(),
        displayTime: displayTime,
        displayDate: slotStart.toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long', 
          day: 'numeric'
        }),
        hour: hour,
        vegasTime: displayTime
      });
    }
  }
  
  return availableSlots;
}

async function findNextAvailableSlots(oauth2Client, daysAhead = 14) {
  const availableSlots = [];
  const today = new Date();
  
  for (let i = 0; i < daysAhead; i++) {
    const checkDate = new Date(today);
    checkDate.setDate(today.getDate() + i);
    
    const daySlots = await getAvailableSlots(oauth2Client, checkDate);
    
    if (daySlots.length > 0) {
      availableSlots.push({
        date: checkDate.toDateString(),
        dateFormatted: checkDate.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }),
        slots: daySlots
      });
    }
    
    // Stop if we have enough options (e.g., 5 days with availability)
    if (availableSlots.length >= 5) break;
  }
  
  return availableSlots;
}

// ================================
// 3. Appointment Booking Functions
// ================================

async function bookEstimateAppointment(oauth2Client, appointmentData) {
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  
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
  
  // Create appointment title
  const title = `${APPOINTMENT_CONFIG.title} - ${clientName}`;
  
  // Create detailed description
  const description = `🏠 ESTIMATE APPOINTMENT

📋 Client Information:
• Name: ${clientName}
• Phone: ${clientPhone}
• Email: ${clientEmail}
• Address: ${homeAddress}

🔨 Estimate Type: ${estimateType}

📞 Call Summary:
${callSummary}

⏰ Scheduled by AI Lead Manager (Carl)
📅 Booked via Nuviao AI System`;
  
  const event = {
    summary: title,
    description: description,
    start: {
      dateTime: startTime,
      timeZone: BUSINESS_HOURS.timezone,
    },
    end: {
      dateTime: endTime,
      timeZone: BUSINESS_HOURS.timezone,
    },
    attendees: [
      { email: clientEmail, displayName: clientName }
    ],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 }, // 24 hours before
        { method: 'popup', minutes: 60 },      // 1 hour before
      ],
    },
  };
  
  try {
    const response = await calendar.events.insert({
      calendarId: GOOGLE_CONFIG.calendarId,
      resource: event,
      sendUpdates: 'all', // Send email invitations
    });
    
    console.log('✅ Google Calendar appointment created:', response.data.id);
    
    return {
      success: true,
      appointmentId: response.data.id,
      appointment: response.data,
      calendarLink: response.data.htmlLink
    };
  } catch (error) {
    console.error('❌ Failed to create Google Calendar appointment:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ================================
// 4. Main Integration Functions
// ================================

async function checkAvailabilityWithGoogle(tokens, daysAhead = 7) {
  try {
    const oauth2Client = createAuthorizedClient(tokens);
    const availability = await findNextAvailableSlots(oauth2Client, daysAhead);
    
    return {
      success: true,
      provider: 'Google Calendar',
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

async function bookAppointmentWithGoogle(tokens, appointmentDetails) {
  try {
    const oauth2Client = createAuthorizedClient(tokens);
    const result = await bookEstimateAppointment(oauth2Client, appointmentDetails);
    
    return result;
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// ================================
// 5. Export Functions
// ================================

module.exports = {
  // OAuth functions
  getAuthUrl,
  getTokensFromCode,
  
  // Main functions for AI integration
  checkAvailabilityWithGoogle,
  bookAppointmentWithGoogle,
  
  // Configuration
  BUSINESS_HOURS,
  APPOINTMENT_CONFIG,
  GOOGLE_CONFIG
};
