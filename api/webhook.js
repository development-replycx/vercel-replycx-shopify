import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Helper to get nested object values by path (e.g. "shipping_address.phone")
function getByPath(obj, path) {
  if (!path) return null;
  return path.split('.').reduce((acc, part) => acc && acc[part], obj);
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
    // Fetch active campaigns for this event (snake_case column name)
    const { data: activeCampaigns, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('event_type', event)
      .eq('status', 'active');

    if (error) throw error;

    if (!activeCampaigns || activeCampaigns.length === 0) {
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
