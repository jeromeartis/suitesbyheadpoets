const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

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
function to12h(t) {
  let [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${suffix}`;
}

// Same .ics builder as the public booking page — works with Google/Apple/Outlook calendars.
function downloadAppointmentIcs({ title, description, location, dateStr, timeStr, durationMinutes }) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const start = new Date(y, mo - 1, d, h, mi);
  const end = new Date(start.getTime() + (durationMinutes || 30) * 60000);

  const pad = (n) => String(n).padStart(2, '0');
  const toIcsDate = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
  const escapeIcs = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@barbershop-booking`;

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Barbershop//Booking//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toIcsDate(new Date())}`,
    `DTSTART:${toIcsDate(start)}`,
    `DTEND:${toIcsDate(end)}`,
    `SUMMARY:${escapeIcs(title)}`,
    description ? `DESCRIPTION:${escapeIcs(description)}` : '',
    location ? `LOCATION:${escapeIcs(location)}` : '',
    'BEGIN:VALARM',
    'TRIGGER:-PT60M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Appointment reminder',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'appointment.ics';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function generateSlots(start, end, stepMinutes) {
  const slots = [];
  let [h, m] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  while (h < endH || (h === endH && m < endM)) {
    slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    m += stepMinutes;
    if (m >= 60) { m -= 60; h += 1; }
  }
  return slots;
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function slotIsAvailable(slotStart, durationMinutes, closeTime, booked) {
  const start = timeToMinutes(slotStart);
  const end = start + durationMinutes;
  if (end > timeToMinutes(closeTime)) return false;
  return !booked.some((b) => {
    const bStart = timeToMinutes(b.appt_time);
    const bEnd = bStart + (b.duration_minutes || 30);
    return start < bEnd && bStart < end;
  });
}

function selectedServiceDuration(selectEl) {
  const opt = selectEl.options[selectEl.selectedIndex];
  const d = opt ? parseInt(opt.dataset.duration, 10) : NaN;
  return Number.isInteger(d) && d > 0 ? d : 30;
}

let currentCustomer = null;
let barbers = [];
let selectedSlot = null;

// If we got here from the public booking page ("sign in to book"), remember which
// barber and tab to land on so booking picks up right where they left off.
const urlParams = new URLSearchParams(location.search);
const pendingBookBarberId = urlParams.get('book') ? Number(urlParams.get('book')) : null;
if (urlParams.get('tab') === 'signup') switchAuthTab('signup'); // function declaration below is hoisted

// ---------- auth flow ----------
document.getElementById('tab-signin-btn').addEventListener('click', () => switchAuthTab('signin'));
document.getElementById('tab-signup-btn').addEventListener('click', () => switchAuthTab('signup'));

function switchAuthTab(which) {
  document.getElementById('tab-signin-btn').classList.toggle('active', which === 'signin');
  document.getElementById('tab-signup-btn').classList.toggle('active', which === 'signup');
  document.getElementById('signin-panel').style.display = which === 'signin' ? 'block' : 'none';
  document.getElementById('signup-panel').style.display = which === 'signup' ? 'block' : 'none';
  document.getElementById('login-banner').innerHTML = '';
}

// Twilio isn't configured in this dev/test environment, so request-otp returns the
// code directly instead of only texting it. Surface that for testers, never in prod
// (server only includes devCode when SMS sending was actually skipped).
function showDevCodeIfPresent(data) {
  if (data && data.devCode) {
    const banner = document.getElementById('login-banner');
    if (data.sms && data.sms.error) {
      banner.innerHTML = `<div class="banner info">The text failed to send (${escapeHtml(data.sms.error)}). Here's your code anyway: <strong>${escapeHtml(data.devCode)}</strong></div>`;
    } else {
      banner.innerHTML = `<div class="banner info">Testing mode — SMS isn't configured, so here's your code: <strong>${escapeHtml(data.devCode)}</strong></div>`;
    }
  }
}

// populate the signup "preferred barber" dropdown once barbers are known
fetch('/api/barbers').then((r) => r.json()).then((list) => {
  const select = document.getElementById('signup-preferred-barber');
  list.forEach((b) => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = `${b.name} — Booth ${b.booth_number || '—'}`;
    select.appendChild(opt);
  });
});

// --- sign in ---
document.getElementById('signin-btn').addEventListener('click', async () => {
  const phone = document.getElementById('signin-phone').value.trim();
  const password = document.getElementById('signin-password').value;
  const banner = document.getElementById('login-banner');
  if (!phone || !password) { banner.innerHTML = `<div class="banner error">Enter your phone and password.</div>`; return; }

  const btn = document.getElementById('signin-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/customer/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, password })
    });
    const data = await res.json();
    if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
    currentCustomer = data.customer;
    showAccount(data.passwordExpired);
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
});

// --- forgot password ---
document.getElementById('forgot-password-link').addEventListener('click', () => {
  document.getElementById('signin-password-step').style.display = 'none';
  document.getElementById('forgot-request-step').style.display = 'block';
});
document.getElementById('forgot-cancel-btn').addEventListener('click', () => {
  document.getElementById('forgot-request-step').style.display = 'none';
  document.getElementById('forgot-reset-step').style.display = 'none';
  document.getElementById('signin-password-step').style.display = 'block';
});
document.getElementById('forgot-send-code-btn').addEventListener('click', async () => {
  const phone = document.getElementById('forgot-phone').value.trim();
  const banner = document.getElementById('login-banner');
  if (!phone) { banner.innerHTML = `<div class="banner error">Enter your mobile number.</div>`; return; }
  const btn = document.getElementById('forgot-send-code-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/customer/request-otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not send code.');
    document.getElementById('forgot-request-step').style.display = 'none';
    document.getElementById('forgot-reset-step').style.display = 'block';
    banner.innerHTML = '';
    showDevCodeIfPresent(data);
  } catch (err) {
    banner.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Send reset code';
  }
});
document.getElementById('forgot-reset-btn').addEventListener('click', async () => {
  const phone = document.getElementById('forgot-phone').value.trim();
  const code = document.getElementById('forgot-code').value.trim();
  const newPassword = document.getElementById('forgot-new-password').value;
  const banner = document.getElementById('login-banner');
  const strengthError = passwordStrengthError(newPassword);
  if (strengthError) { banner.innerHTML = `<div class="banner error">${escapeHtml(strengthError)}</div>`; return; }
  const btn = document.getElementById('forgot-reset-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/customer/forgot-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code, newPassword })
    });
    const data = await res.json();
    if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
    currentCustomer = data.customer;
    showAccount(false);
  } finally {
    btn.disabled = false; btn.textContent = 'Set new password & sign in';
  }
});

// --- sign up ---
document.getElementById('signup-confirm-password').addEventListener('input', (e) => e.target.classList.remove('field-error'));

document.getElementById('signup-send-code-btn').addEventListener('click', async () => {
  const name = document.getElementById('signup-name').value.trim();
  const phone = document.getElementById('signup-phone').value.trim();
  const password = document.getElementById('signup-password').value;
  const confirmField = document.getElementById('signup-confirm-password');
  const confirmPassword = confirmField.value;
  const banner = document.getElementById('login-banner');
  confirmField.classList.remove('field-error');
  if (!name || !phone || !password) { banner.innerHTML = `<div class="banner error">Name, phone, and password are required.</div>`; return; }
  const strengthError = passwordStrengthError(password);
  if (strengthError) { alert(strengthError); return; }
  if (password !== confirmPassword) {
    confirmField.classList.add('field-error');
    banner.innerHTML = `<div class="banner error">Passwords don't match.</div>`;
    return;
  }

  const btn = document.getElementById('signup-send-code-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/customer/request-otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not send code.');
    document.getElementById('signup-code-phone-display').textContent = phone;
    document.getElementById('signup-details-step').style.display = 'none';
    document.getElementById('signup-code-step').style.display = 'block';
    banner.innerHTML = '';
    showDevCodeIfPresent(data);
  } catch (err) {
    banner.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Send verification code';
  }
});
document.getElementById('signup-back-btn').addEventListener('click', () => {
  document.getElementById('signup-code-step').style.display = 'none';
  document.getElementById('signup-details-step').style.display = 'block';
  document.getElementById('signup-code').value = '';
});
document.getElementById('signup-verify-btn').addEventListener('click', async () => {
  const name = document.getElementById('signup-name').value.trim();
  const phone = document.getElementById('signup-phone').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const preferred_barber_id = document.getElementById('signup-preferred-barber').value || null;
  const code = document.getElementById('signup-code').value.trim();
  const sms_consent = document.getElementById('signup-sms-consent').checked;
  const banner = document.getElementById('login-banner');

  const btn = document.getElementById('signup-verify-btn');
  btn.disabled = true; btn.textContent = 'Creating account…';
  try {
    const res = await fetch('/api/customer/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, email, password, preferred_barber_id, code, sms_consent })
    });
    const data = await res.json();
    if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
    currentCustomer = data.customer;
    showAccount(false);
  } finally {
    btn.disabled = false; btn.textContent = 'Verify & create account';
  }
});

document.getElementById('logout-link').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/customer/logout', { method: 'POST' });
  location.href = '/';
});

async function checkSession() {
  const data = await fetch('/api/customer/session').then((r) => r.json());
  if (data.loggedIn) {
    currentCustomer = data.customer;
    showAccount(data.passwordExpired);
  } else {
    document.getElementById('login-shell').style.display = 'grid';
  }
}

async function showAccount(passwordExpired) {
  document.getElementById('login-shell').style.display = 'none';
  document.getElementById('account-shell').style.display = 'block';
  document.getElementById('logout-link').style.display = 'inline';
  document.getElementById('welcome-heading').textContent = `Welcome back, ${firstName(currentCustomer.name)}`;
  document.getElementById('password-gate-section').style.display = passwordExpired ? 'block' : 'none';

  document.getElementById('sms-consent-toggle').checked = currentCustomer.sms_consent === 1;

  await loadBarbers();
  renderPreferredSelect();
  renderBookingBarberSelect();
  loadMyAppointments();

  // Came here from "sign in to book" on the public page — jump straight to that barber.
  if (pendingBookBarberId && barbers.some((b) => b.id === pendingBookBarberId)) {
    const select = document.getElementById('acct-barber-select');
    select.value = String(pendingBookBarberId);
    onBarberChange();
    document.getElementById('acct-barber-select').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ---------- forced password change (expired) ----------
document.getElementById('gate-save-btn').addEventListener('click', async () => {
  const banner = document.getElementById('gate-banner');
  const newPassword = document.getElementById('gate-new-password').value;
  const strengthError = passwordStrengthError(newPassword);
  if (strengthError) { banner.innerHTML = `<div class="banner error">${escapeHtml(strengthError)}</div>`; return; }
  const btn = document.getElementById('gate-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/customer/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword }) // no currentPassword needed once expired — they're already authenticated
    });
    const data = await res.json();
    if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
    document.getElementById('password-gate-section').style.display = 'none';
    document.getElementById('gate-new-password').value = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Set new password';
  }
});

// ---------- change password (account settings) ----------
document.getElementById('change-password-btn').addEventListener('click', async () => {
  const banner = document.getElementById('change-password-banner');
  const currentPassword = document.getElementById('cp-current-password').value;
  const newPassword = document.getElementById('cp-new-password').value;
  const strengthError = passwordStrengthError(newPassword);
  if (strengthError) { banner.innerHTML = `<div class="banner error">${escapeHtml(strengthError)}</div>`; return; }
  const btn = document.getElementById('change-password-btn');
  btn.disabled = true; btn.textContent = 'Updating…';
  try {
    const res = await fetch('/api/customer/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();
    if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
    banner.innerHTML = `<div class="banner success">Password updated.</div>`;
    document.getElementById('cp-current-password').value = '';
    document.getElementById('cp-new-password').value = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Update password';
  }
});

function firstName(name) { return (name || '').split(' ')[0] || 'there'; }

// Mirrors the server-side rule in server.js (validatePasswordStrength) so the user
// gets instant feedback instead of a round trip for something checkable locally.
// The server is still the source of truth — this is just a faster first check.
function passwordStrengthError(password) {
  if (!password || password.length < 10) return 'Password must be at least 10 characters.';
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(password)) {
    return 'Password must include at least one special character (e.g. ! @ # $ % &).';
  }
  return null;
}

// If an action is blocked because the yearly password expired, surface the gate
// instead of a generic error so the customer knows exactly what to do next.
function handleExpiredGate(data) {
  if (data && data.needsPasswordChange) {
    document.getElementById('password-gate-section').style.display = 'block';
    document.getElementById('password-gate-section').scrollIntoView({ behavior: 'smooth' });
    return true;
  }
  return false;
}

async function loadBarbers() {
  barbers = await fetch('/api/barbers').then((r) => r.json());
}

// ---------- preferred barber ----------
function renderPreferredSelect() {
  const select = document.getElementById('preferred-barber-select');
  select.innerHTML = `<option value="">No preference</option>` + barbers.map((b) =>
    `<option value="${b.id}" ${currentCustomer.preferred_barber_id === b.id ? 'selected' : ''}>${escapeHtml(b.name)} — Booth ${b.booth_number || '—'}</option>`
  ).join('');
}

document.getElementById('sms-consent-toggle').addEventListener('change', async (e) => {
  const banner = document.getElementById('sms-consent-banner');
  const wanted = e.target.checked;
  e.target.disabled = true;
  try {
    const res = await fetch('/api/customer/me/sms-consent', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sms_consent: wanted })
    });
    if (!res.ok) throw new Error();
    currentCustomer = await res.json();
    banner.innerHTML = `<div class="banner success">${wanted ? "Text notifications are on." : "Text notifications are off."}</div>`;
  } catch {
    e.target.checked = !wanted; // revert the toggle
    banner.innerHTML = `<div class="banner error">Could not save that. Try again.</div>`;
  } finally {
    e.target.disabled = false;
  }
});

document.getElementById('save-preferred-btn').addEventListener('click', async () => {
  const banner = document.getElementById('preferred-banner');
  const preferred_barber_id = document.getElementById('preferred-barber-select').value || null;
  const res = await fetch('/api/customer/me', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferred_barber_id })
  });
  if (res.ok) {
    currentCustomer = await res.json();
    banner.innerHTML = `<div class="banner success">Saved.</div>`;
    renderBookingBarberSelect();
  } else {
    const data = await res.json().catch(() => ({}));
    if (handleExpiredGate(data)) return;
    banner.innerHTML = `<div class="banner error">${escapeHtml(data.error || 'Could not save. Try again.')}</div>`;
  }
});

// ---------- booking ----------
function renderBookingBarberSelect() {
  const select = document.getElementById('acct-barber-select');
  select.innerHTML = `<option value="">Choose a barber…</option>` + barbers.map((b) =>
    `<option value="${b.id}">${escapeHtml(b.name)} — Booth ${b.booth_number || '—'}${currentCustomer.preferred_barber_id === b.id ? ' (preferred)' : ''}</option>`
  ).join('');
  if (currentCustomer.preferred_barber_id) {
    select.value = String(currentCustomer.preferred_barber_id);
    onBarberChange();
  }
}

document.getElementById('acct-barber-select').addEventListener('change', onBarberChange);
document.getElementById('acct-book-service').addEventListener('change', renderSlotsForDate);

function selectedBarberObj() {
  const id = Number(document.getElementById('acct-barber-select').value);
  return barbers.find((b) => b.id === id) || null;
}

let acctSelectedDate = null;
let acctCalYear, acctCalMonth;

function onBarberChange() {
  const barber = selectedBarberObj();
  selectedSlot = null;
  acctSelectedDate = null;
  const today = new Date();
  acctCalYear = today.getFullYear();
  acctCalMonth = today.getMonth();

  const serviceSelect = document.getElementById('acct-book-service');
  if (barber) {
    const services = (barber.services && barber.services.length)
      ? barber.services
      : [{ name: 'Haircut', price: null, duration_minutes: 30 }, { name: 'Haircut + Beard', price: null, duration_minutes: 60 }, { name: 'Beard trim only', price: null, duration_minutes: 15 }];
    serviceSelect.innerHTML = services.map((s) => {
      const duration = s.duration_minutes || 30;
      const label = s.price != null ? `${s.name} — $${s.price} · ${duration} min` : `${s.name} · ${duration} min`;
      return `<option value="${escapeHtml(s.name)}" data-price="${s.price ?? ''}" data-duration="${duration}">${escapeHtml(label)}</option>`;
    }).join('');
  }
  renderAcctCalendar();
  renderSlotsForDate();
}

// Same idea as the public booking calendar: grey out (and disable) days this barber
// is off, plus past dates, so only bookable days are clickable.
function renderAcctCalendar() {
  const container = document.getElementById('acct-book-calendar');
  const barber = selectedBarberObj();
  if (!barber) { container.innerHTML = '<p style="color:var(--paper-dim)">Pick a barber to see their calendar.</p>'; return; }

  const first = new Date(acctCalYear, acctCalMonth, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(acctCalYear, acctCalMonth + 1, 0).getDate();
  const monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const isCurrentMonth = acctCalYear === todayMidnight.getFullYear() && acctCalMonth === todayMidnight.getMonth();

  let cells = '';
  for (let i = 0; i < startWeekday; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(acctCalYear, acctCalMonth, d);
    const dateStr = `${acctCalYear}-${String(acctCalMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayName = DAYS[dateObj.getDay()];
    const avail = barber.availability[dayName];
    const isOff = !avail || avail.off;
    const isPast = dateObj < todayMidnight;
    const disabled = isPast || isOff;
    const isSelected = dateStr === acctSelectedDate;
    const isToday = dateObj.getTime() === todayMidnight.getTime();
    cells += `<div class="cal-cell ${disabled ? 'disabled' : ''} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}" data-date="${dateStr}" title="${isOff && !isPast ? `${escapeHtml(barber.name)} is off this day` : ''}">${d}</div>`;
  }

  container.innerHTML = `
    <div class="cal-header">
      <button type="button" class="cal-nav" id="acct-cal-prev" ${isCurrentMonth ? 'disabled' : ''}>‹</button>
      <span class="cal-month-label">${monthLabel}</span>
      <button type="button" class="cal-nav" id="acct-cal-next">›</button>
    </div>
    <div class="cal-weekdays">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
  `;

  document.getElementById('acct-cal-prev').addEventListener('click', () => {
    acctCalMonth -= 1;
    if (acctCalMonth < 0) { acctCalMonth = 11; acctCalYear -= 1; }
    renderAcctCalendar();
  });
  document.getElementById('acct-cal-next').addEventListener('click', () => {
    acctCalMonth += 1;
    if (acctCalMonth > 11) { acctCalMonth = 0; acctCalYear += 1; }
    renderAcctCalendar();
  });
  container.querySelectorAll('.cal-cell:not(.disabled):not(.empty)').forEach((cell) => {
    cell.addEventListener('click', () => {
      acctSelectedDate = cell.dataset.date;
      renderAcctCalendar();
      renderSlotsForDate();
    });
  });
}

async function renderSlotsForDate() {
  const slotGrid = document.getElementById('acct-slot-grid');
  const barber = selectedBarberObj();
  const date = acctSelectedDate;
  if (!barber || !date) { slotGrid.innerHTML = '<p style="color:var(--paper-dim)">Pick a barber and date to see open times.</p>'; return; }

  const dayName = DAYS[new Date(date + 'T00:00:00').getDay()];
  const avail = barber.availability[dayName];
  if (!avail || avail.off) {
    slotGrid.innerHTML = `<p style="color:var(--paper-dim)">${escapeHtml(barber.name)} is off that day. Pick another date.</p>`;
    return;
  }

  slotGrid.innerHTML = `<p style="color:var(--paper-dim)">Loading open times…</p>`;
  const taken = await fetch(`/api/barbers/${barber.id}/appointments?date=${date}`).then((r) => r.json());
  const duration = selectedServiceDuration(document.getElementById('acct-book-service'));
  const slots = generateSlots(avail.start, avail.end, 30);
  selectedSlot = null;

  slotGrid.innerHTML = slots.map((s) => {
    const isTaken = !slotIsAvailable(s, duration, avail.end, taken);
    return `<div class="slot ${isTaken ? 'taken' : ''}" data-time="${s}">${to12h(s)}</div>`;
  }).join('') || `<p style="color:var(--paper-dim)">No slots fit that service on this day. Try another date.</p>`;

  if (slots.every((s) => !slotIsAvailable(s, duration, avail.end, taken))) {
    slotGrid.insertAdjacentHTML('beforeend', `<p style="color:var(--paper-dim);grid-column:1/-1;margin:8px 0 0;">Fully booked for this service on this day — try another date.</p>`);
  }

  slotGrid.querySelectorAll('.slot:not(.taken)').forEach((el) => {
    el.addEventListener('click', () => {
      slotGrid.querySelectorAll('.slot').forEach((s) => s.classList.remove('selected'));
      el.classList.add('selected');
      selectedSlot = el.dataset.time;
    });
  });
}

document.getElementById('acct-confirm-book').addEventListener('click', async () => {
  const banner = document.getElementById('acct-book-banner');
  const barber = selectedBarberObj();
  const date = acctSelectedDate;
  if (!barber || !date || !selectedSlot) {
    banner.innerHTML = `<div class="banner error">Pick a barber, date, and open time slot first.</div>`;
    return;
  }
  const serviceSelect = document.getElementById('acct-book-service');
  const opt = serviceSelect.options[serviceSelect.selectedIndex];
  const price = opt ? opt.dataset.price : '';
  const service = price ? `${serviceSelect.value} ($${price})` : (serviceSelect.value || '');
  const duration_minutes = selectedServiceDuration(serviceSelect);

  const btn = document.getElementById('acct-confirm-book');
  btn.disabled = true; btn.textContent = 'Booking…';
  try {
    const res = await fetch('/api/customer/appointments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barber_id: barber.id, service, appt_date: date, appt_time: selectedSlot, duration_minutes })
    });
    const data = await res.json();
    if (!res.ok) {
      if (handleExpiredGate(data)) return;
      banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`;
      renderSlotsForDate();
      return;
    }
    banner.innerHTML = `
      <div class="banner success">
        Booked with ${escapeHtml(barber.name)} on ${date} at ${to12h(selectedSlot)}.
        <div style="margin-top:10px;"><button type="button" class="btn btn-outline btn-sm" id="acct-add-to-calendar-btn">📅 Add to calendar</button></div>
      </div>`;
    document.getElementById('acct-add-to-calendar-btn').addEventListener('click', () => {
      downloadAppointmentIcs({
        title: `${service} with ${barber.name}`,
        description: `Booked at ${barber.name.split(' ')[0]}'s booth${barber.booth_number ? ` #${barber.booth_number}` : ''}.`,
        location: barber.booth_number ? `Booth ${barber.booth_number}` : '',
        dateStr: date,
        timeStr: selectedSlot,
        durationMinutes: duration_minutes
      });
    });
    renderSlotsForDate();
    loadMyAppointments();
  } finally {
    btn.disabled = false; btn.textContent = 'Confirm booking';
  }
});

// ---------- my appointments ----------
// The next upcoming confirmed appointment, for the highlighted card near the top
// of the page — separate from the full history list below it.
function renderNextAppointment(rows) {
  const el = document.getElementById('next-appt-content');
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const nowTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const next = rows.find((a) =>
    (a.status === 'confirmed' || a.status === 'pending') &&
    (a.appt_date > todayStr || (a.appt_date === todayStr && a.appt_time >= nowTimeStr))
  );

  if (!next) {
    el.innerHTML = `<p style="margin:0;">Nothing booked yet. Grab a slot below whenever you're ready.</p>`;
    return;
  }

  const pendingNote = next.status === 'pending'
    ? `<p style="color:var(--brass);margin:0 0 10px;">⏳ Waiting on ${escapeHtml(firstName(next.barber_name))} to approve this request.</p>`
    : '';
  el.innerHTML = `
    <div style="font-family:var(--display);font-size:1.6rem;">${next.appt_date} · ${to12h(next.appt_time)}</div>
    <div style="color:var(--paper-dim);margin:4px 0 12px;">${escapeHtml(next.barber_name)} · Booth ${next.booth_number || '—'}${next.service ? ' · ' + escapeHtml(next.service) : ''}</div>
    ${pendingNote}
    <button type="button" class="btn btn-outline btn-sm" id="next-appt-cal-btn">📅 Add to calendar</button>
  `;
  document.getElementById('next-appt-cal-btn').addEventListener('click', () => {
    downloadAppointmentIcs({
      title: `${next.service || 'Haircut'} with ${next.barber_name}`,
      description: `Booked at ${next.barber_name.split(' ')[0]}'s booth${next.booth_number ? ` #${next.booth_number}` : ''}.`,
      location: next.booth_number ? `Booth ${next.booth_number}` : '',
      dateStr: next.appt_date,
      timeStr: next.appt_time,
      durationMinutes: next.duration_minutes || 30
    });
  });
}

async function loadMyAppointments() {
  const rows = await fetch('/api/customer/appointments').then((r) => r.json());
  renderNextAppointment(rows);
  const list = document.getElementById('my-appointments-list');
  if (!rows.length) {
    list.innerHTML = '<p>No appointments yet — book one above.</p>';
    return;
  }
  list.innerHTML = rows.map((a) => `
    <div class="card appt-card" data-id="${a.id}" data-barber-id="${a.barber_id}" data-duration="${a.duration_minutes || 30}" style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div>
          <div style="font-family:var(--display);font-size:1.3rem;">${a.appt_date} · ${to12h(a.appt_time)}</div>
          <div style="color:var(--paper-dim);font-size:0.9rem;">${escapeHtml(a.barber_name)} · Booth ${a.booth_number || '—'} ${a.service ? '· ' + escapeHtml(a.service) : ''}</div>
          <span class="pill ${a.status}">${a.status === 'pending' ? '⏳ pending approval' : a.status}</span>
        </div>
        ${a.status === 'confirmed' || a.status === 'pending' ? `
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-outline btn-sm add-to-cal-btn" data-id="${a.id}">📅 Calendar</button>
            <button class="btn btn-outline btn-sm reschedule-appt" data-id="${a.id}">Change</button>
            <button class="btn btn-danger btn-sm cancel-appt" data-id="${a.id}">Cancel</button>
          </div>` : ''}
      </div>
      <div class="reschedule-panel" id="reschedule-panel-${a.id}" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--line);"></div>
    </div>
  `).join('');

  list.querySelectorAll('.add-to-cal-btn').forEach((btn) => btn.addEventListener('click', () => {
    const a = rows.find((r) => r.id === Number(btn.dataset.id));
    if (!a) return;
    downloadAppointmentIcs({
      title: `${a.service || 'Haircut'} with ${a.barber_name}`,
      description: `Booked at ${a.barber_name.split(' ')[0]}'s booth${a.booth_number ? ` #${a.booth_number}` : ''}.`,
      location: a.booth_number ? `Booth ${a.booth_number}` : '',
      dateStr: a.appt_date,
      timeStr: a.appt_time,
      durationMinutes: a.duration_minutes || 30
    });
  }));

  list.querySelectorAll('.cancel-appt').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Cancel this appointment?')) return;
    const res = await fetch(`/api/customer/appointments/${btn.dataset.id}/cancel`, { method: 'PUT' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && handleExpiredGate(data)) return;
    loadMyAppointments();
  }));

  list.querySelectorAll('.reschedule-appt').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.dataset.id;
    const panel = document.getElementById(`reschedule-panel-${id}`);
    const isOpen = panel.style.display === 'block';
    document.querySelectorAll('.reschedule-panel').forEach((p) => (p.style.display = 'none'));
    if (!isOpen) openReschedulePanel(id);
  }));
}

// Inline "change appointment" UI — its own tiny date + slot grid, scoped to the
// appointment's existing barber and duration (service doesn't change on a reschedule).
function openReschedulePanel(apptId) {
  const card = document.querySelector(`.appt-card[data-id="${apptId}"]`);
  const barberId = Number(card.dataset.barberId);
  const duration = Number(card.dataset.duration) || 30;
  const barber = barbers.find((b) => b.id === barberId);
  const panel = document.getElementById(`reschedule-panel-${apptId}`);

  panel.innerHTML = `
    <div class="form-row" style="max-width:340px;">
      <label>New date</label>
      <div class="calendar-widget rs-calendar"></div>
    </div>
    <div class="form-row">
      <label>Open slots</label>
      <div class="slot-grid rs-slot-grid"><p style="color:var(--paper-dim)">Pick a date to see open times.</p></div>
    </div>
    <div class="rs-banner"></div>
    <button class="btn btn-primary rs-confirm-btn" disabled>Confirm new time</button>
  `;
  panel.style.display = 'block';

  let rsSelectedSlot = null;
  let rsSelectedDate = null;
  const today = new Date();
  let rsCalYear = today.getFullYear();
  let rsCalMonth = today.getMonth();
  const calContainer = panel.querySelector('.rs-calendar');
  const slotGrid = panel.querySelector('.rs-slot-grid');
  const confirmBtn = panel.querySelector('.rs-confirm-btn');

  function renderRsCalendar() {
    const first = new Date(rsCalYear, rsCalMonth, 1);
    const startWeekday = first.getDay();
    const daysInMonth = new Date(rsCalYear, rsCalMonth + 1, 0).getDate();
    const monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const isCurrentMonth = rsCalYear === todayMidnight.getFullYear() && rsCalMonth === todayMidnight.getMonth();

    let cells = '';
    for (let i = 0; i < startWeekday; i++) cells += `<div class="cal-cell empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateObj = new Date(rsCalYear, rsCalMonth, d);
      const dateStr = `${rsCalYear}-${String(rsCalMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayName = DAYS[dateObj.getDay()];
      const avail = barber ? barber.availability[dayName] : null;
      const isOff = !avail || avail.off;
      const isPast = dateObj < todayMidnight;
      const disabled = isPast || isOff;
      const isSelected = dateStr === rsSelectedDate;
      const isToday = dateObj.getTime() === todayMidnight.getTime();
      cells += `<div class="cal-cell ${disabled ? 'disabled' : ''} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}" data-date="${dateStr}">${d}</div>`;
    }

    calContainer.innerHTML = `
      <div class="cal-header">
        <button type="button" class="cal-nav rs-cal-prev" ${isCurrentMonth ? 'disabled' : ''}>‹</button>
        <span class="cal-month-label">${monthLabel}</span>
        <button type="button" class="cal-nav rs-cal-next">›</button>
      </div>
      <div class="cal-weekdays">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<span>${d}</span>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
    `;

    calContainer.querySelector('.rs-cal-prev').addEventListener('click', () => {
      rsCalMonth -= 1;
      if (rsCalMonth < 0) { rsCalMonth = 11; rsCalYear -= 1; }
      renderRsCalendar();
    });
    calContainer.querySelector('.rs-cal-next').addEventListener('click', () => {
      rsCalMonth += 1;
      if (rsCalMonth > 11) { rsCalMonth = 0; rsCalYear += 1; }
      renderRsCalendar();
    });
    calContainer.querySelectorAll('.cal-cell:not(.disabled):not(.empty)').forEach((cell) => {
      cell.addEventListener('click', () => {
        rsSelectedDate = cell.dataset.date;
        renderRsCalendar();
        renderRsSlots();
      });
    });
  }

  async function renderRsSlots() {
    const date = rsSelectedDate;
    rsSelectedSlot = null;
    confirmBtn.disabled = true;
    if (!barber || !date) return;
    const dayName = DAYS[new Date(date + 'T00:00:00').getDay()];
    const avail = barber.availability[dayName];
    if (!avail || avail.off) {
      slotGrid.innerHTML = `<p style="color:var(--paper-dim)">${escapeHtml(barber.name)} is off that day. Pick another date.</p>`;
      return;
    }
    slotGrid.innerHTML = `<p style="color:var(--paper-dim)">Loading open times…</p>`;
    const taken = await fetch(`/api/barbers/${barber.id}/appointments?date=${date}`).then((r) => r.json());
    const slots = generateSlots(avail.start, avail.end, 30);
    slotGrid.innerHTML = slots.map((s) => {
      const isTaken = !slotIsAvailable(s, duration, avail.end, taken);
      return `<div class="slot ${isTaken ? 'taken' : ''}" data-time="${s}">${to12h(s)}</div>`;
    }).join('') || `<p style="color:var(--paper-dim)">No slots open that day.</p>`;
    slotGrid.querySelectorAll('.slot:not(.taken)').forEach((el) => {
      el.addEventListener('click', () => {
        slotGrid.querySelectorAll('.slot').forEach((s) => s.classList.remove('selected'));
        el.classList.add('selected');
        rsSelectedSlot = el.dataset.time;
        confirmBtn.disabled = false;
      });
    });
  }

  renderRsCalendar();

  confirmBtn.addEventListener('click', async () => {
    const banner = panel.querySelector('.rs-banner');
    if (!rsSelectedSlot) return;
    confirmBtn.disabled = true; confirmBtn.textContent = 'Saving…';
    try {
      const res = await fetch(`/api/customer/appointments/${apptId}/reschedule`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appt_date: rsSelectedDate, appt_time: rsSelectedSlot })
      });
      const data = await res.json();
      if (!res.ok) {
        if (handleExpiredGate(data)) return;
        banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`;
        confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm new time';
        return;
      }
      loadMyAppointments();
    } catch {
      banner.innerHTML = `<div class="banner error">Something went wrong. Try again.</div>`;
      confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm new time';
    }
  });
}

checkSession();
