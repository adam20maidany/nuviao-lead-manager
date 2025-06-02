// smart-callback-algorithm.js - AI-Powered Callback Prediction System
const { createClient } = require('@supabase/supabase-js');

class SmartCallbackPredictor {
  constructor() {
    this.supabase = global.supabase;
    this.businessHours = {
      start: 9,
      end: 17,
      timezone: 'America/Los_Angeles'
    };
    
    // Call outcome weights for learning
    this.outcomeWeights = {
      'answered': 100,
      'appointment_booked': 150,
      'callback_requested': 80,
      'not_interested': -50,
      'no_answer': -10,
      'voicemail': 20,
      'busy': 0,
      'wrong_number': -100
    };

    // Industry-specific calling preferences
    this.industryPatterns = {
      'homeowner': {
        bestTimes: [9, 10, 11, 14, 15, 16], // Avoid lunch and evening
        avoidTimes: [12, 13, 17, 18, 19], // Lunch and dinner
        weekendMultiplier: 1.2 // Slightly better on weekends
      },
      'business_owner': {
        bestTimes: [8, 9, 17, 18], // Early morning or after hours
        avoidTimes: [12, 13, 14, 15], // Busy business hours
        weekendMultiplier: 0.7 // Lower success on weekends
      },
      'contractor': {
        bestTimes: [7, 8, 12, 17, 18], // Early morning, lunch, after work
        avoidTimes: [9, 10, 11, 14, 15, 16], // Working hours
        weekendMultiplier: 0.5 // Much lower success on weekends
      },
      'default': {
        bestTimes: [9, 10, 11, 14, 15, 16],
        avoidTimes: [12, 13],
        weekendMultiplier: 0.8
      }
    };
  }

  // ================================
  // 1. DATA COLLECTION & ANALYSIS
  // ================================

  async recordCallOutcome(leadId, callData) {
    try {
      const callRecord = {
        lead_id: leadId,
        call_time: callData.callTime || new Date().toISOString(),
        outcome: callData.outcome,
        duration: callData.duration || 0,
        day_of_week: new Date(callData.callTime).getDay(),
        hour_of_day: new Date(callData.callTime).getHours(),
        attempt_number: callData.attemptNumber || 1,
        notes: callData.notes || '',
        created_at: new Date().toISOString()
      };

      const { data, error } = await this.supabase
        .from('call_history')
        .insert(callRecord)
        .select()
        .single();

      if (error) throw error;

      console.log('📊 Call outcome recorded:', callRecord);
      return { success: true, data };
    } catch (error) {
      console.error('❌ Failed to record call outcome:', error);
      return { success: false, error: error.message };
    }
  }

  async getLeadCallHistory(leadId) {
    try {
      const { data, error } = await this.supabase
        .from('call_history')
        .select('*')
        .eq('lead_id', leadId)
        .order('call_time', { ascending: false });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Failed to get call history:', error);
      return [];
    }
  }

  async getLeadProfile(leadId) {
    try {
      const { data, error } = await this.supabase
        .from('leads')
        .select('*')
        .eq('id', leadId)
        .single();

      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Failed to get lead profile:', error);
      return null;
    }
  }

  // ================================
  // 2. PATTERN RECOGNITION
  // ================================

  async analyzeGlobalPatterns() {
    try {
      // Get successful call patterns across all leads
      const { data, error } = await this.supabase
        .from('call_history')
        .select('*')
        .in('outcome', ['answered', 'appointment_booked', 'callback_requested']);

      if (error) throw error;

      const patterns = {
        hourlySuccess: {},
        dayOfWeekSuccess: {},
        industrySuccess: {}
      };

      // Analyze hourly patterns
      for (let hour = 7; hour <= 19; hour++) {
        const hourCalls = data.filter(call => call.hour_of_day === hour);
        patterns.hourlySuccess[hour] = {
          totalCalls: hourCalls.length,
          successRate: hourCalls.length > 0 ? 
            hourCalls.filter(call => this.outcomeWeights[call.outcome] > 0).length / hourCalls.length : 0
        };
      }

      // Analyze day of week patterns
      for (let day = 0; day <= 6; day++) {
        const dayCalls = data.filter(call => call.day_of_week === day);
        patterns.dayOfWeekSuccess[day] = {
          totalCalls: dayCalls.length,
          successRate: dayCalls.length > 0 ? 
            dayCalls.filter(call => this.outcomeWeights[call.outcome] > 0).length / dayCalls.length : 0
        };
      }

      console.log('📈 Global patterns analyzed:', patterns);
      return patterns;
    } catch (error) {
      console.error('❌ Failed to analyze global patterns:', error);
      return null;
    }
  }

  async analyzeLeadSpecificPatterns(leadId) {
    const callHistory = await this.getLeadCallHistory(leadId);
    
    if (callHistory.length === 0) {
      return { hasHistory: false, patterns: null };
    }

    const patterns = {
      bestHours: {},
      bestDays: {},
      totalAttempts: callHistory.length,
      successfulContacts: callHistory.filter(call => this.outcomeWeights[call.outcome] > 0).length
    };

    // Analyze personal hour preferences
    callHistory.forEach(call => {
      const hour = call.hour_of_day;
      if (!patterns.bestHours[hour]) {
        patterns.bestHours[hour] = { attempts: 0, successWeight: 0 };
      }
      patterns.bestHours[hour].attempts++;
      patterns.bestHours[hour].successWeight += this.outcomeWeights[call.outcome] || 0;
    });

    // Calculate success rates per hour
    Object.keys(patterns.bestHours).forEach(hour => {
      const hourData = patterns.bestHours[hour];
      hourData.successRate = hourData.successWeight / hourData.attempts;
    });

    console.log('👤 Lead-specific patterns:', leadId, patterns);
    return { hasHistory: true, patterns };
  }

  // ================================
  // 3. PREDICTIVE SCORING ENGINE
  // ================================

  async calculateTimeSlotScore(leadId, targetDateTime) {
    const lead = await this.getLeadProfile(leadId);
    const personalPatterns = await this.analyzeLeadSpecificPatterns(leadId);
    const globalPatterns = await this.analyzeGlobalPatterns();
    
    const hour = targetDateTime.getHours();
    const dayOfWeek = targetDateTime.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    let score = 50; // Base score

    // 1. Industry-specific scoring
    const industry = this.detectIndustry(lead);
    const industryPattern = this.industryPatterns[industry] || this.industryPatterns.default;
    
    if (industryPattern.bestTimes.includes(hour)) {
      score += 20;
    }
    if (industryPattern.avoidTimes.includes(hour)) {
      score -= 15;
    }
    if (isWeekend) {
      score *= industryPattern.weekendMultiplier;
    }

    // 2. Personal history scoring (highest weight)
    if (personalPatterns.hasHistory) {
      const personalHourData = personalPatterns.patterns.bestHours[hour];
      if (personalHourData) {
        // Heavy weight on personal success history
        score += (personalHourData.successRate * 30);
      }
    }

    // 3. Global pattern scoring
    if (globalPatterns) {
      const globalHourSuccess = globalPatterns.hourlySuccess[hour];
      if (globalHourSuccess) {
        score += (globalHourSuccess.successRate * 15);
      }
      
      const globalDaySuccess = globalPatterns.dayOfWeekSuccess[dayOfWeek];
      if (globalDaySuccess) {
        score += (globalDaySuccess.successRate * 10);
      }
    }

    // 4. Business hours enforcement
    if (hour < this.businessHours.start || hour > this.businessHours.end) {
      score *= 0.3; // Heavily penalize outside business hours
    }

    // 5. Recent attempt penalty (avoid calling too frequently)
    const recentCalls = await this.getRecentCallAttempts(leadId, 24); // Last 24 hours
    if (recentCalls.length > 0) {
      score *= (1 - (recentCalls.length * 0.2)); // Reduce score for recent attempts
    }

    return Math.max(0, Math.min(100, score)); // Clamp between 0-100
  }

  async getRecentCallAttempts(leadId, hoursBack = 24) {
    try {
      const cutoffTime = new Date();
      cutoffTime.setHours(cutoffTime.getHours() - hoursBack);

      const { data, error } = await this.supabase
        .from('call_history')
        .select('*')
        .eq('lead_id', leadId)
        .gte('call_time', cutoffTime.toISOString());

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Failed to get recent attempts:', error);
      return [];
    }
  }

  detectIndustry(lead) {
    if (!lead) return 'default';
    
    const projectType = lead.custom_fields?.project_type?.toLowerCase() || '';
    const notes = (lead.custom_fields?.project_notes || '').toLowerCase();
    
    // Simple industry detection logic
    if (projectType.includes('commercial') || notes.includes('business')) {
      return 'business_owner';
    }
    if (notes.includes('contractor') || notes.includes('builder')) {
      return 'contractor';
    }
    return 'homeowner'; // Default for residential projects
  }

  // ================================
  // 4. OPTIMAL TIME PREDICTION
  // ================================

  async predictOptimalCallTimes(leadId, daysAhead = 3) {
    const predictions = [];
    const now = new Date();

    // Generate time slots for the next few days
    for (let day = 0; day < daysAhead; day++) {
      const targetDate = new Date(now);
      targetDate.setDate(now.getDate() + day);
      
      // Skip if it's today and past business hours
      if (day === 0 && targetDate.getHours() >= this.businessHours.end) {
        continue;
      }

      const daySlots = [];

      // Test each business hour
      for (let hour = this.businessHours.start; hour <= this.businessHours.end; hour++) {
        const timeSlot = new Date(targetDate);
        timeSlot.setHours(hour, 0, 0, 0);

        // Skip past times for today
        if (day === 0 && timeSlot <= now) {
          continue;
        }

        const score = await this.calculateTimeSlotScore(leadId, timeSlot);
        
        daySlots.push({
          time: timeSlot.toISOString(),
          hour: hour,
          score: score,
          displayTime: timeSlot.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
            timeZone: this.businessHours.timezone
          }),
          dayOfWeek: timeSlot.getDay(),
          confidence: this.getConfidenceLevel(score)
        });
      }

      // Sort by score and take top slots
      daySlots.sort((a, b) => b.score - a.score);
      
      if (daySlots.length > 0) {
        predictions.push({
          date: targetDate.toDateString(),
          topSlots: daySlots.slice(0, 3), // Top 3 times per day
          allSlots: daySlots
        });
      }
    }

    return predictions;
  }

  getConfidenceLevel(score) {
    if (score >= 80) return 'high';
    if (score >= 60) return 'medium';
    if (score >= 40) return 'low';
    return 'very_low';
  }

  // ================================
  // 5. SMART SCHEDULING
  // ================================

  async scheduleOptimalCallbacks(leadId, maxCallbacksPerDay = 2) {
    try {
      console.log(`🧠 Calculating optimal callback times for lead ${leadId}`);
      
      const predictions = await this.predictOptimalCallTimes(leadId, 7); // Next 7 days
      const scheduledCallbacks = [];

      for (const dayPrediction of predictions) {
        // Take top N slots per day based on maxCallbacksPerDay
        const topSlots = dayPrediction.topSlots.slice(0, maxCallbacksPerDay);
        
        for (const slot of topSlots) {
          // Only schedule if confidence is reasonable
          if (slot.score >= 30) {
            const callback = {
              lead_id: leadId,
              scheduled_time: slot.time,
              predicted_score: slot.score,
              confidence: slot.confidence,
              attempt_type: 'ai_predicted',
              status: 'scheduled',
              created_at: new Date().toISOString()
            };

            const { data, error } = await this.supabase
              .from('callback_queue')
              .insert(callback)
              .select()
              .single();

            if (!error) {
              scheduledCallbacks.push(data);
              console.log(`📅 Scheduled callback: ${slot.displayTime} (score: ${slot.score})`);
            }
          }
        }
      }

      return {
        success: true,
        scheduledCallbacks: scheduledCallbacks,
        totalScheduled: scheduledCallbacks.length
      };

    } catch (error) {
      console.error('❌ Failed to schedule optimal callbacks:', error);
      return { success: false, error: error.message };
    }
  }

  // ================================
  // 6. ADAPTIVE LEARNING
  // ================================

  async updatePredictionAccuracy(callbackId, actualOutcome) {
    try {
      // Get the original prediction
      const { data: callback } = await this.supabase
        .from('callback_queue')
        .select('*')
        .eq('id', callbackId)
        .single();

      if (callback) {
        // Calculate accuracy score
        const predictedScore = callback.predicted_score;
        const actualWeight = this.outcomeWeights[actualOutcome] || 0;
        const actualScore = Math.max(0, Math.min(100, actualWeight + 50)); // Normalize to 0-100
        
        const accuracy = 100 - Math.abs(predictedScore - actualScore);

        // Update the callback record
        await this.supabase
          .from('callback_queue')
          .update({
            actual_outcome: actualOutcome,
            actual_score: actualScore,
            prediction_accuracy: accuracy,
            completed_at: new Date().toISOString()
          })
          .eq('id', callbackId);

        console.log(`🎯 Prediction accuracy: ${accuracy}% (predicted: ${predictedScore}, actual: ${actualScore})`);
        
        return { success: true, accuracy };
      }
    } catch (error) {
      console.error('❌ Failed to update prediction accuracy:', error);
    }
  }

  // ================================
  // 7. MAIN INTEGRATION FUNCTIONS
  // ================================

  async processLeadForCallbacks(leadId, initialOutcome = 'no_answer') {
    try {
      console.log(`🚀 Processing lead ${leadId} for smart callbacks`);

      // Record the initial call outcome
      await this.recordCallOutcome(leadId, {
        callTime: new Date().toISOString(),
        outcome: initialOutcome,
        attemptNumber: 1
      });

      // Only schedule callbacks for specific outcomes
      const callbackTriggers = ['no_answer', 'voicemail', 'busy', 'callback_requested'];
      
      if (callbackTriggers.includes(initialOutcome)) {
        const result = await this.scheduleOptimalCallbacks(leadId, 2); // 2 calls per day
        return result;
      }

      return { success: true, message: 'No callbacks needed for this outcome' };
    } catch (error) {
      console.error('❌ Failed to process lead for callbacks:', error);
      return { success: false, error: error.message };
    }
  }
}

// ================================
// 8. EXPORT FOR INTEGRATION
// ================================

module.exports = {
  SmartCallbackPredictor,
  
  // Helper functions for easy integration
  async initializeCallback(leadId, outcome) {
    const predictor = new SmartCallbackPredictor();
    return await predictor.processLeadForCallbacks(leadId, outcome);
  },

  async getOptimalCallTimes(leadId) {
    const predictor = new SmartCallbackPredictor();
    return await predictor.predictOptimalCallTimes(leadId);
  },

  async recordCall(leadId, callData) {
    const predictor = new SmartCallbackPredictor();
    return await predictor.recordCallOutcome(leadId, callData);
  }
};
