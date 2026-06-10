import { createClient } from '@supabase/supabase-js';

const CAMPAIGN_ID = '11111111-1111-1111-1111-111111111111';

if (!global.webhookDebugLogs) {
  global.webhookDebugLogs = [];
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

function getByPath(obj, path) {
  if (!path || !obj) return null;
  const normalizedPath = path.replace(/\[(\d+)\]/g, '.$1');
  return normalizedPath.split('.').reduce((acc, part) => acc && acc[part], obj);
}

export function createAppSupabase() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey);
}

export async function logDebug(supabase, type, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    details
  };

  global.webhookDebugLogs.unshift(entry);
  if (global.webhookDebugLogs.length > 30) {
    global.webhookDebugLogs.pop();
  }

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

async function deleteCachedCheckout(supabase, cartToken) {
  const { error } = await supabase
    .from('abandoned_checkouts')
    .delete()
    .eq('cart_token', cartToken);

  if (error) {
    await logDebug(supabase, 'checkout_cache_delete_error', { cart_token: cartToken, error: error.message });
  }
}

export async function processDueAbandonedCheckouts({ supabase, limit = 25 } = {}) {
  if (!supabase) {
    return { processed: 0, reason: 'supabase_missing', results: [] };
  }

  const now = new Date().toISOString();
  const { data: dueCheckouts, error } = await supabase
    .from('abandoned_checkouts')
    .select('cart_token,phone,first_name,orders_count,ordered,job_id,scheduled_at,raw_payload')
    .lte('scheduled_at', now)
    .order('scheduled_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  const { data: latestCampaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', CAMPAIGN_ID)
    .single();

  if (campaignError || !latestCampaign) {
    await logDebug(supabase, 'job_failed', {
      reason: 'Flow settings not found in Supabase at processor runtime',
      error: campaignError ? campaignError.message : null
    });
    return { processed: 0, reason: 'campaign_not_found', results: [] };
  }

  const results = [];

  for (const record of dueCheckouts || []) {
    try {
      if (!record.phone && !record.first_name) {
        await logDebug(supabase, 'no_data_found', { cart_token: record.cart_token });
        await deleteCachedCheckout(supabase, record.cart_token);
        results.push({ cart_token: record.cart_token, status: 'no_data_found' });
        continue;
      }

      await logDebug(supabase, 'job_fired', { cart_token: record.cart_token, phone: record.phone || '' });

      if (record.ordered) {
        await logDebug(supabase, 'suppressed', { cart_token: record.cart_token, reason: 'order placed' });
        await deleteCachedCheckout(supabase, record.cart_token);
        results.push({ cart_token: record.cart_token, status: 'suppressed' });
        continue;
      }

      // Parse Bot Trigger config early so we know if it exists
      let botTrigger = null;
      if (latestCampaign.mappings) {
        let parsedMappings = latestCampaign.mappings;
        if (typeof parsedMappings === 'string') {
          try { parsedMappings = JSON.parse(parsedMappings); } catch (e) {}
        }
        if (parsedMappings && parsedMappings.bot_trigger) {
          botTrigger = parsedMappings.bot_trigger;
        }
      }

      const hasMainUrl = !!latestCampaign.reply_url;
      const hasBotUrl = botTrigger && !!botTrigger.url;

      if (latestCampaign.status !== 'active' || (!hasMainUrl && !hasBotUrl)) {
        await logDebug(supabase, 'job_failed', {
          cart_token: record.cart_token,
          reason: 'Campaign inactive or neither URL is set at runtime',
          campaign_status: latestCampaign.status,
          has_reply_url: hasMainUrl,
          has_bot_url: hasBotUrl
        });
        results.push({ cart_token: record.cart_token, status: 'campaign_inactive_or_no_urls' });
        continue;
      }

      let mainResponseStatus = 'skipped';

      if (hasMainUrl) {
        const headers = { 'Content-Type': 'application/json' };
        if (latestCampaign.reply_token) {
          headers['Authorization'] = `Bearer ${latestCampaign.reply_token}`;
        }

        const replyRequestBody = [{
          phone: record.phone || '',
          first_name: record.first_name || '',
          cart_token: record.cart_token,
          orders_count: record.orders_count || 0
        }];

        await logDebug(supabase, 'replycx_post_sending', {
          cart_token: record.cart_token,
          phone: record.phone || '',
          first_name: record.first_name || '',
          reply_url: getUrlPreview(latestCampaign.reply_url),
          has_reply_token: !!latestCampaign.reply_token,
          reply_token_preview: maskSecret(latestCampaign.reply_token),
          payload_format: 'array_json',
          payload: replyRequestBody
        });

        try {
          const response = await fetch(latestCampaign.reply_url, {
            method: 'POST',
            headers,
            body: JSON.stringify(replyRequestBody)
          });
          
          const responseText = await response.text();
          mainResponseStatus = response.status;
          await logDebug(supabase, 'replycx_triggered', {
            cart_token: record.cart_token,
            phone: record.phone || '',
            first_name: record.first_name || '',
            orders_count: record.orders_count || 0,
            payload_format: 'array_json',
            status_code: response.status,
            response: responseText,
            reply_url: getUrlPreview(latestCampaign.reply_url),
            has_reply_token: !!latestCampaign.reply_token,
            reply_token_preview: maskSecret(latestCampaign.reply_token)
          });
        } catch (err) {
          mainResponseStatus = 'error';
          await logDebug(supabase, 'replycx_trigger_failed', {
            cart_token: record.cart_token,
            phone: record.phone || '',
            first_name: record.first_name || '',
            error: err.message,
            reply_url: getUrlPreview(latestCampaign.reply_url),
            has_reply_token: !!latestCampaign.reply_token,
            reply_token_preview: maskSecret(latestCampaign.reply_token)
          });
          // Do not throw here, allow Bot Trigger to proceed!
        }
      }

      // Bot Trigger Push (Independent, Additive)
      if (hasBotUrl) {
        try {
          const payloadObj = record.raw_payload || {};
          const mappedData = {};

          (botTrigger.mappings || []).forEach(mapping => {
            let val = getByPath(payloadObj, mapping.path);

            if (val === null || val === undefined) {
              if (mapping.name === 'completed_at') val = "null";
              else if (mapping.name === 'sku') val = "unknown";
              else if (mapping.name === 'first_name') val = "Customer";
              else val = "";
            } else if (mapping.name === 'phone') {
              let phoneStr = val.toString().replace(/^\+/, '').replace(/\D/g, '');
              if (phoneStr.length === 10) val = `91${phoneStr}`;
              else val = phoneStr;
            }
            mappedData[mapping.name] = val;
          });

          await logDebug(supabase, 'bot_trigger_sending', {
            cart_token: record.cart_token,
            url: getUrlPreview(botTrigger.url),
            payload: [mappedData]
          });

          const botHeaders = { 'Content-Type': 'application/json' };
          if (botTrigger.token) {
            botHeaders['Authorization'] = `Bearer ${botTrigger.token}`;
          }

          const botResponse = await fetch(botTrigger.url, {
            method: 'POST',
            headers: botHeaders,
            body: JSON.stringify([mappedData])
          });

          const botResponseText = await botResponse.text();
          await logDebug(supabase, 'bot_trigger_success', {
            cart_token: record.cart_token,
            status_code: botResponse.status,
            response: botResponseText
          });
        } catch (botErr) {
          await logDebug(supabase, 'bot_trigger_failed', {
            cart_token: record.cart_token,
            error: botErr.message
          });
        }
      }

      await supabase
        .from('campaigns')
        .update({ last_triggered: new Date().toISOString() })
        .eq('id', CAMPAIGN_ID);

      await deleteCachedCheckout(supabase, record.cart_token);
      results.push({ cart_token: record.cart_token, status: mainResponseStatus, bot_triggered: hasBotUrl });
    } catch (err) {
      await logDebug(supabase, 'job_error', { cart_token: record.cart_token, error: err.message });
      results.push({ cart_token: record.cart_token, status: 'error', error: err.message });
    }
  }

  return {
    processed: results.length,
    results
  };
}
