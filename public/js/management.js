const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// 15-minute increments, 24hr value ("HH:MM") stored/sent, 12hr label shown to staff.
function timeOptions() {
  const opts = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const period = h < 12 ? 'AM' : 'PM';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      const label = `${h12}:${String(m).padStart(2, '0')} ${period}`;
      opts.push({ value, label });
    }
  }
  return opts;
}
const TIME_OPTIONS = timeOptions();

// Lets staff see what they just typed into the login password field.
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

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- auth ----------
async function checkSession() {
  const { isAdmin } = await fetch('/api/session').then((r) => r.json());
  if (isAdmin) showDashboard(); else showLogin();
}

function showLogin() {
  document.getElementById('login-shell').style.display = 'grid';
  document.getElementById('admin-shell').style.display = 'none';
  document.getElementById('logout-link').style.display = 'none';
}

function showDashboard() {
  document.getElementById('login-shell').style.display = 'none';
  document.getElementById('admin-shell').style.display = 'grid';
  document.getElementById('logout-link').style.display = 'inline';
  loadBarbers();
  loadCustomers();
  loadWalkinLog();
  loadWalkinQueue();
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const password = document.getElementById('login-password').value;
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
  });
  if (res.ok) { showDashboard(); }
  else document.getElementById('login-banner').innerHTML = `<div class="banner error">Incorrect password.</div>`;
});
document.getElementById('login-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
});

document.getElementById('logout-link').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
});

// ---------- tabs ----------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => (p.style.display = 'none'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).style.display = 'block';
  });
});

// ================= WALK-IN =================
document.getElementById('walkin-btn').addEventListener('click', async () => {
  const banner = document.getElementById('walkin-banner');
  const note = document.getElementById('walkin-note').value.trim();
  const btn = document.getElementById('walkin-btn');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const res = await fetch('/api/walkin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send');
    const results = data.results || [];
    const allFake = results.length > 0 && results.every((r) => r.skipped || r.error);
    if (allFake) {
      banner.innerHTML = `<div class="banner info">Testing mode — SMS isn't configured, so nothing actually sent. Here's the text ${data.sentTo} barber${data.sentTo === 1 ? '' : 's'} would have gotten:<br><strong>${escapeHtml(data.body)}</strong></div>`;
    } else {
      banner.innerHTML = `<div class="banner success">Text sent to ${data.sentTo} barber${data.sentTo === 1 ? '' : 's'}.</div>`;
    }
    document.getElementById('walkin-note').value = '';
    loadWalkinLog();
  } catch (err) {
    banner.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '🚶 Send walk-in alert to all barbers';
  }
});

async function loadWalkinLog() {
  const rows = await fetch('/api/walkin/log').then((r) => r.json());
  document.querySelector('#walkin-log-table tbody').innerHTML = rows.map((r) => `
    <tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${r.sent_to_count}</td><td>${escapeHtml(r.note || '—')}</td></tr>
  `).join('') || '<tr><td colspan="3">No walk-in alerts sent yet.</td></tr>';
}

// ================= WALK-IN QUEUE (self check-in) =================
async function loadWalkinQueue() {
  const rows = await fetch('/api/admin/walkin/queue').then((r) => r.json());
  document.querySelector('#walkin-queue-table tbody').innerHTML = rows.map((r) => `
    <tr>
      <td>${new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
      <td>${escapeHtml(r.customer_name)}</td>
      <td>${escapeHtml(r.customer_phone)}</td>
      <td>${escapeHtml(r.note || '—')}</td>
      <td>${r.claimed_by_name ? `<span class="pill confirmed">${escapeHtml(r.claimed_by_name)}</span>` : '<span style="color:var(--paper-dim);">Waiting for a claim…</span>'}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-outline btn-sm walkin-resolve-btn" data-id="${r.id}" data-status="completed">Done</button>
        <button class="btn btn-outline btn-sm walkin-resolve-btn" data-id="${r.id}" data-status="cancelled">Remove</button>
      </td>
    </tr>
  `).join('') || '<tr><td colspan="6">No one is waiting right now.</td></tr>';

  document.querySelectorAll('.walkin-resolve-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/admin/walkin/queue/${btn.dataset.id}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: btn.dataset.status })
      });
      loadWalkinQueue();
    });
  });
}

// Keep the front-desk queue view fresh without needing a manual refresh.
setInterval(() => {
  if (document.getElementById('admin-shell').style.display !== 'none') loadWalkinQueue();
}, 15000);

// ================= BARBERS =================
let barbersCache = [];

function defaultAvailability() {
  const a = {};
  DAYS.forEach((d) => { a[d] = { off: d === 'sunday', start: '09:00', end: d === 'friday' ? '19:00' : '18:00' }; });
  return a;
}

function renderAvailEditor(avail) {
  const el = document.getElementById('avail-editor');
  el.innerHTML = DAYS.map((d) => {
    const day = avail[d] || { off: true, start: '09:00', end: '18:00' };
    const startOpts = TIME_OPTIONS.map((o) =>
      `<option value="${o.value}" ${o.value === (day.start || '09:00') ? 'selected' : ''}>${o.label}</option>`
    ).join('');
    const endOpts = TIME_OPTIONS.map((o) =>
      `<option value="${o.value}" ${o.value === (day.end || '18:00') ? 'selected' : ''}>${o.label}</option>`
    ).join('');
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
    avail[day] = {
      off: !on,
      start: row.querySelector('.avail-start').value,
      end: row.querySelector('.avail-end').value
    };
  });
  return avail;
}

// ---------- services & pricing editor ----------
function defaultServices() {
  return [
    { name: 'Haircut', price: 35, duration_minutes: 30 },
    { name: 'Haircut + Beard', price: 50, duration_minutes: 60 },
    { name: 'Beard Trim', price: 20, duration_minutes: 15 }
  ];
}

const DURATION_OPTIONS = [15, 30, 45, 60, 75, 90, 120];

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
  const list = (services && services.length) ? services : [];
  list.forEach((s) => addServiceRow(s));
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

async function loadBarbers() {
  barbersCache = await fetch('/api/barbers?all=1').then((r) => r.json());
  renderAdminBarberGrid();
}

function renderAdminBarberGrid() {
  const grid = document.getElementById('admin-barber-grid');
  if (!barbersCache.length) {
    grid.innerHTML = '<p>No barbers yet. Click "Add barber" to set up your first booth.</p>';
    return;
  }
  grid.innerHTML = barbersCache.map((b) => {
    const acctStatus = b.has_password ? '<span class="pill confirmed">Account active</span>'
      : b.invite_pending ? '<span class="pill" style="background:rgba(200,160,60,0.15);color:#c8a03c;border-color:#c8a03c;">Invite sent</span>'
      : '<span class="pill" style="opacity:0.6;">No account yet</span>';
    return `
    <div class="barber-card" style="${b.active ? '' : 'opacity:.5'}">
      <div class="barber-photo" style="${b.photo ? `background-image:url('${b.photo}')` : ''}">
        ${!b.photo ? `<div class="no-photo">${escapeHtml(b.name.charAt(0))}</div>` : ''}
        <span class="booth-tag">BOOTH ${b.booth_number || '—'}</span>
      </div>
      <div class="barber-body">
        <h3>${escapeHtml(b.name)}</h3>
        <p class="barber-bio">${escapeHtml(b.phone)}${b.active ? '' : ' · inactive'}</p>
        <p style="margin:-6px 0 10px;">${acctStatus}</p>
        <p style="font-size:0.8rem;color:var(--paper-dim);margin:-4px 0 10px;">
          ${(b.services && b.services.length) ? b.services.map((s) => `${escapeHtml(s.name)} $${s.price}`).join(' · ') : 'No services added yet'}
        </p>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn btn-outline edit-barber" data-id="${b.id}" style="flex:1;">Edit</button>
          <button class="btn btn-outline invite-barber" data-id="${b.id}">${b.has_password ? 'Re-invite' : 'Invite'}</button>
          <button class="btn btn-danger delete-barber" data-id="${b.id}">Remove</button>
        </div>
      </div>
    </div>
  `;
  }).join('');

  grid.querySelectorAll('.edit-barber').forEach((btn) => btn.addEventListener('click', () => openBarberForm(Number(btn.dataset.id))));
  grid.querySelectorAll('.delete-barber').forEach((btn) => btn.addEventListener('click', () => deleteBarber(Number(btn.dataset.id))));
  grid.querySelectorAll('.invite-barber').forEach((btn) => btn.addEventListener('click', () => inviteBarber(Number(btn.dataset.id), btn)));
}

async function inviteBarber(id, btn) {
  const barber = barbersCache.find((b) => b.id === id);
  const already = barber && barber.has_password;
  if (already && !confirm(`${barber.name} already has an account. Send them a new invite link anyway? (Their current password keeps working until they use the new link.)`)) return;

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch(`/api/barbers/${id}/invite`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Could not send invite.'); return; }

    if (data.devLink) {
      if (data.sms && data.sms.error) {
        // Twilio IS configured but the send actually failed — don't pretend it worked.
        alert(`The text failed to send (${data.sms.error}). Here's the invite link to share manually:\n\n${data.devLink}`);
      } else {
        // Twilio isn't configured at all — this is the expected local/testing path.
        alert(`Testing mode — SMS isn't configured, so here's the invite link:\n\n${data.devLink}`);
      }
    } else {
      alert(`Invite text sent to ${barber ? barber.name : 'the barber'}.`);
    }
    loadBarbers();
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function openBarberForm(id) {
  const card = document.getElementById('barber-form-card');
  card.style.display = 'block';
  const form = document.getElementById('barber-form');
  form.reset();
  document.getElementById('barber-photo-preview').style.backgroundImage = '';
  document.getElementById('gallery-banner').innerHTML = '';
  document.getElementById('qr-banner').innerHTML = '';

  if (id) {
    const b = barbersCache.find((x) => x.id === id);
    document.getElementById('barber-form-title').textContent = `Edit ${b.name}`;
    document.getElementById('barber-id').value = b.id;
    document.getElementById('barber-first-name').value = b.first_name || (b.name || '').split(' ')[0] || '';
    document.getElementById('barber-last-name').value = b.last_name || (b.name || '').split(' ').slice(1).join(' ');
    document.getElementById('barber-booth').value = b.booth_number || '';
    document.getElementById('barber-phone').value = b.phone;
    document.getElementById('barber-email').value = b.email || '';
    document.getElementById('barber-specialty').value = b.specialty || '';
    document.getElementById('barber-bio').value = b.bio || '';
    document.getElementById('barber-instagram').value = b.instagram || '';
    document.getElementById('barber-twitter').value = b.twitter || '';
    if (b.photo) document.getElementById('barber-photo-preview').style.backgroundImage = `url('${b.photo}')`;
    renderAvailEditor(typeof b.availability === 'string' ? JSON.parse(b.availability) : b.availability);
    renderServicesEditor(typeof b.services === 'string' ? JSON.parse(b.services) : b.services);
    document.getElementById('gallery-section').style.display = 'block';
    document.getElementById('qr-section').style.display = 'block';
    loadGallery(b.id);
    renderQrPreview(b.payment_qr);
  } else {
    document.getElementById('barber-form-title').textContent = 'Add a barber';
    document.getElementById('barber-id').value = '';
    renderAvailEditor(defaultAvailability());
    renderServicesEditor(defaultServices());
    document.getElementById('gallery-section').style.display = 'none';
    document.getElementById('qr-section').style.display = 'none';
  }
  card.scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('new-barber-btn').addEventListener('click', () => openBarberForm(null));
document.getElementById('cancel-barber-form').addEventListener('click', () => {
  document.getElementById('barber-form-card').style.display = 'none';
});

document.getElementById('barber-photo').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('barber-photo-preview').style.backgroundImage = `url('${URL.createObjectURL(file)}')`;
});

document.getElementById('barber-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('barber-id').value;
  const fd = new FormData();
  fd.append('first_name', document.getElementById('barber-first-name').value.trim());
  fd.append('last_name', document.getElementById('barber-last-name').value.trim());
  fd.append('phone', document.getElementById('barber-phone').value);
  fd.append('email', document.getElementById('barber-email').value);
  fd.append('booth_number', document.getElementById('barber-booth').value);
  fd.append('specialty', document.getElementById('barber-specialty').value);
  fd.append('bio', document.getElementById('barber-bio').value);
  fd.append('instagram', document.getElementById('barber-instagram').value.trim());
  fd.append('twitter', document.getElementById('barber-twitter').value.trim());
  fd.append('availability', JSON.stringify(readAvailEditor()));
  fd.append('services', JSON.stringify(readServicesEditor()));
  const photoFile = document.getElementById('barber-photo').files[0];
  if (photoFile) fd.append('photo', photoFile);

  const res = await fetch(id ? `/api/barbers/${id}` : '/api/barbers', {
    method: id ? 'PUT' : 'POST',
    body: fd
  });
  if (res.ok) {
    document.getElementById('barber-form-card').style.display = 'none';
    loadBarbers();
  } else {
    const data = await res.json();
    alert(data.error || 'Could not save barber.');
  }
});

// ---------- payment QR ----------
function renderQrPreview(qrPath) {
  const wrap = document.getElementById('qr-preview-wrap');
  wrap.innerHTML = qrPath
    ? `<img src="${qrPath}" alt="Payment QR code" style="width:140px;height:140px;object-fit:contain;border:1px solid var(--line);border-radius:var(--radius);background:#fff;padding:8px;">`
    : `<p style="color:var(--paper-dim);">No QR code uploaded yet.</p>`;
}

document.getElementById('qr-upload-btn').addEventListener('click', async () => {
  const barberId = document.getElementById('barber-id').value;
  const banner = document.getElementById('qr-banner');
  const fileInput = document.getElementById('qr-input');
  const file = fileInput.files[0];
  if (!barberId) { banner.innerHTML = `<div class="banner error">Save the barber first, then upload a QR code.</div>`; return; }
  if (!file) { banner.innerHTML = `<div class="banner error">Choose an image first.</div>`; return; }

  const fd = new FormData();
  fd.append('qr', file);

  const btn = document.getElementById('qr-upload-btn');
  btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    const res = await fetch(`/api/barbers/${barberId}/qr`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error || 'Could not upload.')}</div>`; return; }
    renderQrPreview(data.payment_qr);
    fileInput.value = '';
    banner.innerHTML = `<div class="banner success">QR code updated.</div>`;
    loadBarbers();
  } finally {
    btn.disabled = false; btn.textContent = 'Upload QR code';
  }
});

// ---------- haircut gallery ----------
async function loadGallery(barberId) {
  const photos = await fetch(`/api/barbers/${barberId}/gallery`).then((r) => r.json());
  const grid = document.getElementById('gallery-grid');
  grid.innerHTML = photos.map((p) => `
    <div class="gallery-item" style="background-image:url('${p.photo}')" data-id="${p.id}">
      <button type="button" class="gallery-remove" title="Remove photo" data-id="${p.id}">✕</button>
      ${p.caption ? `<div class="gallery-caption">${escapeHtml(p.caption)}</div>` : ''}
    </div>
  `).join('') || '<p style="color:var(--paper-dim);grid-column:1/-1;">No photos yet.</p>';

  grid.querySelectorAll('.gallery-remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this photo?')) return;
      await fetch(`/api/gallery/${btn.dataset.id}`, { method: 'DELETE' });
      loadGallery(barberId);
    });
  });
}

document.getElementById('gallery-upload-btn').addEventListener('click', async () => {
  const barberId = document.getElementById('barber-id').value;
  const banner = document.getElementById('gallery-banner');
  const fileInput = document.getElementById('gallery-photo-input');
  const files = fileInput.files;
  if (!barberId) { banner.innerHTML = `<div class="banner error">Save the barber first, then add gallery photos.</div>`; return; }
  if (!files.length) { banner.innerHTML = `<div class="banner error">Choose at least one photo first.</div>`; return; }

  const fd = new FormData();
  Array.from(files).forEach((file) => fd.append('photos', file));
  fd.append('caption', document.getElementById('gallery-caption-input').value.trim());

  const btn = document.getElementById('gallery-upload-btn');
  btn.disabled = true; btn.textContent = files.length > 1 ? `Uploading ${files.length} photos…` : 'Uploading…';
  try {
    const res = await fetch(`/api/barbers/${barberId}/gallery`, { method: 'POST', body: fd });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      banner.innerHTML = `<div class="banner error">${escapeHtml(data.error || 'Could not upload photo(s).')}</div>`;
      return;
    }
    fileInput.value = '';
    document.getElementById('gallery-caption-input').value = '';
    banner.innerHTML = '';
    loadGallery(barberId);
  } finally {
    btn.disabled = false; btn.textContent = 'Add to gallery';
  }
});

async function deleteBarber(id) {
  if (!confirm('Remove this barber? This cannot be undone.')) return;
  await fetch(`/api/barbers/${id}`, { method: 'DELETE' });
  loadBarbers();
}

// ================= CUSTOMERS =================
document.getElementById('new-customer-btn').addEventListener('click', () => {
  document.getElementById('customer-form-card').style.display = 'block';
  document.getElementById('customer-form').reset();
});
document.getElementById('cancel-customer-form').addEventListener('click', () => {
  document.getElementById('customer-form-card').style.display = 'none';
});

document.getElementById('customer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    first_name: document.getElementById('cust-form-first-name').value.trim(),
    last_name: document.getElementById('cust-form-last-name').value.trim(),
    phone: document.getElementById('cust-form-phone').value,
    email: document.getElementById('cust-form-email').value,
    notes: document.getElementById('cust-form-notes').value
  };
  const res = await fetch('/api/customers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (res.ok) {
    document.getElementById('customer-form-card').style.display = 'none';
    loadCustomers();
  } else {
    const data = await res.json();
    alert(data.error || 'Could not save customer.');
  }
});

async function loadCustomers() {
  const rows = await fetch('/api/customers').then((r) => r.json());
  document.querySelector('#customers-table tbody').innerHTML = rows.map((c) => `
    <tr>
      <td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.phone)}</td><td>${escapeHtml(c.email || '—')}</td>
      <td>${c.preferred_barber_name ? escapeHtml(c.preferred_barber_name) : '<span style="color:var(--paper-dim);">None</span>'}</td>
      <td>${escapeHtml(c.notes || '—')}</td>
      <td><button class="btn btn-danger delete-customer" data-id="${c.id}">Remove</button></td>
    </tr>
  `).join('') || '<tr><td colspan="6">No customers yet.</td></tr>';

  document.querySelectorAll('.delete-customer').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Remove this customer?')) return;
    await fetch(`/api/customers/${btn.dataset.id}`, { method: 'DELETE' });
    loadCustomers();
  }));
}


checkSession();
