const { getDb } = require('./database');

function runMigrations() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS hotels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      city TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      phone TEXT,
      role TEXT DEFAULT 'customer',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      capacity INTEGER DEFAULT 2,
      basePrice REAL NOT NULL,
      registrationAmount REAL NOT NULL DEFAULT 0,
      arrivalAmount REAL NOT NULL DEFAULT 0,
      totalPrice REAL NOT NULL DEFAULT 0,
      amenities TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS room_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      image_path TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      capacity INTEGER DEFAULT 2,
      quantity INTEGER NOT NULL DEFAULT 1,
      basePrice REAL NOT NULL,
      registrationAmount REAL NOT NULL DEFAULT 0,
      arrivalAmount REAL NOT NULL DEFAULT 0,
      totalPrice REAL NOT NULL DEFAULT 0,
      amenities TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tent_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tent_id INTEGER REFERENCES tents(id) ON DELETE CASCADE,
      image_path TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_ref TEXT UNIQUE NOT NULL,
      user_id INTEGER REFERENCES users(id),
      property_type TEXT NOT NULL,
      property_id INTEGER NOT NULL,
      check_in DATE NOT NULL,
      check_out DATE NOT NULL,
      guests INTEGER DEFAULT 1,
      nights INTEGER NOT NULL,
      base_amount REAL NOT NULL,
      tax_amount REAL NOT NULL,
      total_amount REAL NOT NULL,
      registration_amount REAL NOT NULL DEFAULT 0,
      arrival_amount REAL NOT NULL DEFAULT 0,
      special_requests TEXT,
      status TEXT DEFAULT 'pending',
      payment_status TEXT DEFAULT 'unpaid',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS room_manual_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      check_in DATE NOT NULL,
      check_out DATE NOT NULL,
      booked_quantity INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_by_user_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(room_id, check_in, check_out)
    );

    CREATE TABLE IF NOT EXISTS tent_manual_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tent_id INTEGER NOT NULL REFERENCES tents(id) ON DELETE CASCADE,
      check_in DATE NOT NULL,
      check_out DATE NOT NULL,
      booked_quantity INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created_by_user_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tent_id, check_in, check_out)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER REFERENCES bookings(id),
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'INR',
      status TEXT DEFAULT 'pending',
      paid_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS price_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_type TEXT NOT NULL,
      property_id INTEGER NOT NULL,
      season TEXT DEFAULT 'all',
      price_per_night REAL NOT NULL,
      weekend_surcharge REAL DEFAULT 0,
      tax_percent REAL DEFAULT 18,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS enquiries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      interested_in TEXT,
      approx_guests INTEGER,
      message TEXT,
      status TEXT DEFAULT 'new',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS phone_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      otp TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      verified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS promo_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      agent_id INTEGER REFERENCES users(id),
      discount_percent REAL NOT NULL,
      max_uses INTEGER DEFAULT 0,
      used_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      valid_from DATETIME DEFAULT CURRENT_TIMESTAMP,
      valid_until DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agent_referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id INTEGER REFERENCES users(id),
      customer_id INTEGER REFERENCES users(id),
      booking_id INTEGER REFERENCES bookings(id),
      promo_code_id INTEGER REFERENCES promo_codes(id),
      discount_amount REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Add hotel_id column to users table if it doesn't exist yet
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  const hasHotelId = userColumns.some((col) => col.name === 'hotel_id');
  if (!hasHotelId) {
    db.exec('ALTER TABLE users ADD COLUMN hotel_id INTEGER REFERENCES hotels(id);');
  }

  // Add hotel_id column to rooms table if it doesn't exist yet
  const roomColumns = db.prepare('PRAGMA table_info(rooms)').all();
  const roomHasHotelId = roomColumns.some((col) => col.name === 'hotel_id');
  if (!roomHasHotelId) {
    db.exec('ALTER TABLE rooms ADD COLUMN hotel_id INTEGER REFERENCES hotels(id);');
  }
  const roomHasRegistrationAmount = roomColumns.some((col) => col.name === 'registrationAmount');
  if (!roomHasRegistrationAmount) {
    db.exec('ALTER TABLE rooms ADD COLUMN registrationAmount REAL NOT NULL DEFAULT 0;');
  }
  const roomHasArrivalAmount = roomColumns.some((col) => col.name === 'arrivalAmount');
  if (!roomHasArrivalAmount) {
    db.exec('ALTER TABLE rooms ADD COLUMN arrivalAmount REAL NOT NULL DEFAULT 0;');
  }
  const roomHasTotalPrice = roomColumns.some((col) => col.name === 'totalPrice');
  if (!roomHasTotalPrice) {
    db.exec('ALTER TABLE rooms ADD COLUMN totalPrice REAL NOT NULL DEFAULT 0;');
  }
  const roomHasQuantity = roomColumns.some((col) => col.name === 'quantity');
  if (!roomHasQuantity) {
    db.exec('ALTER TABLE rooms ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;');
  }
  db.exec(
    `UPDATE rooms
     SET registrationAmount = CASE WHEN registrationAmount > 0 THEN registrationAmount ELSE basePrice END,
         arrivalAmount = CASE WHEN arrivalAmount > 0 THEN arrivalAmount ELSE 0 END,
         quantity = CASE WHEN IFNULL(quantity, 0) > 0 THEN quantity ELSE 1 END,
         totalPrice = CASE
           WHEN totalPrice > 0 THEN totalPrice
           ELSE (CASE WHEN registrationAmount > 0 THEN registrationAmount ELSE basePrice END)
              + (CASE WHEN arrivalAmount > 0 THEN arrivalAmount ELSE 0 END)
         END`
  );

  // Add hotel_id column to tents table if it doesn't exist yet
  const tentColumns = db.prepare('PRAGMA table_info(tents)').all();
  const tentHasHotelId = tentColumns.some((col) => col.name === 'hotel_id');
  if (!tentHasHotelId) {
    db.exec('ALTER TABLE tents ADD COLUMN hotel_id INTEGER REFERENCES hotels(id);');
  }
  const tentHasRegistrationAmount = tentColumns.some((col) => col.name === 'registrationAmount');
  if (!tentHasRegistrationAmount) {
    db.exec('ALTER TABLE tents ADD COLUMN registrationAmount REAL NOT NULL DEFAULT 0;');
  }
  const tentHasArrivalAmount = tentColumns.some((col) => col.name === 'arrivalAmount');
  if (!tentHasArrivalAmount) {
    db.exec('ALTER TABLE tents ADD COLUMN arrivalAmount REAL NOT NULL DEFAULT 0;');
  }
  const tentHasTotalPrice = tentColumns.some((col) => col.name === 'totalPrice');
  if (!tentHasTotalPrice) {
    db.exec('ALTER TABLE tents ADD COLUMN totalPrice REAL NOT NULL DEFAULT 0;');
  }
  const tentHasQuantity = tentColumns.some((col) => col.name === 'quantity');
  if (!tentHasQuantity) {
    db.exec('ALTER TABLE tents ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;');
  }
  db.exec(
    `UPDATE tents
     SET registrationAmount = CASE WHEN registrationAmount > 0 THEN registrationAmount ELSE basePrice END,
          arrivalAmount = CASE WHEN arrivalAmount > 0 THEN arrivalAmount ELSE 0 END,
          quantity = CASE WHEN IFNULL(quantity, 0) > 0 THEN quantity ELSE 1 END,
          totalPrice = CASE
            WHEN totalPrice > 0 THEN totalPrice
            ELSE (CASE WHEN registrationAmount > 0 THEN registrationAmount ELSE basePrice END)
               + (CASE WHEN arrivalAmount > 0 THEN arrivalAmount ELSE 0 END)
          END`
  );

  // Add promo_code_id column to bookings table if it doesn't exist yet
  const bookingColumns = db.prepare('PRAGMA table_info(bookings)').all();
  const bookingHasPromoCodeId = bookingColumns.some((col) => col.name === 'promo_code_id');
  if (!bookingHasPromoCodeId) {
    db.exec('ALTER TABLE bookings ADD COLUMN promo_code_id INTEGER REFERENCES promo_codes(id);');
    db.exec('ALTER TABLE bookings ADD COLUMN discount_amount REAL DEFAULT 0;');
  }
  const bookingHasRegistrationAmount = bookingColumns.some(
    (col) => col.name === 'registration_amount'
  );
  if (!bookingHasRegistrationAmount) {
    db.exec('ALTER TABLE bookings ADD COLUMN registration_amount REAL NOT NULL DEFAULT 0;');
  }
  const bookingHasArrivalAmount = bookingColumns.some((col) => col.name === 'arrival_amount');
  if (!bookingHasArrivalAmount) {
    db.exec('ALTER TABLE bookings ADD COLUMN arrival_amount REAL NOT NULL DEFAULT 0;');
  }
  db.exec(
    `UPDATE bookings
     SET registration_amount = CASE
           WHEN registration_amount > 0 THEN registration_amount
           ELSE total_amount
         END,
         arrival_amount = CASE
           WHEN arrival_amount >= 0 THEN arrival_amount
           ELSE 0
          END`
  );

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_room_manual_bookings_room_dates
     ON room_manual_bookings (room_id, check_in, check_out);`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tent_manual_bookings_tent_dates
     ON tent_manual_bookings (tent_id, check_in, check_out);`
  );

  seedInitialData(db);
}

function seedInitialData(db) {
  // Keep only admin seeding; avoid pre-seeding other records.
  const hotelRow = db.prepare('SELECT id FROM hotels ORDER BY id LIMIT 1').get();
  const defaultHotelId = hotelRow ? hotelRow.id : null;

  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    const bcrypt = require('bcryptjs');
    const passwordHash = bcrypt.hashSync('admin', 10);
    db.prepare(
      'INSERT INTO users (name, email, phone, password_hash, role, hotel_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('Admin', 'admin@admin.com','9999999999', passwordHash, 'admin', defaultHotelId);
  }
}

module.exports = { runMigrations };

