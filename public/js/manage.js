const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function to12h(t) {
  let [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${suffix}`;
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

const token = new URLSearchParams(location.search).get('token');
let appt = null;
let barber = null;
let selectedSlot = null;
let reschedDate = null;
let reschedCalYear, reschedCalMonth;

async function load() {
  const banner = document.getElementById('manage-banner');
  if (!token) {
    banner.innerHTML = `<div class="banner error">This link is missing its code. Please use the link from your reminder text.</div>`;
    return;
  }

  try {
    const res = await fetch(`/api/appointments/token/${token}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'This link is invalid or has expired.');
    appt = data;
    barber = await fetch(`/api/barbers/${appt.barber_id}`).then((r) => r.json());
    render();
  } catch (err) {
    banner.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
  }
}

function render() {
  document.getElementById('manage-content').style.display = 'block';
  document.getElementById('appt-summary').innerHTML = `
    <div style="font-family:var(--display);font-size:1.6rem;">${appt.appt_date} · ${to12h(appt.appt_time)}</div>
    <p style="margin:6px 0 0;">${escapeHtml(appt.barber_name)}${appt.service ? ' · ' + escapeHtml(appt.service) : ''}</p>
    <span class="pill ${appt.status}">${appt.status}</span>
  `;

  if (appt.status === 'cancelled') {
    document.getElementById('cancelled-notice').style.display = 'block';
    document.getElementById('active-actions').style.display = 'none';
    return;
  }

  const today = new Date();
  const apptDateObj = new Date(appt.appt_date + 'T00:00:00');
  // Open the calendar on whichever month is relevant: the existing appointment's
  // month if it's still upcoming, otherwise the current month.
  const startFrom = apptDateObj >= new Date(today.getFullYear(), today.getMonth(), today.getDate()) ? apptDateObj : today;
  reschedCalYear = startFrom.getFullYear();
  reschedCalMonth = startFrom.getMonth();
  reschedDate = null;
  renderReschedCalendar();
}

// Same pattern as the booking calendars elsewhere in the app: only days the barber
// actually works (and not already past) are clickable.
function renderReschedCalendar() {
  const container = document.getElementById('resched-calendar');
  const first = new Date(reschedCalYear, reschedCalMonth, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(reschedCalYear, reschedCalMonth + 1, 0).getDate();
  const monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const isCurrentMonth = reschedCalYear === todayMidnight.getFullYear() && reschedCalMonth === todayMidnight.getMonth();

  let cells = '';
  for (let i = 0; i < startWeekday; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(reschedCalYear, reschedCalMonth, d);
    const dateStr = `${reschedCalYear}-${String(reschedCalMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayName = DAYS[dateObj.getDay()];
    const avail = barber.availability[dayName];
    const isOff = !avail || avail.off;
    const isPast = dateObj < todayMidnight;
    const disabled = isPast || isOff;
    const isSelected = dateStr === reschedDate;
    const isToday = dateObj.getTime() === todayMidnight.getTime();
    cells += `<div class="cal-cell ${disabled ? 'disabled' : ''} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}" data-date="${dateStr}">${d}</div>`;
  }

  container.innerHTML = `
    <div class="cal-header">
      <button type="button" class="cal-nav" id="resched-cal-prev" ${isCurrentMonth ? 'disabled' : ''}>‹</button>
      <span class="cal-month-label">${monthLabel}</span>
      <button type="button" class="cal-nav" id="resched-cal-next">›</button>
    </div>
    <div class="cal-weekdays">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="cal-grid">${cells}</div>
  `;

  document.getElementById('resched-cal-prev').addEventListener('click', () => {
    reschedCalMonth -= 1;
    if (reschedCalMonth < 0) { reschedCalMonth = 11; reschedCalYear -= 1; }
    renderReschedCalendar();
  });
  document.getElementById('resched-cal-next').addEventListener('click', () => {
    reschedCalMonth += 1;
    if (reschedCalMonth > 11) { reschedCalMonth = 0; reschedCalYear += 1; }
    renderReschedCalendar();
  });
  container.querySelectorAll('.cal-cell:not(.disabled):not(.empty)').forEach((cell) => {
    cell.addEventListener('click', () => {
      reschedDate = cell.dataset.date;
      renderReschedCalendar();
      renderSlots();
    });
  });
}

async function renderSlots() {
  const slotGrid = document.getElementById('resched-slot-grid');
  const date = reschedDate;
  if (!date) { slotGrid.innerHTML = ''; return; }
  const dayName = DAYS[new Date(date + 'T00:00:00').getDay()];
  const avail = barber.availability[dayName];
  if (!avail || avail.off) {
    slotGrid.innerHTML = `<p style="color:var(--paper-dim)">${escapeHtml(barber.name)} is off that day. Pick another date.</p>`;
    return;
  }
  slotGrid.innerHTML = `<p style="color:var(--paper-dim)">Loading open times…</p>`;
  const taken = await fetch(`/api/barbers/${barber.id}/appointments?date=${date}`).then((r) => r.json());
  const duration = appt.duration_minutes || 30;
  const slots = generateSlots(avail.start, avail.end, 30);
  selectedSlot = null;
  slotGrid.innerHTML = slots.map((s) => {
    const isTaken = !slotIsAvailable(s, duration, avail.end, taken);
    return `<div class="slot ${isTaken ? 'taken' : ''}" data-time="${s}">${to12h(s)}</div>`;
  }).join('');
  slotGrid.querySelectorAll('.slot:not(.taken)').forEach((el) => {
    el.addEventListener('click', () => {
      slotGrid.querySelectorAll('.slot').forEach((s) => s.classList.remove('selected'));
      el.classList.add('selected');
      selectedSlot = el.dataset.time;
    });
  });
}

document.getElementById('resched-confirm-btn').addEventListener('click', async () => {
  const banner = document.getElementById('manage-banner');
  const date = reschedDate;
  if (!selectedSlot) { banner.innerHTML = `<div class="banner error">Pick an open time slot first.</div>`; return; }

  const res = await fetch(`/api/appointments/token/${token}/reschedule`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appt_date: date, appt_time: selectedSlot })
  });
  const data = await res.json();
  if (!res.ok) { banner.innerHTML = `<div class="banner error">${escapeHtml(data.error)}</div>`; return; }
  appt = data.appointment;
  banner.innerHTML = `<div class="banner success">Moved to ${date} at ${to12h(selectedSlot)}.</div>`;
  render();
});

document.getElementById('cancel-appt-btn').addEventListener('click', async () => {
  if (!confirm('Cancel this appointment?')) return;
  const res = await fetch(`/api/appointments/token/${token}/cancel`, { method: 'PUT' });
  if (res.ok) { appt.status = 'cancelled'; render(); }
});

load();
