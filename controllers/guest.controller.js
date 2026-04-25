const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');

function normalizePhone(phone) {
  return String(phone || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^\d+]/g, '');
}

function isValidPhone(phone) {
  return /^\+?\d{10,15}$/.test(phone);
}

function validateEmail(email) {
  return typeof email === 'string' && /\S+@\S+\.\S+/.test(email);
}

function fallbackEmail(phone) {
  const digits = phone.replace(/\D/g, '');
  return `user_${digits}@auto.local`;
}

async function checkPhone(req, res) {
  try {
    const normalizedPhone = normalizePhone(req.query.phone);
    if (!isValidPhone(normalizedPhone)) {
      return res.status(400).json({ message: 'Valid phone number is required' });
    }

    const db = getDb();
    const user = db.prepare('SELECT id FROM users WHERE phone = ?').get(normalizedPhone);

    return res.json({
      exists: !!user,
      guest_id: user ? String(user.id) : null
    });
  } catch (err) {
    console.error('Check phone error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function createGuest(req, res) {
  try {
    const normalizedPhone = normalizePhone(req.body.phone);
    const name = String(req.body.name || '').trim();
    const password = String(req.body.password || `${normalizedPhone}@pass`);
    const email = req.body.email ? String(req.body.email).trim() : '';

    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }
    if (!isValidPhone(normalizedPhone)) {
      return res.status(400).json({ message: 'Valid phone number is required' });
    }
    if (email && !validateEmail(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(normalizedPhone);
    if (existing) {
      return res.json({ guest_id: String(existing.id) });
    }

    const storedEmail = email || fallbackEmail(normalizedPhone);
    const emailExists = db.prepare('SELECT id FROM users WHERE email = ?').get(storedEmail);
    const finalEmail = emailExists ? fallbackEmail(`${normalizedPhone}${Date.now()}`) : storedEmail;

    const passwordHash = await bcrypt.hash(password, 10);
    const info = db
      .prepare(
        'INSERT INTO users (name, email, password_hash, phone, role, hotel_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(name, finalEmail, passwordHash, normalizedPhone, 'customer', null);

    return res.status(201).json({ guest_id: String(info.lastInsertRowid) });
  } catch (err) {
    console.error('Create guest error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function updateGuestProfile(req, res) {
  try {
    const name = String(req.body.name || '').trim();
    const email = req.body.email ? String(req.body.email).trim() : '';

    if (!req.user || !req.user.id) {
      return res.status(401).json({ message: 'Authorization token missing' });
    }
    if (!name) {
      return res.status(400).json({ message: 'Name is required' });
    }
    if (email && !validateEmail(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    const db = getDb();
    if (email) {
      const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
      if (taken) {
        return res.status(400).json({ message: 'Email is already in use' });
      }
    }

    const existing = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
    if (!existing) {
      return res.status(404).json({ message: 'Guest not found' });
    }
    const finalEmail = email || existing.email || fallbackEmail(`guest_${req.user.id}`);

    db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, finalEmail, req.user.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Update guest profile error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  checkPhone,
  createGuest,
  updateGuestProfile,
  normalizePhone,
  isValidPhone
};
