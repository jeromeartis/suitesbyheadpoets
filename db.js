const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DB_PATH lets the host point the SQLite file at a persistent volume (e.g. a
// Render disk mounted at /var/data). Falls back to the in-repo data/ dir locally.
const dbFile = process.env.DB_PATH || path.join(__dirname, 'data', 'shop.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS barbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    booth_number INTEGER,
    specialty TEXT,
    bio TEXT,
    photo TEXT,
    payment_qr TEXT,
    availability TEXT NOT NULL DEFAULT '{}',
    services TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    password_hash TEXT,
    password_salt TEXT,
    invite_token TEXT,
    invite_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    email TEXT,
    notes TEXT,
    preferred_barber_id INTEGER,
    password_hash TEXT,
    password_salt TEXT,
    password_set_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Last few password hashes per customer, so a new password can be checked against
  -- recent history (shop policy: can't reuse your last 3 passwords).
  CREATE TABLE IF NOT EXISTS customer_password_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    service TEXT,
    appt_date TEXT NOT NULL,
    appt_time TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 30,
    status TEXT NOT NULL DEFAULT 'confirmed',
    manage_token TEXT UNIQUE,
    reminder_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS walkin_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_to_count INTEGER,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Haircut portfolio: photos a barber (via staff/management) adds of their work,
  -- shown on their public profile card.
  CREATE TABLE IF NOT EXISTS gallery_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    photo TEXT NOT NULL,
    caption TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Customer self-check-in queue ("I'm here, get me the next available barber").
  -- Separate from walkin_log, which just records the staff-triggered mass text.
  CREATE TABLE IF NOT EXISTS walkin_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'waiting', -- waiting | claimed | completed | cancelled
    claimed_by_barber_id INTEGER REFERENCES barbers(id) ON DELETE SET NULL,
    claimed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  -- One row per barber texted about a given walk-in. Lets an inbound "2" reply be
  -- matched back to the specific walk-in that barber was just offered.
  CREATE TABLE IF NOT EXISTS walkin_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walkin_queue_id INTEGER NOT NULL REFERENCES walkin_queue(id) ON DELETE CASCADE,
    barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS otp_codes (
    phone TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );

  -- A customer a barber has marked as trusted/regular — scoped per-barber, since a
  -- customer could be a known regular for one barber but a first-timer for another.
  -- Bookings from a preferred customer skip the pending-approval step entirely.
  CREATE TABLE IF NOT EXISTS preferred_customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barber_id INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(barber_id, customer_id)
  );
`);

// Migrations for databases created before these columns/tables existed.
// ALTER TABLE fails if the column is already there, so we just ignore that error.
function safeAlter(sql) {
  try { db.exec(sql); } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}
safeAlter(`ALTER TABLE barbers ADD COLUMN services TEXT NOT NULL DEFAULT '[]'`);
safeAlter(`ALTER TABLE customers ADD COLUMN preferred_barber_id INTEGER`);
safeAlter(`ALTER TABLE customers ADD COLUMN password_hash TEXT`);
safeAlter(`ALTER TABLE customers ADD COLUMN password_salt TEXT`);
safeAlter(`ALTER TABLE customers ADD COLUMN password_set_at TEXT`);
safeAlter(`ALTER TABLE appointments ADD COLUMN manage_token TEXT`);
safeAlter(`ALTER TABLE appointments ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0`);
safeAlter(`ALTER TABLE appointments ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 30`);
safeAlter(`ALTER TABLE barbers ADD COLUMN payment_qr TEXT`);
safeAlter(`ALTER TABLE barbers ADD COLUMN password_hash TEXT`);
safeAlter(`ALTER TABLE barbers ADD COLUMN password_salt TEXT`);
safeAlter(`ALTER TABLE barbers ADD COLUMN invite_token TEXT`);
safeAlter(`ALTER TABLE barbers ADD COLUMN invite_expires_at TEXT`);
safeAlter(`ALTER TABLE walkin_queue ADD COLUMN claimed_by_barber_id INTEGER REFERENCES barbers(id) ON DELETE SET NULL`);
safeAlter(`ALTER TABLE walkin_queue ADD COLUMN claimed_at TEXT`);
safeAlter(`ALTER TABLE barbers ADD COLUMN instagram TEXT`);
safeAlter(`ALTER TABLE barbers ADD COLUMN twitter TEXT`);
safeAlter(`ALTER TABLE barbers ADD COLUMN last_login_at TEXT`);
safeAlter(`ALTER TABLE customers ADD COLUMN last_login_at TEXT`);

// Default weekly availability template used when a barber is created without one
const DEFAULT_AVAILABILITY = {
  monday:    { off: false, start: '09:00', end: '18:00' },
  tuesday:   { off: false, start: '09:00', end: '18:00' },
  wednesday: { off: false, start: '09:00', end: '18:00' },
  thursday:  { off: false, start: '09:00', end: '18:00' },
  friday:    { off: false, start: '09:00', end: '19:00' },
  saturday:  { off: false, start: '09:00', end: '17:00' },
  sunday:    { off: true,  start: '', end: '' }
};

// Starter services shown when a barber is first created, so the pricing list
// isn't empty before the shop customizes it.
const DEFAULT_SERVICES = [
  { name: 'Haircut', price: 35, duration_minutes: 30 },
  { name: 'Haircut + Beard', price: 50, duration_minutes: 60 },
  { name: 'Beard Trim', price: 20, duration_minutes: 15 }
];

module.exports = { db, DEFAULT_AVAILABILITY, DEFAULT_SERVICES };
