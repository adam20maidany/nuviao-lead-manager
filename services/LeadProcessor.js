const moment = require('moment-timezone');

class LeadProcessor {
  async processLead(leadData, clientId) {
    try {
      console.log(`📋 Processing lead: ${leadData.name}`);
      
      // Check for existing lead
      const existingLead = await this.findExistingLead(leadData.phone, clientId);
      
      if (existingLead) {
        console.log(`🔄 Updating existing lead: ${leadData.phone}`);
        return await this.updateLead(existingLead.id, leadData);
      }

      // Create new lead
      const lead = await this.createLead(leadData, clientId);
      console.log(`✅ New lead created: ${lead.name} - ID: ${lead.id}`);
      
      return lead;

    } catch (error) {
      console.error('❌ Lead processing failed:', error);
      throw error;
    }
  }

  async findExistingLead(phone, clientId) {
    if (!global.supabase) return null;
    
    const { data } = await global.supabase
      .from('leads')
      .select('*')
      .eq('phone', phone)
      .eq('client_id', clientId)
      .single();
    
    return data;
  }

  async createLead(leadData, clientId) {
    if (!global.supabase) {
      // Return mock lead if no database
      return {
        id: Date.now(),
        ...leadData,
        client_id: clientId,
        status: 'new',
        created_at: new Date().toISOString()
      };
    }

    const { data, error } = await global.supabase
      .from('leads')
      .insert({
        client_id: clientId,
        name: leadData.name,
        phone: this.formatPhone(leadData.phone),
        email: leadData.email,
        source: leadData.source,
        status: 'new',
        custom_fields: {
          ghl_contact_id: leadData.ghl_contact_id,
          received_at: moment().tz('America/Los_Angeles').format()
        }
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateLead(leadId, leadData) {
    if (!global.supabase) return { id: leadId, ...leadData };

    const { data, error } = await global.supabase
      .from('leads')
      .update({
        email: leadData.email || null,
        source: leadData.source,
        custom_fields: {
          ghl_contact_id: leadData.ghl_contact_id,
          last_update: moment().tz('America/Los_Angeles').format()
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', leadId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  formatPhone(phone) {
    // Ensure phone is in E.164 format
    const cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.length === 10) {
      return `+1${cleaned}`;
    }
    
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
      return `+${cleaned}`;
    }
    
    return phone;
  }
}

module.exports = LeadProcessor;
