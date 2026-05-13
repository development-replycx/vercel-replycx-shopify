import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  console.log('API Method:', req.method);
  console.log('Supabase URL present:', !!supabaseUrl);
  console.log('Supabase Key present:', !!supabaseKey);

  if (!supabaseUrl) {
    return res.status(500).json({ error: 'Environment variable SUPABASE_URL is missing.' });
  }
  if (!supabaseKey) {
    return res.status(500).json({ error: 'Environment variable SUPABASE_SERVICE_ROLE_KEY is missing.' });
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { method } = req;

  try {
    if (method === 'GET') {
      const { data, error } = await supabase
        .from('campaigns')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Supabase GET Error:', error);
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json(data || []);
    }

    if (method === 'POST') {
      const campaign = req.body;
      console.log('Incoming Payload:', campaign);
      
      const dbPayload = {
        name: campaign.name,
        event_type: campaign.event_type,
        reply_url: campaign.reply_url,
        reply_token: campaign.reply_token,
        mappings: campaign.mappings,
        status: 'active',
        updated_at: new Date().toISOString()
      };

      if (campaign.id) {
        dbPayload.id = campaign.id;
      }

      const { data, error } = await supabase
        .from('campaigns')
        .upsert(dbPayload)
        .select()
        .single();

      if (error) {
        console.error('Supabase POST Error:', error);
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json(data);
    }

    if (method === 'DELETE') {
      const { id } = req.query;
      const { error } = await supabase
        .from('campaigns')
        .delete()
        .eq('id', id);

      if (error) {
        console.error('Supabase DELETE Error:', error);
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: `Method ${method} Not Allowed` });
  } catch (error) {
    console.error('Internal Handler Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
