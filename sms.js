const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER
} = process.env;

let client = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_ACCOUNT_SID.startsWith('AC')) {
  client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn(
    '[sms] Twilio credentials not set in .env — SMS sending is disabled. ' +
    'Messages will be logged to the console instead.'
  );
}

// Twilio requires E.164 (+1XXXXXXXXXX) — trial accounts especially reject anything
// else with a vague "invalid parameters" error. People type phone numbers into this
// app in every format imaginable, so normalize before ever calling the API instead
// of relying on every input field to enforce it.
function toE164(raw) {
  const str = String(raw || '').trim();
  if (!str) return str;
  if (str.startsWith('+')) return `+${str.slice(1).replace(/\D/g, '')}`; // keep existing country code, strip formatting chars
  const digits = str.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`; // bare US number
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`; // US number with leading 1
  return `+${digits}`; // best-effort fallback for anything else
}

/**
 * Send a single SMS. Falls back to console logging if Twilio isn't configured,
 * so the rest of the app still works during local development.
 */
async function sendSms(to, body) {
  if (!to) return { skipped: true, reason: 'no phone number on file' };
  const formattedTo = toE164(to);

  if (!client) {
    console.log(`[sms:fake] to ${formattedTo} -> ${body}`);
    return { skipped: true, reason: 'twilio not configured' };
  }

  try {
    const msg = await client.messages.create({
      to: formattedTo,
      from: TWILIO_PHONE_NUMBER,
      body
    });
    return { sid: msg.sid, status: msg.status };
  } catch (err) {
    console.error(`[sms] failed to send to ${formattedTo}:`, err.message);
    return { error: err.message };
  }
}

/**
 * Send the same SMS to a list of phone numbers (used for the walk-in mass alert).
 * Sends are fired concurrently and failures for one barber don't block the others.
 */
async function sendMassSms(numbers, body) {
  const results = await Promise.all(
    numbers.map((to) => sendSms(to, body))
  );
  return results;
}

module.exports = { sendSms, sendMassSms };
