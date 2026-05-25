import { createClient } from '@supabase/supabase-js';

function wantsJson(req) {
  return req.query.format === 'json' || (req.headers.accept || '').includes('application/json');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtml({ source, logs, warning, error, processorResult }) {
  const rows = logs.map(log => {
    const details = JSON.stringify(log.details || {}, null, 2);
    return `
      <article class="log">
        <div class="meta">
          <strong>${escapeHtml(log.type || 'unknown')}</strong>
          <time>${escapeHtml(log.created_at || log.timestamp || '')}</time>
        </div>
        <pre>${escapeHtml(details)}</pre>
      </article>
    `;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Webhook Debug Logs</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f6f7f9; color: #111827; }
    main { max-width: 1080px; margin: 0 auto; padding: 28px 18px 48px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
    h1 { font-size: 24px; margin: 0 0 4px; }
    p { margin: 0; color: #5b6472; }
    .actions { display: flex; gap: 10px; align-items: center; }
    button, a.button { border: 0; border-radius: 6px; padding: 10px 14px; font: inherit; cursor: pointer; text-decoration: none; }
    button { background: #dc2626; color: white; }
    a.button { background: #e5e7eb; color: #111827; }
    .notice { background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; padding: 12px 14px; border-radius: 6px; margin: 14px 0; }
    .error { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
    .log { background: white; border: 1px solid #e5e7eb; border-radius: 6px; margin: 10px 0; overflow: hidden; }
    .meta { display: flex; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; background: #f9fafb; }
    time { color: #6b7280; font-size: 13px; white-space: nowrap; }
    pre { margin: 0; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.45; }
    .empty { background: white; border: 1px dashed #cbd5e1; border-radius: 6px; padding: 28px; text-align: center; }
    @media (prefers-color-scheme: dark) {
      body { background: #0f172a; color: #e5e7eb; }
      p, time { color: #9ca3af; }
      .log, .empty { background: #111827; border-color: #374151; }
      .meta { background: #1f2937; border-color: #374151; }
      a.button { background: #374151; color: #f9fafb; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Webhook Debug Logs</h1>
        <p>Source: ${escapeHtml(source)} - Showing ${logs.length} latest logs</p>
      </div>
      <div class="actions">
        <a class="button" href="/api/debug-logs?format=json">JSON</a>
        <form method="post">
          <input type="hidden" name="action" value="process_due">
          <button type="submit">Run due jobs now</button>
        </form>
        <form method="post" onsubmit="return confirm('Clear all webhook debug logs?');">
          <input type="hidden" name="action" value="clear_logs">
          <button type="submit">Clear logs</button>
        </form>
      </div>
    </header>
    ${warning ? `<div class="notice">${escapeHtml(warning)}</div>` : ''}
    ${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ''}
    ${processorResult ? `<div class="notice">Processor result: ${escapeHtml(JSON.stringify(processorResult))}</div>` : ''}
    ${rows || '<div class="empty">No logs found.</div>'}
  </main>
</body>
</html>`;
}

async function clearLogs(supabase) {
  global.webhookDebugLogs = [];

  if (!supabase) {
    return { source: 'memory', deleted: true };
  }

  const { error } = await supabase
    .from('webhook_debug_logs')
    .delete()
    .gte('created_at', '1900-01-01T00:00:00.000Z');

  if (error) throw error;
  return { source: 'supabase', deleted: true };
}

async function processDueJobs(req) {
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const response = await fetch(`${proto}://${host}/api/process-abandoned-checkouts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  const text = await response.text();

  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

export default async function handler(req, res) {
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!global.webhookDebugLogs) {
    global.webhookDebugLogs = [];
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
  let processorResult = null;

  if (req.method === 'POST' || req.method === 'DELETE') {
    try {
      const action = req.body?.action || req.query.action || 'clear_logs';

      if (action === 'process_due') {
        processorResult = await processDueJobs(req);
        if (wantsJson(req)) {
          return res.status(200).json(processorResult);
        }
      } else {
        const result = await clearLogs(supabase);
        if (wantsJson(req) || req.method === 'DELETE') {
          return res.status(200).json(result);
        }
        res.setHeader('Location', '/api/debug-logs');
        return res.status(303).end();
      }
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  if (req.method === 'GET' && supabase && req.query.autorun !== '0') {
    try {
      processorResult = await processDueJobs(req);
    } catch (error) {
      processorResult = { status: 500, body: { error: error.message } };
    }
  }

  if (!supabase) {
    const payload = {
      source: 'memory',
      warning: 'Supabase credentials are missing, so only warm in-memory logs are available.',
      logs: global.webhookDebugLogs,
      processorResult
    };
    if (wantsJson(req)) return res.status(200).json(payload);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(renderHtml(payload));
  }

  const { data, error } = await supabase
    .from('webhook_debug_logs')
    .select('created_at,type,details')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    const payload = {
      source: 'supabase',
      error: error.message,
      hint: 'Create the webhook_debug_logs table in Supabase, then redeploy if needed.',
      setup_sql: [
        'create table if not exists public.webhook_debug_logs (',
        '  id bigserial primary key,',
        '  created_at timestamptz not null default now(),',
        '  type text not null,',
        '  details jsonb not null default \'{}\'::jsonb',
        ');',
        'create index if not exists webhook_debug_logs_created_at_idx on public.webhook_debug_logs (created_at desc);'
      ].join('\n'),
      memory_logs: global.webhookDebugLogs,
      logs: global.webhookDebugLogs,
      processorResult
    };
    if (wantsJson(req)) return res.status(500).json(payload);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(renderHtml(payload));
  }

  const payload = {
    source: 'supabase',
    logs: data || [],
    processorResult
  };

  if (wantsJson(req)) return res.status(200).json(payload);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(renderHtml(payload));
}
