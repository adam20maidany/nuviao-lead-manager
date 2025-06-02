// GHL Calendar Integration - Complete System
// For AI Lead Manager - Phase 2

const GHL_API_KEY = process.env.GHL_API_KEY || 'pit-518beebf-30b6-4444-a3b7-430a1bfd526c';
const LOCATION_ID = process.env.LOCATION_ID || 'llj5AyvYH8kun6U6fX84';
const GHL_BASE_URL = 'https://rest.gohighlevel.com/v1';

// Business Hours Configuration
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
// 1. GHL API Helper Functions
// ================================

async function makeGHLRequest(endpoint, method = 'GET', body = null) {
    const url = `${GHL_BASE_URL}${endpoint}`;
    
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${GHL_API_KEY}`,
            'Content-Type': 'application/json'
        }
    };
    
    if (body && method !== 'GET') {
        options.body = JSON.stringify(body);
    }
    
    try {
        const response = await fetch(url, options);
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(`GHL API Error: ${response.status} - ${JSON.stringify(data)}`);
        }
        
        return { success: true, data };
    } catch (error) {
        console.error('GHL API Request Failed:', error);
        return { success: false, error: error.message };
    }
}

// ================================
// 2. Calendar Management Functions
// ================================

async function getLocationCalendars() {
    const result = await makeGHLRequest(`/locations/${LOCATION_ID}/calendars`);
    
    if (result.success) {
        return result.data.calendars || [];
    }
    
    console.error('Failed to get calendars:', result.error);
    return [];
}

async function getCalendarEvents(calendarId, startDate, endDate) {
    const endpoint = `/calendars/${calendarId}/events?startDate=${startDate}&endDate=${endDate}`;
    const result = await makeGHLRequest(endpoint);
    
    if (result.success) {
        return result.data.events || [];
    }
    
    console.error('Failed to get events:', result.error);
    return [];
}

// ================================
// 3. Availability Checker
// ================================

function isBusinessHour(hour, minute = 0) {
    return hour >= BUSINESS_HOURS.start && hour < BUSINESS_HOURS.end;
}

function isWeekday(date) {
    const day = date.getDay();
    return day >= 1 && day <= 5; // Monday = 1, Friday = 5
}

async function getAvailableSlots(calendarId, targetDate) {
    // Get start and end of the target date
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);
    
    // Get existing appointments for the day
    const existingEvents = await getCalendarEvents(
        calendarId, 
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
        const slotStart = new Date(targetDate);
        slotStart.setHours(hour, 0, 0, 0);
        
        const slotEnd = new Date(slotStart);
        slotEnd.setMinutes(slotEnd.getMinutes() + APPOINTMENT_CONFIG.duration);
        
        // Check if this slot conflicts with existing appointments (including buffer)
        const hasConflict = existingEvents.some(event => {
            const eventStart = new Date(event.startTime);
            const eventEnd = new Date(event.endTime);
            
            // Add buffer time around existing events
            const bufferStart = new Date(eventStart);
            bufferStart.setMinutes(bufferStart.getMinutes() - APPOINTMENT_CONFIG.buffer);
            
            const bufferEnd = new Date(eventEnd);
            bufferEnd.setMinutes(bufferEnd.getMinutes() + APPOINTMENT_CONFIG.buffer);
            
            // Check for overlap with buffer zone
            return (slotStart < bufferEnd && slotEnd > bufferStart);
        });
        
        if (!hasConflict) {
            availableSlots.push({
                startTime: slotStart.toISOString(),
                endTime: slotEnd.toISOString(),
                displayTime: slotStart.toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                })
            });
        }
    }
    
    return availableSlots;
}

async function findNextAvailableSlots(calendarId, daysAhead = 14) {
    const availableSlots = [];
    const today = new Date();
    
    for (let i = 0; i < daysAhead; i++) {
        const checkDate = new Date(today);
        checkDate.setDate(today.getDate() + i);
        
        const daySlots = await getAvailableSlots(calendarId, checkDate);
        
        if (daySlots.length > 0) {
            availableSlots.push({
                date: checkDate.toDateString(),
                slots: daySlots
            });
        }
        
        // Stop if we have enough options (e.g., 5 days with availability)
        if (availableSlots.length >= 5) break;
    }
    
    return availableSlots;
}

// ================================
// 4. Appointment Booking
// ================================

async function bookAppointment(calendarId, appointmentData) {
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
    const description = `
🏠 ESTIMATE APPOINTMENT

📋 Client Information:
• Name: ${clientName}
• Phone: ${clientPhone}
• Email: ${clientEmail}
• Address: ${homeAddress}

🔨 Estimate Type: ${estimateType}

📞 Call Summary:
${callSummary}

⏰ Scheduled by AI Lead Manager
    `.trim();
    
    const eventData = {
        title,
        description,
        startTime,
        endTime,
        locationId: LOCATION_ID,
        contactId: appointmentData.contactId || null,
        appointmentStatus: 'confirmed'
    };
    
    const result = await makeGHLRequest(`/calendars/${calendarId}/events`, 'POST', eventData);
    
    if (result.success) {
        console.log('✅ Appointment booked successfully:', result.data);
        return {
            success: true,
            appointmentId: result.data.id,
            appointment: result.data
        };
    } else {
        console.error('❌ Failed to book appointment:', result.error);
        return {
            success: false,
            error: result.error
        };
    }
}

// ================================
// 5. Main Integration Functions
// ================================

async function setupCalendarForClient() {
    // Get all calendars for the location
    const calendars = await getLocationCalendars();
    
    if (calendars.length === 0) {
        throw new Error('No calendars found for location');
    }
    
    // Use the first calendar (or you can add logic to select specific calendar)
    const primaryCalendar = calendars[0];
    
    console.log('📅 Using calendar:', {
        id: primaryCalendar.id,
        name: primaryCalendar.name,
        timezone: primaryCalendar.timezone
    });
    
    return primaryCalendar;
}

async function checkAvailabilityForAI(daysAhead = 7) {
    try {
        const calendar = await setupCalendarForClient();
        const availability = await findNextAvailableSlots(calendar.id, daysAhead);
        
        return {
            success: true,
            calendar: calendar,
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

async function bookEstimateAppointment(appointmentDetails) {
    try {
        const calendar = await setupCalendarForClient();
        const result = await bookAppointment(calendar.id, appointmentDetails);
        
        return result;
    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// ================================
// 6. Export Functions for Integration
// ================================

module.exports = {
    // Main functions for AI integration
    checkAvailabilityForAI,
    bookEstimateAppointment,
    
    // Utility functions
    getAvailableSlots,
    findNextAvailableSlots,
    setupCalendarForClient,
    
    // Configuration
    BUSINESS_HOURS,
    APPOINTMENT_CONFIG
};

// ================================
// 7. Example Usage for Testing
// ================================

async function testCalendarIntegration() {
    console.log('🧪 Testing Calendar Integration...\n');
    
    // Test 1: Check availability
    console.log('1. Checking availability...');
    const availability = await checkAvailabilityForAI();
    console.log('Availability result:', availability);
    
    if (availability.success && availability.availability.length > 0) {
        console.log('\n2. Testing appointment booking...');
        
        // Use first available slot for testing
        const firstDay = availability.availability[0];
        const firstSlot = firstDay.slots[0];
        
        const testAppointment = {
            clientName: 'John Smith',
            clientPhone: '702-555-0123',
            clientEmail: 'john.smith@email.com',
            homeAddress: '123 Main St, Las Vegas, NV 89101',
            estimateType: 'Kitchen Remodel', // You'll provide dropdown options later
            callSummary: 'Client wants to remodel kitchen. Mentioned granite countertops and new cabinets. Budget around $25,000.',
            startTime: firstSlot.startTime,
            endTime: firstSlot.endTime
        };
        
        const bookingResult = await bookEstimateAppointment(testAppointment);
        console.log('Booking result:', bookingResult);
    }
}

// Uncomment to run test
// testCalendarIntegration();
