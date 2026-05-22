import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Helper to get nested object values by path (e.g. "shipping_address.phone")
// Supports dot notation and array indices like "fulfillments[0].tracking_number" or "fulfillments.0.tracking_number"
function getByPath(obj, path) {
  if (!path) return null;
  // Normalize array bracket notation (e.g., fulfillments[0] -> fulfillments.0)
  const normalizedPath = path.replace(/\[(\d+)\]/g, '.$1');
  return normalizedPath.split('.').reduce((acc, part) => acc && acc[part], obj);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { event } = req.query;
  const payload = req.body;

  if (!event) {
    return res.status(400).json({ error: 'Missing event parameter' });
  }

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // Fetch all active campaigns
    const { data: allActiveCampaigns, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('status', 'active');

    if (error) throw error;

    // Filter active campaigns matching the event (supporting multiple comma-separated event types)
    const activeCampaigns = (allActiveCampaigns || []).filter(campaign => {
      if (!campaign.event_type) return false;
      const configuredEvents = campaign.event_type
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);
      return configuredEvents.includes(event.trim().toLowerCase());
    });

    if (activeCampaigns.length === 0) {
      return res.status(404).json({ error: `No active campaign found for event: ${event}` });
    }

    const results = [];

    for (const campaign of activeCampaigns) {
      const mappedData = {};
      
      if (campaign.mappings && Array.isArray(campaign.mappings)) {
        campaign.mappings.forEach(mapping => {
          let value = getByPath(payload, mapping.path);
          
          // Hardcoded rule: Phone gets +91 prefix
          if (mapping.name === 'phone' && value) {
            const digits = value.toString().replace(/\D/g, '');
            if (digits.length === 12 && digits.startsWith('91')) {
              value = `+${digits}`;
            } else if (digits.length === 10) {
              value = `+91${digits}`;
            } else {
              value = `+91${digits}`;
            }
          }

          // Hardcoded rule: Clean order name (e.g., "1306.1" -> "1306")
          if ((mapping.name === 'name' || mapping.path === 'name') && value) {
            const strVal = value.toString().trim();
            if (strVal.includes('.')) {
              value = strVal.split('.')[0];
            }
          }
          
          mappedData[mapping.name] = value;
        });
      }

      const replyPayload = [mappedData];

      // Forward to Reply.cx
      try {
        const response = await fetch(campaign.reply_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${campaign.reply_token}`
          },
          body: JSON.stringify(replyPayload)
        });

        const responseText = await response.text();
        
        // Update last triggered timestamp (snake_case)
        await supabase
          .from('campaigns')
          .update({ last_triggered: new Date().toISOString() })
          .eq('id', campaign.id);
        
        results.push({
          campaignId: campaign.id,
          status: response.status,
          response: responseText
        });
      } catch (err) {
        results.push({
          campaignId: campaign.id,
          error: err.message
        });
      }
    }

    return res.status(200).json({ success: true, results });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
