import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // Allow only GET requests to view the log history
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!global.webhookDebugLogs) {
    global.webhookDebugLogs = [];
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(200).json({
      source: 'memory',
      warning: 'Supabase credentials are missing, so only warm in-memory logs are available.',
      logs: global.webhookDebugLogs
    });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data, error } = await supabase
    .from('webhook_debug_logs')
    .select('created_at,type,details')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    return res.status(500).json({
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
      memory_logs: global.webhookDebugLogs
    });
  }

  return res.status(200).json({
    source: 'supabase',
    logs: data || []
  });
}
