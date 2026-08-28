const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

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
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
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
const BOOKING_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// 15-minute increments, 24hr value stored/sent, 12hr label shown.
function timeOptions() {
  const opts = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const period = h < 12 ? 'AM' : 'PM';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      opts.push({ value, label: `${h12}:${String(m).padStart(2, '0')} ${period}` });
    }
  }
  return opts;
}
const TIME_OPTIONS = timeOptions();
const DURATION_OPTIONS = [15, 30, 45, 60, 75, 90, 120];

let currentBarber = null;

// ---------- auth ----------
document.getElementById('login-btn').addEventListener('click', async () => {
  const phone = document.getElementById('login-phone').value.trim();
  const password = document.getElementById('login-password').value;
  const banner = document.getElementById('login-banner');
  if (!phone || !password) { banner.innerHTML = `<div class="banner error">Enter your phone and password.</div>`; return; }

  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/barber/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, password })
    });
    const data = await res.json();
    if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
    await checkSession();
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
});

document.getElementById('logout-link').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/barber/logout', { method: 'POST' });
  location.reload();
});

// Twilio isn't configured in this dev/test environment, so request-otp returns the
// code directly instead of only texting it. Surface that for testers, never in prod
// (server only includes devCode when SMS sending was actually skipped).
// Mirrors the server-side rule in server.js (validatePasswordStrength) so the user
// gets instant feedback instead of a round trip for something checkable locally.
function passwordStrengthError(password) {
  if (!password || password.length < 10) return 'Password must be at least 10 characters.';
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(password)) {
    return 'Password must include at least one special character (e.g. ! @ # $ % &).';
  }
  return null;
}

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

// ---------- forgot password ----------
document.getElementById('barber-forgot-password-link').addEventListener('click', () => {
  document.getElementById('login-password-step').style.display = 'none';
  document.getElementById('barber-forgot-request-step').style.display = 'block';
});
document.getElementById('barber-forgot-cancel-btn').addEventListener('click', () => {
  document.getElementById('barber-forgot-request-step').style.display = 'none';
  document.getElementById('barber-forgot-reset-step').style.display = 'none';
  document.getElementById('login-password-step').style.display = 'block';
});
document.getElementById('barber-forgot-send-code-btn').addEventListener('click', async () => {
  const phone = document.getElementById('barber-forgot-phone').value.trim();
  const banner = document.getElementById('login-banner');
  if (!phone) { banner.innerHTML = `<div class="banner error">Enter your mobile number.</div>`; return; }
  const btn = document.getElementById('barber-forgot-send-code-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/customer/request-otp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not send code.');
    document.getElementById('barber-forgot-request-step').style.display = 'none';
    document.getElementById('barber-forgot-reset-step').style.display = 'block';
    banner.innerHTML = '';
    showDevCodeIfPresent(data);
  } catch (err) {
    banner.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Send reset code';
  }
});
document.getElementById('barber-forgot-reset-btn').addEventListener('click', async () => {
  const phone = document.getElementById('barber-forgot-phone').value.trim();
  const code = document.getElementById('barber-forgot-code').value.trim();
  const newPassword = document.getElementById('barber-forgot-new-password').value;
  const banner = document.getElementById('login-banner');
  const strengthError = passwordStrengthError(newPassword);
  if (strengthError) { banner.innerHTML = `<div class="banner error">${escapeHtml(strengthError)}</div>`; return; }
  const btn = document.getElementById('barber-forgot-reset-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/barber/forgot-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code, newPassword })
    });
    const data = await res.json();
    if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
    await checkSession();
  } finally {
    btn.disabled = false; btn.textContent = 'Set new password & sign in';
  }
});

async function checkSession() {
  const data = await fetch('/api/barber/session').then((r) => r.json());
  if (data.loggedIn) {
    currentBarber = data.barber;
    showPortal();
  } else {
    document.getElementById('login-shell').style.display = 'grid';
  }
}

function showPortal() {
  document.getElementById('login-shell').style.display = 'none';
  document.getElementById('portal-shell').style.display = 'block';
  document.getElementById('logout-link').style.display = 'inline';
  document.getElementById('welcome-heading').textContent = `Welcome back, ${firstName(currentBarber.name)}`;

  document.getElementById('email-input').value = currentBarber.email || '';
  document.getElementById('specialty-input').value = currentBarber.specialty || '';
  document.getElementById('bio-input').value = currentBarber.bio || '';
  document.getElementById('instagram-input').value = currentBarber.instagram || '';
  document.getElementById('twitter-input').value = currentBarber.twitter || '';
  document.getElementById('photo-preview').style.backgroundImage = currentBarber.photo ? `url('${currentBarber.photo}')` : '';

  renderAvailEditor(currentBarber.availability || {});
  renderServicesEditor(currentBarber.services || []);
  renderQrPreview();
  renderGallery();
  loadPortalAppointments();
  renderPbServiceOptions();
  renderPbCalendar();
  loadPortalWalkins();
  loadPortalCustomers();

  // Some browsers restore previously-typed values into these on reload/back-nav
  // even with autocomplete off — force them blank on every fresh login.
  document.getElementById('pb-existing-customer').value = '';
  document.getElementById('pb-customer-name').value = '';
  document.getElementById('pb-customer-phone').value = '';
  document.getElementById('pb-customer-email').value = '';
}

function firstName(name) { return (name || '').split(' ')[0] || 'there'; }

// ---------- availability editor ----------
function renderAvailEditor(avail) {
  const el = document.getElementById('avail-editor');
  el.innerHTML = DAYS.map((d) => {
    const day = avail[d] || { off: true, start: '09:00', end: '18:00' };
    const startOpts = TIME_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === (day.start || '09:00') ? 'selected' : ''}>${o.label}</option>`).join('');
    const endOpts = TIME_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === (day.end || '18:00') ? 'selected' : ''}>${o.label}</option>`).join('');
    return `
      <div class="avail-row" data-day="${d}">
        <label><input type="checkbox" class="avail-on" ${!day.off ? 'checked' : ''}> ${d}</label>
        <span></span>
        <select class="avail-start" ${day.off ? 'disabled' : ''}>${startOpts}</select>
        <select class="avail-end" ${day.off ? 'disabled' : ''}>${endOpts}</select>
      </div>`;
  }).join('');

  el.querySelectorAll('.avail-on').forEach((cb) => {
    cb.addEventListener('change', () => {
      const row = cb.closest('.avail-row');
      row.querySelector('.avail-start').disabled = !cb.checked;
      row.querySelector('.avail-end').disabled = !cb.checked;
    });
  });
}
function readAvailEditor() {
  const avail = {};
  document.querySelectorAll('#avail-editor .avail-row').forEach((row) => {
    const day = row.dataset.day;
    const on = row.querySelector('.avail-on').checked;
    avail[day] = { off: !on, start: row.querySelector('.avail-start').value, end: row.querySelector('.avail-end').value };
  });
  return avail;
}

// ---------- services editor ----------
function addServiceRow(service) {
  const el = document.getElementById('services-editor');
  const row = document.createElement('div');
  row.className = 'service-row';
  const duration = service?.duration_minutes || 30;
  row.innerHTML = `
    <input type="text" class="service-name" placeholder="e.g. Skin Fade" value="${escapeHtml(service?.name || '')}">
    <div class="service-price-wrap">
      <input type="number" class="service-price" min="0" step="1" placeholder="35" value="${service?.price ?? ''}">
    </div>
    <select class="service-duration" title="How long this service takes">
      ${DURATION_OPTIONS.map((m) => `<option value="${m}" ${m === duration ? 'selected' : ''}>${m} min</option>`).join('')}
    </select>
    <button type="button" class="remove-service" title="Remove service">✕</button>
  `;
  row.querySelector('.remove-service').addEventListener('click', () => row.remove());
  el.appendChild(row);
}
function renderServicesEditor(services) {
  const el = document.getElementById('services-editor');
  el.innerHTML = '';
  (services && services.length ? services : []).forEach((s) => addServiceRow(s));
}
function readServicesEditor() {
  const rows = document.querySelectorAll('#services-editor .service-row');
  const services = [];
  rows.forEach((row) => {
    const name = row.querySelector('.service-name').value.trim();
    const price = parseFloat(row.querySelector('.service-price').value);
    const duration_minutes = parseInt(row.querySelector('.service-duration').value, 10) || 30;
    if (name && !Number.isNaN(price)) services.push({ name, price, duration_minutes });
  });
  return services;
}
document.getElementById('add-service-row').addEventListener('click', () => addServiceRow());

// ---------- save profile ----------
document.getElementById('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const banner = document.getElementById('save-banner');
  const fd = new FormData();
  fd.append('email', document.getElementById('email-input').value.trim());
  fd.append('specialty', document.getElementById('specialty-input').value.trim());
  fd.append('bio', document.getElementById('bio-input').value.trim());
  fd.append('instagram', document.getElementById('instagram-input').value.trim());
  fd.append('twitter', document.getElementById('twitter-input').value.trim());
  fd.append('availability', JSON.stringify(readAvailEditor()));
  fd.append('services', JSON.stringify(readServicesEditor()));
  const photoFile = document.getElementById('photo-input').files[0];
  if (photoFile) fd.append('photo', photoFile);

  const res = await fetch('/api/barber/me', { method: 'PUT', body: fd });
  const data = await res.json();
  if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error || 'Could not save.')}</div>`; return; }
  currentBarber = data;
  banner.innerHTML = `<div class="banner success">Saved.</div>`;
  document.getElementById('photo-preview').style.backgroundImage = currentBarber.photo ? `url('${currentBarber.photo}')` : '';
  document.getElementById('photo-input').value = '';
});

// ---------- payment QR ----------
function renderQrPreview() {
  const wrap = document.getElementById('qr-preview-wrap');
  wrap.innerHTML = currentBarber.payment_qr
    ? `<img src="${currentBarber.payment_qr}" alt="Payment QR code" style="width:160px;height:160px;object-fit:contain;border:1px solid var(--line);border-radius:var(--radius);background:#fff;padding:8px;">`
    : `<p style="color:var(--paper-dim);">No QR code uploaded yet.</p>`;
}
document.getElementById('qr-upload-btn').addEventListener('click', async () => {
  const banner = document.getElementById('qr-banner');
  const file = document.getElementById('qr-input').files[0];
  if (!file) { banner.innerHTML = `<div class="banner error">Choose an image first.</div>`; return; }
  const fd = new FormData();
  fd.append('qr', file);
  const btn = document.getElementById('qr-upload-btn');
  btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    const res = await fetch('/api/barber/me/qr', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error || 'Could not upload.')}</div>`; return; }
    currentBarber.payment_qr = data.payment_qr;
    renderQrPreview();
    document.getElementById('qr-input').value = '';
    banner.innerHTML = `<div class="banner success">QR code updated.</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Upload QR code';
  }
});

// ---------- gallery ----------
function renderGallery() {
  const grid = document.getElementById('gallery-grid');
  const photos = currentBarber.gallery || [];
  grid.innerHTML = photos.map((p) => `
    <div class="gallery-item" style="background-image:url('${p.photo}')" data-id="${p.id}">
      <button type="button" class="gallery-remove" title="Remove photo" data-id="${p.id}">✕</button>
      ${p.caption ? `<div class="gallery-caption">${escapeHtml(p.caption)}</div>` : ''}
    </div>
  `).join('') || '<p style="color:var(--paper-dim);grid-column:1/-1;">No photos yet.</p>';

  grid.querySelectorAll('.gallery-remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this photo?')) return;
      await fetch(`/api/barber/me/gallery/${btn.dataset.id}`, { method: 'DELETE' });
      currentBarber.gallery = (currentBarber.gallery || []).filter((p) => p.id !== Number(btn.dataset.id));
      renderGallery();
    });
  });
}
document.getElementById('gallery-upload-btn').addEventListener('click', async () => {
  const banner = document.getElementById('gallery-banner');
  const fileInput = document.getElementById('gallery-photo-input');
  const files = fileInput.files;
  if (!files.length) { banner.innerHTML = `<div class="banner error">Choose at least one photo first.</div>`; return; }

  const fd = new FormData();
  Array.from(files).forEach((file) => fd.append('photos', file));
  fd.append('caption', document.getElementById('gallery-caption-input').value.trim());

  const btn = document.getElementById('gallery-upload-btn');
  btn.disabled = true; btn.textContent = files.length > 1 ? `Uploading ${files.length} photos…` : 'Uploading…';
  try {
    const res = await fetch('/api/barber/me/gallery', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error || 'Could not upload photo(s).')}</div>`; return; }
    currentBarber.gallery = [...data, ...(currentBarber.gallery || [])];
    renderGallery();
    fileInput.value = '';
    document.getElementById('gallery-caption-input').value = '';
    banner.innerHTML = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Add to gallery';
  }
});

// ================= WALK-IN OFFERS =================
// Alternative to replying "2" by text — accept a waiting walk-in right from the
// portal. Polls periodically since a walk-in can arrive at any moment.
async function loadPortalWalkins() {
  const rows = await fetch('/api/barber/me/walkins').then((r) => r.json());
  const section = document.getElementById('portal-walkin-section');
  const list = document.getElementById('portal-walkin-list');
  if (!rows.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  list.innerHTML = rows.map((w) => `
    <div class="card" style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
      <div>
        <strong>${escapeHtml(w.customer_name)}</strong> · ${escapeHtml(w.customer_phone)}
        ${w.note ? `<div style="color:var(--paper-dim);font-size:0.9rem;">${escapeHtml(w.note)}</div>` : ''}
      </div>
      <button class="btn btn-primary btn-sm portal-accept-walkin" data-id="${w.id}">Accept</button>
    </div>
  `).join('');

  list.querySelectorAll('.portal-accept-walkin').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Accepting…';
      try {
        const res = await fetch(`/api/barber/me/walkins/${btn.dataset.id}/accept`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) { alert(data.error || 'Could not accept.'); return; }
        loadPortalWalkins();
      } finally {
        btn.disabled = false; btn.textContent = 'Accept';
      }
    });
  });
}
// Keep this fresh without a manual refresh — same polling cadence as Management's
// front-desk walk-in queue view.
setInterval(() => {
  if (document.getElementById('portal-shell').style.display !== 'none') loadPortalWalkins();
}, 15000);

// ================= YOUR SCHEDULE =================
// Shown one calendar week (Sun–Sat) at a time so a busy barber's full history
// doesn't flood the page. "Show next week" widens the window by 7 more days
// without re-fetching — all appointments are already loaded client-side.
let portalAppointmentsAll = [];
let portalWeeksShown = 1;

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Sunday that starts the current calendar week.
function portalWeekStart() {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
}
// Saturday that ends the window currently shown (widens by 7 days per "show more" click).
function portalWeekEnd(weeksShown) {
  const start = portalWeekStart();
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6 + (weeksShown - 1) * 7);
}

async function loadPortalAppointments() {
  portalAppointmentsAll = await fetch('/api/barber/me/appointments').then((r) => r.json());
  renderPendingRequestsBanner();
  renderPortalAppointments();
}

// Shared by both the always-visible "Pending requests" banner and the regular
// schedule list below it, so approving/declining works identically from either.
async function approveAppointment(id) {
  await fetch(`/api/barber/me/appointments/${id}/status`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'confirmed' })
  });
  loadPortalAppointments();
}
async function declineAppointment(id) {
  if (!confirm('Decline this appointment request?')) return;
  await fetch(`/api/barber/me/appointments/${id}/status`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' })
  });
  loadPortalAppointments();
}

// Surfaces every pending request up top, regardless of which week the main
// schedule list below is currently showing — a request 3 weeks out shouldn't be
// invisible just because "Show next week" hasn't been clicked enough times.
function renderPendingRequestsBanner() {
  const section = document.getElementById('portal-pending-section');
  const list = document.getElementById('portal-pending-list');
  const pending = portalAppointmentsAll.filter((a) => a.status === 'pending');

  if (!pending.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  list.innerHTML = pending.map((a) => `
    <div class="card" data-id="${a.id}" style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
      <div>
        <strong>${a.appt_date} · ${to12h(a.appt_time)}</strong>
        <div style="color:var(--paper-dim);font-size:0.9rem;">${escapeHtml(a.customer_name)} · ${escapeHtml(a.customer_phone)}${a.service ? ' · ' + escapeHtml(a.service) : ''}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm pending-banner-approve" data-id="${a.id}">Approve</button>
        <button class="btn btn-danger btn-sm pending-banner-decline" data-id="${a.id}">Decline</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.pending-banner-approve').forEach((btn) => btn.addEventListener('click', () => approveAppointment(btn.dataset.id)));
  list.querySelectorAll('.pending-banner-decline').forEach((btn) => btn.addEventListener('click', () => declineAppointment(btn.dataset.id)));
}

function renderPortalAppointments() {
  const startStr = dateStr(portalWeekStart());
  const endStr = dateStr(portalWeekEnd(portalWeeksShown));
  const rows = portalAppointmentsAll.filter((a) => a.appt_date >= startStr && a.appt_date <= endStr);

  const rangeLabel = document.getElementById('portal-appointments-range');
  const rangeOpts = { month: 'short', day: 'numeric' };
  rangeLabel.textContent = `Showing ${new Date(startStr + 'T00:00:00').toLocaleDateString('en-US', rangeOpts)} – ${new Date(endStr + 'T00:00:00').toLocaleDateString('en-US', rangeOpts)}`;

  const moreBtn = document.getElementById('portal-show-next-week-btn');
  let totalWeeksAvailable = 1;
  if (portalAppointmentsAll.length) {
    const latestDate = new Date(portalAppointmentsAll[portalAppointmentsAll.length - 1].appt_date + 'T00:00:00');
    const daysDiff = Math.round((latestDate - portalWeekStart()) / 86400000);
    totalWeeksAvailable = daysDiff < 0 ? 1 : Math.floor(daysDiff / 7) + 1;
  }
  moreBtn.style.display = portalWeeksShown < totalWeeksAvailable ? 'inline-block' : 'none';

  const list = document.getElementById('portal-appointments-list');
  if (!rows.length) {
    list.innerHTML = '<p>No appointments this week.</p>';
    return;
  }
  list.innerHTML = rows.map((a) => `
    <div class="card appt-card" data-id="${a.id}" data-duration="${a.duration_minutes || 30}" style="margin-bottom:12px;${a.status === 'pending' ? 'border-color:var(--brass);' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div>
          <div style="font-family:var(--display);font-size:1.3rem;">${a.appt_date} · ${to12h(a.appt_time)}</div>
          <div style="color:var(--paper-dim);font-size:0.9rem;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span>${escapeHtml(a.customer_name)} · ${escapeHtml(a.customer_phone)}${a.service ? ' · ' + escapeHtml(a.service) : ''}</span>
            <button type="button" class="portal-toggle-preferred" data-customer-id="${a.customer_id}" data-preferred="${a.preferred ? '1' : '0'}" title="${a.preferred ? 'Preferred customer — click to remove' : 'Mark as a preferred customer (auto-confirms future bookings)'}" style="background:none;border:none;cursor:pointer;padding:0;font-size:1rem;color:${a.preferred ? 'var(--brass)' : 'var(--paper-dim)'};">${a.preferred ? '⭐' : '☆'}</button>
          </div>
          <span class="pill ${a.status}">${a.status === 'pending' ? '⏳ awaiting your approval' : a.status}</span>
        </div>
        ${a.status === 'pending' ? `
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm portal-approve-appt" data-id="${a.id}">Approve</button>
            <button class="btn btn-danger btn-sm portal-decline-appt" data-id="${a.id}">Decline</button>
          </div>` : ''}
        ${a.status === 'confirmed' ? `
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-outline btn-sm portal-reschedule-appt" data-id="${a.id}">Change</button>
            <button class="btn btn-outline btn-sm portal-complete-appt" data-id="${a.id}">Mark done</button>
            <button class="btn btn-danger btn-sm portal-cancel-appt" data-id="${a.id}">Cancel</button>
          </div>` : ''}
      </div>
      <div class="reschedule-panel" id="portal-reschedule-panel-${a.id}" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--line);"></div>
    </div>
  `).join('');

  list.querySelectorAll('.portal-toggle-preferred').forEach((btn) => btn.addEventListener('click', async () => {
    const isPreferred = btn.dataset.preferred === '1';
    await fetch(`/api/barber/me/customers/${btn.dataset.customerId}/preferred`, {
      method: isPreferred ? 'DELETE' : 'POST'
    });
    loadPortalAppointments();
    loadPortalCustomers();
  }));

  list.querySelectorAll('.portal-approve-appt').forEach((btn) => btn.addEventListener('click', () => approveAppointment(btn.dataset.id)));
  list.querySelectorAll('.portal-decline-appt').forEach((btn) => btn.addEventListener('click', () => declineAppointment(btn.dataset.id)));

  list.querySelectorAll('.portal-cancel-appt').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Cancel this appointment?')) return;
    await fetch(`/api/barber/me/appointments/${btn.dataset.id}/status`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'cancelled' })
    });
    loadPortalAppointments();
  }));

  list.querySelectorAll('.portal-complete-appt').forEach((btn) => btn.addEventListener('click', async () => {
    await fetch(`/api/barber/me/appointments/${btn.dataset.id}/status`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' })
    });
    loadPortalAppointments();
  }));

  list.querySelectorAll('.portal-reschedule-appt').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.dataset.id;
    const panel = document.getElementById(`portal-reschedule-panel-${id}`);
    const isOpen = panel.style.display === 'block';
    document.querySelectorAll('.reschedule-panel').forEach((p) => (p.style.display = 'none'));
    if (!isOpen) openPortalReschedulePanel(id);
  }));
}
document.getElementById('portal-show-next-week-btn').addEventListener('click', () => {
  portalWeeksShown += 1;
  renderPortalAppointments();
});

// Inline "change appointment" UI, scoped to the logged-in barber's own schedule.
function openPortalReschedulePanel(apptId) {
  const card = document.querySelector(`.appt-card[data-id="${apptId}"]`);
  const duration = Number(card.dataset.duration) || 30;
  const panel = document.getElementById(`portal-reschedule-panel-${apptId}`);

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
      const dayName = BOOKING_DAYS[dateObj.getDay()];
      const avail = currentBarber.availability[dayName];
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
    if (!date) return;
    const dayName = BOOKING_DAYS[new Date(date + 'T00:00:00').getDay()];
    const avail = currentBarber.availability[dayName];
    if (!avail || avail.off) {
      slotGrid.innerHTML = `<p style="color:var(--paper-dim)">You're off that day. Pick another date.</p>`;
      return;
    }
    slotGrid.innerHTML = `<p style="color:var(--paper-dim)">Loading open times…</p>`;
    const taken = await fetch(`/api/barbers/${currentBarber.id}/appointments?date=${date}`).then((r) => r.json());
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
      const res = await fetch(`/api/barber/me/appointments/${apptId}/reschedule`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appt_date: rsSelectedDate, appt_time: rsSelectedSlot })
      });
      const data = await res.json();
      if (!res.ok) {
        banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`;
        confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm new time';
        return;
      }
      loadPortalAppointments();
    } catch {
      banner.innerHTML = `<div class="banner error">Something went wrong. Try again.</div>`;
      confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm new time';
    }
  });
}

// ================= BOOK A CUSTOMER =================
let pbSelectedDate = null;
let pbSelectedSlot = null;
let pbCalYear, pbCalMonth;
let portalCustomers = [];

// Customers this barber has booked before — lets them pick one instead of retyping
// contact info. Only ever this barber's own history (see /api/barber/me/customers).
async function loadPortalCustomers() {
  portalCustomers = await fetch('/api/barber/me/customers').then((r) => r.json());
  populateSelectFromCustomers('pb-existing-customer');
  populateSelectFromCustomers('recur-existing-customer');
}
function populateSelectFromCustomers(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = `<option value="">— New customer —</option>` + portalCustomers.map((c) =>
    `<option value="${c.id}">${c.preferred ? '⭐ ' : ''}${escapeHtml(c.name)} — ${escapeHtml(c.phone)}</option>`
  ).join('');
}

// ================= MANAGE CUSTOMERS MODAL =================
async function openCustomersModal() {
  await loadPortalCustomers();
  renderCustomersModalList();
  document.getElementById('customers-modal-overlay').style.display = 'flex';
}
function closeCustomersModal() {
  document.getElementById('customers-modal-overlay').style.display = 'none';
}
document.getElementById('open-customers-modal-btn').addEventListener('click', openCustomersModal);
document.getElementById('close-customers-modal-btn').addEventListener('click', closeCustomersModal);
document.getElementById('customers-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'customers-modal-overlay') closeCustomersModal();
});

function renderCustomersModalList() {
  const el = document.getElementById('customers-modal-list');
  if (!portalCustomers.length) {
    el.innerHTML = '<p>No customers yet — they\'ll show up here after their first booking with you.</p>';
    return;
  }
  el.innerHTML = portalCustomers.map((c) => `
    <div class="card" style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
      <div>
        <strong>${escapeHtml(c.name)}</strong> · ${escapeHtml(c.phone)}
        ${c.email ? `<div style="color:var(--paper-dim);font-size:0.85rem;">${escapeHtml(c.email)}</div>` : ''}
      </div>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;white-space:nowrap;">
        <input type="checkbox" class="customers-modal-preferred-checkbox" data-customer-id="${c.id}" ${c.preferred ? 'checked' : ''}>
        <span>${c.preferred ? '⭐ Preferred' : 'Mark as preferred'}</span>
      </label>
    </div>
  `).join('');

  el.querySelectorAll('.customers-modal-preferred-checkbox').forEach((checkbox) => checkbox.addEventListener('change', async () => {
    checkbox.disabled = true;
    await fetch(`/api/barber/me/customers/${checkbox.dataset.customerId}/preferred`, { method: checkbox.checked ? 'POST' : 'DELETE' });
    await loadPortalCustomers();
    renderCustomersModalList();
    loadPortalAppointments();
  }));
}
document.getElementById('pb-existing-customer').addEventListener('change', (e) => {
  const customer = portalCustomers.find((c) => c.id === Number(e.target.value));
  document.getElementById('pb-customer-name').value = customer ? customer.name : '';
  document.getElementById('pb-customer-phone').value = customer ? customer.phone : '';
  document.getElementById('pb-customer-email').value = customer ? (customer.email || '') : '';
});

function renderPbServiceOptions() {
  const select = document.getElementById('pb-service');
  const services = (currentBarber.services && currentBarber.services.length)
    ? currentBarber.services
    : [{ name: 'Haircut', price: null, duration_minutes: 30 }];
  select.innerHTML = services.map((s) => {
    const duration = s.duration_minutes || 30;
    const label = s.price != null ? `${s.name} — $${s.price} · ${duration} min` : `${s.name} · ${duration} min`;
    return `<option value="${escapeHtml(s.name)}" data-price="${s.price ?? ''}" data-duration="${duration}">${escapeHtml(label)}</option>`;
  }).join('');
}
document.getElementById('pb-service').addEventListener('change', renderPbSlots);

function renderPbCalendar() {
  const container = document.getElementById('pb-calendar');
  const today = new Date();
  if (pbCalYear === undefined) { pbCalYear = today.getFullYear(); pbCalMonth = today.getMonth(); }

  const first = new Date(pbCalYear, pbCalMonth, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(pbCalYear, pbCalMonth + 1, 0).getDate();
  const monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const isCurrentMonth = pbCalYear === todayMidnight.getFullYear() && pbCalMonth === todayMidnight.getMonth();

  let cells = '';
  for (let i = 0; i < startWeekday; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(pbCalYear, pbCalMonth, d);
    const dateStr = `${pbCalYear}-${String(pbCalMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayName = BOOKING_DAYS[dateObj.getDay()];
    const avail = currentBarber.availability[dayName];
    const isOff = !avail || avail.off;
    const isPast = dateObj < todayMidnight;
    const disabled = isPast || isOff;
    const isSelected = dateStr === pbSelectedDate;
    const isToday = dateObj.getTime() === todayMidnight.getTime();
    cells += `<div class="cal-cell ${disabled ? 'disabled' : ''} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}" data-date="${dateStr}" title="${isOff && !isPast ? "You're off this day" : ''}">${d}</div>`;
  }

  container.innerHTML = `
    <div class="cal-header">
      <button type="button" class="cal-nav" id="pb-cal-prev" ${isCurrentMonth ? 'disabled' : ''}>‹</button>
      <span class="cal-month-label">${monthLabel}</span>
      <button type="button" class="cal-nav" id="pb-cal-next">›</button>
    </div>
    <div class="cal-weekdays">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
  `;

  document.getElementById('pb-cal-prev').addEventListener('click', () => {
    pbCalMonth -= 1;
    if (pbCalMonth < 0) { pbCalMonth = 11; pbCalYear -= 1; }
    renderPbCalendar();
  });
  document.getElementById('pb-cal-next').addEventListener('click', () => {
    pbCalMonth += 1;
    if (pbCalMonth > 11) { pbCalMonth = 0; pbCalYear += 1; }
    renderPbCalendar();
  });
  container.querySelectorAll('.cal-cell:not(.disabled):not(.empty)').forEach((cell) => {
    cell.addEventListener('click', () => {
      pbSelectedDate = cell.dataset.date;
      renderPbCalendar();
      renderPbSlots();
    });
  });
}

async function renderPbSlots() {
  const slotGrid = document.getElementById('pb-slot-grid');
  const date = pbSelectedDate;
  if (!date) { slotGrid.innerHTML = '<p style="color:var(--paper-dim)">Pick a date to see open times.</p>'; return; }

  const dayName = BOOKING_DAYS[new Date(date + 'T00:00:00').getDay()];
  const avail = currentBarber.availability[dayName];
  if (!avail || avail.off) {
    slotGrid.innerHTML = `<p style="color:var(--paper-dim)">You're off that day. Pick another date.</p>`;
    return;
  }

  slotGrid.innerHTML = `<p style="color:var(--paper-dim)">Loading open times…</p>`;
  const taken = await fetch(`/api/barbers/${currentBarber.id}/appointments?date=${date}`).then((r) => r.json());
  const duration = selectedServiceDuration(document.getElementById('pb-service'));
  const slots = generateSlots(avail.start, avail.end, 30);
  pbSelectedSlot = null;

  slotGrid.innerHTML = slots.map((s) => {
    const isTaken = !slotIsAvailable(s, duration, avail.end, taken);
    return `<div class="slot ${isTaken ? 'taken' : ''}" data-time="${s}">${to12h(s)}</div>`;
  }).join('') || `<p style="color:var(--paper-dim)">No slots fit that service on this day. Try another date.</p>`;

  slotGrid.querySelectorAll('.slot:not(.taken)').forEach((el) => {
    el.addEventListener('click', () => {
      slotGrid.querySelectorAll('.slot').forEach((s) => s.classList.remove('selected'));
      el.classList.add('selected');
      pbSelectedSlot = el.dataset.time;
    });
  });
}

document.getElementById('pb-confirm-btn').addEventListener('click', async () => {
  const banner = document.getElementById('pb-banner');
  const customer_name = document.getElementById('pb-customer-name').value.trim();
  const customer_phone = document.getElementById('pb-customer-phone').value.trim();
  const customer_email = document.getElementById('pb-customer-email').value.trim();
  if (!customer_name || !customer_phone) {
    banner.innerHTML = `<div class="banner error">Customer name and phone are required.</div>`;
    return;
  }
  if (!pbSelectedDate || !pbSelectedSlot) {
    banner.innerHTML = `<div class="banner error">Pick a date and open time slot first.</div>`;
    return;
  }
  const serviceSelect = document.getElementById('pb-service');
  const opt = serviceSelect.options[serviceSelect.selectedIndex];
  const price = opt ? opt.dataset.price : '';
  const service = price ? `${serviceSelect.value} ($${price})` : (serviceSelect.value || '');
  const duration_minutes = selectedServiceDuration(serviceSelect);

  const btn = document.getElementById('pb-confirm-btn');
  btn.disabled = true; btn.textContent = 'Booking…';
  try {
    const res = await fetch('/api/barber/me/appointments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_name, customer_phone, customer_email, service, appt_date: pbSelectedDate, appt_time: pbSelectedSlot, duration_minutes })
    });
    const data = await res.json();
    if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
    banner.innerHTML = `<div class="banner success">Booked ${escapeHtml(customer_name)} on ${pbSelectedDate} at ${to12h(pbSelectedSlot)}.</div>`;
    document.getElementById('pb-existing-customer').value = '';
    document.getElementById('pb-customer-name').value = '';
    document.getElementById('pb-customer-phone').value = '';
    document.getElementById('pb-customer-email').value = '';
    pbSelectedDate = null; pbSelectedSlot = null;
    renderPbCalendar();
    renderPbSlots();
    loadPortalAppointments();
    loadPortalCustomers();
  } finally {
    btn.disabled = false; btn.textContent = 'Book appointment';
  }
});

// ================= RECURRING APPOINTMENT MODAL =================
const MAX_RECURRENCE_DAYS = 14 * 7;
let recurSelectedDate = null;
let recurSelectedSlot = null;
let recurCalYear, recurCalMonth;

function openRecurringModal() {
  document.getElementById('recur-banner').innerHTML = '';
  document.getElementById('recur-existing-customer').value = '';
  document.getElementById('recur-customer-name').value = '';
  document.getElementById('recur-customer-phone').value = '';
  document.getElementById('recur-customer-email').value = '';
  document.getElementById('recur-end-date').value = '';
  document.getElementById('recur-cadence').value = 'weekly';
  recurSelectedDate = null;
  recurSelectedSlot = null;
  const today = new Date();
  recurCalYear = today.getFullYear();
  recurCalMonth = today.getMonth();
  renderRecurServiceOptions();
  populateSelectFromCustomers('recur-existing-customer');
  renderRecurCalendar();
  renderRecurSlots();
  document.getElementById('recurring-modal-overlay').style.display = 'flex';
}
function closeRecurringModal() {
  document.getElementById('recurring-modal-overlay').style.display = 'none';
}
document.getElementById('open-recurring-modal-btn').addEventListener('click', openRecurringModal);
document.getElementById('close-recurring-modal-btn').addEventListener('click', closeRecurringModal);
document.getElementById('recurring-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'recurring-modal-overlay') closeRecurringModal();
});

document.getElementById('recur-existing-customer').addEventListener('change', (e) => {
  const customer = portalCustomers.find((c) => c.id === Number(e.target.value));
  document.getElementById('recur-customer-name').value = customer ? customer.name : '';
  document.getElementById('recur-customer-phone').value = customer ? customer.phone : '';
  document.getElementById('recur-customer-email').value = customer ? (customer.email || '') : '';
});

function renderRecurServiceOptions() {
  const select = document.getElementById('recur-service');
  const services = (currentBarber.services && currentBarber.services.length)
    ? currentBarber.services
    : [{ name: 'Haircut', price: null, duration_minutes: 30 }];
  select.innerHTML = services.map((s) => {
    const duration = s.duration_minutes || 30;
    const label = s.price != null ? `${s.name} — $${s.price} · ${duration} min` : `${s.name} · ${duration} min`;
    return `<option value="${escapeHtml(s.name)}" data-price="${s.price ?? ''}" data-duration="${duration}">${escapeHtml(label)}</option>`;
  }).join('');
}
document.getElementById('recur-service').addEventListener('change', renderRecurSlots);

function dateStrFromParts(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function renderRecurCalendar() {
  const container = document.getElementById('recur-calendar');
  const first = new Date(recurCalYear, recurCalMonth, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(recurCalYear, recurCalMonth + 1, 0).getDate();
  const monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const isCurrentMonth = recurCalYear === todayMidnight.getFullYear() && recurCalMonth === todayMidnight.getMonth();

  let cells = '';
  for (let i = 0; i < startWeekday; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(recurCalYear, recurCalMonth, d);
    const dateStr = dateStrFromParts(recurCalYear, recurCalMonth, d);
    const dayName = BOOKING_DAYS[dateObj.getDay()];
    const avail = currentBarber.availability[dayName];
    const isOff = !avail || avail.off;
    const isPast = dateObj < todayMidnight;
    const disabled = isPast || isOff;
    const isSelected = dateStr === recurSelectedDate;
    const isToday = dateObj.getTime() === todayMidnight.getTime();
    cells += `<div class="cal-cell ${disabled ? 'disabled' : ''} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}" data-date="${dateStr}" title="${isOff && !isPast ? "You're off this day" : ''}">${d}</div>`;
  }

  container.innerHTML = `
    <div class="cal-header">
      <button type="button" class="cal-nav" id="recur-cal-prev" ${isCurrentMonth ? 'disabled' : ''}>‹</button>
      <span class="cal-month-label">${monthLabel}</span>
      <button type="button" class="cal-nav" id="recur-cal-next">›</button>
    </div>
    <div class="cal-weekdays">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
  `;

  document.getElementById('recur-cal-prev').addEventListener('click', () => {
    recurCalMonth -= 1;
    if (recurCalMonth < 0) { recurCalMonth = 11; recurCalYear -= 1; }
    renderRecurCalendar();
  });
  document.getElementById('recur-cal-next').addEventListener('click', () => {
    recurCalMonth += 1;
    if (recurCalMonth > 11) { recurCalMonth = 0; recurCalYear += 1; }
    renderRecurCalendar();
  });
  container.querySelectorAll('.cal-cell:not(.disabled):not(.empty)').forEach((cell) => {
    cell.addEventListener('click', () => {
      recurSelectedDate = cell.dataset.date;
      renderRecurCalendar();
      renderRecurSlots();
      updateRecurEndDateBounds();
    });
  });
}

// The end-date field is a native <input type="date"> — its own browser calendar
// picker — bounded to [start date, start date + 14 weeks].
function updateRecurEndDateBounds() {
  const endInput = document.getElementById('recur-end-date');
  if (!recurSelectedDate) { endInput.min = ''; endInput.max = ''; return; }
  const [y, m, d] = recurSelectedDate.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const maxEnd = new Date(y, m - 1, d + MAX_RECURRENCE_DAYS);
  endInput.min = recurSelectedDate;
  endInput.max = dateStrFromParts(maxEnd.getFullYear(), maxEnd.getMonth(), maxEnd.getDate());
  if (endInput.value && (endInput.value < endInput.min || endInput.value > endInput.max)) {
    endInput.value = '';
  }
}

async function renderRecurSlots() {
  const slotGrid = document.getElementById('recur-slot-grid');
  const date = recurSelectedDate;
  if (!date) { slotGrid.innerHTML = '<p style="color:var(--paper-dim)">Pick a start date to see open times.</p>'; return; }

  const dayName = BOOKING_DAYS[new Date(date + 'T00:00:00').getDay()];
  const avail = currentBarber.availability[dayName];
  if (!avail || avail.off) {
    slotGrid.innerHTML = `<p style="color:var(--paper-dim)">You're off that day. Pick another start date.</p>`;
    return;
  }

  slotGrid.innerHTML = `<p style="color:var(--paper-dim)">Loading open times…</p>`;
  const taken = await fetch(`/api/barbers/${currentBarber.id}/appointments?date=${date}`).then((r) => r.json());
  const duration = selectedServiceDuration(document.getElementById('recur-service'));
  const slots = generateSlots(avail.start, avail.end, 30);
  recurSelectedSlot = null;

  slotGrid.innerHTML = slots.map((s) => {
    const isTaken = !slotIsAvailable(s, duration, avail.end, taken);
    return `<div class="slot ${isTaken ? 'taken' : ''}" data-time="${s}">${to12h(s)}</div>`;
  }).join('') || `<p style="color:var(--paper-dim)">No slots fit that service on this day. Try another date.</p>`;

  slotGrid.querySelectorAll('.slot:not(.taken)').forEach((el) => {
    el.addEventListener('click', () => {
      slotGrid.querySelectorAll('.slot').forEach((s) => s.classList.remove('selected'));
      el.classList.add('selected');
      recurSelectedSlot = el.dataset.time;
    });
  });
}

document.getElementById('recur-confirm-btn').addEventListener('click', async () => {
  const banner = document.getElementById('recur-banner');
  const customer_name = document.getElementById('recur-customer-name').value.trim();
  const customer_phone = document.getElementById('recur-customer-phone').value.trim();
  const customer_email = document.getElementById('recur-customer-email').value.trim();
  const repeat = document.getElementById('recur-cadence').value;
  const repeat_until = document.getElementById('recur-end-date').value;

  if (!customer_name || !customer_phone) {
    banner.innerHTML = `<div class="banner error">Customer name and phone are required.</div>`;
    return;
  }
  if (!recurSelectedDate || !recurSelectedSlot) {
    banner.innerHTML = `<div class="banner error">Pick a start date and open time slot first.</div>`;
    return;
  }
  if (!repeat_until) {
    banner.innerHTML = `<div class="banner error">Pick an end date for the series.</div>`;
    return;
  }

  const serviceSelect = document.getElementById('recur-service');
  const opt = serviceSelect.options[serviceSelect.selectedIndex];
  const price = opt ? opt.dataset.price : '';
  const service = price ? `${serviceSelect.value} ($${price})` : (serviceSelect.value || '');
  const duration_minutes = selectedServiceDuration(serviceSelect);

  const btn = document.getElementById('recur-confirm-btn');
  btn.disabled = true; btn.textContent = 'Booking…';
  try {
    const res = await fetch('/api/barber/me/appointments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_name, customer_phone, customer_email, service,
        appt_date: recurSelectedDate, appt_time: recurSelectedSlot, duration_minutes,
        repeat, repeat_until
      })
    });
    const data = await res.json();
    if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
    const skippedNote = data.skippedCount
      ? ` ${data.skippedCount} occurrence${data.skippedCount === 1 ? '' : 's'} couldn't be booked due to a scheduling conflict — check the schedule.`
      : '';
    banner.innerHTML = `<div class="banner success">Booked ${data.bookedCount} appointment${data.bookedCount === 1 ? '' : 's'} for ${escapeHtml(customer_name)}, ${recurSelectedDate} through ${repeat_until}.${skippedNote}</div>`;
    loadPortalAppointments();
    loadPortalCustomers();
    setTimeout(closeRecurringModal, 2500);
  } finally {
    btn.disabled = false; btn.textContent = 'Book recurring series';
  }
});

checkSession();
