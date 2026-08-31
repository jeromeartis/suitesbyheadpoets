const crypto = require('crypto');
const { db } = require('./db');
const { sendSms } = require('./sms');

const SHOP_NAME = process.env.SHOP_NAME || 'SuitesByHeadPoets';
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

function tomorrowDateString() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function to12h(t) {
  let [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * Finds every confirmed appointment happening tomorrow that hasn't been reminded yet,
 * texts the customer a reminder with a link to change/cancel, and marks it as sent.
 * Safe to call more than once (e.g. manual admin trigger) — already-reminded rows are skipped.
 */
async function sendAppointmentReminders() {
  const date = tomorrowDateString();

  // Only remind customers who opted in to appointment texts. Others still see their
  // booking in their account; we just don't text them.
  const rows = db.prepare(`
    SELECT a.*, b.name AS barber_name, c.name AS customer_name, c.phone AS customer_phone
    FROM appointments a
    JOIN barbers b ON b.id = a.barber_id
    JOIN customers c ON c.id = a.customer_id
    WHERE a.appt_date = ? AND a.status = 'confirmed' AND a.reminder_sent = 0 AND c.sms_consent = 1
  `).all(date);

  const results = [];

  for (const appt of rows) {
    // Older appointments created before this feature existed may not have a token yet.
    let token = appt.manage_token;
    if (!token) {
      token = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE appointments SET manage_token = ? WHERE id = ?').run(token, appt.id);
    }

    const link = `${BASE_URL}/manage.html?token=${token}`;
    const body = `Reminder: your ${SHOP_NAME} appointment with ${appt.barber_name} is tomorrow, ` +
      `${appt.appt_date} at ${to12h(appt.appt_time)}. Need to change or cancel? ${link}`;

    const smsResult = await sendSms(appt.customer_phone, body);
    db.prepare('UPDATE appointments SET reminder_sent = 1 WHERE id = ?').run(appt.id);
    results.push({ appointmentId: appt.id, customer: appt.customer_name, sms: smsResult });
  }

  return results;
}

module.exports = { sendAppointmentReminders, tomorrowDateString };
