# Acme API

Base URL: `http://localhost:4173`. Bodies are JSON objects. Every endpoint except health, sign-up, sign-in and accept needs a signed-in account: `Authorization: Bearer <token>` or the `acme_session` cookie. Errors come back as `{"error": "<text>"}`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | none | `{"ok": true}` |
| POST | `/api/signup` | `{"email", "password"}` | 201 `{"key", "org", "token"}`, sets the session cookie |
| POST | `/api/signin` | `{"email", "password"}` | `{"ok": true}`, sets the session cookie |
| GET | `/api/invites` | none; optional query `?status=sent\|accepted\|revoked` and `?org=<your org id>` | your org's invites |
| POST | `/api/invites` | `{"email"}` | 201 the new invite; the invitee gets an email with an accept link |
| POST | `/api/invites/<id>/resend` | none | the invite; emails the link again (sent invites only) |
| DELETE | `/api/invites/<id>` | none | the revoked invite |
| POST | `/api/accept/<code>` | none | the accepted invite |

An invite is `{"id", "orgId", "email", "byKey", "createdAt", "status", "code"}`; `status` is `sent`, `accepted` or `revoked`. Only org owners can send, resend and revoke.
