const { getDb } = require('../db/database');

async function createEnquiry(req, res) {
  try {
    const { name, email, phone, interestedIn, approxGuests, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ message: 'Name, email and message are required' });
    }

    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO enquiries (name, email, phone, interested_in, approx_guests, message, status)
       VALUES (?, ?, ?, ?, ?, ?, 'new')`
    );
    const info = stmt.run(
      name,
      email,
      phone || null,
      interestedIn || null,
      approxGuests || null,
      message
    );

    const enquiry = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json(enquiry);
  } catch (err) {
    console.error('Create enquiry error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  createEnquiry
};

