import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

async function logDebug(supabase, type, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    details
  };

  global.webhookDebugLogs.unshift(entry);
  if (global.webhookDebugLogs.length > 30) {
    global.webhookDebugLogs.pop();
  }

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

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const now = new Date().toISOString();

  try {
    const { data: dueCheckouts, error } = await supabase
      .from('abandoned_checkouts')
      .select('cart_token,phone,first_name,orders_count,ordered,job_id,scheduled_at')
      .lte('scheduled_at', now)
      .order('scheduled_at', { ascending: true })
      .limit(25);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const { data: latestCampaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', '11111111-1111-1111-1111-111111111111')
      .single();

    if (campaignError || !latestCampaign) {
      await logDebug(supabase, 'job_failed', {
        reason: 'Flow settings not found in Supabase at processor runtime',
        error: campaignError ? campaignError.message : null
      });
      return res.status(200).json({ processed: 0, reason: 'campaign_not_found' });
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

        if (latestCampaign.status !== 'active' || !latestCampaign.reply_url) {
          await logDebug(supabase, 'job_failed', {
            cart_token: record.cart_token,
            reason: 'Campaign inactive or URL not set at runtime',
            campaign_status: latestCampaign.status,
            has_reply_url: !!latestCampaign.reply_url
          });
          results.push({ cart_token: record.cart_token, status: 'campaign_inactive' });
          continue;
        }

        const headers = { 'Content-Type': 'application/json' };
        if (latestCampaign.reply_token) {
          headers['Authorization'] = `Bearer ${latestCampaign.reply_token}`;
        }

        const replyRequestBody = {
          phone: record.phone || '',
          first_name: record.first_name || '',
          cart_token: record.cart_token,
          orders_count: String(record.orders_count || 0)
        };

        await logDebug(supabase, 'replycx_post_sending', {
          cart_token: record.cart_token,
          phone: record.phone || '',
          first_name: record.first_name || '',
          reply_url: getUrlPreview(latestCampaign.reply_url),
          has_reply_token: !!latestCampaign.reply_token,
          reply_token_preview: maskSecret(latestCampaign.reply_token),
          payload_format: 'flat_json',
          payload: replyRequestBody
        });

        let response;
        try {
          response = await fetch(latestCampaign.reply_url, {
            method: 'POST',
            headers,
            body: JSON.stringify(replyRequestBody)
          });
        } catch (err) {
          await logDebug(supabase, 'replycx_trigger_failed', {
            cart_token: record.cart_token,
            phone: record.phone || '',
            first_name: record.first_name || '',
            error: err.message,
            reply_url: getUrlPreview(latestCampaign.reply_url),
            has_reply_token: !!latestCampaign.reply_token,
            reply_token_preview: maskSecret(latestCampaign.reply_token)
          });
          throw err;
        }

        const responseText = await response.text();
        await logDebug(supabase, 'replycx_triggered', {
          cart_token: record.cart_token,
          phone: record.phone || '',
          first_name: record.first_name || '',
          orders_count: record.orders_count || 0,
          payload_format: 'flat_json',
          status_code: response.status,
          response: responseText,
          reply_url: getUrlPreview(latestCampaign.reply_url),
          has_reply_token: !!latestCampaign.reply_token,
          reply_token_preview: maskSecret(latestCampaign.reply_token)
        });

        await supabase
          .from('campaigns')
          .update({ last_triggered: new Date().toISOString() })
          .eq('id', '11111111-1111-1111-1111-111111111111');

        await deleteCachedCheckout(supabase, record.cart_token);
        results.push({ cart_token: record.cart_token, status: response.status });
      } catch (err) {
        await logDebug(supabase, 'job_error', { cart_token: record.cart_token, error: err.message });
        results.push({ cart_token: record.cart_token, status: 'error', error: err.message });
      }
    }

    return res.status(200).json({
      processed: results.length,
      results
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
