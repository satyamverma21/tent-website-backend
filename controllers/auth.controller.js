const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');
const { sendWhatsappOtp } = require('../utils/whatsapp');
const { normalizePhone, isValidPhone } = require('./guest.controller');
require('dotenv').config();

function validateEmail(email) {
  return typeof email === 'string' && /\S+@\S+\.\S+/.test(email);
}

async function register(req, res) {
  try {
    const { name, email, password, phone } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({ message: 'Name, phone and password are required' });
    }

    if (email && !validateEmail(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const db = getDb();

    // Ensure email (if provided) and phone are unique
    if (email) {
      const existingByEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existingByEmail) {
        return res.status(400).json({ message: 'Email is already registered' });
      }
    }

    const existingByPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
    if (existingByPhone) {
      return res.status(400).json({ message: 'Phone is already registered' });
    }

    // Email column is NOT NULL in schema; generate a placeholder if user didn't provide one
    const storedEmail = email || `user_${phone}@auto.local`;

    const passwordHash = await bcrypt.hash(password, 10);
    const stmt = db.prepare(
      'INSERT INTO users (name, email, password_hash, phone, role, hotel_id) VALUES (?, ?, ?, ?, ?, ?)'
    );

    // Public registration users are not tied to a specific hotel by default
    const info = stmt.run(name, storedEmail, passwordHash, phone || null, 'customer', null);

    const user = db.prepare('SELECT id, name, email, phone, role, hotel_id FROM users WHERE id = ?').get(
      info.lastInsertRowid
    );

    // Generate and store OTP for phone verification
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    db.prepare(
      "INSERT INTO phone_verifications (user_id, phone, otp, expires_at, verified) VALUES (?, ?, ?, datetime('now', '+10 minutes'), 0)"
    ).run(user.id, phone, otp);

    // Fire-and-forget WhatsApp send (do not block registration on failures)
    sendWhatsappOtp(phone, otp).catch((err) => {
      console.error('Failed to send WhatsApp OTP', err);
    });

    const token = signAuthToken(user, process.env.JWT_EXPIRES_IN || '7d');

    return res.status(201).json({ token, user });
  } catch (err) {
    console.error('Register error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function login(req, res) {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ message: 'Phone and password are required' });
    }

    const db = getDb();
    const user = db
      .prepare(
        'SELECT id, name, email, phone, role, password_hash, hotel_id FROM users WHERE phone = ?'
      )
      .get(phone);

    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = signAuthToken(user, process.env.JWT_EXPIRES_IN || '7d');

    const { password_hash, ...publicUser } = user;

    return res.json({ token, user: publicUser });
  } catch (err) {
    console.error('Login error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function verifyPhone(req, res) {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ message: 'Phone and OTP are required' });
    }

    const db = getDb();
    const record = db
      .prepare(
        `
        SELECT id, user_id, phone, otp, expires_at, verified
        FROM phone_verifications
        WHERE phone = ? AND otp = ?
        ORDER BY created_at DESC
        LIMIT 1
      `
      )
      .get(phone, otp);

    if (!record) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    if (record.verified) {
      return res.status(400).json({ message: 'OTP already used' });
    }

    const nowRow = db.prepare('SELECT datetime("now") as now').get();
    if (nowRow.now > record.expires_at) {
      return res.status(400).json({ message: 'OTP has expired' });
    }

    db.prepare('UPDATE phone_verifications SET verified = 1 WHERE id = ?').run(record.id);

    return res.json({ message: 'Phone verified successfully' });
  } catch (err) {
    console.error('Verify phone error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function me(req, res) {
  try {
    const db = getDb();
    const user = db
      .prepare(
        `SELECT u.id,
                u.name,
                u.email,
                u.phone,
                u.role,
                u.hotel_id,
                h.name as hotel_name
         FROM users u
         LEFT JOIN hotels h ON h.id = u.hotel_id
         WHERE u.id = ?`
      )
      .get(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.json({
      guest_id: String(user.id),
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email && user.email.endsWith('@auto.local') ? null : user.email,
      role: user.role,
      hotel_id: user.hotel_id || null,
      hotel_name: user.hotel_name || null
    });
  } catch (err) {
    console.error('Me error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

function fallbackEmail(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return `user_${digits}@auto.local`;
}

function signAuthToken(user, expiresIn) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      hotelId: user.hotel_id || null
    },
    process.env.JWT_SECRET,
    { expiresIn }
  );
}

async function phoneLogin(req, res) {
  try {
    const phone = normalizePhone(req.body.phone);
    const name = String(req.body.name || '').trim();
    const email = req.body.email ? String(req.body.email).trim() : '';

    if (!isValidPhone(phone)) {
      return res.status(400).json({ message: 'Valid phone number is required' });
    }
    if (email && !validateEmail(email)) {
      return res.status(400).json({ message: 'Invalid email format' });
    }

    const db = getDb();
    let user = db
      .prepare('SELECT id, name, email, phone, role, password_hash, hotel_id FROM users WHERE phone = ?')
      .get(phone);

    let exists = !!user;

    if (!user) {
      const finalName = name || 'Guest User';
      const storedEmail = email || fallbackEmail(phone);
      const emailExists = db.prepare('SELECT id FROM users WHERE email = ?').get(storedEmail);
      const finalEmail = emailExists ? fallbackEmail(`${phone}${Date.now()}`) : storedEmail;
      const passwordHash = await bcrypt.hash(`${phone}@pass`, 10);

      const info = db
        .prepare(
          'INSERT INTO users (name, email, password_hash, phone, role, hotel_id) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(finalName, finalEmail, passwordHash, phone, 'customer', null);

      user = db
        .prepare('SELECT id, name, email, phone, role, password_hash, hotel_id FROM users WHERE id = ?')
        .get(info.lastInsertRowid);
      exists = false;
    } else {
      // Keep returning guest data current when caller provides newer values.
      const nextName = name || user.name;
      let nextEmail = user.email;
      if (email && validateEmail(email)) {
        const emailTaken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, user.id);
        if (!emailTaken) {
          nextEmail = email;
        }
      }

      if (nextName !== user.name || nextEmail !== user.email) {
        db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(nextName, nextEmail, user.id);
        user = db
          .prepare('SELECT id, name, email, phone, role, password_hash, hotel_id FROM users WHERE id = ?')
          .get(user.id);
      }
    }

    const token = signAuthToken(user, process.env.PHONE_LOGIN_JWT_EXPIRES_IN || '30d');

    return res.json({
      guest_id: String(user.id),
      token,
      exists,
      name: user.name,
      phone: user.phone,
      email: user.email && user.email.endsWith('@auto.local') ? null : user.email
    });
  } catch (err) {
    console.error('Phone login error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  register,
  login,
  me,
  verifyPhone,
  phoneLogin
};

