import { createAppSupabase, processDueAbandonedCheckouts } from '../lib/abandoned-checkout-processor.js';

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const supabase = createAppSupabase();
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }

  try {
    const forceAll = req.query.forceAll === 'true' || req.body?.forceAll === true;
    const result = await processDueAbandonedCheckouts({ supabase, forceAll });
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
