const { getDb } = require('../db/database');
const bcrypt = require('bcryptjs');
const { normalizePhone, isValidPhone } = require('./guest.controller');
require('dotenv').config();

function calculateNights(checkIn, checkOut) {
  const inDate = new Date(checkIn);
  const outDate = new Date(checkOut);
  const diffMs = outDate.getTime() - inDate.getTime();
  const nights = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  return nights > 0 ? nights : 0;
}

function getPriceForProperty(db, propertyType, propertyId, nights) {
  let property = null;
  if (propertyType === 'room') {
    property = db
      .prepare('SELECT registrationAmount, arrivalAmount, totalPrice, basePrice FROM rooms WHERE id = ?')
      .get(propertyId);
  } else if (propertyType === 'tent') {
    property = db
      .prepare('SELECT registrationAmount, arrivalAmount, totalPrice, basePrice FROM tents WHERE id = ?')
      .get(propertyId);
  }

  if (!property) {
    return null;
  }

  const registrationPerNight = Number(property.registrationAmount || 0);
  const arrivalPerNight = Number(property.arrivalAmount || 0);
  const totalPerNight = Number(property.totalPrice || 0);

  if (registrationPerNight > 0 && arrivalPerNight > 0 && totalPerNight > 0) {
    const registrationAmount = registrationPerNight * nights;
    const arrivalAmount = arrivalPerNight * nights;
    const totalAmount = totalPerNight * nights;
    return {
      baseAmount: totalAmount,
      taxAmount: 0,
      totalAmount,
      registrationAmount,
      arrivalAmount
    };
  }

  // Backward compatibility for legacy records that still only have basePrice.
  const fallbackTotal = Number(property.basePrice || 0) * nights;
  return {
    baseAmount: fallbackTotal,
    taxAmount: 0,
    totalAmount: fallbackTotal,
    registrationAmount: fallbackTotal,
    arrivalAmount: 0
  };
}

function hasInventoryForDates(db, propertyType, propertyId, checkIn, checkOut) {
  if (propertyType === 'room') {
    const room = db.prepare('SELECT quantity FROM rooms WHERE id = ?').get(propertyId);
    if (!room) {
      return false;
    }
    const totalInventory = Math.max(Number(room.quantity || 1), 1);
    const overlappingCount = db
      .prepare(
        `SELECT COUNT(*) as c FROM bookings
         WHERE property_type = 'room'
           AND property_id = ?
           AND status != 'cancelled'
           AND NOT (date(check_out) <= date(?) OR date(check_in) >= date(?))`
      )
      .get(propertyId, checkIn, checkOut).c;
    return overlappingCount < totalInventory;
  }

  const overlapping = db
    .prepare(
      `SELECT 1 FROM bookings
       WHERE property_type = ?
         AND property_id = ?
         AND status != 'cancelled'
         AND NOT (date(check_out) <= date(?) OR date(check_in) >= date(?))`
    )
    .get(propertyType, propertyId, checkIn, checkOut);
  return !overlapping;
}

function generateBookingRef(db, id) {
  const year = new Date().getFullYear();
  const padded = String(id).padStart(5, '0');
  return `BK-${year}-${padded}`;
}

function validateEmail(email) {
  return typeof email === 'string' && /\S+@\S+\.\S+/.test(email);
}

function fallbackEmail(phone) {
  const digits = phone.replace(/\D/g, '');
  return `user_${digits}@auto.local`;
}

function recalculateStoredBookingAmounts(db, booking) {
  if (!booking || booking.payment_status === 'paid' || !['room', 'tent'].includes(booking.property_type)) {
    return booking;
  }

  const table = booking.property_type === 'room' ? 'rooms' : 'tents';
  const property = db
    .prepare(`SELECT registrationAmount, arrivalAmount, totalPrice FROM ${table} WHERE id = ?`)
    .get(booking.property_id);

  if (!property) {
    return booking;
  }

  const nights = Math.max(Number(booking.nights || 0), 1);
  const registrationPerNight = Number(property.registrationAmount || 0);
  const arrivalPerNight = Number(property.arrivalAmount || 0);
  const totalPerNight = Number(property.totalPrice || 0);

  if (registrationPerNight <= 0 || arrivalPerNight <= 0 || totalPerNight <= 0) {
    return booking;
  }

  const baseAmount = totalPerNight * nights;
  const arrivalAmount = arrivalPerNight * nights;
  const discountAmount = Number(booking.discount_amount || 0);
  const registrationAmount = Math.max(registrationPerNight * nights - discountAmount, 0);
  const totalAmount = Math.max(baseAmount - discountAmount, 0);

  const changed =
    Number(booking.base_amount || 0) !== baseAmount ||
    Number(booking.registration_amount || 0) !== registrationAmount ||
    Number(booking.arrival_amount || 0) !== arrivalAmount ||
    Number(booking.total_amount || 0) !== totalAmount;

  if (!changed) {
    return booking;
  }

  db.prepare(
    `UPDATE bookings
     SET base_amount = ?, registration_amount = ?, arrival_amount = ?, total_amount = ?
     WHERE id = ?`
  ).run(baseAmount, registrationAmount, arrivalAmount, totalAmount, booking.id);

  return {
    ...booking,
    base_amount: baseAmount,
    registration_amount: registrationAmount,
    arrival_amount: arrivalAmount,
    total_amount: totalAmount
  };
}

async function ensureGuestUser(db, { name, phone, email }) {
  let user = db.prepare('SELECT id, name, email, phone, role, hotel_id FROM users WHERE phone = ?').get(phone);
  if (user) {
    return user;
  }

  const autoPassword = `${phone}@pass`;
  const passwordHash = await bcrypt.hash(autoPassword, 10);
  const storedEmail = email || fallbackEmail(phone);
  const emailExists = db.prepare('SELECT id FROM users WHERE email = ?').get(storedEmail);
  const finalEmail = emailExists ? fallbackEmail(`${phone}${Date.now()}`) : storedEmail;

  const insertUser = db.prepare(
    'INSERT INTO users (name, email, password_hash, phone, role, hotel_id) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const userInfo = insertUser.run(name, finalEmail, passwordHash, phone, 'customer', null);
  user = db
    .prepare('SELECT id, name, email, phone, role, hotel_id FROM users WHERE id = ?')
    .get(userInfo.lastInsertRowid);

  return user;
}

async function createBooking(req, res) {
  try {
    const { propertyType, propertyId, checkIn, checkOut, guests, specialRequests, promoCode } = req.body;

    if (!propertyType || !propertyId || !checkIn || !checkOut) {
      return res.status(400).json({ message: 'Missing required booking fields' });
    }
    if (!['room', 'tent'].includes(propertyType)) {
      return res.status(400).json({ message: 'Invalid property type' });
    }

    const db = getDb();
    const nights = calculateNights(checkIn, checkOut);
    if (nights <= 0) {
      return res.status(400).json({ message: 'Checkout must be after checkin' });
    }

    if (!hasInventoryForDates(db, propertyType, propertyId, checkIn, checkOut)) {
      return res.status(400).json({ message: 'Selected dates are not available' });
    }

    const pricing = getPriceForProperty(
      db,
      propertyType,
      propertyId,
      nights
    );
    if (!pricing) {
      return res.status(404).json({ message: 'Property not found' });
    }
    let { baseAmount, taxAmount, totalAmount, registrationAmount, arrivalAmount } = pricing;

    let promoCodeData = null;
    let discountAmount = 0;

    // Handle promo code if provided
    if (promoCode) {
      promoCodeData = db.prepare(`
        SELECT pc.*, u.name as agent_name
        FROM promo_codes pc
        LEFT JOIN users u ON u.id = pc.agent_id
        WHERE pc.code = ? AND pc.status = 'active'
      `).get(promoCode);

      if (!promoCodeData) {
        return res.status(400).json({ message: 'Invalid promo code' });
      }

      // Check if promo code is still valid
      if (promoCodeData.valid_until && new Date(promoCodeData.valid_until) < new Date()) {
        return res.status(400).json({ message: 'Promo code has expired' });
      }

      // Check if max uses reached
      if (promoCodeData.max_uses > 0 && promoCodeData.used_count >= promoCodeData.max_uses) {
        return res.status(400).json({ message: 'Promo code usage limit reached' });
      }

      // Calculate discount
      discountAmount = (baseAmount * promoCodeData.discount_percent) / 100;
      totalAmount = baseAmount + taxAmount - discountAmount;
      registrationAmount = Math.max(registrationAmount - discountAmount, 0);

      // Ensure total amount doesn't go below 0
      if (totalAmount < 0) totalAmount = 0;
    }

    const insertStmt = db.prepare(
      `INSERT INTO bookings (
        booking_ref, user_id, property_type, property_id,
        check_in, check_out, guests, nights,
        base_amount, tax_amount, total_amount, registration_amount, arrival_amount, discount_amount,
        special_requests, status, payment_status, promo_code_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unpaid', ?)`
    );

    const tempRef = `TEMP-${Date.now()}`;
    const info = insertStmt.run(
      tempRef,
      req.user.id,
      propertyType,
      propertyId,
      checkIn,
      checkOut,
      guests || 1,
      nights,
      baseAmount,
      taxAmount,
      totalAmount,
      registrationAmount,
      arrivalAmount,
      discountAmount,
      specialRequests || null,
      promoCodeData ? promoCodeData.id : null
    );

    const bookingId = info.lastInsertRowid;
    const bookingRef = generateBookingRef(db, bookingId);
    db.prepare('UPDATE bookings SET booking_ref = ? WHERE id = ?').run(bookingRef, bookingId);

    // Update promo code usage count
    if (promoCodeData) {
      db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ?').run(promoCodeData.id);

      // Create agent referral record
      db.prepare(`
        INSERT INTO agent_referrals (agent_id, customer_id, booking_id, promo_code_id, discount_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        promoCodeData.agent_id,
        req.user.id,
        bookingId,
        promoCodeData.id,
        discountAmount
      );
    }

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);

    return res.status(201).json(booking);
  } catch (err) {
    console.error('Create booking error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function getMyBookings(req, res) {
  try {
    const db = getDb();
    const bookings = db
      .prepare(
        `SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC`
      )
      .all(req.user.id);
    return res.json(bookings);
  } catch (err) {
    console.error('Get my bookings error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function getBookingById(req, res) {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    let booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }
    if (booking.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }
    booking = recalculateStoredBookingAmounts(db, booking);
    return res.json(booking);
  } catch (err) {
    console.error('Get booking by id error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function cancelBooking(req, res) {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }
    if (booking.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (booking.status === 'cancelled') {
      return res.status(400).json({ message: 'Booking already cancelled' });
    }

    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run('cancelled', id);
    const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    return res.json(updated);
  } catch (err) {
    console.error('Cancel booking error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function createGuestBooking(req, res) {
  try {
    const {
      name,
      phone,
      email,
      propertyType,
      propertyId,
      checkIn,
      checkOut,
      guests,
      specialRequests,
      promoCode
    } = req.body;

    const normalizedPhone = normalizePhone(phone);
    const trimmedName = String(name || '').trim();
    const trimmedEmail = email ? String(email).trim() : '';

    if (!normalizedPhone || !trimmedName) {
      return res.status(400).json({ message: 'Name and phone number are required' });
    }
    if (!isValidPhone(normalizedPhone)) {
      return res.status(400).json({ message: 'Valid phone number is required' });
    }
    if (trimmedEmail && !validateEmail(trimmedEmail)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }
    if (!propertyType || !propertyId || !checkIn || !checkOut) {
      return res.status(400).json({ message: 'Missing required booking fields' });
    }
    if (!['room', 'tent'].includes(propertyType)) {
      return res.status(400).json({ message: 'Invalid property type' });
    }

    const db = getDb();

    const user = await ensureGuestUser(db, {
      name: trimmedName,
      phone: normalizedPhone,
      email: trimmedEmail
    });

    const nights = calculateNights(checkIn, checkOut);
    if (nights <= 0) {
      return res.status(400).json({ message: 'Checkout must be after checkin' });
    }

    if (!hasInventoryForDates(db, propertyType, propertyId, checkIn, checkOut)) {
      return res.status(400).json({ message: 'Selected dates are not available' });
    }

    const pricing = getPriceForProperty(db, propertyType, propertyId, nights);
    if (!pricing) {
      return res.status(404).json({ message: 'Property not found' });
    }
    let { baseAmount, taxAmount, totalAmount, registrationAmount, arrivalAmount } = pricing;

    let promoCodeData = null;
    let discountAmount = 0;

    if (promoCode) {
      promoCodeData = db.prepare(`
        SELECT pc.*, u.name as agent_name
        FROM promo_codes pc
        LEFT JOIN users u ON u.id = pc.agent_id
        WHERE pc.code = ? AND pc.status = 'active'
      `).get(promoCode);

      if (!promoCodeData) {
        return res.status(400).json({ message: 'Invalid promo code' });
      }
      if (promoCodeData.valid_until && new Date(promoCodeData.valid_until) < new Date()) {
        return res.status(400).json({ message: 'Promo code has expired' });
      }
      if (promoCodeData.max_uses > 0 && promoCodeData.used_count >= promoCodeData.max_uses) {
        return res.status(400).json({ message: 'Promo code usage limit reached' });
      }

      discountAmount = (baseAmount * promoCodeData.discount_percent) / 100;
      totalAmount = baseAmount + taxAmount - discountAmount;
      if (totalAmount < 0) totalAmount = 0;
      registrationAmount = Math.max(registrationAmount - discountAmount, 0);
    }

    const insertStmt = db.prepare(
      `INSERT INTO bookings (
        booking_ref, user_id, property_type, property_id,
        check_in, check_out, guests, nights,
        base_amount, tax_amount, total_amount, registration_amount, arrival_amount, discount_amount,
        special_requests, status, payment_status, promo_code_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'unpaid', ?)`
    );

    const tempRef = `TEMP-${Date.now()}`;
    const info = insertStmt.run(
      tempRef,
      user.id,
      propertyType,
      propertyId,
      checkIn,
      checkOut,
      guests || 1,
      nights,
      baseAmount,
      taxAmount,
      totalAmount,
      registrationAmount,
      arrivalAmount,
      discountAmount,
      specialRequests || null,
      promoCodeData ? promoCodeData.id : null
    );

    const bookingId = info.lastInsertRowid;
    const bookingRef = generateBookingRef(db, bookingId);
    db.prepare('UPDATE bookings SET booking_ref = ? WHERE id = ?').run(bookingRef, bookingId);

    if (promoCodeData) {
      db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ?').run(promoCodeData.id);
      db.prepare(`
        INSERT INTO agent_referrals (agent_id, customer_id, booking_id, promo_code_id, discount_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(promoCodeData.agent_id, user.id, bookingId, promoCodeData.id, discountAmount);
    }

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);

    return res.status(201).json({
      booking: {
        ...booking,
        guest_name: user.name,
        guest_phone: user.phone,
        guest_email: trimmedEmail || user.email || null
      },
      guest_id: String(user.id)
    });
  } catch (err) {
    console.error('Create guest booking error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function getGuestBookingById(req, res) {
  try {
    const bookingId = Number(req.params.id);
    const phone = normalizePhone(req.query.phone);
    if (!bookingId) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }
    if (!isValidPhone(phone)) {
      return res.status(400).json({ message: 'Valid phone number is required' });
    }

    const db = getDb();
    let booking = db
      .prepare(
        `SELECT b.*,
                u.name as guest_name,
                u.phone as guest_phone,
                u.email as guest_email
         FROM bookings b
         JOIN users u ON u.id = b.user_id
         WHERE b.id = ?`
      )
      .get(bookingId);

    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }
    if (booking.guest_phone !== phone) {
      return res.status(403).json({ message: 'Access denied' });
    }

    booking = recalculateStoredBookingAmounts(db, booking);
    return res.json(booking);
  } catch (err) {
    console.error('Get guest booking by id error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  createBooking,
  createGuestBooking,
  getGuestBookingById,
  getMyBookings,
  getBookingById,
  cancelBooking
};

