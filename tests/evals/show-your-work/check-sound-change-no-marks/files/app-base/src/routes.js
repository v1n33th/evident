import { sendInvite } from './invites.js';

export function routes(app, db) {
  app.post('/api/invites', async (req, res) => {
    try {
      res.status(201).json(await sendInvite(db, req.org, req.user, req.body.email));
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  });
  app.get('/api/invites', async (req, res) => res.json(await db.invites.list(req.org.id)));
}
