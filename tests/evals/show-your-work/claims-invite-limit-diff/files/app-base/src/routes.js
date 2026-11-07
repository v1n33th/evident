import { sendInvite } from './invites.js';

export function routes(app, db) {
  app.post('/api/invites', async (req, res) => {
    try {
      const invite = await sendInvite(db, req.org, req.user, req.body.email);
      res.status(201).json(invite);
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });
  app.get('/api/invites', async (req, res) => res.json(await db.invites.list(req.org.id)));
}
