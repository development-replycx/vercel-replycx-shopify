import { createClient } from '@supabase/supabase-js';
import { processDueAbandonedCheckouts } from '../lib/abandoned-checkout-processor.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let debugSupabase = null;

// Initialize global in-memory cart storage (survives hot reloads within the same Node process)
if (!global.cartStorage) {
  global.cartStorage = new Map();
}
const cartStorage = global.cartStorage;

if (!global.cartTimers) {
  global.cartTimers = new Map();
}
const cartTimers = global.cartTimers;

// Initialize global debug logs for easy local diagnostics
if (!global.webhookDebugLogs) {
  global.webhookDebugLogs = [];
}

function getDebugSupabase() {
  if (!supabaseUrl || !supabaseKey) return null;
  if (!debugSupabase) {
    debugSupabase = createClient(supabaseUrl, supabaseKey);
  }
  return debugSupabase;
}

function maskSecret(value) {
  if (!value) return null;
  const text = value.toString();
  if (text.length <= 8) return `${text.slice(0, 2)}...`;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function getUrlPreview(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return {
      origin: url.origin,
      path_preview: maskSecret(url.pathname),
      length: value.length
    };
  } catch (err) {
    return {
      origin: null,
      path_preview: maskSecret(value),
      length: value.toString().length
    };
  }
}

async function logDebug(type, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    details
  };

  global.webhookDebugLogs.unshift(entry);
  if (global.webhookDebugLogs.length > 30) {
    global.webhookDebugLogs.pop();
  }

  const supabase = getDebugSupabase();
  if (!supabase) return;

  const { error } = await supabase
    .from('webhook_debug_logs')
    .insert({
      type,
      details,
      created_at: entry.timestamp
    });

  if (error) {
    console.error('[Debug Logs] Failed to persist log:', error.message);
  }
}

async function cacheCheckout(supabase, record) {
  const { error } = await supabase
    .from('abandoned_checkouts')
    .upsert({
      cart_token: record.cart_token,
      phone: record.phone,
      first_name: record.first_name,
      orders_count: record.orders_count,
      ordered: record.ordered,
      job_id: record.job_id,
      scheduled_at: record.scheduled_at,
      updated_at: new Date().toISOString()
    }, { onConflict: 'cart_token' });

  if (error) {
    await logDebug('checkout_cache_error', { cart_token: record.cart_token, error: error.message });
  }
}

async function markCheckoutOrdered(cartToken) {
  const supabase = getDebugSupabase();
  if (!supabase) return;

  const { error } = await supabase
    .from('abandoned_checkouts')
    .update({
      ordered: true,
      updated_at: new Date().toISOString()
    })
    .eq('cart_token', cartToken);

  if (error) {
    await logDebug('checkout_ordered_update_error', { cart_token: cartToken, error: error.message });
  }
}

async function getLatestCachedCheckout(supabase, cartToken) {
  const { data, error } = await supabase
    .from('abandoned_checkouts')
    .select('phone,first_name,orders_count,ordered,job_id')
    .eq('cart_token', cartToken)
    .maybeSingle();

  if (error) {
    await logDebug('checkout_cache_read_error', { cart_token: cartToken, error: error.message });
    return null;
  }

  if (!data) return null;

  const record = {
    phone: data.phone || '',
    first_name: data.first_name || '',
    orders_count: data.orders_count || 0,
    ordered: !!data.ordered,
    job_id: data.job_id || null
  };
  cartStorage.set(cartToken, record);
  return record;
}

async function deleteCachedCheckout(supabase, cartToken) {
  cartStorage.delete(cartToken);
  if (cartTimers.has(cartToken)) {
    clearTimeout(cartTimers.get(cartToken));
    cartTimers.delete(cartToken);
  }

  const { error } = await supabase
    .from('abandoned_checkouts')
    .delete()
    .eq('cart_token', cartToken);

  if (error) {
    await logDebug('checkout_cache_delete_error', { cart_token: cartToken, error: error.message });
  }
}

// Helper to format phone numbers to 91XXXXXXXXXX for Reply.cx
function formatPhoneNumber(value) {
  if (!value) return null;
  const digits = value.toString().replace(/\D/g, '');

  if (digits.startsWith('91')) return digits;
  if (digits.length === 10) return `91${digits}`;

  return digits ? `91${digits}` : null;
}

// Helper to get nested object values by path (e.g. "shipping_address.phone")
// Supports dot notation and array indices like "fulfillments[0].tracking_number" or "fulfillments.0.tracking_number"
function getByPath(obj, path) {
  if (!path) return null;
  // Normalize array bracket notation (e.g., fulfillments[0] -> fulfillments.0)
  const normalizedPath = path.replace(/\[(\d+)\]/g, '.$1');
  return normalizedPath.split('.').reduce((acc, part) => acc && acc[part], obj);
}

function parseCampaignMappings(rawMappings) {
  let parsed = rawMappings || [];
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (e) { parsed = []; }
  }

  if (Array.isArray(parsed)) {
    return {
      fields: parsed,
      phoneCountryCode: { enabled: false, countryCode: '91' }
    };
  }

  const phoneConfig = parsed.phone_country_code || parsed.phoneCountryCode || {};
  return {
    fields: Array.isArray(parsed.fields) ? parsed.fields : [],
    phoneCountryCode: {
      enabled: !!phoneConfig.enabled,
      countryCode: phoneConfig.country_code || phoneConfig.countryCode || '91'
    }
  };
}

function addCountryCodeToPhone(value, countryCode) {
  if (!value) return value;
  const code = (countryCode || '91').toString().replace(/\D/g, '') || '91';
  const phone = value.toString().trim().replace(/^\+/, '').replace(/^0+/, '').replace(/\D/g, '');
  if (!phone) return value;
  return phone.startsWith(code) ? phone : `${code}${phone}`;
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
        await markCheckoutOrdered(orderCartToken);
        await logDebug('order_suppression', { cart_token: orderCartToken, status: 'suppressed' });
        console.log(`[Abandoned Cart] Suppressing recovery: Order created for cart_token: ${orderCartToken}`);
      } else {
        await markCheckoutOrdered(orderCartToken);
        await logDebug('order_suppression', { cart_token: orderCartToken, status: 'suppressed_in_supabase' });
      }
    }
  }

  // STEP 1 — New checkouts/update webhook listener (silent):
  if (normalizedEvent === 'checkouts/update' || normalizedEvent === 'checkouts_update') {
    try {
      const cart_token = payload.cart_token;
      if (!cart_token) {
        await logDebug('checkout_ignored', { reason: 'Missing cart_token', payloadKeys: Object.keys(payload) });
        return res.status(200).json({ success: true, message: 'No cart_token in payload, skipped' });
      }

      if (!supabaseUrl || !supabaseKey) {
        console.error('[Abandoned Cart] Supabase credentials missing');
        return res.status(500).json({ error: 'Supabase credentials missing' });
      }

      const supabase = createClient(supabaseUrl, supabaseKey);
      await processDueAbandonedCheckouts({ supabase, limit: 10 });

      // Query Supabase to check if the Abandoned Cart Flow is active and get settings
      const { data: campaign, error } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', '11111111-1111-1111-1111-111111111111')
        .single();

      if (error || !campaign) {
        await logDebug('checkout_ignored', { cart_token, reason: 'Flow settings not found in Supabase' });
        console.log(`[Abandoned Cart] Flow is not configured or error fetching: ${error ? error.message : 'Not configured'}`);
        return res.status(200).json({ success: true, message: 'Abandoned Cart flow is not configured.' });
      }

      if (campaign.status !== 'active') {
        await logDebug('checkout_ignored', { cart_token, reason: 'Flow is currently inactive' });
        console.log('[Abandoned Cart] Flow is currently inactive.');
        return res.status(200).json({ success: true, message: 'Abandoned Cart flow is inactive.' });
      }

      // Extract checkout details from the checkout payload.
      const rawPhone = getByPath(payload, 'shipping_address.phone');
      const first_name = getByPath(payload, 'shipping_address.first_name') || '';
      const phone = formatPhoneNumber(rawPhone) || '';
      const orders_count = getByPath(payload, 'customer.orders_count') || 0;
      const job_id = `${cart_token}:${Date.now()}`;

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

      const scheduled_at = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();

      // Save to warm cache and durable schedule
      cartStorage.set(cart_token, { phone, first_name, orders_count, ordered: false, job_id, scheduled_at });
      await cacheCheckout(supabase, { cart_token, phone, first_name, orders_count, ordered: false, job_id, scheduled_at });
      await logDebug('checkout_cached', { cart_token, phone, first_name, orders_count, job_id, delay_minutes: delayMinutes, scheduled_at });
      console.log(`[Abandoned Cart] Saved checkout to queue. cart_token: ${cart_token}, scheduled_at: ${scheduled_at}`);

      return res.status(200).json({ success: true, message: 'Checkout update received silently' });
    } catch (err) {
      await logDebug('checkout_error', { error: err.message });
      console.error('[Abandoned Cart] Error handling checkouts/update:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  await processDueAbandonedCheckouts({ supabase, limit: 10 });

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
      const mappingConfig = parseCampaignMappings(campaign.mappings);
      
      if (mappingConfig.fields.length > 0) {
        mappingConfig.fields.forEach(mapping => {
          let value = getByPath(payload, mapping.path);
          const replyVariableName = (mapping.name || '').trim();
          
          if (replyVariableName === 'phone' && value) {
            if (mappingConfig.phoneCountryCode.enabled) {
              value = addCountryCodeToPhone(value, mappingConfig.phoneCountryCode.countryCode);
            } else {
              // Existing behavior for old campaigns: phone gets +91 prefix.
              const digits = value.toString().replace(/\D/g, '');
              if (digits.length === 12 && digits.startsWith('91')) {
                value = `+${digits}`;
              } else if (digits.length === 10) {
                value = `+91${digits}`;
              } else {
                value = `+91${digits}`;
              }
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
