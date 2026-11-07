const $ = (id) => document.getElementById(id);

function toast(text) {
  $('toast').textContent = text;
}

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error || 'Something went wrong.');
  return json;
}

// Run fn while the button is disabled; show any error as a toast.
async function busy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
  }
}

// Auth forms: post the fields to the API, then go to the team page.
function authForm(path) {
  $('auth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('submit'), async () => {
      await api('POST', path, { email: $('email').value, password: $('password').value });
      location.href = '/team';
    });
  });
}

async function loadInvites() {
  const invites = await api('GET', '/api/invites');
  const list = $('invite-list');
  list.innerHTML = '';
  for (const i of invites) {
    const row = document.createElement('tr');
    row.className = 'invite';
    row.dataset.id = i.id;
    const email = document.createElement('td');
    email.textContent = i.email;
    const status = document.createElement('td');
    status.className = 'status';
    status.textContent = i.status;
    const actions = document.createElement('td');
    const buttons = document.createElement('div');
    buttons.className = 'actions';
    if (i.status === 'sent') buttons.append(rowButton('resend', 'Resend'));
    if (i.status !== 'revoked') buttons.append(rowButton('revoke', 'Revoke'));
    actions.append(buttons);
    row.append(email, status, actions);
    list.append(row);
  }
}

function rowButton(cls, label) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  return b;
}

function teamPage() {
  $('invite-form').addEventListener('submit', (e) => {
    e.preventDefault();
    busy($('send'), async () => {
      const email = $('email').value;
      await api('POST', '/api/invites', { email });
      toast(`Invite sent to ${email}`);
      $('email').value = '';
      await loadInvites();
    });
  });
  $('invite-list').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    const id = button.closest('.invite').dataset.id;
    busy(button, async () => {
      if (button.classList.contains('resend')) {
        const invite = await api('POST', `/api/invites/${id}/resend`);
        toast(`Invite sent to ${invite.email}`);
      } else {
        await api('DELETE', `/api/invites/${id}`);
      }
      await loadInvites();
    });
  });
  loadInvites().catch((e) => toast(e.message));
}

async function acceptPage() {
  const code = location.pathname.split('/').pop();
  try {
    await api('POST', `/api/accept/${code}`);
    toast('Invite accepted.');
  } catch (e) {
    toast(e.message);
  }
}

const page = document.body.dataset.page;
if (page === 'signup') authForm('/api/signup');
if (page === 'signin') authForm('/api/signin');
if (page === 'team') teamPage();
if (page === 'accept') acceptPage();
