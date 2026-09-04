function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Lets someone see what they just typed into a "create/set a password" field.
const ICON_EYE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const ICON_EYE_OFF = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
document.querySelectorAll('.password-toggle-btn').forEach((btn) => {
  btn.innerHTML = ICON_EYE;
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.innerHTML = showing ? ICON_EYE : ICON_EYE_OFF;
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  });
});

const token = new URLSearchParams(location.search).get('token');
const banner = document.getElementById('signup-banner');

async function loadInvite() {
  if (!token) {
    banner.innerHTML = `<div class="banner error">This link is missing its code. Ask the shop for a new invite text.</div>`;
    return;
  }
  try {
    const res = await fetch(`/api/barber/invite/${token}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'This invite link is invalid.');
    document.getElementById('invite-greeting').textContent = `Hi ${data.first_name || (data.name || '').split(' ')[0]} — set a password for ${data.phone} to finish setting up your profile.`;
    document.getElementById('signup-form-wrap').style.display = 'block';
  } catch (err) {
    banner.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
  }
}

document.getElementById('confirm-password-input').addEventListener('input', (e) => e.target.classList.remove('field-error'));

document.getElementById('signup-btn').addEventListener('click', async () => {
  const password = document.getElementById('password-input').value;
  const confirmField = document.getElementById('confirm-password-input');
  const confirmPassword = confirmField.value;
  confirmField.classList.remove('field-error');
  if (!password || password.length < 10) {
    alert('Password must be at least 10 characters.');
    return;
  }
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(password)) {
    alert('Password must include at least one special character (e.g. ! @ # $ % &).');
    return;
  }
  if (password !== confirmPassword) {
    confirmField.classList.add('field-error');
    banner.innerHTML = `<div class="banner error">Passwords don't match.</div>`;
    return;
  }
  const btn = document.getElementById('signup-btn');
  btn.disabled = true; btn.textContent = 'Setting up…';
  try {
    const res = await fetch('/api/barber/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not set up your account.');
    location.href = '/barber-portal.html';
  } catch (err) {
    banner.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
    btn.disabled = false; btn.textContent = 'Set password & sign in';
  }
});

loadInvite();
