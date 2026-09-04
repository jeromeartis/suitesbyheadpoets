require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const cron = require('node-cron');
const sharp = require('sharp');

const { db, DEFAULT_AVAILABILITY, DEFAULT_SERVICES } = require('./db');
const { sendSms, sendMassSms } = require('./sms');
const { sendAppointmentReminders } = require('./reminders');

const app = express();
const PORT = process.env.PORT || 3000;
const SHOP_NAME = process.env.SHOP_NAME || 'SuitesByHeadPoets';
// The shop runs on one wall-clock timezone regardless of where the server is
// hosted (Render defaults to UTC). Used to reject bookings for times that have
// already passed. Override with SHOP_TZ if the shop ever relocates.
const SHOP_TZ = process.env.SHOP_TZ || 'America/New_York';

// "YYYY-MM-DD HH:MM" for right now, in the shop's timezone. Lets us compare a
// booking's naive date+time strings against the current moment without pulling
// in a date library.
function shopNowStamp() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  const hour = p.hour === '24' ? '00' : p.hour; // some engines emit 24 for midnight
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute}`;
}

// True if appt_date (YYYY-MM-DD) + appt_time (HH:MM) is in the past, shop-local.
function isPastDateTime(appt_date, appt_time) {
  return `${appt_date} ${appt_time}` <= shopNowStamp();
}

// Staff and barbers share one 12-hour session window. Customers get a shorter one
// (see CUSTOMER_SESSION_MAX_AGE_MS) — set explicitly at every login point below,
// since all three roles share the same session cookie and default maxAge.
const STAFF_SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12; // 12 hours
const CUSTOMER_SESSION_MAX_AGE_MS = 1000 * 60 * 30; // 30 minutes

// Behind Render's (or any) HTTPS-terminating proxy, so req.protocol / req.secure
// reflect the original scheme and the session cookie can be marked secure.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    // 'auto' = secure only when the request came in over HTTPS, so local http dev
    // still works while production cookies get the Secure flag.
    cookie: { maxAge: STAFF_SESSION_MAX_AGE_MS, secure: 'auto', sameSite: 'lax' }
  })
);

// ---------- static files ----------
// UPLOADS_DIR lets the host keep user-uploaded images on a persistent volume
// (e.g. a Render disk at /var/data/uploads) instead of the ephemeral public/
// dir, which is wiped on every deploy. Falls back to public/uploads locally.
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Photo paths are stored in the DB as "/uploads/<file>"; map one back to its
// real location on disk (guarding against path traversal via the basename).
const uploadFilePath = (storedPath) => path.join(uploadsDir, path.basename(storedPath));

// Serve uploads from uploadsDir explicitly, then the rest of public/ as usual.
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- photo upload config ----------
// Uploads are held in memory (not written to disk directly) so saveProcessedImage()
// can resize/compress them first — otherwise a phone-camera photo straight off an
// iPhone (often 3000px+ wide, several MB) gets served as-is to every visitor.
const imageFileFilter = (req, file, cb) => {
  if (/^image\//.test(file.mimetype)) cb(null, true);
  else cb(new Error('Only image files are allowed'));
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: imageFileFilter });
const galleryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 }, fileFilter: imageFileFilter });
const qrUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: imageFileFilter });

// Resizes/compresses an uploaded image and writes it to public/uploads, returning
// just the filename. Auto-orients using the original's EXIF rotation, then strips
// metadata (also shrinks file size — phone photos often carry a lot of it).
// QR codes stay PNG (lossless, keeps sharp edges scannable); everything else
// re-encodes as JPEG, which is dramatically smaller for real photos.
async function saveProcessedImage(buffer, { prefix, maxDimension = 1600, format = 'jpeg', quality = 82 }) {
  const ext = format === 'png' ? '.png' : '.jpg';
  const filename = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
  let pipeline = sharp(buffer).rotate().resize({
    width: maxDimension,
    height: maxDimension,
    fit: 'inside',
    withoutEnlargement: true
  });
  pipeline = format === 'png' ? pipeline.png({ compressionLevel: 9 }) : pipeline.jpeg({ quality, mozjpeg: true });
  const outBuffer = await pipeline.toBuffer();
  fs.writeFileSync(path.join(uploadsDir, filename), outBuffer);
  return filename;
}

// Wraps an async route handler so a rejected promise (e.g. sharp failing on a
// corrupt/unsupported image) becomes a normal error response instead of an
// unhandled rejection that leaves the request hanging forever.
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      console.error('[route error]', err.message);
      res.status(400).json({ error: 'Could not process that image. Try a different file.' });
    });
  };
}

// ---------- auth ----------
function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

function requireCustomerAuth(req, res, next) {
  if (req.session && req.session.customerId) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

function requireBarberAuth(req, res, next) {
  if (req.session && req.session.barberId) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    req.session.cookie.maxAge = STAFF_SESSION_MAX_AGE_MS;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Incorrect password' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

// ---- name helpers ----
// Names are entered as separate first/last fields, but we still store a combined
// `name` ("First Last") for SMS copy and existing UI. These normalize whatever a
// request sent — first_name/last_name, or just a combined `name` from an older
// client / guest booking — into all three values.
function splitName(full) {
  const trimmed = String(full || '').trim();
  const sp = trimmed.indexOf(' ');
  return sp === -1
    ? { first_name: trimmed, last_name: '' }
    : { first_name: trimmed.slice(0, sp), last_name: trimmed.slice(sp + 1).trim() };
}
function joinName(first, last) {
  return [first, last].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
}
function resolveName(body = {}, existing = {}) {
  let first = String(body.first_name || '').trim();
  let last = String(body.last_name || '').trim();
  if (!first && !last && body.name != null && String(body.name).trim()) {
    ({ first_name: first, last_name: last } = splitName(body.name));
  }
  if (!first && !last) {
    return {
      first_name: existing.first_name || '',
      last_name: existing.last_name || '',
      name: existing.name || ''
    };
  }
  return { first_name: first, last_name: last, name: joinName(first, last) };
}

// ================= BARBERS =================

// Public: list active barbers (booking page / directory)
// Strips auth secrets before a barber record goes out over a public/customer-facing
// route. Admin and barber-self routes fetch barbers directly and don't need this.
function sanitizeBarberForPublic(b) {
  const { password_hash, password_salt, invite_token, invite_expires_at, ...safe } = b;
  return safe;
}

// For the admin barber list only: strips the actual secret values but keeps boolean
// flags so Management can show account status ("Invite sent" / "Account active").
function sanitizeBarberForAdmin(b) {
  const { password_hash, password_salt, invite_token, invite_expires_at, ...safe } = b;
  return {
    ...safe,
    has_password: !!password_hash,
    invite_pending: !!invite_token && new Date(invite_expires_at) > new Date()
  };
}

app.get('/api/barbers', (req, res) => {
  const includeInactive = req.query.all === '1' && req.session && req.session.isAdmin;
  const rows = includeInactive
    ? db.prepare('SELECT * FROM barbers ORDER BY booth_number ASC').all()
    : db.prepare('SELECT * FROM barbers WHERE active = 1 ORDER BY booth_number ASC').all();

  const galleryStmt = db.prepare('SELECT id, photo, caption FROM gallery_photos WHERE barber_id = ? ORDER BY created_at DESC LIMIT 6');
  const sanitize = includeInactive ? sanitizeBarberForAdmin : sanitizeBarberForPublic;
  const barbers = rows.map((b) => sanitize({
    ...b,
    availability: JSON.parse(b.availability || '{}'),
    services: JSON.parse(b.services || '[]'),
    gallery: galleryStmt.all(b.id)
  }));
  res.json(barbers);
});

app.get('/api/barbers/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM barbers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Barber not found' });
  const gallery = db.prepare('SELECT id, photo, caption FROM gallery_photos WHERE barber_id = ? ORDER BY created_at DESC').all(row.id);
  res.json(sanitizeBarberForPublic({ ...row, availability: JSON.parse(row.availability || '{}'), services: JSON.parse(row.services || '[]'), gallery }));
});

// Management: create barber
app.post('/api/barbers', requireAuth, upload.single('photo'), asyncRoute(async (req, res) => {
  const { phone, email, booth_number, specialty, bio, instagram, twitter } = req.body;
  const { first_name, last_name, name } = resolveName(req.body);
  if (!first_name || !phone) return res.status(400).json({ error: 'First name and phone are required' });

  let availability = DEFAULT_AVAILABILITY;
  if (req.body.availability) {
    try { availability = JSON.parse(req.body.availability); } catch { /* keep default */ }
  }

  let services = DEFAULT_SERVICES;
  if (req.body.services) {
    try { services = JSON.parse(req.body.services); } catch { /* keep default */ }
  }

  const photo = req.file ? `/uploads/${await saveProcessedImage(req.file.buffer, { prefix: 'barber', maxDimension: 1200 })}` : null;

  const info = db.prepare(`
    INSERT INTO barbers (name, first_name, last_name, phone, email, booth_number, specialty, bio, photo, availability, services, instagram, twitter)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, first_name, last_name, phone, email || null, booth_number || null, specialty || null, bio || null, photo, JSON.stringify(availability), JSON.stringify(services), instagram || null, twitter || null);

  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(sanitizeBarberForPublic({ ...barber, availability: JSON.parse(barber.availability), services: JSON.parse(barber.services) }));
}));

// Management: update barber (bio, photo, availability, booth, active status, etc.)
app.put('/api/barbers/:id', requireAuth, upload.single('photo'), asyncRoute(async (req, res) => {
  const existing = db.prepare('SELECT * FROM barbers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Barber not found' });

  const { first_name, last_name, name } = resolveName(req.body, existing);
  const {
    phone = existing.phone,
    email = existing.email,
    booth_number = existing.booth_number,
    specialty = existing.specialty,
    bio = existing.bio,
    instagram = existing.instagram,
    twitter = existing.twitter,
    active
  } = req.body;

  let availability = existing.availability;
  if (req.body.availability) {
    try { availability = JSON.stringify(JSON.parse(req.body.availability)); } catch { /* keep old */ }
  }

  let services = existing.services;
  if (req.body.services) {
    try { services = JSON.stringify(JSON.parse(req.body.services)); } catch { /* keep old */ }
  }

  let photo = existing.photo;
  if (req.file) {
    photo = `/uploads/${await saveProcessedImage(req.file.buffer, { prefix: 'barber', maxDimension: 1200 })}`;
    // clean up old photo file if it was a local upload
    if (existing.photo && existing.photo.startsWith('/uploads/')) {
      fs.unlink(uploadFilePath(existing.photo), () => {});
    }
  }

  const activeVal = active === undefined ? existing.active : (active === 'true' || active === true || active === '1' ? 1 : 0);

  db.prepare(`
    UPDATE barbers SET name=?, first_name=?, last_name=?, phone=?, email=?, booth_number=?, specialty=?, bio=?, photo=?, availability=?, services=?, active=?, instagram=?, twitter=?
    WHERE id=?
  `).run(name, first_name, last_name, phone, email, booth_number, specialty, bio, photo, availability, services, activeVal, instagram || null, twitter || null, req.params.id);

  const updated = db.prepare('SELECT * FROM barbers WHERE id = ?').get(req.params.id);
  res.json(sanitizeBarberForPublic({ ...updated, availability: JSON.parse(updated.availability), services: JSON.parse(updated.services) }));
}));

app.delete('/api/barbers/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM barbers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ================= HAIRCUT GALLERY =================
// Photos of a barber's work, shown on their public profile card.

// Public: view a barber's gallery
app.get('/api/barbers/:id/gallery', (req, res) => {
  const rows = db.prepare('SELECT * FROM gallery_photos WHERE barber_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json(rows);
});

// Staff: add one or more photos to a barber's gallery in one request. Any caption
// given is applied to every photo in the batch.
app.post('/api/barbers/:id/gallery', requireAuth, galleryUpload.array('photos', 10), asyncRoute(async (req, res) => {
  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(req.params.id);
  if (!barber) return res.status(404).json({ error: 'Barber not found' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'At least one photo file is required.' });

  const insert = db.prepare('INSERT INTO gallery_photos (barber_id, photo, caption) VALUES (?, ?, ?)');
  const caption = req.body.caption || null;
  const created = [];
  for (const file of req.files) {
    const filename = await saveProcessedImage(file.buffer, { prefix: 'gallery', maxDimension: 1600 });
    const info = insert.run(req.params.id, `/uploads/${filename}`, caption);
    created.push(db.prepare('SELECT * FROM gallery_photos WHERE id = ?').get(info.lastInsertRowid));
  }

  res.status(201).json(created);
}));

// Staff: remove a gallery photo (also deletes the file off disk)
app.delete('/api/gallery/:photoId', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM gallery_photos WHERE id = ?').get(req.params.photoId);
  if (!row) return res.status(404).json({ error: 'Photo not found' });

  db.prepare('DELETE FROM gallery_photos WHERE id = ?').run(row.id);

  fs.unlink(uploadFilePath(row.photo), () => {}); // best-effort; don't fail the request if the file's already gone

  res.json({ ok: true });
});

// ================= BARBER ACCOUNTS (invite-only, self-service profile) =================
//
// Barbers don't sign up on their own — an admin invites them from Management, which
// texts a one-time link. That link lets the barber set a password; from then on they
// log in with phone + password. A barber's session can only ever touch their own
// profile/gallery/QR — never other barbers, appointments, or admin settings.

const INVITE_EXPIRY_DAYS = 7;

app.post('/api/barbers/:id/invite', requireAuth, async (req, res) => {
  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(req.params.id);
  if (!barber) return res.status(404).json({ error: 'Barber not found' });

  const token = crypto.randomBytes(20).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE barbers SET invite_token = ?, invite_expires_at = ? WHERE id = ?').run(token, expiresAt, barber.id);

  const link = `${req.protocol}://${req.get('host')}/barber-signup.html?token=${token}`;
  const smsResult = await sendSms(barber.phone, `${SHOP_NAME}: you've been invited to manage your barber profile. Set up your login here (link expires in ${INVITE_EXPIRY_DAYS} days): ${link}`);

  // Same testing convenience as customer OTP: when Twilio isn't configured, the text
  // only goes to the console, so hand the link back directly for local testing.
  // Any time the text didn't actually go out — Twilio not configured, or a real send
  // failure (bad credentials, unverified trial number, etc.) — hand back the link
  // directly so staff aren't left with no way to reach the barber.
  const smsFailed = smsResult && (smsResult.skipped || smsResult.error);
  const devLink = smsFailed ? link : undefined;
  res.json({ ok: true, sms: smsResult, devLink });
});

app.get('/api/barber/invite/:token', (req, res) => {
  const barber = db.prepare('SELECT * FROM barbers WHERE invite_token = ?').get(req.params.token);
  if (!barber) return res.status(404).json({ error: 'This invite link is invalid or has already been used.' });
  if (new Date(barber.invite_expires_at) < new Date()) return res.status(410).json({ error: 'This invite link has expired. Ask the shop to send you a new one.' });
  res.json({ name: barber.name, first_name: barber.first_name, last_name: barber.last_name, phone: barber.phone });
});

app.post('/api/barber/signup', (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required.' });
  const strengthError = validatePasswordStrength(password);
  if (strengthError) return res.status(400).json({ error: strengthError });

  const barber = db.prepare('SELECT * FROM barbers WHERE invite_token = ?').get(token);
  if (!barber) return res.status(404).json({ error: 'This invite link is invalid or has already been used.' });
  if (new Date(barber.invite_expires_at) < new Date()) return res.status(410).json({ error: 'This invite link has expired. Ask the shop to send you a new one.' });

  const { hash, salt } = hashPassword(password);
  db.prepare('UPDATE barbers SET password_hash = ?, password_salt = ?, invite_token = NULL, invite_expires_at = NULL WHERE id = ?')
    .run(hash, salt, barber.id);

  req.session.barberId = barber.id;
  req.session.cookie.maxAge = STAFF_SESSION_MAX_AGE_MS;
  touchLastLogin('barbers', barber.id);
  res.status(201).json({ ok: true });
});

app.post('/api/barber/login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password are required.' });

  const barber = findBarberByPhone(phone);
  if (!barber || !barber.password_hash) {
    return res.status(401).json({ error: 'No barber account found for that number. Ask the shop for an invite link.' });
  }
  if (!passwordMatches(password, barber.password_hash, barber.password_salt)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  req.session.barberId = barber.id;
  req.session.cookie.maxAge = STAFF_SESSION_MAX_AGE_MS;
  touchLastLogin('barbers', barber.id);
  res.json({ ok: true });
});

// Forgot password: reuses the same texted 6-digit code flow as customer signup
// (POST /api/customer/request-otp — it's generic, not customer-specific) to prove
// the barber owns that phone, then sets a new password in the same step.
app.post('/api/barber/forgot-password', (req, res) => {
  const { phone, code, newPassword } = req.body;
  if (!phone || !code || !newPassword) return res.status(400).json({ error: 'Phone, code, and new password are required.' });

  // Validate everything that doesn't require the code first — the code gets
  // consumed on a successful check, so failing it shouldn't burn a valid one.
  const barber = findBarberByPhone(phone);
  if (!barber || !barber.password_hash) {
    return res.status(404).json({ error: 'No barber account found for that number. Ask the shop for an invite link.' });
  }

  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) return res.status(400).json({ error: strengthError });

  const otpResult = verifyOtpCode(phone, code);
  if (!otpResult.ok) return res.status(401).json({ error: otpResult.error });

  const { hash, salt } = hashPassword(newPassword);
  db.prepare('UPDATE barbers SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, barber.id);

  req.session.barberId = barber.id;
  req.session.cookie.maxAge = STAFF_SESSION_MAX_AGE_MS;
  touchLastLogin('barbers', barber.id);
  res.json({ ok: true });
});

app.post('/api/barber/logout', (req, res) => {
  delete req.session.barberId;
  res.json({ ok: true });
});

app.get('/api/barber/session', (req, res) => {
  if (!(req.session && req.session.barberId)) return res.json({ loggedIn: false });
  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(req.session.barberId);
  if (!barber) return res.json({ loggedIn: false });
  const gallery = db.prepare('SELECT id, photo, caption FROM gallery_photos WHERE barber_id = ? ORDER BY created_at DESC').all(barber.id);
  res.json({
    loggedIn: true,
    barber: sanitizeBarberForPublic({ ...barber, availability: JSON.parse(barber.availability || '{}'), services: JSON.parse(barber.services || '[]'), gallery })
  });
});

// A barber can edit their own bio/specialty/email/hours/services/photo — not their
// name, phone, booth number, or active status, which stay admin-controlled.
app.put('/api/barber/me', requireBarberAuth, upload.single('photo'), asyncRoute(async (req, res) => {
  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(req.session.barberId);
  const {
    email = barber.email,
    specialty = barber.specialty,
    bio = barber.bio,
    instagram = barber.instagram,
    twitter = barber.twitter,
    availability,
    services
  } = req.body;

  const photo = req.file ? `/uploads/${await saveProcessedImage(req.file.buffer, { prefix: 'barber', maxDimension: 1200 })}` : barber.photo;
  const availabilityJson = availability ? availability : barber.availability;
  const servicesJson = services ? services : barber.services;

  db.prepare(`
    UPDATE barbers SET email = ?, specialty = ?, bio = ?, photo = ?, availability = ?, services = ?, instagram = ?, twitter = ? WHERE id = ?
  `).run(email, specialty, bio, photo, availabilityJson, servicesJson, instagram || null, twitter || null, barber.id);

  const updated = db.prepare('SELECT * FROM barbers WHERE id = ?').get(barber.id);
  res.json(sanitizeBarberForPublic({ ...updated, availability: JSON.parse(updated.availability || '{}'), services: JSON.parse(updated.services || '[]') }));
}));

app.post('/api/barber/me/gallery', requireBarberAuth, galleryUpload.array('photos', 10), asyncRoute(async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'At least one photo file is required.' });
  const insert = db.prepare('INSERT INTO gallery_photos (barber_id, photo, caption) VALUES (?, ?, ?)');
  const caption = req.body.caption || null;
  const created = [];
  for (const file of req.files) {
    const filename = await saveProcessedImage(file.buffer, { prefix: 'gallery', maxDimension: 1600 });
    const info = insert.run(req.session.barberId, `/uploads/${filename}`, caption);
    created.push(db.prepare('SELECT * FROM gallery_photos WHERE id = ?').get(info.lastInsertRowid));
  }
  res.status(201).json(created);
}));

app.delete('/api/barber/me/gallery/:photoId', requireBarberAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM gallery_photos WHERE id = ?').get(req.params.photoId);
  if (!row || row.barber_id !== req.session.barberId) return res.status(404).json({ error: 'Photo not found' });

  db.prepare('DELETE FROM gallery_photos WHERE id = ?').run(row.id);
  fs.unlink(uploadFilePath(row.photo), () => {});
  res.json({ ok: true });
});

// Payment QR upload — either the barber themselves, or an admin on their behalf.
app.post('/api/barber/me/qr', requireBarberAuth, qrUpload.single('qr'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A QR code image is required.' });
  const qrPath = `/uploads/${await saveProcessedImage(req.file.buffer, { prefix: 'qr', maxDimension: 800, format: 'png' })}`;
  db.prepare('UPDATE barbers SET payment_qr = ? WHERE id = ?').run(qrPath, req.session.barberId);
  res.json({ ok: true, payment_qr: qrPath });
}));

app.post('/api/barbers/:id/qr', requireAuth, qrUpload.single('qr'), asyncRoute(async (req, res) => {
  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(req.params.id);
  if (!barber) return res.status(404).json({ error: 'Barber not found' });
  if (!req.file) return res.status(400).json({ error: 'A QR code image is required.' });
  const qrPath = `/uploads/${await saveProcessedImage(req.file.buffer, { prefix: 'qr', maxDimension: 800, format: 'png' })}`;
  db.prepare('UPDATE barbers SET payment_qr = ? WHERE id = ?').run(qrPath, barber.id);
  res.json({ ok: true, payment_qr: qrPath });
}));

// ================= CUSTOMERS =================

app.get('/api/customers', requireAuth, (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, b.name AS preferred_barber_name
    FROM customers c
    LEFT JOIN barbers b ON b.id = c.preferred_barber_id
    ORDER BY c.created_at DESC
  `).all());
});

// Used by both the public booking flow and the management "add customer" form.
// Upserts by phone number so repeat customers don't get duplicated.
function findOrCreateCustomer({ name, first_name, last_name, phone, email, notes }) {
  const existing = findCustomerByPhone(phone);
  if (existing) {
    const r = resolveName({ name, first_name, last_name }, existing);
    db.prepare('UPDATE customers SET name = ?, first_name = ?, last_name = ?, email = COALESCE(?, email), notes = COALESCE(?, notes) WHERE id = ?')
      .run(r.name || existing.name, r.first_name, r.last_name, email, notes, existing.id);
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id);
  }
  const r = resolveName({ name, first_name, last_name });
  const info = db.prepare('INSERT INTO customers (name, first_name, last_name, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(r.name, r.first_name, r.last_name, phone, email || null, notes || null);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
}

app.post('/api/customers', requireAuth, (req, res) => {
  const { phone, email, notes } = req.body;
  const { first_name, last_name, name } = resolveName(req.body);
  if (!first_name || !phone) return res.status(400).json({ error: 'First name and phone are required' });
  const customer = findOrCreateCustomer({ first_name, last_name, name, phone, email, notes });
  res.status(201).json(customer);
});

app.delete('/api/customers/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ================= APPOINTMENTS =================

// Minutes-since-midnight helpers, used for overlap math ("does a 60-min service
// starting at 2:30 collide with something already on the books").
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}


// Public: appointments for one barber on one date, so the booking page can grey out taken
// slots. Returns each booking's start time AND duration so the front end can block every
// slot a longer service occupies, not just its exact start time.
app.get('/api/barbers/:id/appointments', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });
  const rows = db.prepare(`
    SELECT appt_time, duration_minutes FROM appointments WHERE barber_id = ? AND appt_date = ? AND status != 'cancelled'
  `).all(req.params.id, date);
  res.json(rows);
});

// Shared overlap/hours check used by both new bookings and reschedules.
// Returns an error string, or null if the slot is clear.
function checkSlotAvailable({ barber, appt_date, appt_time, duration_minutes, excludeAppointmentId }) {
  if (isPastDateTime(appt_date, appt_time)) {
    return 'That time has already passed. Please pick a later slot.';
  }

  const dayName = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
    new Date(appt_date + 'T00:00:00').getDay()
  ];
  const availability = JSON.parse(barber.availability || '{}');
  const dayAvail = availability[dayName];

  const start = timeToMinutes(appt_time);
  const end = start + duration_minutes;

  if (dayAvail && !dayAvail.off && dayAvail.start && dayAvail.end) {
    const openStart = timeToMinutes(dayAvail.start);
    const openEnd = timeToMinutes(dayAvail.end);
    if (start < openStart || end > openEnd) {
      return `That time doesn't leave enough room before ${barber.name.split(' ')[0]} closes. Pick an earlier slot or a shorter service.`;
    }
  }

  const sameDay = db.prepare(
    `SELECT id, appt_time, duration_minutes FROM appointments WHERE barber_id = ? AND appt_date = ? AND status != 'cancelled'`
  ).all(barber.id, appt_date);

  const clash = sameDay.some((e) => {
    if (excludeAppointmentId && e.id === excludeAppointmentId) return false;
    const eStart = timeToMinutes(e.appt_time);
    const eEnd = eStart + (e.duration_minutes || 30);
    return start < eEnd && eStart < end; // classic interval overlap
  });
  if (clash) return 'That time slot was just taken. Please pick another.';

  return null;
}

// A customer a barber has marked as trusted — their bookings with that barber
// skip the pending-approval step. Scoped per-barber (see preferred_customers).
function isPreferredCustomer(barberId, customerId) {
  return !!db.prepare('SELECT 1 FROM preferred_customers WHERE barber_id = ? AND customer_id = ?').get(barberId, customerId);
}

// Public: create a booking. This is the main SMS trigger for a scheduled appointment.
// Shared by the public booking form, the logged-in customer booking flow, and a
// barber booking on behalf of a customer (see /api/barber/me/appointments below).
// Checks for double-booking (accounting for service duration), inserts the row with a
// manage token, and texts the barber — unless notifyBarber is false, which skips that
// text since it'd just be the barber notifying themselves.
//
// requiresApproval lands the row as 'pending' instead of 'confirmed' — used for
// customer self-service bookings, so the barber has to accept it before it's real.
// It still blocks the slot from being double-booked while awaiting a decision (see
// checkSlotAvailable, which only excludes 'cancelled'). Barber-initiated bookings
// (the barber booking on behalf of a walk-in/phone customer) skip this entirely,
// since there's no one to approve it — they're already confirming it themselves.
async function createAppointment({ barber_id, service, appt_date, appt_time, duration_minutes, customerRow, notifyBarber = true, requiresApproval = false }) {
  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(barber_id);
  if (!barber) return { error: 'Barber not found', status: 404 };

  const safeDuration = Number.isInteger(duration_minutes) && duration_minutes > 0 ? duration_minutes : 30;

  const conflictMsg = checkSlotAvailable({ barber, appt_date, appt_time, duration_minutes: safeDuration });
  if (conflictMsg) return { error: conflictMsg, status: 409 };

  const manageToken = crypto.randomBytes(16).toString('hex');
  const status = requiresApproval ? 'pending' : 'confirmed';

  const info = db.prepare(`
    INSERT INTO appointments (barber_id, customer_id, service, appt_date, appt_time, duration_minutes, manage_token, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(barber_id, customerRow.id, service || null, appt_date, appt_time, safeDuration, manageToken, status);

  const smsResult = notifyBarber
    ? await sendSms(
        barber.phone,
        requiresApproval
          ? `🔔 Appointment REQUEST at ${SHOP_NAME}: ${customerRow.name} wants ${appt_date} at ${appt_time}` +
            (service ? ` for ${service}.` : '.') +
            ` Booth #${barber.booth_number || '-'}. Approve or decline it from your barber portal.`
          : `📅 New booking at ${SHOP_NAME}: ${customerRow.name} on ${appt_date} at ${appt_time}` +
            (service ? ` for ${service}.` : '.') +
            ` Booth #${barber.booth_number || '-'}. Reply if you have a conflict.`
      )
    : { skipped: true, reason: 'barber booked this appointment themselves' };

  return {
    appointment: db.prepare('SELECT * FROM appointments WHERE id = ?').get(info.lastInsertRowid),
    sms: smsResult
  };
}

// NOTE: appointment creation now requires a signed-in customer (see
// /api/customer/appointments below). This route is intentionally gone — booking
// is no longer anonymous, so there's no unauthenticated path left that creates one.

// ================= CUSTOMER ACCOUNTS (phone + password, OTP for verification) =================
//
// Signup and "forgot password" both verify phone ownership via a texted 6-digit code
// (reusing /api/customer/request-otp). Regular sign-in is phone + password.
// Shop policy: passwords expire after a year, and a new password can't match the
// current one or any of the last 3 previously used ones.

const PASSWORD_MAX_AGE_DAYS = 365;
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_SPECIAL_CHAR_RE = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/;

// Shop policy: customer passwords must be at least 10 characters and include at
// least one special character. Returns an error string, or null if strong enough.
function validatePasswordStrength(password) {
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (!PASSWORD_SPECIAL_CHAR_RE.test(password)) {
    return 'Password must include at least one special character (e.g. ! @ # $ % &).';
  }
  return null;
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Verifies a texted code against otp_codes, consuming it on success. Shared by
// signup and password-reset so the OTP rules (expiry, attempt limit) live in one place.
// Keyed by normalized digits (not the raw string) so it doesn't matter if the phone
// was typed differently between requesting the code and submitting it.
function verifyOtpCode(phone, code) {
  const key = normalizePhoneDigits(phone);
  const row = db.prepare('SELECT * FROM otp_codes WHERE phone = ?').get(key);
  if (!row) return { ok: false, error: 'Request a verification code first.' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, error: 'That code expired. Request a new one.' };
  if (row.attempts >= 5) return { ok: false, error: 'Too many attempts. Request a new code.' };
  if (row.code !== code) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?').run(key);
    return { ok: false, error: 'Incorrect code.' };
  }
  db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(key);
  return { ok: true };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function passwordMatches(password, hash, salt) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}
function isPasswordExpired(customer) {
  if (!customer.password_set_at) return false; // never set = nothing to expire yet
  const ageMs = Date.now() - new Date(customer.password_set_at).getTime();
  return ageMs > PASSWORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

// Enforces the "not the same as current, and not one of the last 3" rule.
// Returns an error string, or null if the new password is acceptable.
function checkPasswordReuse(customerId, newPassword, currentHash, currentSalt) {
  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) return strengthError;
  if (currentHash && currentSalt && passwordMatches(newPassword, currentHash, currentSalt)) {
    return "That's your current password. Choose a new one.";
  }
  const history = db.prepare(
    `SELECT password_hash, password_salt FROM customer_password_history WHERE customer_id = ? ORDER BY created_at DESC LIMIT 3`
  ).all(customerId);
  const reused = history.some((h) => passwordMatches(newPassword, h.password_hash, h.password_salt));
  if (reused) return "You've used that password recently. Choose one you haven't used in the last 3 changes.";
  return null;
}

// Records the password that's about to be replaced into history, then trims to the
// last 3 so the table doesn't grow forever.
function archiveCurrentPassword(customerId, hash, salt) {
  if (!hash || !salt) return;
  db.prepare(`INSERT INTO customer_password_history (customer_id, password_hash, password_salt) VALUES (?, ?, ?)`)
    .run(customerId, hash, salt);
  db.prepare(`
    DELETE FROM customer_password_history WHERE customer_id = ? AND id NOT IN (
      SELECT id FROM customer_password_history WHERE customer_id = ? ORDER BY created_at DESC LIMIT 3
    )
  `).run(customerId, customerId);
}

app.post('/api/customer/request-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  const code = generateOtp();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Keyed by normalized digits (see verifyOtpCode) so the code isn't tied to the
  // exact formatting the phone was typed in on this request.
  db.prepare(`
    INSERT INTO otp_codes (phone, code, expires_at, attempts) VALUES (?, ?, ?, 0)
    ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0
  `).run(normalizePhoneDigits(phone), code, expiresAt);

  const smsResult = await sendSms(phone, `Your ${SHOP_NAME} verification code is ${code}. It expires in 10 minutes.`);
  // When Twilio isn't configured, sendSms just logs to the server console and nobody
  // testing in a browser can see that. Surface the code directly in the response in
  // that case only, so login/signup can be tested end-to-end without a real phone.
  // Same reasoning as the barber invite: if the text didn't actually go out (Twilio
  // not configured, or a real send failure), hand back the code directly so testing
  // and account recovery aren't dead-ended by a silent SMS failure.
  const devCode = smsResult && (smsResult.skipped || smsResult.error) ? code : undefined;
  res.json({ ok: true, sms: smsResult, devCode });
});

// Create a new customer account. Phone verification (a texted code) is only
// required when the customer opts in to appointment texts — that way someone can
// sign up and use the site without ever receiving an SMS. If a guest booking
// already created this phone number (no password set), signup "claims" that
// record instead of erroring, so their appointment history isn't lost.
app.post('/api/customer/signup', (req, res) => {
  const { phone, code, password, email, preferred_barber_id } = req.body;
  const { first_name, last_name, name } = resolveName(req.body);
  if (!first_name || !phone || !password) {
    return res.status(400).json({ error: 'First name, phone, and password are required.' });
  }
  // Opt-in to ongoing appointment texts is optional — never a condition of signup.
  const smsConsent = req.body.sms_consent === true || req.body.sms_consent === 'true' || req.body.sms_consent === 1;
  const consentAt = smsConsent ? new Date().toISOString() : null;

  // Validate everything that doesn't require the code first — the code gets
  // consumed on a successful check, so failing it shouldn't burn a valid one.
  const existing = findCustomerByPhone(phone);
  if (existing && existing.password_hash) {
    return res.status(409).json({ error: 'An account with that phone number already exists. Please sign in instead.' });
  }

  const reuseError = checkPasswordReuse(existing?.id, password, null, null);
  if (reuseError) return res.status(400).json({ error: reuseError });

  // Only customers opting in to texts prove ownership of the number with a code.
  let phoneVerified = 0;
  if (smsConsent) {
    if (!code) return res.status(400).json({ error: 'Enter the verification code we texted you.' });
    const otpResult = verifyOtpCode(phone, code);
    if (!otpResult.ok) return res.status(401).json({ error: otpResult.error });
    phoneVerified = 1;
  }

  const { hash, salt } = hashPassword(password);
  const preferredId = preferred_barber_id || null;

  let customerId;
  if (existing) {
    db.prepare(`
      UPDATE customers SET name = ?, first_name = ?, last_name = ?, email = COALESCE(?, email), preferred_barber_id = ?, password_hash = ?, password_salt = ?, password_set_at = datetime('now'),
        sms_consent = ?, sms_consent_at = ?, phone_verified = ?
      WHERE id = ?
    `).run(name, first_name, last_name, email || null, preferredId, hash, salt, smsConsent ? 1 : 0, consentAt, phoneVerified, existing.id);
    customerId = existing.id;
  } else {
    const info = db.prepare(`
      INSERT INTO customers (name, first_name, last_name, phone, email, preferred_barber_id, password_hash, password_salt, password_set_at, sms_consent, sms_consent_at, phone_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
    `).run(name, first_name, last_name, phone, email || null, preferredId, hash, salt, smsConsent ? 1 : 0, consentAt, phoneVerified);
    customerId = info.lastInsertRowid;
  }

  archiveCurrentPassword(customerId, hash, salt);
  req.session.customerId = customerId;
  req.session.cookie.maxAge = CUSTOMER_SESSION_MAX_AGE_MS;
  touchLastLogin('customers', customerId);
  res.status(201).json({ ok: true, customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) });
});

app.post('/api/customer/login', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password are required.' });

  const customer = findCustomerByPhone(phone);
  if (!customer || !customer.password_hash) {
    return res.status(401).json({ error: "No account found for that number. Sign up, or use 'Forgot password' if you set one up before." });
  }
  if (!passwordMatches(password, customer.password_hash, customer.password_salt)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  req.session.customerId = customer.id;
  req.session.cookie.maxAge = CUSTOMER_SESSION_MAX_AGE_MS;
  touchLastLogin('customers', customer.id);
  res.json({ ok: true, customer, passwordExpired: isPasswordExpired(customer) });
});

// Forgot password: verify a texted code, then set a new password in the same step.
app.post('/api/customer/forgot-password', (req, res) => {
  const { phone, code, newPassword } = req.body;
  if (!phone || !code || !newPassword) return res.status(400).json({ error: 'Phone, code, and new password are required.' });

  // Validate everything that doesn't require the code first — the code gets
  // consumed on a successful check, so failing it shouldn't burn a valid one.
  const customer = findCustomerByPhone(phone);
  if (!customer) return res.status(404).json({ error: 'No account found for that number.' });

  const reuseError = checkPasswordReuse(customer.id, newPassword, customer.password_hash, customer.password_salt);
  if (reuseError) return res.status(400).json({ error: reuseError });

  const otpResult = verifyOtpCode(phone, code);
  if (!otpResult.ok) return res.status(401).json({ error: otpResult.error });

  const { hash, salt } = hashPassword(newPassword);
  archiveCurrentPassword(customer.id, customer.password_hash, customer.password_salt);
  db.prepare(`UPDATE customers SET password_hash = ?, password_salt = ?, password_set_at = datetime('now') WHERE id = ?`)
    .run(hash, salt, customer.id);

  req.session.customerId = customer.id;
  req.session.cookie.maxAge = CUSTOMER_SESSION_MAX_AGE_MS;
  touchLastLogin('customers', customer.id);
  res.json({ ok: true, customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(customer.id) });
});

app.post('/api/customer/logout', (req, res) => {
  delete req.session.customerId;
  res.json({ ok: true });
});

app.get('/api/customer/session', (req, res) => {
  if (!(req.session && req.session.customerId)) return res.json({ loggedIn: false });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.session.customerId);
  if (!customer) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, customer, passwordExpired: isPasswordExpired(customer) });
});

// Blocks account actions (booking, cancelling, editing) once the yearly password
// expiry has passed, until the customer sets a new one. Viewing is still allowed.
function blockIfPasswordExpired(req, res, next) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.session.customerId);
  if (customer && isPasswordExpired(customer)) {
    return res.status(403).json({ error: 'Your password has expired. Please set a new one to continue.', needsPasswordChange: true });
  }
  next();
}

app.post('/api/customer/change-password', requireCustomerAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: 'New password is required.' });

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.session.customerId);
  if (customer.password_hash) {
    if (!currentPassword || !passwordMatches(currentPassword, customer.password_hash, customer.password_salt)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }
  }

  const reuseError = checkPasswordReuse(customer.id, newPassword, customer.password_hash, customer.password_salt);
  if (reuseError) return res.status(400).json({ error: reuseError });

  const { hash, salt } = hashPassword(newPassword);
  archiveCurrentPassword(customer.id, customer.password_hash, customer.password_salt);
  db.prepare(`UPDATE customers SET password_hash = ?, password_salt = ?, password_set_at = datetime('now') WHERE id = ?`)
    .run(hash, salt, customer.id);

  res.json({ ok: true });
});

app.put('/api/customer/me', requireCustomerAuth, blockIfPasswordExpired, (req, res) => {
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.session.customerId);
  const { email = existing.email, preferred_barber_id } = req.body;
  const { first_name, last_name, name } = resolveName(req.body, existing);
  const preferredId = preferred_barber_id === '' || preferred_barber_id === undefined
    ? existing.preferred_barber_id
    : preferred_barber_id;

  db.prepare('UPDATE customers SET name = ?, first_name = ?, last_name = ?, email = ?, preferred_barber_id = ? WHERE id = ?')
    .run(name, first_name, last_name, email, preferredId, req.session.customerId);

  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.session.customerId));
});

// Turn appointment texts (confirmations, reminders) on or off. Opt-in is always
// optional, so this can be toggled freely from the account page.
app.put('/api/customer/me/sms-consent', requireCustomerAuth, (req, res) => {
  const consent = req.body.sms_consent === true || req.body.sms_consent === 'true' || req.body.sms_consent === 1;
  db.prepare('UPDATE customers SET sms_consent = ?, sms_consent_at = ? WHERE id = ?')
    .run(consent ? 1 : 0, consent ? new Date().toISOString() : null, req.session.customerId);
  res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.session.customerId));
});

// Logged-in customer's own appointments, soonest first
app.get('/api/customer/appointments', requireCustomerAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, b.name AS barber_name, b.booth_number, b.photo AS barber_photo
    FROM appointments a
    JOIN barbers b ON b.id = a.barber_id
    WHERE a.customer_id = ?
    ORDER BY a.appt_date ASC, a.appt_time ASC
  `).all(req.session.customerId);
  res.json(rows);
});

// Logged-in customer books their own appointment (no need to re-type name/phone)
app.post('/api/customer/appointments', requireCustomerAuth, blockIfPasswordExpired, async (req, res) => {
  const { barber_id, service, appt_date, appt_time, duration_minutes } = req.body;
  if (!barber_id || !appt_date || !appt_time) {
    return res.status(400).json({ error: 'barber_id, appt_date, and appt_time are required' });
  }
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.session.customerId);
  const preferred = isPreferredCustomer(barber_id, customer.id);
  const result = await createAppointment({ barber_id, service, appt_date, appt_time, duration_minutes, customerRow: customer, requiresApproval: !preferred });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result);
});

app.put('/api/customer/appointments/:id/cancel', requireCustomerAuth, blockIfPasswordExpired, async (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ? AND customer_id = ?').get(req.params.id, req.session.customerId);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`).run(appt.id);

  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(appt.barber_id);
  if (barber) {
    await sendSms(barber.phone, `❌ Cancelled: the ${appt.appt_date} ${appt.appt_time} booking on your schedule was cancelled by the customer.`);
  }
  res.json({ ok: true });
});

// Logged-in customer reschedules their own appointment (same service/duration, new date/time)
app.put('/api/customer/appointments/:id/reschedule', requireCustomerAuth, blockIfPasswordExpired, async (req, res) => {
  const { appt_date, appt_time } = req.body;
  if (!appt_date || !appt_time) return res.status(400).json({ error: 'appt_date and appt_time are required' });

  const appt = db.prepare('SELECT * FROM appointments WHERE id = ? AND customer_id = ?').get(req.params.id, req.session.customerId);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(appt.barber_id);
  if (!barber) return res.status(404).json({ error: 'Barber not found' });

  const conflictMsg = checkSlotAvailable({
    barber, appt_date, appt_time,
    duration_minutes: appt.duration_minutes || 30,
    excludeAppointmentId: appt.id
  });
  if (conflictMsg) return res.status(409).json({ error: conflictMsg });

  // Keep a still-pending request pending after a reschedule — otherwise rescheduling
  // would be a backdoor around needing the barber's approval.
  const newStatus = appt.status === 'pending' ? 'pending' : 'confirmed';
  db.prepare(`UPDATE appointments SET appt_date = ?, appt_time = ?, status = ?, reminder_sent = 0 WHERE id = ?`)
    .run(appt_date, appt_time, newStatus, appt.id);

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.session.customerId);
  await sendSms(barber.phone, `🔁 Rescheduled: ${customer ? customer.name : 'a customer'} moved their booking to ${appt_date} at ${appt_time}.`);

  res.json({ ok: true, appointment: db.prepare('SELECT * FROM appointments WHERE id = ?').get(appt.id) });
});

// ================= BARBER: OWN APPOINTMENTS =================
// A barber can see, manage, and create appointments on their own schedule only —
// these all key off req.session.barberId, never a barber_id from the request body.

// A barber's own appointments, soonest first.
app.get('/api/barber/me/appointments', requireBarberAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, c.name AS customer_name, c.phone AS customer_phone,
      EXISTS(SELECT 1 FROM preferred_customers p WHERE p.barber_id = a.barber_id AND p.customer_id = a.customer_id) AS preferred
    FROM appointments a
    JOIN customers c ON c.id = a.customer_id
    WHERE a.barber_id = ?
    ORDER BY a.appt_date ASC, a.appt_time ASC
  `).all(req.session.barberId);
  res.json(rows);
});

// Customers this barber has actually booked before — powers the "existing customer"
// picker on their booking form. Scoped to their own appointment history only, same
// privacy boundary as everything else in the barber portal (never another barber's
// customers, never the full shop-wide customer list that's admin-only).
app.get('/api/barber/me/customers', requireBarberAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT c.id, c.name, c.phone, c.email,
      EXISTS(SELECT 1 FROM preferred_customers p WHERE p.barber_id = ? AND p.customer_id = c.id) AS preferred
    FROM customers c
    JOIN appointments a ON a.customer_id = c.id
    WHERE a.barber_id = ?
    ORDER BY c.name ASC
  `).all(req.session.barberId, req.session.barberId);
  res.json(rows);
});

// Mark/unmark a customer as preferred for this barber — their future bookings with
// this barber skip the pending-approval step. Only ever this barber's own
// customers (via their appointment history), never a global customer flag.
app.post('/api/barber/me/customers/:customerId/preferred', requireBarberAuth, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO preferred_customers (barber_id, customer_id) VALUES (?, ?)')
    .run(req.session.barberId, req.params.customerId);
  res.json({ ok: true, preferred: true });
});
app.delete('/api/barber/me/customers/:customerId/preferred', requireBarberAuth, (req, res) => {
  db.prepare('DELETE FROM preferred_customers WHERE barber_id = ? AND customer_id = ?')
    .run(req.session.barberId, req.params.customerId);
  res.json({ ok: true, preferred: false });
});

// A recurring series can't run longer than this many days from its first
// appointment, regardless of cadence or the chosen end date.
const MAX_RECURRENCE_DAYS = 14 * 7;
const RECURRENCE_CADENCE_WEEKS = { weekly: 1, biweekly: 2, monthly: 4 };

// A barber books a slot on their own schedule for a customer who isn't signed in —
// e.g. a walk-in or a phone booking. Finds or creates the customer by phone number,
// same as the public booking flow, then books it the same way (skipping the "new
// booking" text back to the barber, since they're the one creating it). Optionally
// repeats weekly/biweekly/monthly through an explicit end date (repeat_until),
// capped at MAX_RECURRENCE_DAYS from the first occurrence — each occurrence is
// checked independently, so a conflict on one date just skips that one instead of
// failing the whole series.
app.post('/api/barber/me/appointments', requireBarberAuth, async (req, res) => {
  const { customer_name, customer_phone, customer_email, service, appt_date, appt_time, duration_minutes, repeat, repeat_until } = req.body;
  if (!customer_name || !customer_phone || !appt_date || !appt_time) {
    return res.status(400).json({ error: 'Customer name, phone, date, and time are required.' });
  }

  const customerRow = findOrCreateCustomer({ name: customer_name, phone: customer_phone, email: customer_email });
  const cadenceWeeks = RECURRENCE_CADENCE_WEEKS[repeat];

  if (!cadenceWeeks) {
    const result = await createAppointment({
      barber_id: req.session.barberId,
      service, appt_date, appt_time, duration_minutes,
      customerRow,
      notifyBarber: false
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.status(201).json(result);
  }

  if (!repeat_until) {
    return res.status(400).json({ error: 'An end date is required for a recurring series.' });
  }

  const [year, month, day] = appt_date.split('-').map(Number);
  const startDate = new Date(year, month - 1, day);
  const [endYear, endMonth, endDay] = repeat_until.split('-').map(Number);
  const endDate = new Date(endYear, endMonth - 1, endDay);

  const spanDays = Math.round((endDate - startDate) / 86400000);
  if (spanDays < 0) {
    return res.status(400).json({ error: 'End date must be on or after the start date.' });
  }
  if (spanDays > MAX_RECURRENCE_DAYS) {
    return res.status(400).json({ error: 'End date can’t be more than 14 weeks after the start date.' });
  }

  const occurrenceDates = [];
  for (let offsetDays = 0; offsetDays <= spanDays; offsetDays += cadenceWeeks * 7) {
    const d = new Date(year, month - 1, day + offsetDays);
    occurrenceDates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }

  const series = [];
  for (const occDate of occurrenceDates) {
    const result = await createAppointment({
      barber_id: req.session.barberId,
      service, appt_date: occDate, appt_time, duration_minutes,
      customerRow,
      notifyBarber: false
    });
    series.push({ appt_date: occDate, ...result });
  }

  const booked = series.filter((r) => !r.error);
  if (!booked.length) {
    return res.status(409).json({ error: series[0].error || 'Could not book any occurrence of this series.' });
  }

  res.status(201).json({
    appointment: booked[0].appointment,
    series,
    bookedCount: booked.length,
    skippedCount: series.length - booked.length
  });
});

// A barber updates the status of one of their own appointments (confirm / complete / cancel).
// Also how a barber approves/declines a pending request — approve is just status
// 'confirmed', decline is 'cancelled'. The customer never got an initial text (only
// the barber does when a request comes in), so this is their first word on it.
app.put('/api/barber/me/appointments/:id/status', requireBarberAuth, async (req, res) => {
  const { status } = req.body;
  if (!['confirmed', 'completed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'status must be confirmed, completed, or cancelled.' });
  }
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ? AND barber_id = ?').get(req.params.id, req.session.barberId);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const wasPending = appt.status === 'pending';
  db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, appt.id);

  if (wasPending && (status === 'confirmed' || status === 'cancelled')) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(appt.customer_id);
    const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(req.session.barberId);
    if (customer && barber && customer.sms_consent) {
      const body = status === 'confirmed'
        ? `✅ Your ${SHOP_NAME} appointment with ${barber.name} on ${appt.appt_date} at ${appt.appt_time} is confirmed!`
        : `Your ${SHOP_NAME} appointment request with ${barber.name} for ${appt.appt_date} at ${appt.appt_time} was declined. Please pick another time.`;
      await sendSms(customer.phone, body);
    }
  }

  res.json({ ok: true });
});

// A barber reschedules one of their own appointments to a new date/time.
app.put('/api/barber/me/appointments/:id/reschedule', requireBarberAuth, (req, res) => {
  const { appt_date, appt_time } = req.body;
  if (!appt_date || !appt_time) return res.status(400).json({ error: 'appt_date and appt_time are required' });

  const appt = db.prepare('SELECT * FROM appointments WHERE id = ? AND barber_id = ?').get(req.params.id, req.session.barberId);
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(req.session.barberId);
  const conflictMsg = checkSlotAvailable({
    barber, appt_date, appt_time,
    duration_minutes: appt.duration_minutes || 30,
    excludeAppointmentId: appt.id
  });
  if (conflictMsg) return res.status(409).json({ error: conflictMsg });

  // Keep a still-pending request pending — rescheduling isn't the same as approving
  // it; that's a separate explicit action (see the status route below).
  const newStatus = appt.status === 'pending' ? 'pending' : 'confirmed';
  db.prepare(`UPDATE appointments SET appt_date = ?, appt_time = ?, status = ?, reminder_sent = 0 WHERE id = ?`)
    .run(appt_date, appt_time, newStatus, appt.id);

  res.json({ ok: true, appointment: db.prepare('SELECT * FROM appointments WHERE id = ?').get(appt.id) });
});

// ================= MANAGE-BY-LINK (no login needed — used by SMS reminder links) =================

app.get('/api/appointments/token/:token', (req, res) => {
  const row = db.prepare(`
    SELECT a.*, b.name AS barber_name, b.id AS barber_id, c.name AS customer_name
    FROM appointments a
    JOIN barbers b ON b.id = a.barber_id
    JOIN customers c ON c.id = a.customer_id
    WHERE a.manage_token = ?
  `).get(req.params.token);
  if (!row) return res.status(404).json({ error: 'This link is invalid or has expired.' });
  res.json(row);
});

app.put('/api/appointments/token/:token/cancel', async (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE manage_token = ?').get(req.params.token);
  if (!appt) return res.status(404).json({ error: 'This link is invalid or has expired.' });

  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`).run(appt.id);

  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(appt.barber_id);
  if (barber) {
    await sendSms(barber.phone, `❌ Cancelled: the ${appt.appt_date} ${appt.appt_time} booking on your schedule was cancelled by the customer.`);
  }
  res.json({ ok: true });
});

app.put('/api/appointments/token/:token/reschedule', async (req, res) => {
  const { appt_date, appt_time } = req.body;
  if (!appt_date || !appt_time) return res.status(400).json({ error: 'appt_date and appt_time are required' });

  const appt = db.prepare('SELECT * FROM appointments WHERE manage_token = ?').get(req.params.token);
  if (!appt) return res.status(404).json({ error: 'This link is invalid or has expired.' });

  const barber = db.prepare('SELECT * FROM barbers WHERE id = ?').get(appt.barber_id);
  if (!barber) return res.status(404).json({ error: 'Barber not found' });

  // Keep the appointment's original duration — rescheduling doesn't change the service.
  const conflictMsg = checkSlotAvailable({
    barber, appt_date, appt_time,
    duration_minutes: appt.duration_minutes || 30,
    excludeAppointmentId: appt.id
  });
  if (conflictMsg) return res.status(409).json({ error: conflictMsg });

  const newStatus = appt.status === 'pending' ? 'pending' : 'confirmed';
  db.prepare(`UPDATE appointments SET appt_date = ?, appt_time = ?, status = ?, reminder_sent = 0 WHERE id = ?`)
    .run(appt_date, appt_time, newStatus, appt.id);

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(appt.customer_id);
  await sendSms(barber.phone, `🔁 Rescheduled: ${customer ? customer.name : 'a customer'} moved their booking to ${appt_date} at ${appt_time}.`);

  res.json({ ok: true, appointment: db.prepare('SELECT * FROM appointments WHERE id = ?').get(appt.id) });
});

// ================= WALK-IN QUEUE (customer self check-in) =================

// Public: a customer at the shop checks themselves in for the next available barber.
// Creates/updates their customer record, adds them to the waiting queue, and fires
// the same mass alert to every active barber as the staff walk-in button does —
// each barber can claim it by texting back "2" (see /api/sms/inbound below).
app.post('/api/walkin/join', async (req, res) => {
  const { name, phone } = req.body;
  let note = req.body.note;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });

  const customer = findOrCreateCustomer({ name, phone });

  const already = db.prepare(
    `SELECT id FROM walkin_queue WHERE customer_id = ? AND status IN ('waiting', 'claimed')`
  ).get(customer.id);
  if (already) {
    return res.status(409).json({ error: "You're already checked in and waiting." });
  }

  const info = db.prepare(
    `INSERT INTO walkin_queue (customer_id, note) VALUES (?, ?)`
  ).run(customer.id, note || null);
  const walkinId = info.lastInsertRowid;

  const activeBarbers = db.prepare('SELECT * FROM barbers WHERE active = 1').all();
  const numbers = activeBarbers.map((b) => b.phone).filter(Boolean);
  const body = `🚶 Walk-in at ${SHOP_NAME}: ${customer.name} just checked in for the next available barber.` +
    (note ? ` Note: ${note}.` : '') +
    ` Reply 2 to claim them.`;
  const smsResults = await sendMassSms(numbers, body);

  const insertOffer = db.prepare(`INSERT INTO walkin_offers (walkin_queue_id, barber_id) VALUES (?, ?)`);
  activeBarbers.forEach((b) => insertOffer.run(walkinId, b.id));

  db.prepare('INSERT INTO walkin_log (sent_to_count, note) VALUES (?, ?)')
    .run(numbers.length, `Self check-in: ${customer.name}${note ? ' — ' + note : ''}`);

  const entry = db.prepare('SELECT * FROM walkin_queue WHERE id = ?').get(walkinId);
  res.status(201).json({ ok: true, entry, sentTo: numbers.length, smsResults, body });
});

// Management: view the live waiting/claimed list.
app.get('/api/admin/walkin/queue', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT q.*, c.name AS customer_name, c.phone AS customer_phone, b.name AS claimed_by_name
    FROM walkin_queue q
    JOIN customers c ON c.id = q.customer_id
    LEFT JOIN barbers b ON b.id = q.claimed_by_barber_id
    WHERE q.status IN ('waiting', 'claimed')
    ORDER BY q.created_at ASC
  `).all();
  res.json(rows);
});

// Management: mark someone as seated/done, or remove them from the queue.
app.post('/api/admin/walkin/queue/:id/resolve', requireAuth, (req, res) => {
  const status = req.body.status === 'cancelled' ? 'cancelled' : 'completed';
  db.prepare(
    `UPDATE walkin_queue SET status = ?, resolved_at = datetime('now') WHERE id = ?`
  ).run(status, req.params.id);
  res.json({ ok: true });
});

// Matches phones regardless of formatting (+1, dashes, parens, spaces) by comparing
// the last 10 digits, since numbers get typed inconsistently throughout the app —
// e.g. a barber's phone entered as "+15551234567" in Management still has to match
// them typing "(555) 123-4567" when they log in.
function normalizePhoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

// Phone-number lookups that tolerate formatting differences between how a number
// was originally stored and how it's typed on a later request (login, signup, etc).
// The tables here are small (a handful of barbers, at most a few hundred customers),
// so scanning and comparing normalized digits is simpler and safer than trying to
// keep every write path storing a canonical format.
function findBarberByPhone(phone) {
  const target = normalizePhoneDigits(phone);
  if (!target) return undefined;
  return db.prepare('SELECT * FROM barbers').all().find((b) => normalizePhoneDigits(b.phone) === target);
}
function findCustomerByPhone(phone) {
  const target = normalizePhoneDigits(phone);
  if (!target) return undefined;
  return db.prepare('SELECT * FROM customers').all().find((c) => normalizePhoneDigits(c.phone) === target);
}

// Records that a barber/customer just proved who they are (signup, login, or a
// password reset all count) — powers the inactivity cleanup below.
function touchLastLogin(table, id) {
  db.prepare(`UPDATE ${table} SET last_login_at = datetime('now') WHERE id = ?`).run(id);
}

// Shop policy: an account that hasn't signed in for 6 months gets its login
// credentials cleared — not the record itself, so appointment history survives.
// A customer can just sign up again with the same phone number (the signup route
// already "claims" an existing passwordless customer record instead of erroring).
// A barber has no self-service signup, so they'll need a fresh invite from Management.
const INACTIVITY_MONTHS = 6;
function clearInactiveLogins() {
  const cutoff = `-${INACTIVITY_MONTHS} months`;
  const barbers = db.prepare(`
    UPDATE barbers SET password_hash = NULL, password_salt = NULL
    WHERE password_hash IS NOT NULL AND last_login_at IS NOT NULL AND last_login_at < datetime('now', ?)
  `).run(cutoff);
  const customers = db.prepare(`
    UPDATE customers SET password_hash = NULL, password_salt = NULL, password_set_at = NULL
    WHERE password_hash IS NOT NULL AND last_login_at IS NOT NULL AND last_login_at < datetime('now', ?)
  `).run(cutoff);
  return { barbersCleared: barbers.changes, customersCleared: customers.changes };
}

function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Twilio inbound SMS webhook: a barber replies "2" to a walk-in text to claim that
// customer. Point your Twilio number's "A message comes in" webhook at
// POST https://<your-domain>/api/sms/inbound for this to fire (see README).
// Attempts to claim a waiting walk-in for a barber. Shared by the SMS "reply 2"
// flow and the barber portal's "Accept" button — same conditional UPDATE (guards
// against two barbers claiming the same walk-in at once) and same "sorry, already
// claimed" notice to whichever other barbers were offered it.
function claimWalkinForBarber(barberId, walkinQueueId) {
  const claim = db.prepare(
    `UPDATE walkin_queue SET status = 'claimed', claimed_by_barber_id = ?, claimed_at = datetime('now') WHERE id = ? AND status = 'waiting'`
  ).run(barberId, walkinQueueId);

  if (claim.changes === 0) return { ok: false, error: 'Sorry — another barber already grabbed that one.' };

  const walkin = db.prepare(`
    SELECT wq.*, c.name AS customer_name FROM walkin_queue wq JOIN customers c ON c.id = wq.customer_id WHERE wq.id = ?
  `).get(walkinQueueId);

  const others = db.prepare(`
    SELECT b.phone FROM walkin_offers wo JOIN barbers b ON b.id = wo.barber_id
    WHERE wo.walkin_queue_id = ? AND wo.barber_id != ?
  `).all(walkinQueueId, barberId);
  sendMassSms(others.map((o) => o.phone).filter(Boolean), `That walk-in (${walkin.customer_name}) was already claimed by another barber — thanks anyway!`);

  return { ok: true, walkin };
}

// A barber's currently-waiting walk-in offers, for the "accept from the portal"
// button — an alternative to replying "2" by text.
app.get('/api/barber/me/walkins', requireBarberAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT wq.id, wq.note, wq.created_at, c.name AS customer_name, c.phone AS customer_phone
    FROM walkin_offers wo
    JOIN walkin_queue wq ON wq.id = wo.walkin_queue_id
    JOIN customers c ON c.id = wq.customer_id
    WHERE wo.barber_id = ? AND wq.status = 'waiting'
    ORDER BY wq.created_at ASC
  `).all(req.session.barberId);
  res.json(rows);
});

app.post('/api/barber/me/walkins/:walkinId/accept', requireBarberAuth, (req, res) => {
  const offered = db.prepare(
    `SELECT 1 FROM walkin_offers WHERE walkin_queue_id = ? AND barber_id = ?`
  ).get(req.params.walkinId, req.session.barberId);
  if (!offered) return res.status(404).json({ error: 'This walk-in was not offered to you.' });

  const result = claimWalkinForBarber(req.session.barberId, Number(req.params.walkinId));
  if (!result.ok) return res.status(409).json({ error: result.error });
  res.json({ ok: true, walkin: result.walkin });
});

app.post('/api/sms/inbound', (req, res) => {
  const from = req.body.From;
  const bodyText = String(req.body.Body || '').trim();
  res.type('text/xml');

  const reply = (msg) => res.send(`<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${escapeXml(msg)}</Message>` : ''}</Response>`);

  if (bodyText !== '2' || !from) return reply(null); // ignore anything that isn't a claim reply

  const barbers = db.prepare('SELECT * FROM barbers WHERE active = 1').all();
  const barber = barbers.find((b) => normalizePhoneDigits(b.phone) === normalizePhoneDigits(from));
  if (!barber) return reply(null); // not a recognized barber number — stay silent

  const offer = db.prepare(`
    SELECT wq.id FROM walkin_offers wo
    JOIN walkin_queue wq ON wq.id = wo.walkin_queue_id
    WHERE wo.barber_id = ? AND wq.status = 'waiting'
    ORDER BY wo.created_at DESC LIMIT 1
  `).get(barber.id);

  if (!offer) return reply("No walk-in is waiting for you right now.");

  const result = claimWalkinForBarber(barber.id, offer.id);
  if (!result.ok) return reply(result.error);

  reply(`You've got it! ${result.walkin.customer_name} is waiting for you at the front.`);
});

// ================= WALK-IN MASS ALERT =================

// Front desk / management: notify every active barber that a walk-in just arrived.
app.post('/api/walkin', requireAuth, async (req, res) => {
  const { note } = req.body;
  const barbers = db.prepare('SELECT * FROM barbers WHERE active = 1').all();
  const numbers = barbers.map((b) => b.phone).filter(Boolean);

  const body = `🚶 Walk-in at ${SHOP_NAME}! First available barber, please head to the front.` +
    (note ? ` Note: ${note}` : '');

  const results = await sendMassSms(numbers, body);

  db.prepare('INSERT INTO walkin_log (sent_to_count, note) VALUES (?, ?)').run(numbers.length, note || null);

  res.json({ sentTo: numbers.length, results, body });
});

app.get('/api/walkin/log', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM walkin_log ORDER BY created_at DESC LIMIT 50').all());
});

// Lets a manager fire tomorrow's reminder batch on demand (e.g. to test it works)
// instead of waiting for the scheduled time.
app.post('/api/admin/send-reminders-now', requireAuth, async (req, res) => {
  const results = await sendAppointmentReminders();
  res.json({ sent: results.length, results });
});

// Lets a manager run the inactivity cleanup on demand instead of waiting for the
// scheduled time.
app.post('/api/admin/clear-inactive-logins-now', requireAuth, (req, res) => {
  res.json({ ok: true, ...clearInactiveLogins() });
});

// ---------- error handler for multer/file errors ----------
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message });
  next();
});

app.listen(PORT, () => {
  console.log(`${SHOP_NAME} server running at http://localhost:${PORT}`);
});

// Daily job: text anyone with a confirmed appointment happening tomorrow, with a link
// to change or cancel it. Runs once a day at REMINDER_HOUR (server local time).
const reminderHour = parseInt(process.env.REMINDER_HOUR, 10);
const cronHour = Number.isInteger(reminderHour) && reminderHour >= 0 && reminderHour <= 23 ? reminderHour : 9;
cron.schedule(`0 ${cronHour} * * *`, () => {
  sendAppointmentReminders()
    .then((results) => console.log(`[reminders] sent ${results.length} appointment reminder(s)`))
    .catch((err) => console.error('[reminders] failed:', err.message));
});

// Daily job: clear login credentials for any barber/customer who hasn't signed in
// for INACTIVITY_MONTHS. Runs at a fixed off-peak hour, independent of REMINDER_HOUR.
cron.schedule('0 3 * * *', () => {
  try {
    const { barbersCleared, customersCleared } = clearInactiveLogins();
    console.log(`[inactivity-cleanup] cleared ${barbersCleared} barber login(s), ${customersCleared} customer login(s)`);
  } catch (err) {
    console.error('[inactivity-cleanup] failed:', err.message);
  }
});
