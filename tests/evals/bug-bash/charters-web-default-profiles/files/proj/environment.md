# Test environment: Acme Invites

## Target
- Environment: local
- App: http://localhost:3000
- Also allowed: none
- Never open: https://app.acme-invites.com
- Health: http://localhost:3000/health
- Code: ../app

## Targets
- Web: http://localhost:3000
- API: none

## Browser
`agent-browser --no-auto-dialog --session <app-name>-<session>`

## Evidence
- Web: gif, text
- API: readable · tool: curl
- Custom: none
- Strength: cross-checked
- Check: on
- Secrets: redacted

## Accounts
| key | purpose | email | password | role |
|---|---|---|---|---|
| owner | owner of a Free org with seed data | qa-owner@acme.test | Passw0rd! | owner |
| member | member without invite permission, same org | qa-member@acme.test | Passw0rd! | member |

New accounts: qa+<unix-time>@acme.test
Sign in: setup login
Sign out: clear cookies

## Emails
Mailpit API at http://localhost:8025/api/v1/messages

## Setup commands
| key | does | command | allowed on |
|---|---|---|---|
| login | prints a session cookie and bearer token for an account key | `npm run qa:login -- {account}` | local |
| set-plan | moves an org to a plan | `npm run qa:set-plan -- {org} {plan}` | local |
| seed-invites | records invites sent today for an org | `npm run qa:seed-invites -- {org} {count}` | local |

## Rules
No real payments. Name created data "QA ...".

## Preferences
- Viewports: desktop 1440×900, tablet 768×1024, mobile 390×844 (device: iPhone 14)
- Profiles: default
