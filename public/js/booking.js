const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ABBR = { sunday: 'Su', monday: 'Mo', tuesday: 'Tu', wednesday: 'We', thursday: 'Th', friday: 'Fr', saturday: 'Sa' };

// Inline SVGs (no external icon library/CDN — keeps the site dependency-free and working offline)
const ICON_INSTAGRAM = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.7" stroke="currentColor" stroke-width="2"/><circle cx="17.6" cy="6.4" r="1.15" fill="currentColor"/></svg>`;
const ICON_X = `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`;

let barbers = [];
let selectedBarber = null;
let selectedSlot = null;
let selectedDate = null;
let calYear, calMonth; // currently displayed month in the calendar widget
let sessionCustomer = null; // logged-in customer, or null if signed out

async function checkCustomerSession() {
  const data = await fetch('/api/customer/session').then((r) => r.json());
  sessionCustomer = data.loggedIn ? data.customer : null;
  const authStatus = document.getElementById('auth-status');
  if (sessionCustomer) {
    authStatus.innerHTML = `Signed in as ${escapeHtml(firstName(sessionCustomer.name))}<a href="#" id="topbar-signout">Sign out</a>`;
    document.getElementById('topbar-signout').addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/customer/logout', { method: 'POST' });
      location.reload();
    });
  } else {
    authStatus.innerHTML = '';
  }
}

async function loadBarbers() {
  const res = await fetch('/api/barbers');
  barbers = await res.json();
  document.getElementById('stat-barbers').textContent = barbers.length;
  renderBarberGrid();
  renderStyleCarousel();
}

// Real haircut photos from barbers' own galleries, not stock art — each barber's
// `gallery` already comes back with the rest of /api/barbers. Falls back to the
// static illustrated cards already in the HTML if nobody's uploaded any yet.
function renderStyleCarousel() {
  const track = document.getElementById('style-track');
  if (!track) return;

  const photos = barbers.flatMap((b) =>
    (b.gallery || []).map((g) => ({ photo: g.photo, caption: g.caption, barberName: b.name }))
  );
  if (!photos.length) return; // keep the illustrated placeholders

  track.innerHTML = photos.map((p) => `
    <div class="style-card style-card-photo" style="background-image:url('${p.photo}')">
      <div class="style-name">${escapeHtml(p.caption || `By ${firstName(p.barberName)}`)}</div>
    </div>
  `).join('');
}

function renderBarberGrid() {
  const grid = document.getElementById('barber-grid');
  if (!barbers.length) {
    grid.innerHTML = '<p>No barbers are set up yet. Check back soon, or visit the management page to add one.</p>';
    return;
  }
  // Cards show just enough to compare barbers at a glance — full bio, gallery,
  // socials, pricing, and hours live in the profile modal (see openBarberProfile).
  grid.innerHTML = barbers.map((b) => `
    <div class="barber-card" data-id="${b.id}">
      <div class="barber-photo view-profile-trigger" style="${b.photo ? `background-image:url('${b.photo}')` : ''}">
        ${!b.photo ? `<div class="no-photo">${escapeHtml(b.name.charAt(0))}</div>` : ''}
        <span class="booth-tag">BOOTH ${b.booth_number || '—'}</span>
      </div>
      <div class="barber-body">
        <h3 class="view-profile-trigger" style="cursor:pointer;">${escapeHtml(b.name)}</h3>
        ${b.specialty ? `<div class="barber-specialty">${escapeHtml(b.specialty)}</div>` : ''}
        ${b.services && b.services.length ? `
          <p style="font-size:0.8rem;color:var(--brass);font-family:var(--mono);margin:2px 0 4px;">
            From $${Math.min(...b.services.map((s) => s.price))}
          </p>` : ''}
        <div class="barber-days">
          ${DAYS.map((d) => {
            const on = b.availability[d] && !b.availability[d].off;
            return `<span class="day-chip ${on ? 'on' : ''}">${DAY_ABBR[d]}</span>`;
          }).join('')}
        </div>
        <button type="button" class="btn btn-outline btn-block view-profile-trigger" style="margin-bottom:8px;">View full profile</button>
        <button class="btn btn-primary btn-block select-barber">Book with ${escapeHtml(firstName(b.name))}</button>
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.select-barber').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.target.closest('.barber-card').dataset.id;
      selectBarber(Number(id));
    });
  });

  grid.querySelectorAll('.view-profile-trigger').forEach((el) => {
    el.addEventListener('click', (e) => {
      const id = e.target.closest('.barber-card').dataset.id;
      openBarberProfile(Number(id));
    });
  });
}

// ---------- barber profile modal (the "click for more details" view) ----------
function openBarberProfile(id) {
  const b = barbers.find((x) => x.id === id);
  if (!b) return;

  const servicesHtml = (b.services && b.services.length) ? `
    <h4 class="modal-subhead">Services &amp; pricing</h4>
    <ul class="modal-list">
      ${b.services.map((s) => `<li><span>${escapeHtml(s.name)}</span><span class="modal-list-meta">$${s.price} · ${s.duration_minutes || 30} min</span></li>`).join('')}
    </ul>` : '';

  const hoursHtml = `
    <h4 class="modal-subhead">Weekly hours</h4>
    <ul class="modal-list">
      ${DAYS.map((d) => {
        const avail = b.availability[d];
        const label = avail && !avail.off ? `${to12h(avail.start)} – ${to12h(avail.end)}` : 'Unavailable';
        return `<li style="text-transform:capitalize;"><span>${d}</span><span class="modal-list-meta">${label}</span></li>`;
      }).join('')}
    </ul>`;

  const galleryHtml = (b.gallery && b.gallery.length) ? `
    <h4 class="modal-subhead">Haircut gallery</h4>
    <div class="mini-gallery" style="grid-template-columns:repeat(4, 1fr);">
      ${b.gallery.map((g) => `<div class="mini-gallery-item" style="background-image:url('${g.photo}')" title="${escapeHtml(g.caption || '')}"></div>`).join('')}
    </div>` : '';

  const socialsHtml = (b.instagram || b.twitter) ? `
    <div class="social-links" style="margin:10px 0 4px;">
      ${b.instagram ? `<a href="${escapeHtml(socialUrl('instagram', b.instagram))}" target="_blank" rel="noopener">${ICON_INSTAGRAM}<span>Instagram</span></a>` : ''}
      ${b.twitter ? `<a href="${escapeHtml(socialUrl('twitter', b.twitter))}" target="_blank" rel="noopener">${ICON_X}<span>Twitter</span></a>` : ''}
    </div>` : '';

  const qrHtml = b.payment_qr ? `
    <a href="${b.payment_qr}" target="_blank" rel="noopener" class="pay-qr-link" style="margin-top:14px;">
      <img src="${b.payment_qr}" alt="Pay ${escapeHtml(b.name)} via QR code">
      <span>Scan to pay ${escapeHtml(firstName(b.name))}</span>
    </a>` : '';

  document.getElementById('barber-profile-modal-body').innerHTML = `
    <div class="barber-photo" style="${b.photo ? `background-image:url('${b.photo}');` : ''} width:196px;height:238px;margin:2px auto 22px;">
      ${!b.photo ? `<div class="no-photo">${escapeHtml(b.name.charAt(0))}</div>` : ''}
      <span class="booth-tag">BOOTH ${b.booth_number || '—'}</span>
    </div>
    <h2 style="margin:0 0 4px; text-align:center;">${escapeHtml(b.name)}</h2>
    ${b.specialty ? `<div class="barber-specialty">${escapeHtml(b.specialty)}</div>` : ''}
    ${socialsHtml}
    <p class="barber-bio">${escapeHtml(b.bio || 'No bio yet.')}</p>
    ${servicesHtml}
    ${hoursHtml}
    ${galleryHtml}
    ${qrHtml}
    <button class="btn btn-primary btn-block" id="modal-book-btn" style="margin-top:18px;">Book with ${escapeHtml(firstName(b.name))}</button>
  `;
  document.getElementById('modal-book-btn').addEventListener('click', () => {
    closeBarberProfile();
    selectBarber(id);
  });
  document.getElementById('barber-profile-modal-overlay').style.display = 'flex';
}
function closeBarberProfile() {
  document.getElementById('barber-profile-modal-overlay').style.display = 'none';
}
document.getElementById('close-barber-profile-btn').addEventListener('click', closeBarberProfile);
document.getElementById('barber-profile-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'barber-profile-modal-overlay') closeBarberProfile();
});

function firstName(name) { return name.split(' ')[0]; }
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Barbers can enter either a plain @handle or a full profile URL — build a clickable
// link either way.
function socialUrl(platform, value) {
  const v = String(value || '').trim();
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, '');
  return platform === 'instagram' ? `https://instagram.com/${handle}` : `https://twitter.com/${handle}`;
}

function selectBarber(id) {
  selectedBarber = barbers.find((b) => b.id === id);
  selectedSlot = null;
  selectedDate = null;
  document.getElementById('book').style.display = 'block';
  document.getElementById('book-heading').textContent = `Book with ${selectedBarber.name} — Booth ${selectedBarber.booth_number || '—'}`;
  document.getElementById('book-banner').innerHTML = '';
  document.getElementById('book').scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (!sessionCustomer) {
    document.getElementById('book-login-required').style.display = 'block';
    document.getElementById('book-authenticated-panel').style.display = 'none';
    document.getElementById('book-signin-link').href = `/account.html?book=${selectedBarber.id}`;
    document.getElementById('book-signup-link').href = `/account.html?tab=signup&book=${selectedBarber.id}`;
    return;
  }

  document.getElementById('book-login-required').style.display = 'none';
  document.getElementById('book-authenticated-panel').style.display = 'block';
  document.getElementById('booking-as-banner').innerHTML = `
    <span>Booking as <strong>${escapeHtml(sessionCustomer.name)}</strong> (${escapeHtml(sessionCustomer.phone)})</span>
    <a href="/account.html" style="color:var(--brass);white-space:nowrap;">Not you?</a>
  `;

  renderServiceOptions();

  const today = new Date();
  calYear = today.getFullYear();
  calMonth = today.getMonth();
  renderCalendar();
  renderSlotsForDate();
}

// Builds the service dropdown from this barber's own priced services.
// Falls back to generic options if the barber hasn't set any up yet, so booking is never blocked.
function renderServiceOptions() {
  const select = document.getElementById('book-service');
  const services = (selectedBarber.services && selectedBarber.services.length)
    ? selectedBarber.services
    : [{ name: 'Haircut', price: null, duration_minutes: 30 }, { name: 'Haircut + Beard', price: null, duration_minutes: 60 }, { name: 'Beard trim only', price: null, duration_minutes: 15 }, { name: 'Kids cut', price: null, duration_minutes: 30 }, { name: 'Other', price: null, duration_minutes: 30 }];

  select.innerHTML = services.map((s) => {
    const duration = s.duration_minutes || 30;
    const label = s.price != null ? `${s.name} — $${s.price} · ${duration} min` : `${s.name} · ${duration} min`;
    return `<option value="${escapeHtml(s.name)}" data-price="${s.price ?? ''}" data-duration="${duration}">${escapeHtml(label)}</option>`;
  }).join('');
}

document.getElementById('change-barber').addEventListener('click', () => {
  document.getElementById('book').style.display = 'none';
  document.getElementById('barbers').scrollIntoView({ behavior: 'smooth' });
});

document.getElementById('book-service').addEventListener('change', renderSlotsForDate);

// Renders a month grid for the currently selected barber, greying out (and disabling)
// any day they're off as well as past dates, so a customer can only pick a day the
// barber actually works.
function renderCalendar() {
  const container = document.getElementById('book-calendar');
  if (!selectedBarber) { container.innerHTML = ''; return; }

  const first = new Date(calYear, calMonth, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const isCurrentMonth = calYear === todayMidnight.getFullYear() && calMonth === todayMidnight.getMonth();

  let cells = '';
  for (let i = 0; i < startWeekday; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(calYear, calMonth, d);
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayName = DAYS[dateObj.getDay()];
    const avail = selectedBarber.availability[dayName];
    const isOff = !avail || avail.off;
    const isPast = dateObj < todayMidnight;
    const disabled = isPast || isOff;
    const isSelected = dateStr === selectedDate;
    const isToday = dateObj.getTime() === todayMidnight.getTime();
    cells += `<div class="cal-cell ${disabled ? 'disabled' : ''} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}" data-date="${dateStr}" title="${isOff && !isPast ? `${selectedBarber.name} is off this day` : ''}">${d}</div>`;
  }

  container.innerHTML = `
    <div class="cal-header">
      <button type="button" class="cal-nav" id="cal-prev" ${isCurrentMonth ? 'disabled' : ''}>‹</button>
      <span class="cal-month-label">${monthLabel}</span>
      <button type="button" class="cal-nav" id="cal-next">›</button>
    </div>
    <div class="cal-weekdays">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
  `;

  document.getElementById('cal-prev').addEventListener('click', () => {
    calMonth -= 1;
    if (calMonth < 0) { calMonth = 11; calYear -= 1; }
    renderCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    calMonth += 1;
    if (calMonth > 11) { calMonth = 0; calYear += 1; }
    renderCalendar();
  });
  container.querySelectorAll('.cal-cell:not(.disabled):not(.empty)').forEach((cell) => {
    cell.addEventListener('click', () => {
      selectedDate = cell.dataset.date;
      renderCalendar();
      renderSlotsForDate();
    });
  });
}

async function renderSlotsForDate() {
  const slotGrid = document.getElementById('slot-grid');
  if (!selectedBarber || !selectedDate) {
    slotGrid.innerHTML = `<p style="color:var(--paper-dim)">Pick a date on the calendar to see open times.</p>`;
    return;
  }

  const dayName = DAYS[new Date(selectedDate + 'T00:00:00').getDay()];
  const avail = selectedBarber.availability[dayName];

  if (!avail || avail.off) {
    slotGrid.innerHTML = `<p style="color:var(--paper-dim)">${selectedBarber.name} is off that day. Pick another date.</p>`;
    return;
  }

  slotGrid.innerHTML = `<p style="color:var(--paper-dim)">Loading open times…</p>`;
  const booked = await fetch(`/api/barbers/${selectedBarber.id}/appointments?date=${selectedDate}`).then((r) => r.json());
  const duration = selectedServiceDuration(document.getElementById('book-service'));
  const slots = generateSlots(avail.start, avail.end, 30);
  selectedSlot = null;

  slotGrid.innerHTML = slots.map((s) => {
    const taken = !slotIsAvailable(s, duration, avail.end, booked);
    return `<div class="slot ${taken ? 'taken' : ''}" data-time="${s}">${to12h(s)}</div>`;
  }).join('') || `<p style="color:var(--paper-dim)">No slots fit that service on this day. Try another date.</p>`;

  if (slots.every((s) => !slotIsAvailable(s, duration, avail.end, booked))) {
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

// A candidate slot works if the service fits before closing and doesn't overlap
// anything already booked for that barber that day.
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

function to12h(t) {
  let [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${suffix}`;
}

// Builds a standard .ics file for one appointment and triggers a download — works
// with Google Calendar, Apple Calendar, Outlook, and anything else that reads iCal.
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

document.getElementById('confirm-book').addEventListener('click', async () => {
  const banner = document.getElementById('book-banner');
  const serviceSelect = document.getElementById('book-service');
  const selectedOption = serviceSelect.options[serviceSelect.selectedIndex];
  const servicePrice = selectedOption ? selectedOption.dataset.price : '';
  const service = servicePrice ? `${serviceSelect.value} ($${servicePrice})` : serviceSelect.value;
  const duration_minutes = selectedServiceDuration(serviceSelect);
  const date = selectedDate;

  if (!sessionCustomer) {
    banner.innerHTML = `<div class="banner error">Please sign in first.</div>`;
    return;
  }
  if (!selectedBarber || !date || !selectedSlot) {
    banner.innerHTML = `<div class="banner error">Pick a date and an open time slot first.</div>`;
    return;
  }

  const btn = document.getElementById('confirm-book');
  btn.disabled = true;
  btn.textContent = 'Booking…';

  try {
    const res = await fetch('/api/customer/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        barber_id: selectedBarber.id,
        service,
        appt_date: date,
        appt_time: selectedSlot,
        duration_minutes
      })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.needsPasswordChange) {
        banner.innerHTML = `<div class="banner error">Your password has expired. <a href="/account.html" style="color:var(--brass);">Update it via Customer Login</a> to keep booking.</div>`;
        return;
      }
      banner.innerHTML = `<div class="banner error">${escapeHtml(data.error || 'Could not book that slot.')}</div>`;
      renderSlotsForDate();
      return;
    }
    banner.innerHTML = `
      <div class="banner success">
        You're booked with ${escapeHtml(selectedBarber.name)} on ${date} at ${to12h(selectedSlot)}. They've been texted — see you then! Manage this anytime from <a href="/account.html" style="color:inherit;text-decoration:underline;">Customer Login</a>.
        <div style="margin-top:10px;"><button type="button" class="btn btn-outline btn-sm" id="add-to-calendar-btn">📅 Add to calendar</button></div>
      </div>`;
    document.getElementById('add-to-calendar-btn').addEventListener('click', () => {
      downloadAppointmentIcs({
        title: `${service} with ${selectedBarber.name}`,
        description: `Booked at ${selectedBarber.name.split(' ')[0]}'s booth${selectedBarber.booth_number ? ` #${selectedBarber.booth_number}` : ''}.`,
        location: selectedBarber.booth_number ? `Booth ${selectedBarber.booth_number}` : '',
        dateStr: date,
        timeStr: selectedSlot,
        durationMinutes: duration_minutes
      });
    });
    renderSlotsForDate();
  } catch (err) {
    banner.innerHTML = `<div class="banner error">Something went wrong. Please try again.</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Confirm booking';
  }
});

checkCustomerSession();
loadBarbers();

// ---------- haircut styles carousel ----------
const styleTrack = document.getElementById('style-track');
if (styleTrack) {
  document.getElementById('style-prev').addEventListener('click', () => {
    styleTrack.scrollBy({ left: -320, behavior: 'smooth' });
  });
  document.getElementById('style-next').addEventListener('click', () => {
    styleTrack.scrollBy({ left: 320, behavior: 'smooth' });
  });
}

// ---------- walk-in check-in ----------
const walkinOverlay = document.getElementById('walkin-modal-overlay');
const openWalkinBtn = document.getElementById('open-walkin-btn');
const closeWalkinBtn = document.getElementById('close-walkin-btn');
const submitWalkinBtn = document.getElementById('submit-walkin-btn');

function openWalkinModal() {
  document.getElementById('walkin-banner').innerHTML = '';
  walkinOverlay.style.display = 'flex';
}
function closeWalkinModal() {
  walkinOverlay.style.display = 'none';
}
// After a successful check-in, send the customer back to the top of the home page.
function returnHomeFromWalkin() {
  closeWalkinModal();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

if (openWalkinBtn) openWalkinBtn.addEventListener('click', openWalkinModal);
if (closeWalkinBtn) closeWalkinBtn.addEventListener('click', closeWalkinModal);
if (walkinOverlay) {
  walkinOverlay.addEventListener('click', (e) => {
    if (e.target === walkinOverlay) closeWalkinModal();
  });
}

if (submitWalkinBtn) {
  submitWalkinBtn.addEventListener('click', async () => {
    const banner = document.getElementById('walkin-banner');
    const name = document.getElementById('walkin-name').value.trim();
    const phone = document.getElementById('walkin-phone').value.trim();
    const note = document.getElementById('walkin-note').value.trim();

    if (!name || !phone) {
      banner.innerHTML = `<div class="banner error">Name and phone number are required.</div>`;
      return;
    }

    submitWalkinBtn.disabled = true;
    submitWalkinBtn.textContent = 'Checking in…';
    try {
      const res = await fetch('/api/walkin/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, note })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not check you in.');

      const results = data.smsResults || [];
      const allFake = results.length > 0 && results.every((r) => r.skipped || r.error);
      document.getElementById('walkin-name').value = '';
      document.getElementById('walkin-phone').value = '';
      document.getElementById('walkin-note').value = '';
      if (allFake) {
        banner.innerHTML = `<div class="banner info">You're checked in! Testing mode — SMS isn't configured, so here's the text ${data.sentTo} barber${data.sentTo === 1 ? '' : 's'} would have gotten:<br><strong>${escapeHtml(data.body)}</strong></div>`;
        setTimeout(returnHomeFromWalkin, 4500);
      } else {
        banner.innerHTML = `<div class="banner success">You're checked in! We texted the barbers — first one free will grab you.</div>`;
        setTimeout(returnHomeFromWalkin, 2200);
      }
    } catch (err) {
      banner.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
    } finally {
      submitWalkinBtn.disabled = false;
      submitWalkinBtn.textContent = 'Check me in';
    }
  });
}
