import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Initialize global in-memory cart storage (survives hot reloads within the same Node process)
if (!global.cartStorage) {
  global.cartStorage = new Map();
}
const cartStorage = global.cartStorage;

// Initialize global debug logs for easy diagnostics
if (!global.webhookDebugLogs) {
  global.webhookDebugLogs = [];
}
function logDebug(type, details) {
  global.webhookDebugLogs.unshift({
    timestamp: new Date().toISOString(),
    type,
    details
  });
  if (global.webhookDebugLogs.length > 30) {
    global.webhookDebugLogs.pop();
  }
}

// Helper to format phone numbers to +91 international standard for Reply.cx
function formatPhoneNumber(value) {
  if (!value) return null;
  const digits = value.toString().replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  } else if (digits.length === 10) {
    return `+91${digits}`;
  } else {
    return `+91${digits}`;
  }
}

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

  const normalizedEvent = event.trim().toLowerCase();

  // STEP 2 — In existing orders/create handler (add only this interceptor)
  if (normalizedEvent === 'orders/create' || normalizedEvent === 'orders_create') {
    if (payload && payload.cart_token) {
      const orderCartToken = payload.cart_token;
      if (cartStorage.has(orderCartToken)) {
        const record = cartStorage.get(orderCartToken);
        record.ordered = true;
        cartStorage.set(orderCartToken, record);
        logDebug('order_suppression', { cart_token: orderCartToken, status: 'suppressed' });
        console.log(`[Abandoned Cart] Suppressing recovery: Order created for cart_token: ${orderCartToken}`);
      }
    }
  }

  // STEP 1 — New checkouts/update webhook listener (silent):
  if (normalizedEvent === 'checkouts/update' || normalizedEvent === 'checkouts_update') {
    try {
      const cart_token = payload.cart_token;
      if (!cart_token) {
        logDebug('checkout_ignored', { reason: 'Missing cart_token', payloadKeys: Object.keys(payload) });
        return res.status(200).json({ success: true, message: 'No cart_token in payload, skipped' });
      }

      if (!supabaseUrl || !supabaseKey) {
        console.error('[Abandoned Cart] Supabase credentials missing');
        return res.status(500).json({ error: 'Supabase credentials missing' });
      }

      const supabase = createClient(supabaseUrl, supabaseKey);

      // Query Supabase to check if the Abandoned Cart Flow is active and get settings
      const { data: campaign, error } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', '11111111-1111-1111-1111-111111111111')
        .single();

      if (error || !campaign) {
        logDebug('checkout_ignored', { cart_token, reason: 'Flow settings not found in Supabase' });
        console.log(`[Abandoned Cart] Flow is not configured or error fetching: ${error ? error.message : 'Not configured'}`);
        return res.status(200).json({ success: true, message: 'Abandoned Cart flow is not configured.' });
      }

      if (campaign.status !== 'active') {
        logDebug('checkout_ignored', { cart_token, reason: 'Flow is currently inactive' });
        console.log('[Abandoned Cart] Flow is currently inactive.');
        return res.status(200).json({ success: true, message: 'Abandoned Cart flow is inactive.' });
      }

      // Extract details
      const rawPhone = getByPath(payload, 'shipping_address.phone') || payload.phone;
      const first_name = getByPath(payload, 'shipping_address.first_name') || payload.first_name || '';
      const phone = formatPhoneNumber(rawPhone) || '';

      // Save to warm cache
      cartStorage.set(cart_token, { phone, first_name, ordered: false });
      logDebug('checkout_cached', { cart_token, phone, first_name });
      console.log(`[Abandoned Cart] Saved checkout to temp cache. cart_token: ${cart_token}`);

      // Read delay minutes
      let delayMinutes = 60;
      if (campaign.mappings) {
        let parsedMappings = campaign.mappings;
        if (typeof campaign.mappings === 'string') {
          try { parsedMappings = JSON.parse(campaign.mappings); } catch (e) {}
        }
        if (parsedMappings && parsedMappings.delay_minutes !== undefined) {
          delayMinutes = parseInt(parsedMappings.delay_minutes, 10) || 60;
        }
      }

      console.log(`[Abandoned Cart] Scheduling delayed job for cart_token: ${cart_token} in ${delayMinutes} minutes.`);

      // Start delayed job
      setTimeout(async () => {
        try {
          const record = cartStorage.get(cart_token);
          if (!record) {
            logDebug('job_skipped', { cart_token, reason: 'No cached checkout found' });
            console.log(`[Abandoned Cart] Delayed job fired: No record found for cart_token: ${cart_token}`);
            return;
          }

          if (record.ordered) {
            logDebug('job_skipped', { cart_token, phone: record.phone, reason: 'Suppression active (ordered = true)' });
            console.log(`[Abandoned Cart] Delayed job fired: Suppression active (ordered = true) for cart_token: ${cart_token}`);
            return;
          }

          // Fetch latest campaign settings dynamically to use latest URL/token if updated
          const { data: latestCampaign } = await supabase
            .from('campaigns')
            .select('*')
            .eq('id', '11111111-1111-1111-1111-111111111111')
            .single();

          if (!latestCampaign || latestCampaign.status !== 'active' || !latestCampaign.reply_url) {
            logDebug('job_failed', { cart_token, reason: 'Campaign inactive or URL not set at runtime' });
            console.warn('[Abandoned Cart] Delayed job fired: Webhook URL is not configured or flow is inactive.');
            return;
          }

          console.log(`[Abandoned Cart] Delayed job fired: Sending recovery trigger for cart_token: ${cart_token} to Reply.cx.`);
          
          const headers = { 'Content-Type': 'application/json' };
          if (latestCampaign.reply_token) {
            headers['Authorization'] = `Bearer ${latestCampaign.reply_token}`;
          }

          const response = await fetch(latestCampaign.reply_url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              phone: record.phone,
              first_name: record.first_name,
              cart_token: cart_token
            })
          });

          const responseText = await response.text();
          logDebug('reply_triggered', {
            cart_token,
            phone: record.phone,
            first_name: record.first_name,
            status: response.status,
            response: responseText
          });
          console.log(`[Abandoned Cart] Reply.cx Webhook response: ${response.status} - ${responseText}`);

          // Update last triggered timestamp
          await supabase
            .from('campaigns')
            .update({ last_triggered: new Date().toISOString() })
            .eq('id', '11111111-1111-1111-1111-111111111111');

        } catch (err) {
          logDebug('job_error', { cart_token, error: err.message });
          console.error(`[Abandoned Cart] Error executing delayed job for cart_token: ${cart_token}`, err);
        } finally {
          // Purge temp cache entry
          cartStorage.delete(cart_token);
          console.log(`[Abandoned Cart] Purged checkout cache for cart_token: ${cart_token}`);
        }
      }, delayMinutes * 60 * 1000);

      return res.status(200).json({ success: true, message: 'Checkout update received silently' });
    } catch (err) {
      logDebug('checkout_error', { error: err.message });
      console.error('[Abandoned Cart] Error handling checkouts/update:', err);
      return res.status(500).json({ error: err.message });
    }
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
