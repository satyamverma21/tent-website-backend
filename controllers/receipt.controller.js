const { getDb } = require('../db/database');
const { generateReceiptPdf } = require('../utils/pdfGenerator');
const { normalizePhone, isValidPhone } = require('./guest.controller');

async function getReceipt(req, res) {
  try {
    const bookingId = Number(req.params.bookingId);
    const db = getDb();

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (req.user) {
      if (booking.user_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Access denied' });
      }
    } else {
      const phone = normalizePhone(req.query.phone);
      if (!isValidPhone(phone)) {
        return res.status(400).json({ message: 'Valid phone number is required' });
      }
      const owner = db.prepare('SELECT phone FROM users WHERE id = ?').get(booking.user_id);
      if (!owner || owner.phone !== phone) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }
    if (booking.payment_status !== 'paid') {
      return res.status(400).json({ message: 'Receipt available only for paid bookings' });
    }

    const user = db
      .prepare('SELECT id, name, email, phone FROM users WHERE id = ?')
      .get(booking.user_id);

    let propertyTable = booking.property_type === 'room' ? 'rooms' : 'tents';
    const property = db
      .prepare(`SELECT id, name, type, description FROM ${propertyTable} WHERE id = ?`)
      .get(booking.property_id);

    const payment = db
      .prepare('SELECT * FROM payments WHERE booking_id = ? AND status = "success"')
      .get(bookingId);

    const buffer = await generateReceiptPdf(booking, payment, user, property);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=receipt-${booking.booking_ref}.pdf`
    );

    return res.send(buffer);
  } catch (err) {
    console.error('Get receipt error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  getReceipt
};

