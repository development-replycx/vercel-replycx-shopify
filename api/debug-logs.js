export default async function handler(req, res) {
  // Allow only GET requests to view the log history
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!global.webhookDebugLogs) {
    global.webhookDebugLogs = [];
  }

  // Return the live, warm-cached log history
  return res.status(200).json(global.webhookDebugLogs);
}
