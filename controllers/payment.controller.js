const { getDb } = require('../db/database');
const { normalizePhone, isValidPhone } = require('./guest.controller');
require('dotenv').config();

function hasBookingAccess(db, booking, req, phone) {
  if (req.user) {
    return booking.user_id === req.user.id || req.user.role === 'admin';
  }
  if (!isValidPhone(phone)) {
    return false;
  }
  const user = db.prepare('SELECT phone FROM users WHERE id = ?').get(booking.user_id);
  return !!user && user.phone === phone;
}

function recalculateBookingAmounts(db, booking) {
  if (!['room', 'tent'].includes(booking.property_type)) {
    return null;
  }

  const table = booking.property_type === 'room' ? 'rooms' : 'tents';
  const property = db
    .prepare(`SELECT registrationAmount, arrivalAmount, totalPrice FROM ${table} WHERE id = ?`)
    .get(booking.property_id);

  if (!property) {
    return null;
  }

  const nights = Math.max(Number(booking.nights || 0), 1);
  const registrationPerNight = Number(property.registrationAmount || 0);
  const arrivalPerNight = Number(property.arrivalAmount || 0);
  const totalPerNight = Number(property.totalPrice || 0);

  if (registrationPerNight <= 0 || arrivalPerNight <= 0 || totalPerNight <= 0) {
    return null;
  }

  const baseAmount = totalPerNight * nights;
  const arrivalAmount = arrivalPerNight * nights;
  const discountAmount = Number(booking.discount_amount || 0);
  const registrationAmount = Math.max(registrationPerNight * nights - discountAmount, 0);
  const totalAmount = Math.max(baseAmount - discountAmount, 0);

  return {
    baseAmount,
    registrationAmount,
    arrivalAmount,
    totalAmount
  };
}

function getHotelNameForBooking(db, booking) {
  if (!booking || !['room', 'tent'].includes(booking.property_type)) {
    return '';
  }
  const table = booking.property_type === 'room' ? 'rooms' : 'tents';
  const property = db.prepare(`SELECT name, hotel_id FROM ${table} WHERE id = ?`).get(booking.property_id);
  if (!property) {
    return '';
  }
  if (property.hotel_id) {
    const hotel = db.prepare('SELECT name FROM hotels WHERE id = ?').get(property.hotel_id);
    if (hotel?.name) {
      return String(hotel.name).trim();
    }
  }
  return String(property.name || '').trim();
}

function getSupportContactsForBooking(db, booking) {
  if (!booking || !['room', 'tent'].includes(booking.property_type)) {
    return { hotelAdminPhone: '', mainAdminPhone: '' };
  }

  const table = booking.property_type === 'room' ? 'rooms' : 'tents';
  const property = db.prepare(`SELECT hotel_id FROM ${table} WHERE id = ?`).get(booking.property_id);
  const hotelId = property?.hotel_id ? Number(property.hotel_id) : null;

  const mainAdmin = db
    .prepare(
      `SELECT phone
       FROM users
       WHERE role = 'admin' AND phone IS NOT NULL AND TRIM(phone) != ''
       ORDER BY id ASC
       LIMIT 1`
    )
    .get();

  let hotelAdmin = null;
  if (hotelId) {
    hotelAdmin = db
      .prepare(
        `SELECT phone
         FROM users
         WHERE role = 'hotel-admin'
           AND hotel_id = ?
           AND phone IS NOT NULL
           AND TRIM(phone) != ''
         ORDER BY id ASC
         LIMIT 1`
      )
      .get(hotelId);
  }

  return {
    hotelAdminPhone: String(hotelAdmin?.phone || '').trim(),
    mainAdminPhone: String(mainAdmin?.phone || '').trim()
  };
}

async function createPaymentOrder(req, res) {
  try {
    const { bookingId, phone } = req.body;
    if (!bookingId) {
      return res.status(400).json({ message: 'bookingId is required' });
    }

    const db = getDb();
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }
    const normalizedPhone = normalizePhone(phone);
    if (!hasBookingAccess(db, booking, req, normalizedPhone)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (booking.payment_status === 'paid') {
      return res.status(400).json({ message: 'Booking already paid' });
    }
    if (booking.payment_status === 'pending_verification') {
      return res.status(400).json({ message: 'Payment verification is already pending for this booking' });
    }

    const recalculated = recalculateBookingAmounts(db, booking);
    if (recalculated && booking.payment_status !== 'paid') {
      const regChanged = Number(booking.registration_amount || 0) !== recalculated.registrationAmount;
      const arrChanged = Number(booking.arrival_amount || 0) !== recalculated.arrivalAmount;
      const totalChanged = Number(booking.total_amount || 0) !== recalculated.totalAmount;
      const baseChanged = Number(booking.base_amount || 0) !== recalculated.baseAmount;

      if (regChanged || arrChanged || totalChanged || baseChanged) {
        db.prepare(
          `UPDATE bookings
           SET base_amount = ?, registration_amount = ?, arrival_amount = ?, total_amount = ?
           WHERE id = ?`
        ).run(
          recalculated.baseAmount,
          recalculated.registrationAmount,
          recalculated.arrivalAmount,
          recalculated.totalAmount,
          booking.id
        );
        booking.base_amount = recalculated.baseAmount;
        booking.registration_amount = recalculated.registrationAmount;
        booking.arrival_amount = recalculated.arrivalAmount;
        booking.total_amount = recalculated.totalAmount;
      }
    }

    const registrationAmount = Number(booking.registration_amount || booking.total_amount || 0);
    const arrivalAmount = Number(booking.arrival_amount || 0);
    const totalAmount = Number(booking.total_amount || registrationAmount + arrivalAmount);
    if (registrationAmount <= 0) {
      return res.status(400).json({ message: 'Invalid downpayment amount for this booking' });
    }

    const paytmUpiId = String(process.env.PAYTM_UPI_ID || '').trim();
    const paytmUpiName = String(process.env.PAYTM_UPI_NAME || '').trim();
    const phonepeUpiId = String(process.env.PHONEPE_UPI_ID || '').trim();
    const phonepeUpiName = String(process.env.PHONEPE_UPI_NAME || '').trim();

    if (!paytmUpiId || !paytmUpiName || !phonepeUpiId || !phonepeUpiName) {
      return res.status(500).json({
        message:
          'UPI payment config missing. Set PAYTM_UPI_ID, PAYTM_UPI_NAME, PHONEPE_UPI_ID and PHONEPE_UPI_NAME.'
      });
    }

    const amountText = registrationAmount.toFixed(2);
    const hotelName = getHotelNameForBooking(db, booking);
    const transactionNote = hotelName
      ? `${hotelName} - Booking ${booking.booking_ref}`
      : `Booking ${booking.booking_ref}`;

    const upiBase = (upiId, upiName) =>
      `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(
        upiName
      )}&am=${encodeURIComponent(amountText)}&cu=INR&tn=${encodeURIComponent(transactionNote)}`;

    const paytmUpiUri = upiBase(paytmUpiId, paytmUpiName);
    const phonepeUpiUri = upiBase(phonepeUpiId, phonepeUpiName);
    const paytmDeepLink = `paytmmp://pay?pa=${encodeURIComponent(
      paytmUpiId
    )}&pn=${encodeURIComponent(paytmUpiName)}&am=${encodeURIComponent(
      amountText
    )}&cu=INR&tn=${encodeURIComponent(transactionNote)}`;
    const phonepeDeepLink = `phonepe://upi/pay?pa=${encodeURIComponent(
      phonepeUpiId
    )}&pn=${encodeURIComponent(phonepeUpiName)}&am=${encodeURIComponent(
      amountText
    )}&cu=INR&tn=${encodeURIComponent(transactionNote)}`;

    const existingPayment = db.prepare('SELECT * FROM payments WHERE booking_id = ?').get(bookingId);
    if (!existingPayment) {
      db.prepare(
        `INSERT INTO payments (booking_id, amount, currency, status)
         VALUES (?, ?, ?, 'pending')`
      ).run(bookingId, registrationAmount, 'INR');
    } else if (existingPayment.status !== 'success') {
      db.prepare(
        `UPDATE payments
         SET amount = ?, currency = 'INR', status = 'pending'
         WHERE booking_id = ?`
      ).run(registrationAmount, bookingId);
    }

    return res.json({
      amount: registrationAmount,
      currency: 'INR',
      upiIds: {
        paytm: paytmUpiId,
        phonepe: phonepeUpiId
      },
      deepLinks: {
        paytm: paytmDeepLink,
        phonepe: phonepeDeepLink
      },
      upiLinks: {
        paytm: paytmUpiUri,
        phonepe: phonepeUpiUri
      },
      bookingRef: booking.booking_ref,
      paymentBreakdown: {
        paidNow: registrationAmount,
        dueOnArrival: arrivalAmount,
        total: totalAmount
      }
    });
  } catch (err) {
    console.error('Create payment order error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function verifyPayment(req, res) {
  try {
    const { bookingId, phone, transactionId, method } = req.body;
    if (!bookingId) {
      return res.status(400).json({ message: 'bookingId is required' });
    }
    const db = getDb();
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!hasBookingAccess(db, booking, req, normalizedPhone)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (booking.payment_status === 'paid') {
      return res.json({ success: true, booking, verificationRequired: false });
    }
    if (booking.payment_status === 'pending_verification') {
      return res.status(400).json({ message: 'Payment verification is already pending for this booking' });
    }

    const now = new Date().toISOString();
    const payment = db.prepare('SELECT * FROM payments WHERE booking_id = ?').get(bookingId);
    if (!payment) {
      db.prepare(
        `INSERT INTO payments (booking_id, amount, currency, status, paid_at, razorpay_payment_id, razorpay_signature)
         VALUES (?, ?, 'INR', 'pending_verification', ?, ?, ?)`
      ).run(
        bookingId,
        Number(booking.registration_amount || booking.total_amount || 0),
        now,
        transactionId || `manual_${Date.now()}`,
        method || 'upi'
      );
    } else {
      db.prepare(
        `UPDATE payments 
         SET razorpay_payment_id = ?, razorpay_signature = ?, status = 'pending_verification', paid_at = ?
         WHERE booking_id = ?`
      ).run(transactionId || `manual_${Date.now()}`, method || 'upi', now, bookingId);
    }

    db.prepare(
      `UPDATE bookings 
       SET payment_status = 'pending_verification'
       WHERE id = ?`
    ).run(bookingId);

    const updatedBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);

    return res.json({
      success: true,
      verificationRequired: true,
      message: 'Payment submitted. Our team will verify and confirm shortly.',
      booking: updatedBooking,
      supportContacts: getSupportContactsForBooking(db, updatedBooking),
      paymentBreakdown: {
        paidNow: Number(updatedBooking.registration_amount || updatedBooking.total_amount || 0),
        dueOnArrival: Number(updatedBooking.arrival_amount || 0),
        total: Number(updatedBooking.total_amount || 0)
      }
    });
  } catch (err) {
    console.error('Verify payment error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function getPaymentByBooking(req, res) {
  try {
    const bookingId = Number(req.params.bookingId);
    const normalizedPhone = normalizePhone(req.query.phone);
    const db = getDb();
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }
    if (!hasBookingAccess(db, booking, req, normalizedPhone)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const payment = db.prepare('SELECT * FROM payments WHERE booking_id = ?').get(bookingId);
    return res.json({
      payment: payment || null,
      supportContacts: getSupportContactsForBooking(db, booking)
    });
  } catch (err) {
    console.error('Get payment by booking error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  createPaymentOrder,
  verifyPayment,
  getPaymentByBooking
};

