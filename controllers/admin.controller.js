const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { MAX_IMAGES_PER_PROPERTY } = require('../middleware/upload.middleware');
const bcrypt = require('bcryptjs');
require('dotenv').config();

function getTodayDateString() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function addDaysToDateString(dateText, days) {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return getTodayDateString();
  }
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function isValidDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function assignRoomUnitLabels(entries, roomQuantity) {
  const maxUnits = Math.max(Number(roomQuantity || 1), 1);
  const sorted = [...entries].sort((a, b) => {
    const aKey = `${a.check_in}|${a.check_out}|${a.created_at || ''}|${a.booking_ref || ''}`;
    const bKey = `${b.check_in}|${b.check_out}|${b.created_at || ''}|${b.booking_ref || ''}`;
    return aKey.localeCompare(bKey);
  });

  const slotEnds = Array.from({ length: maxUnits }, () => '');
  sorted.forEach((entry) => {
    const requiredUnitsRaw =
      entry.source_type === 'manual'
        ? Number(entry.manual_booked_quantity || 0)
        : Number(entry.status === 'cancelled' ? 0 : 1);
    const requiredUnits = Math.max(Math.min(requiredUnitsRaw, maxUnits), 0);
    if (requiredUnits <= 0) {
      entry.room_unit_ids = [];
      entry.room_unit_label = '-';
      return;
    }

    const availableSlots = [];
    for (let i = 0; i < maxUnits; i += 1) {
      if (!slotEnds[i] || String(slotEnds[i]) <= String(entry.check_in)) {
        availableSlots.push(i + 1);
      }
    }

    const assigned = availableSlots.slice(0, requiredUnits);

    assigned.forEach((slotId) => {
      slotEnds[slotId - 1] = entry.check_out;
    });
    entry.room_unit_ids = assigned;
    entry.room_unit_label =
      assigned.length === requiredUnits
        ? assigned.join(', ')
        : `${assigned.join(', ') || '-'} (overbooked)`;
  });
}

function getScopedRoomById(db, user, roomId) {
  const room = db
    .prepare('SELECT id, name, quantity, hotel_id FROM rooms WHERE id = ?')
    .get(roomId);
  if (!room) {
    return null;
  }
  if (user.role === 'hotel-admin' && Number(user.hotelId || 0) !== Number(room.hotel_id || 0)) {
    return null;
  }
  return room;
}

function getScopedTentById(db, user, tentId) {
  const tent = db
    .prepare('SELECT id, name, quantity, hotel_id FROM tents WHERE id = ?')
    .get(tentId);
  if (!tent) {
    return null;
  }
  if (user.role === 'hotel-admin' && Number(user.hotelId || 0) !== Number(tent.hotel_id || 0)) {
    return null;
  }
  return tent;
}

function getBookingHotelId(db, booking) {
  if (!booking || !booking.property_type || !booking.property_id) {
    return null;
  }
  if (booking.property_type === 'room') {
    const room = db.prepare('SELECT hotel_id FROM rooms WHERE id = ?').get(booking.property_id);
    return room ? room.hotel_id : null;
  }
  if (booking.property_type === 'tent') {
    const tent = db.prepare('SELECT hotel_id FROM tents WHERE id = ?').get(booking.property_id);
    return tent ? tent.hotel_id : null;
  }
  return null;
}

function normalizeAmenitiesInput(inputAmenities, fallbackAmenities) {
  if (inputAmenities === undefined) {
    return fallbackAmenities;
  }

  let value = inputAmenities;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return JSON.stringify([]);
    }
    try {
      value = JSON.parse(trimmed);
    } catch (_) {
      value = [trimmed];
    }
  }

  if (!Array.isArray(value)) {
    value = value == null ? [] : [String(value)];
  }

  const normalized = value.map((item) => String(item).trim()).filter(Boolean);
  return JSON.stringify(normalized);
}

async function getDashboard(req, res) {
  try {
    const db = getDb();
    const isHotelAdmin = req.user.role === 'hotel-admin';
    const revenueAmountColumn = isHotelAdmin ? 'b.arrival_amount' : 'b.registration_amount';
    const hotelId = req.user.hotelId ? Number(req.user.hotelId) : null;
    if (isHotelAdmin && !hotelId) {
      return res.status(400).json({ message: 'Hotel not assigned to this user' });
    }

    const scopedJoin =
      " LEFT JOIN rooms r ON b.property_type = 'room' AND r.id = b.property_id " +
      " LEFT JOIN tents t ON b.property_type = 'tent' AND t.id = b.property_id ";
    const scopedWhere = isHotelAdmin ? ' WHERE COALESCE(r.hotel_id, t.hotel_id) = ?' : '';

    const totalBookings = db
      .prepare(`SELECT COUNT(*) as count FROM bookings b ${scopedJoin}${scopedWhere}`)
      .get(...(isHotelAdmin ? [hotelId] : [])).count;

    const thisMonthStart = new Date();
    thisMonthStart.setDate(1);
    const monthStartStr = thisMonthStart.toISOString().slice(0, 10);
    const thisMonthRevenue = db
      .prepare(
        `SELECT IFNULL(SUM(CASE WHEN b.payment_status = 'paid' THEN ${revenueAmountColumn} ELSE 0 END), 0) as revenue
         FROM bookings b
         ${scopedJoin}
         WHERE date(b.created_at) >= date(?)
           ${isHotelAdmin ? 'AND COALESCE(r.hotel_id, t.hotel_id) = ?' : ''}`
      )
      .get(...(isHotelAdmin ? [monthStartStr, hotelId] : [monthStartStr])).revenue;

    const today = getTodayDateString();
    const activeRooms = db
      .prepare(
        `SELECT COUNT(*) as c FROM rooms
         WHERE status = 'active'
           ${isHotelAdmin ? 'AND hotel_id = ?' : ''}`
      )
      .get(...(isHotelAdmin ? [hotelId] : [])).c;
    const activeTents = db
      .prepare(
        `SELECT COUNT(*) as c FROM tents
         WHERE status = 'active'
           ${isHotelAdmin ? 'AND hotel_id = ?' : ''}`
      )
      .get(...(isHotelAdmin ? [hotelId] : [])).c;
    const totalProperties = activeRooms + activeTents || 1;

    const todaysConfirmed = db
      .prepare(
        `SELECT COUNT(*) as c
         FROM bookings b
         ${scopedJoin}
         WHERE b.status = 'confirmed'
           AND date(b.check_in) <= date(?)
           AND date(b.check_out) > date(?)
           ${isHotelAdmin ? 'AND COALESCE(r.hotel_id, t.hotel_id) = ?' : ''}`
      )
      .get(...(isHotelAdmin ? [today, today, hotelId] : [today, today])).c;
    const occupancy = (todaysConfirmed / totalProperties) * 100;

    const pendingEnquiries = isHotelAdmin
      ? 0
      : db.prepare(`SELECT COUNT(*) as c FROM enquiries WHERE status = 'new'`).get().c;

    const recentBookings = db
      .prepare(
        `SELECT b.*,
                u.name as guest_name,
                u.phone as guest_phone,
                COALESCE(r.name, t.name) as property_name,
                COALESCE(hr.name, ht.name) as hotel_name
         FROM bookings b
         LEFT JOIN users u ON u.id = b.user_id
         LEFT JOIN rooms r ON b.property_type = 'room' AND r.id = b.property_id
         LEFT JOIN tents t ON b.property_type = 'tent' AND t.id = b.property_id
         LEFT JOIN hotels hr ON hr.id = r.hotel_id
         LEFT JOIN hotels ht ON ht.id = t.hotel_id
         ${
           isHotelAdmin
             ? "WHERE COALESCE(r.hotel_id, t.hotel_id) = ? AND b.status = 'confirmed'"
             : ''
         }
         ORDER BY b.created_at DESC
         LIMIT 50`
      )
      .all(...(isHotelAdmin ? [hotelId] : []));

    const scopedRecentBookings = isHotelAdmin
      ? recentBookings.map((booking) => ({
          booking_ref: booking.booking_ref,
          guest_name: booking.guest_name,
          guest_phone: booking.guest_phone,
          property_name: booking.property_name,
          property_type: booking.property_type,
          check_in: booking.check_in,
          check_out: booking.check_out,
          arrival_amount: Number(booking.arrival_amount || 0),
          status: booking.status,
          hotel_name: booking.hotel_name
        }))
      : recentBookings;

    const hotelWiseSummary = db
      .prepare(
        `SELECT COALESCE(h.name, 'Unassigned') as hotel_name,
                COUNT(*) as total_bookings,
                SUM(CASE WHEN b.status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_bookings,
                SUM(CASE WHEN b.status = 'pending' THEN 1 ELSE 0 END) as pending_bookings,
                IFNULL(SUM(CASE WHEN b.payment_status = 'paid' THEN ${revenueAmountColumn} ELSE 0 END), 0) as paid_revenue
         FROM bookings b
         LEFT JOIN rooms r ON b.property_type = 'room' AND r.id = b.property_id
         LEFT JOIN tents t ON b.property_type = 'tent' AND t.id = b.property_id
         LEFT JOIN hotels h ON h.id = COALESCE(r.hotel_id, t.hotel_id)
         WHERE 1 = 1
           ${isHotelAdmin ? 'AND COALESCE(r.hotel_id, t.hotel_id) = ?' : ''}
         GROUP BY COALESCE(h.id, -1), COALESCE(h.name, 'Unassigned')
         ORDER BY paid_revenue DESC, total_bookings DESC`
      )
      .all(...(isHotelAdmin ? [hotelId] : []));

    return res.json({
      totalBookings,
      thisMonthRevenue,
      occupancy: Number(occupancy.toFixed(2)),
      pendingEnquiries,
      recentBookings: scopedRecentBookings,
      hotelWiseSummary
    });
  } catch (err) {
    console.error('Get dashboard error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

// HOTEL MASTER

async function listHotels(req, res) {
  try {
    const db = getDb();
    const hotels = db.prepare('SELECT * FROM hotels ORDER BY name').all();
    return res.json(hotels);
  } catch (err) {
    console.error('Admin list hotels error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function createHotel(req, res) {
  try {
    const { name, city, status } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'Hotel name is required' });
    }
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO hotels (name, city, status)
       VALUES (?, ?, ?)`
    );
    const info = stmt.run(name, city || null, status || 'active');
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json(hotel);
  } catch (err) {
    console.error('Admin create hotel error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function updateHotel(req, res) {
  try {
    const id = Number(req.params.id);
    const { name, city, status } = req.body;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM hotels WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'Hotel not found' });
    }
    db.prepare(
      `UPDATE hotels
       SET name = ?, city = ?, status = ?
       WHERE id = ?`
    ).run(
      name || existing.name,
      city !== undefined ? city : existing.city,
      status || existing.status,
      id
    );
    const hotel = db.prepare('SELECT * FROM hotels WHERE id = ?').get(id);
    return res.json(hotel);
  } catch (err) {
    console.error('Admin update hotel error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function deleteHotel(req, res) {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM hotels WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'Hotel not found' });
    }

    // Optional safety: prevent deleting a hotel that still has users
    const userCount = db
      .prepare('SELECT COUNT(*) as c FROM users WHERE hotel_id = ?')
      .get(id).c;
    if (userCount > 0) {
      return res
        .status(400)
        .json({ message: 'Cannot delete hotel with associated users. Move or remove users first.' });
    }

    db.prepare('DELETE FROM hotels WHERE id = ?').run(id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin delete hotel error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

// USER MASTER (HOTEL-WISE)

async function listUsers(req, res) {
  try {
    const { hotelId, id } = req.query;
    const db = getDb();
    let query = `SELECT u.id, u.name, u.email, u.phone, u.role, u.hotel_id, h.name as hotel_name
                 FROM users u
                 LEFT JOIN hotels h ON h.id = u.hotel_id
                 WHERE 1 = 1`;
    const params = [];

    if (id) {
      query += ' AND u.id = ?';
      params.push(Number(id));
    }
    if (hotelId) {
      query += ' AND u.hotel_id = ?';
      params.push(Number(hotelId));
    }

    query += ' ORDER BY u.name';
    const users = db.prepare(query).all(...params);
    return res.json(users);
  } catch (err) {
    console.error('Admin list users error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function createUser(req, res) {
  try {
    const { name, email, phone, password, role, hotelId } = req.body;
    if (!name || !phone || !password) {
      return res
        .status(400)
        .json({ message: 'Name, phone and password are required' });
    }

    const db = getDb();

    const existingByPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
    if (existingByPhone) {
      return res.status(400).json({ message: 'Phone is already registered' });
    }
    if (email) {
      const existingByEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existingByEmail) {
        return res.status(400).json({ message: 'Email is already registered' });
      }
    }

    const storedEmail = email || `user_${phone}@auto.local`;
    const passwordHash = await bcrypt.hash(password, 10);

    const stmt = db.prepare(
      `INSERT INTO users (name, email, password_hash, phone, role, hotel_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const finalRole = role || 'admin';
    let finalHotelId = null;
    if (finalRole === 'hotel-admin') {
      if (!hotelId) {
        return res
          .status(400)
          .json({ message: 'Hotel is required for hotel-admin users' });
      }
      finalHotelId = Number(hotelId);
    }

    const info = stmt.run(
      name,
      storedEmail,
      passwordHash,
      phone,
      finalRole,
      finalHotelId
    );

    const user = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.phone, u.role, u.hotel_id, h.name as hotel_name
         FROM users u
         LEFT JOIN hotels h ON h.id = u.hotel_id
         WHERE u.id = ?`
      )
      .get(info.lastInsertRowid);

    return res.status(201).json(user);
  } catch (err) {
    console.error('Admin create user error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function updateUser(req, res) {
  try {
    const id = Number(req.params.id);
    const { name, email, phone, password, role, hotelId } = req.body;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Update unique fields if they are changing
    if (phone && phone !== existing.phone) {
      const existingByPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (existingByPhone) {
        return res.status(400).json({ message: 'Phone is already registered' });
      }
    }
    if (email && email !== existing.email) {
      const existingByEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existingByEmail) {
        return res.status(400).json({ message: 'Email is already registered' });
      }
    }

    let passwordHash = existing.password_hash;
    if (password) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    db.prepare(
      `UPDATE users
       SET name = ?, email = ?, phone = ?, role = ?, hotel_id = ?, password_hash = ?
       WHERE id = ?`
    ).run(
      name || existing.name,
      email || existing.email,
      phone || existing.phone,
      role || existing.role,
      hotelId !== undefined ? Number(hotelId) : existing.hotel_id,
      passwordHash,
      id
    );

    const user = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.phone, u.role, u.hotel_id, h.name as hotel_name
         FROM users u
         LEFT JOIN hotels h ON h.id = u.hotel_id
         WHERE u.id = ?`
      )
      .get(id);

    return res.json(user);
  } catch (err) {
    console.error('Admin update user error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function deleteUser(req, res) {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (req.user && req.user.id === id) {
      return res.status(400).json({ message: 'You cannot delete your own account' });
    }

    const bookingsCount = db.prepare('SELECT COUNT(*) as c FROM bookings WHERE user_id = ?').get(id).c;
    if (bookingsCount > 0) {
      return res.status(400).json({
        message: 'Cannot delete user with bookings. Remove or reassign related bookings first.'
      });
    }

    const promoCodesCount = db.prepare('SELECT COUNT(*) as c FROM promo_codes WHERE agent_id = ?').get(id).c;
    if (promoCodesCount > 0) {
      return res.status(400).json({
        message: 'Cannot delete user with promo codes. Remove related promo codes first.'
      });
    }

    const referralsCount = db
      .prepare('SELECT COUNT(*) as c FROM agent_referrals WHERE agent_id = ? OR customer_id = ?')
      .get(id, id).c;
    if (referralsCount > 0) {
      return res.status(400).json({
        message: 'Cannot delete user with referral records. Remove related referrals first.'
      });
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin delete user error', err);
    if (err && err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return res.status(400).json({
        message: 'Cannot delete user due to linked records. Remove linked data first.'
      });
    }
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function listRooms(req, res) {
  try {
    const { hotelId } = req.query;
    const db = getDb();
    let query = `SELECT r.*, h.name as hotel_name
                 FROM rooms r
                 LEFT JOIN hotels h ON h.id = r.hotel_id
                 WHERE 1 = 1`;
    const params = [];

    // If caller is hotel-admin, force filter to their hotel
    if (req.user.role === 'hotel-admin') {
      if (!req.user.hotelId) {
        return res.status(400).json({ message: 'Hotel not assigned to this user' });
      }
      query += ' AND r.hotel_id = ?';
      params.push(req.user.hotelId);
    } else if (hotelId) {
      query += ' AND r.hotel_id = ?';
      params.push(Number(hotelId));
    }

    const rooms = db.prepare(query).all(...params);
    return res.json(rooms);
  } catch (err) {
    console.error('Admin list rooms error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function listInventory(req, res) {
  try {
    const db = getDb();
    const isHotelAdmin = req.user.role === 'hotel-admin';
    const userHotelId = req.user.hotelId ? Number(req.user.hotelId) : null;
    if (isHotelAdmin && !userHotelId) {
      return res.status(400).json({ message: 'Hotel not assigned to this user' });
    }

    const requestedFrom = isValidDateString(req.query.from)
      ? String(req.query.from)
      : getTodayDateString();
    const requestedTo = isValidDateString(req.query.to)
      ? String(req.query.to)
      : addDaysToDateString(requestedFrom, 1);
    if (requestedTo <= requestedFrom) {
      return res.status(400).json({ message: '`to` date must be after `from` date' });
    }

    const requestedHotelId = req.query.hotelId ? Number(req.query.hotelId) : null;
    const selectedHotelId = isHotelAdmin ? userHotelId : requestedHotelId;
    const type = req.query.type ? String(req.query.type).trim() : '';
    const status = req.query.status ? String(req.query.status).trim() : '';
    const search = req.query.search ? String(req.query.search).trim() : '';

    const params = [];
    const filterConditions = [];
    if (selectedHotelId) {
      filterConditions.push('p.hotel_id = ?');
      params.push(selectedHotelId);
    }
    if (type) {
      filterConditions.push('p.type = ?');
      params.push(type);
    }
    if (status) {
      filterConditions.push('p.status = ?');
      params.push(status);
    }
    if (search) {
      filterConditions.push('(p.name LIKE ? OR p.type LIKE ? OR h.name LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const whereClause = filterConditions.length ? ` AND ${filterConditions.join(' AND ')}` : '';
    const propertiesQuery = `
      SELECT p.property_type,
             p.id,
             p.name,
             p.type,
             p.status,
             p.capacity,
             p.quantity,
             p.registrationAmount,
             p.arrivalAmount,
             p.totalPrice,
             p.hotel_id,
             h.name as hotel_name
      FROM (
        SELECT 'room' as property_type, r.*
        FROM rooms r
        UNION ALL
        SELECT 'tent' as property_type, t.*
        FROM tents t
      ) p
      LEFT JOIN hotels h ON h.id = p.hotel_id
      WHERE 1 = 1
      ${whereClause}
      ORDER BY COALESCE(h.name, 'Unassigned'), p.property_type, p.name`;
    const properties = db.prepare(propertiesQuery).all(...params);

    const bookingOverlapStmt = db.prepare(
      `SELECT COUNT(*) as c
       FROM bookings
       WHERE property_type = ?
         AND property_id = ?
         AND status != 'cancelled'
         AND NOT (date(check_out) <= date(?) OR date(check_in) >= date(?))`
    );
    const roomManualOverlapStmt = db.prepare(
      `SELECT IFNULL(SUM(booked_quantity), 0) as c
       FROM room_manual_bookings
       WHERE room_id = ?
         AND NOT (date(check_out) <= date(?) OR date(check_in) >= date(?))`
    );
    const tentManualOverlapStmt = db.prepare(
      `SELECT IFNULL(SUM(booked_quantity), 0) as c
       FROM tent_manual_bookings
       WHERE tent_id = ?
         AND NOT (date(check_out) <= date(?) OR date(check_in) >= date(?))`
    );

    const rows = properties.map((property) => {
      const registeredQuantity = Math.max(Number(property.quantity || 1), 1);
      const actualBookedQuantity = Number(
        bookingOverlapStmt.get(property.property_type, property.id, requestedFrom, requestedTo).c || 0
      );
      const manualBookedQuantity = Number(
        property.property_type === 'room'
          ? roomManualOverlapStmt.get(property.id, requestedFrom, requestedTo).c || 0
          : tentManualOverlapStmt.get(property.id, requestedFrom, requestedTo).c || 0
      );
      const rawBookedQuantity = actualBookedQuantity + manualBookedQuantity;
      const bookedQuantity = Math.min(rawBookedQuantity, registeredQuantity);
      const availableQuantity = Math.max(registeredQuantity - bookedQuantity, 0);
      const occupancyPercent = registeredQuantity
        ? Number(((bookedQuantity / registeredQuantity) * 100).toFixed(2))
        : 0;

      return {
        property_type: property.property_type,
        property_id: property.id,
        property_name: property.name,
        property_item_label: `${property.property_type === 'room' ? 'Room' : 'Tent'} #${property.id}`,
        property_type_name: property.type,
        property_status: property.status,
        capacity: Number(property.capacity || 0),
        hotel_id: property.hotel_id,
        hotel_name: property.hotel_name || 'Unassigned',
        registered_quantity: registeredQuantity,
        actual_booked_quantity: actualBookedQuantity,
        manual_booked_quantity: manualBookedQuantity,
        booked_quantity: bookedQuantity,
        available_quantity: availableQuantity,
        occupancy_percent: occupancyPercent,
        registration_amount: Number(property.registrationAmount || 0),
        arrival_amount: Number(property.arrivalAmount || 0),
        total_price: Number(property.totalPrice || 0)
      };
    });

    const hotelSummaryMap = new Map();
    rows.forEach((row) => {
      const key = `${row.hotel_id || 0}:${row.hotel_name}`;
      if (!hotelSummaryMap.has(key)) {
        hotelSummaryMap.set(key, {
          hotel_id: row.hotel_id,
          hotel_name: row.hotel_name,
          property_types: 0,
          registered_quantity: 0,
          booked_quantity: 0,
          available_quantity: 0,
          occupancy_percent: 0
        });
      }
      const bucket = hotelSummaryMap.get(key);
      bucket.property_types += 1;
      bucket.registered_quantity += row.registered_quantity;
      bucket.booked_quantity += row.booked_quantity;
      bucket.available_quantity += row.available_quantity;
    });

    const hotelSummary = Array.from(hotelSummaryMap.values())
      .map((hotel) => ({
        ...hotel,
        occupancy_percent: hotel.registered_quantity
          ? Number(((hotel.booked_quantity / hotel.registered_quantity) * 100).toFixed(2))
          : 0
      }))
      .sort((a, b) => a.hotel_name.localeCompare(b.hotel_name));

    const totalRegistered = rows.reduce((sum, row) => sum + row.registered_quantity, 0);
    const totalBooked = rows.reduce((sum, row) => sum + row.booked_quantity, 0);

    return res.json({
      period: {
        from: requestedFrom,
        to: requestedTo
      },
      summary: {
        property_types: rows.length,
        hotels: hotelSummary.length,
        registered_quantity: totalRegistered,
        booked_quantity: totalBooked,
        available_quantity: Math.max(totalRegistered - totalBooked, 0),
        occupancy_percent: totalRegistered ? Number(((totalBooked / totalRegistered) * 100).toFixed(2)) : 0
      },
      hotelSummary,
      rows
    });
  } catch (err) {
    console.error('Admin inventory error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function createManualRoomBooking(req, res) {
  try {
    const { propertyType, propertyId, roomId, tentId, from, to, bookedQuantity, notes } = req.body || {};
    const normalizedType = propertyType === 'tent' || tentId ? 'tent' : 'room';
    const parsedPropertyId = Number(propertyId || roomId || tentId);
    const parsedBookedQuantity = Number(bookedQuantity);

    if (!['room', 'tent'].includes(normalizedType)) {
      return res.status(400).json({ message: 'propertyType must be room or tent' });
    }
    if (!Number.isInteger(parsedPropertyId) || parsedPropertyId <= 0) {
      return res.status(400).json({ message: 'Valid propertyId is required' });
    }
    if (!isValidDateString(from) || !isValidDateString(to) || String(to) <= String(from)) {
      return res.status(400).json({ message: 'Valid date range is required and `to` must be after `from`' });
    }
    if (!Number.isInteger(parsedBookedQuantity) || parsedBookedQuantity < 0) {
      return res.status(400).json({ message: 'bookedQuantity must be a whole number (0 or more)' });
    }

    const db = getDb();
    const property =
      normalizedType === 'room'
        ? getScopedRoomById(db, req.user, parsedPropertyId)
        : getScopedTentById(db, req.user, parsedPropertyId);
    if (!property) {
      return res.status(404).json({ message: 'Property not found or access denied' });
    }

    const propertyQuantity = Math.max(Number(property.quantity || 1), 1);
    if (parsedBookedQuantity > propertyQuantity) {
      return res
        .status(400)
        .json({ message: `bookedQuantity cannot exceed property quantity (${propertyQuantity})` });
    }

    const tableName = normalizedType === 'room' ? 'room_manual_bookings' : 'tent_manual_bookings';
    const idColumn = normalizedType === 'room' ? 'room_id' : 'tent_id';

    if (parsedBookedQuantity === 0) {
      db.prepare(
        `DELETE FROM ${tableName}
         WHERE ${idColumn} = ? AND check_in = ? AND check_out = ?`
      ).run(parsedPropertyId, from, to);
      return res.json({
        success: true,
        removed: true,
        property_type: normalizedType,
        property_id: parsedPropertyId,
        check_in: from,
        check_out: to
      });
    }

    const normalizedNotes = typeof notes === 'string' ? notes.trim().slice(0, 500) : null;
    db.prepare(
      `INSERT INTO ${tableName} (${idColumn}, check_in, check_out, booked_quantity, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(${idColumn}, check_in, check_out)
       DO UPDATE SET
         booked_quantity = excluded.booked_quantity,
         notes = excluded.notes,
         created_by_user_id = excluded.created_by_user_id`
    ).run(parsedPropertyId, from, to, parsedBookedQuantity, normalizedNotes || null, req.user.id);

    const saved = db
      .prepare(
        `SELECT id, ${idColumn} as property_id, check_in, check_out, booked_quantity, notes, created_by_user_id, created_at
         FROM ${tableName}
         WHERE ${idColumn} = ? AND check_in = ? AND check_out = ?`
      )
      .get(parsedPropertyId, from, to);

    return res.status(201).json({ property_type: normalizedType, ...saved });
  } catch (err) {
    console.error('Create manual room booking error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function deleteManualRoomBooking(req, res) {
  try {
    const manualBookingId = Number(req.params.id);
    const propertyType = String(req.query.propertyType || 'room').trim().toLowerCase();
    if (!Number.isInteger(manualBookingId) || manualBookingId <= 0) {
      return res.status(400).json({ message: 'Valid manual booking id is required' });
    }
    if (!['room', 'tent'].includes(propertyType)) {
      return res.status(400).json({ message: 'propertyType must be room or tent' });
    }

    const db = getDb();
    const tableName = propertyType === 'room' ? 'room_manual_bookings' : 'tent_manual_bookings';
    const idColumn = propertyType === 'room' ? 'room_id' : 'tent_id';
    const existing = db
      .prepare(
        `SELECT mb.id, mb.${idColumn} as property_id, mb.check_in, mb.check_out, mb.booked_quantity, h.id as hotel_id
         FROM ${tableName} mb
         LEFT JOIN ${propertyType === 'room' ? 'rooms' : 'tents'} p ON p.id = mb.${idColumn}
         LEFT JOIN hotels h ON h.id = p.hotel_id
         WHERE mb.id = ?`
      )
      .get(manualBookingId);
    if (!existing) {
      return res.status(404).json({ message: 'Manual booking not found' });
    }

    if (req.user.role === 'hotel-admin') {
      if (!req.user.hotelId || Number(existing.hotel_id || 0) !== Number(req.user.hotelId)) {
        return res.status(403).json({ message: 'Not allowed to cancel manual bookings of another hotel' });
      }
    }

    db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(manualBookingId);
    return res.json({ success: true, removed: true, id: manualBookingId, property_type: propertyType });
  } catch (err) {
    console.error('Delete manual room booking error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

function listPropertyBookingsData(db, propertyType, propertyId) {
  const propertyTable = propertyType === 'room' ? 'rooms' : 'tents';
  const manualTable = propertyType === 'room' ? 'room_manual_bookings' : 'tent_manual_bookings';
  const manualPropertyIdColumn = propertyType === 'room' ? 'room_id' : 'tent_id';

  const property = db
    .prepare(
      `SELECT p.id, p.name, p.type, p.quantity, p.hotel_id, COALESCE(h.name, 'Unassigned') as hotel_name
       FROM ${propertyTable} p
       LEFT JOIN hotels h ON h.id = p.hotel_id
       WHERE p.id = ?`
    )
    .get(propertyId);
  if (!property) {
    return null;
  }

  const bookingRows = db
    .prepare(
      `SELECT b.id,
              b.booking_ref,
              b.check_in,
              b.check_out,
              b.status,
              b.payment_status,
              b.registration_amount,
              b.arrival_amount,
              b.total_amount,
              b.created_at,
              u.name as guest_name,
              u.phone as guest_phone
       FROM bookings b
       LEFT JOIN users u ON u.id = b.user_id
       WHERE b.property_type = ?
         AND b.property_id = ?
       ORDER BY date(b.check_in) DESC, b.id DESC`
    )
    .all(propertyType, propertyId);

  const manualRows = db
    .prepare(
      `SELECT mb.id,
              mb.check_in,
              mb.check_out,
              mb.booked_quantity,
              mb.created_at
       FROM ${manualTable} mb
       WHERE mb.${manualPropertyIdColumn} = ?
       ORDER BY date(mb.check_in) DESC, mb.id DESC`
    )
    .all(propertyId)
    .map((manual) => ({
      id: -Number(manual.id),
      manual_booking_id: Number(manual.id),
      source_type: 'manual',
      booking_ref: `MANUAL-${manual.id}`,
      check_in: manual.check_in,
      check_out: manual.check_out,
      status: 'manual',
      payment_status: null,
      registration_amount: 0,
      arrival_amount: 0,
      total_amount: 0,
      created_at: manual.created_at,
      guest_name: 'SELF',
      guest_phone: null,
      manual_booked_quantity: Number(manual.booked_quantity || 0)
    }));

  const rows = [
    ...bookingRows.map((booking) => ({
      ...booking,
      source_type: 'booking',
      manual_booking_id: null,
      manual_booked_quantity: 0
    })),
    ...manualRows
  ];
  assignRoomUnitLabels(rows, property.quantity);

  const today = getTodayDateString();
  const currentAndUpcoming = [];
  const past = [];
  rows.forEach((booking) => {
    if (String(booking.check_out) > today) {
      currentAndUpcoming.push(booking);
    } else {
      past.push(booking);
    }
  });
  currentAndUpcoming.sort((a, b) => String(a.check_in).localeCompare(String(b.check_in)));
  past.sort((a, b) => String(b.check_in).localeCompare(String(a.check_in)));

  return {
    property: {
      id: property.id,
      name: property.name,
      type: property.type,
      quantity: Number(property.quantity || 1),
      hotel_id: property.hotel_id,
      hotel_name: property.hotel_name,
      property_type: propertyType
    },
    currentAndUpcoming,
    past
  };
}

async function listRoomBookings(req, res) {
  try {
    const roomId = Number(req.params.roomId);
    if (!Number.isInteger(roomId) || roomId <= 0) {
      return res.status(400).json({ message: 'Valid roomId is required' });
    }

    const db = getDb();
    const room = getScopedRoomById(db, req.user, roomId);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }
    if (req.user.role === 'hotel-admin' && (!req.user.hotelId || Number(room.hotel_id || 0) !== Number(req.user.hotelId))) {
      return res.status(403).json({ message: 'Not allowed to view bookings of another hotel room' });
    }

    const payload = listPropertyBookingsData(db, 'room', roomId);
    return res.json(payload);
  } catch (err) {
    console.error('Admin list room bookings error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function listTentBookings(req, res) {
  try {
    const tentId = Number(req.params.tentId);
    if (!Number.isInteger(tentId) || tentId <= 0) {
      return res.status(400).json({ message: 'Valid tentId is required' });
    }

    const db = getDb();
    const tent = getScopedTentById(db, req.user, tentId);
    if (!tent) {
      return res.status(404).json({ message: 'Tent not found' });
    }
    if (req.user.role === 'hotel-admin' && (!req.user.hotelId || Number(tent.hotel_id || 0) !== Number(req.user.hotelId))) {
      return res.status(403).json({ message: 'Not allowed to view bookings of another hotel tent' });
    }

    const payload = listPropertyBookingsData(db, 'tent', tentId);
    return res.json(payload);
  } catch (err) {
    console.error('Admin list tent bookings error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function createRoom(req, res) {
  try {
    const {
      name,
      type,
      description,
      capacity,
      quantity,
      registrationAmount,
      arrivalAmount,
      amenities,
      status,
      hotelId
    } = req.body;
    const registration = Number(registrationAmount);
    const arrival = Number(arrivalAmount);
    if (!name || !type || !Number.isFinite(registration) || !Number.isFinite(arrival)) {
      return res
        .status(400)
        .json({ message: 'Name, type, downpaymentAmount and arrivalAmount are required for a room' });
    }
    if (registration <= 0 || arrival <= 0) {
      return res
        .status(400)
        .json({ message: 'downpaymentAmount and arrivalAmount must be greater than 0' });
    }
    const roomQuantity = quantity != null ? Number(quantity) : 1;
    if (!Number.isInteger(roomQuantity) || roomQuantity <= 0) {
      return res.status(400).json({ message: 'quantity must be a positive whole number' });
    }
    const db = getDb();
    const totalPrice = registration + arrival;

    let effectiveHotelId = null;
    if (req.user.role === 'hotel-admin') {
      if (!req.user.hotelId) {
        return res.status(400).json({ message: 'Hotel not assigned to this user' });
      }
      effectiveHotelId = req.user.hotelId;
    } else {
      if (!hotelId) {
        return res.status(400).json({ message: 'hotelId is required for creating a room' });
      }
      effectiveHotelId = Number(hotelId);
    }

    const stmt = db.prepare(
      `INSERT INTO rooms (
        name, type, description, capacity, quantity,
        basePrice, registrationAmount, arrivalAmount, totalPrice,
        amenities, status, hotel_id
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(
      name,
      type,
      description || null,
      capacity || 2,
      roomQuantity,
      totalPrice,
      registration,
      arrival,
      totalPrice,
      amenities ? JSON.stringify(amenities) : null,
      status || 'active',
      effectiveHotelId
    );
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json(room);
  } catch (err) {
    console.error('Admin create room error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function updateRoom(req, res) {
  try {
    const id = Number(req.params.id);
    const {
      name,
      type,
      description,
      capacity,
      quantity,
      registrationAmount,
      arrivalAmount,
      amenities,
      status
    } = req.body;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Hotel-admins may only modify rooms for their own hotel
    if (req.user.role === 'hotel-admin') {
      if (!req.user.hotelId || existing.hotel_id !== req.user.hotelId) {
        return res.status(403).json({ message: 'Not allowed to modify rooms of another hotel' });
      }
    }
    const nextRegistration =
      registrationAmount != null ? Number(registrationAmount) : Number(existing.registrationAmount || 0);
    const nextArrival =
      arrivalAmount != null ? Number(arrivalAmount) : Number(existing.arrivalAmount || 0);
    if (!Number.isFinite(nextRegistration) || !Number.isFinite(nextArrival)) {
      return res
        .status(400)
        .json({ message: 'downpaymentAmount and arrivalAmount must be valid numbers' });
    }
    if (nextRegistration <= 0 || nextArrival <= 0) {
      return res
        .status(400)
        .json({ message: 'downpaymentAmount and arrivalAmount must be greater than 0' });
    }
    const nextQuantity = quantity != null ? Number(quantity) : Number(existing.quantity || 1);
    if (!Number.isInteger(nextQuantity) || nextQuantity <= 0) {
      return res.status(400).json({ message: 'quantity must be a positive whole number' });
    }
    const nextTotal = nextRegistration + nextArrival;

    const stmt = db.prepare(
      `UPDATE rooms SET 
        name = ?, type = ?, description = ?, capacity = ?, quantity = ?,
        basePrice = ?, registrationAmount = ?, arrivalAmount = ?, totalPrice = ?, amenities = ?, status = ?
       WHERE id = ?`
    );
    stmt.run(
      name ?? existing.name,
      type ?? existing.type,
      description ?? existing.description,
      capacity ?? existing.capacity,
      nextQuantity,
      nextTotal,
      nextRegistration,
      nextArrival,
      nextTotal,
      normalizeAmenitiesInput(amenities, existing.amenities),
      status ?? existing.status,
      id
    );
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    return res.json(room);
  } catch (err) {
    console.error('Admin update room error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function deleteRoom(req, res) {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (req.user.role === 'hotel-admin') {
      if (!req.user.hotelId || existing.hotel_id !== req.user.hotelId) {
        return res.status(403).json({ message: 'Not allowed to delete rooms of another hotel' });
      }
    }
    db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin delete room error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function uploadRoomImages(req, res) {
  try {
    const roomId = Number(req.params.id);
    const db = getDb();
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }
    if (req.user.role === 'hotel-admin') {
      if (!req.user.hotelId || room.hotel_id !== req.user.hotelId) {
        return res.status(403).json({ message: 'Not allowed to manage images of another hotel' });
      }
    }
    if (!req.files || !req.files.length) {
      return res.status(400).json({ message: 'No images uploaded' });
    }

    const currentCount = db.prepare('SELECT COUNT(*) as c FROM room_images WHERE room_id = ?').get(roomId).c;
    const slotsLeft = MAX_IMAGES_PER_PROPERTY - currentCount;
    if (slotsLeft <= 0) {
      return res.status(400).json({
        message: `Maximum ${MAX_IMAGES_PER_PROPERTY} images per room. Remove an image to add more.`
      });
    }
    
    const filesToAdd = req.files.slice(0, slotsLeft);
    const insert = db.prepare(
      'INSERT INTO room_images (room_id, image_path, is_primary) VALUES (?, ?, ?)'
    );
    const existingPrimary = db
      .prepare('SELECT 1 FROM room_images WHERE room_id = ? AND is_primary = 1')
      .get(roomId);

    const images = [];
    filesToAdd.forEach((file, index) => {
      const isPrimary = !existingPrimary && index === 0 ? 1 : 0;
      const info = insert.run(roomId, file.path, isPrimary);
      images.push({
        id: info.lastInsertRowid,
        room_id: roomId,
        image_path: file.path,
        is_primary: isPrimary
      });
    });

    return res.status(201).json(images);
  } catch (err) {
    console.error('Admin upload room images error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

function resolveImagePath(imagePath) {
  if (!imagePath) return null;
  const normalized = path.normalize(imagePath);
  return path.isAbsolute(normalized) ? normalized : path.resolve(process.cwd(), normalized);
}

async function deleteRoomImage(req, res) {
  try {
    const roomId = Number(req.params.id);
    const imageId = Number(req.params.imageId);
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM room_images WHERE id = ? AND room_id = ?')
      .get(imageId, roomId);
    if (!existing) {
      return res.status(404).json({ message: 'Image not found' });
    }
    const filePath = resolveImagePath(existing.image_path);
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (unlinkErr) {
        console.warn('Could not delete image file:', filePath, unlinkErr.message);
      }
    }
    db.prepare('DELETE FROM room_images WHERE id = ?').run(imageId);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin delete room image error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function setPrimaryRoomImage(req, res) {
  try {
    const roomId = Number(req.params.id);
    const imageId = Number(req.params.imageId);
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM room_images WHERE id = ? AND room_id = ?')
      .get(imageId, roomId);
    if (!existing) {
      return res.status(404).json({ message: 'Image not found' });
    }
    db.prepare('UPDATE room_images SET is_primary = 0 WHERE room_id = ?').run(roomId);
    db.prepare('UPDATE room_images SET is_primary = 1 WHERE id = ?').run(imageId);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin set primary room image error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function listTents(req, res) {
  try {
    const { hotelId } = req.query;
    const db = getDb();
    let query = `SELECT t.*, h.name as hotel_name
                 FROM tents t
                 LEFT JOIN hotels h ON h.id = t.hotel_id
                 WHERE 1 = 1`;
    const params = [];

    if (req.user.role === 'hotel-admin') {
      if (!req.user.hotelId) {
        return res.status(400).json({ message: 'Hotel not assigned to this user' });
      }
      query += ' AND t.hotel_id = ?';
      params.push(req.user.hotelId);
    } else if (hotelId) {
      query += ' AND t.hotel_id = ?';
      params.push(Number(hotelId));
    }

    const tents = db.prepare(query).all(...params);
    return res.json(tents);
  } catch (err) {
    console.error('Admin list tents error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function createTent(req, res) {
  try {
    const {
      name,
      type,
      description,
      capacity,
      quantity,
      registrationAmount,
      arrivalAmount,
      amenities,
      status,
      hotelId
    } = req.body;
    const registration = Number(registrationAmount);
    const arrival = Number(arrivalAmount);
    
    if (!name || !type || !Number.isFinite(registration) || !Number.isFinite(arrival)) {
      return res
        .status(400)
        .json({ message: 'Name, type, downpaymentAmount and arrivalAmount are required for a tent' });
    }
    if (registration <= 0 || arrival <= 0) {
      return res
        .status(400)
        .json({ message: 'downpaymentAmount and arrivalAmount must be greater than 0' });
    }
    const tentQuantity = quantity != null ? Number(quantity) : 1;
    if (!Number.isInteger(tentQuantity) || tentQuantity <= 0) {
      return res.status(400).json({ message: 'quantity must be a positive whole number' });
    }
    const db = getDb();
    const totalPrice = registration + arrival;

    let effectiveHotelId = null;
    if (req.user.role === 'hotel-admin') {
      if (!req.user.hotelId) {
        return res.status(400).json({ message: 'Hotel not assigned to this user' });
      }
      effectiveHotelId = req.user.hotelId;
    } else {
      if (!hotelId) {
        return res.status(400).json({ message: 'hotelId is required for creating a tent' });
      }
      effectiveHotelId = Number(hotelId);
    }

    const stmt = db.prepare(
      `INSERT INTO tents (
        name, type, description, capacity, quantity,
        basePrice, registrationAmount, arrivalAmount, totalPrice,
        amenities, status, hotel_id
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(
      name,
      type,
      description || null,
      capacity || 2,
      tentQuantity,
      totalPrice,
      registration,
      arrival,
      totalPrice,
      amenities ? JSON.stringify(amenities) : null,
      status || 'active',
      effectiveHotelId
    );
    const tent = db.prepare('SELECT * FROM tents WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json(tent);
  } catch (err) {
    console.error('Admin create tent error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function updateTent(req, res) {
  try {
    const id = Number(req.params.id);
    const { name, type, description, capacity, quantity, registrationAmount, arrivalAmount, amenities, status } = req.body;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM tents WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'Tent not found' });
    }

    if (req.user.role === 'hotel-admin') {
      if (!req.user.hotelId || existing.hotel_id !== req.user.hotelId) {
        return res.status(403).json({ message: 'Not allowed to modify tents of another hotel' });
      }
    }
    const nextRegistration =
      registrationAmount != null ? Number(registrationAmount) : Number(existing.registrationAmount || 0);
    const nextArrival =
      arrivalAmount != null ? Number(arrivalAmount) : Number(existing.arrivalAmount || 0);
    if (!Number.isFinite(nextRegistration) || !Number.isFinite(nextArrival)) {
      return res
        .status(400)
        .json({ message: 'downpaymentAmount and arrivalAmount must be valid numbers' });
    }
    if (nextRegistration <= 0 || nextArrival <= 0) {
      return res
        .status(400)
        .json({ message: 'downpaymentAmount and arrivalAmount must be greater than 0' });
    }
    const nextQuantity = quantity != null ? Number(quantity) : Number(existing.quantity || 1);
    if (!Number.isInteger(nextQuantity) || nextQuantity <= 0) {
      return res.status(400).json({ message: 'quantity must be a positive whole number' });
    }
    const nextTotal = nextRegistration + nextArrival;

    const stmt = db.prepare(
      `UPDATE tents SET 
        name = ?, type = ?, description = ?, capacity = ?, quantity = ?,
        basePrice = ?, registrationAmount = ?, arrivalAmount = ?, totalPrice = ?, amenities = ?, status = ?
       WHERE id = ?`
    );
    stmt.run(
      name ?? existing.name,
      type ?? existing.type,
      description ?? existing.description,
      capacity ?? existing.capacity,
      nextQuantity,
      nextTotal,
      nextRegistration,
      nextArrival,
      nextTotal,
      normalizeAmenitiesInput(amenities, existing.amenities),
      status ?? existing.status,
      id
    );
    const tent = db.prepare('SELECT * FROM tents WHERE id = ?').get(id);
    return res.json(tent);
  } catch (err) {
    console.error('Admin update tent error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function deleteTent(req, res) {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM tents WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'Tent not found' });
    }

    if (req.user.role === 'hotel-admin') {
      if (!req.user.hotelId || existing.hotel_id !== req.user.hotelId) {
        return res.status(403).json({ message: 'Not allowed to delete tents of another hotel' });
      }
    }
    db.prepare('DELETE FROM tents WHERE id = ?').run(id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin delete tent error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function uploadTentImages(req, res) {
  try {
    const tentId = Number(req.params.id);
    const db = getDb();
    const tent = db.prepare('SELECT * FROM tents WHERE id = ?').get(tentId);
    if (!tent) {
      return res.status(404).json({ message: 'Tent not found' });
    }
    if (req.user.role === 'hotel-admin') {
      if (!req.user.hotelId || tent.hotel_id !== req.user.hotelId) {
        return res.status(403).json({ message: 'Not allowed to manage images of another hotel' });
      }
    }
    if (!req.files || !req.files.length) {
      return res.status(400).json({ message: 'No images uploaded' });
    }

    const currentCount = db.prepare('SELECT COUNT(*) as c FROM tent_images WHERE tent_id = ?').get(tentId).c;
    const slotsLeft = MAX_IMAGES_PER_PROPERTY - currentCount;
    if (slotsLeft <= 0) {
      return res.status(400).json({
        message: `Maximum ${MAX_IMAGES_PER_PROPERTY} images per tent. Remove an image to add more.`
      });
    }
    const filesToAdd = req.files.slice(0, slotsLeft);

    const insert = db.prepare(
      'INSERT INTO tent_images (tent_id, image_path, is_primary) VALUES (?, ?, ?)'
    );
    const existingPrimary = db
      .prepare('SELECT 1 FROM tent_images WHERE tent_id = ? AND is_primary = 1')
      .get(tentId);

    const images = [];
    filesToAdd.forEach((file, index) => {
      const isPrimary = !existingPrimary && index === 0 ? 1 : 0;
      const info = insert.run(tentId, file.path, isPrimary);
      images.push({
        id: info.lastInsertRowid,
        tent_id: tentId,
        image_path: file.path,
        is_primary: isPrimary
      });
    });

    return res.status(201).json(images);
  } catch (err) {
    console.error('Admin upload tent images error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function deleteTentImage(req, res) {
  try {
    const tentId = Number(req.params.id);
    const imageId = Number(req.params.imageId);
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM tent_images WHERE id = ? AND tent_id = ?')
      .get(imageId, tentId);
    if (!existing) {
      return res.status(404).json({ message: 'Image not found' });
    }
    const filePath = resolveImagePath(existing.image_path);
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (unlinkErr) {
        console.warn('Could not delete image file:', filePath, unlinkErr.message);
      }
    }
    db.prepare('DELETE FROM tent_images WHERE id = ?').run(imageId);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin delete tent image error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function setPrimaryTentImage(req, res) {
  try {
    const tentId = Number(req.params.id);
    const imageId = Number(req.params.imageId);
    const db = getDb();
    const existing = db
      .prepare('SELECT * FROM tent_images WHERE id = ? AND tent_id = ?')
      .get(imageId, tentId);
    if (!existing) {
      return res.status(404).json({ message: 'Image not found' });
    }
    db.prepare('UPDATE tent_images SET is_primary = 0 WHERE tent_id = ?').run(tentId);
    db.prepare('UPDATE tent_images SET is_primary = 1 WHERE id = ?').run(imageId);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin set primary tent image error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function listAdminBookings(req, res) {
  try {
    const { status, propertyType, from, to, hotelId: hotelIdFilter, paymentStatus, search, checkInFrom, checkInTo } = req.query;
    const db = getDb();
    const isHotelAdmin = req.user.role === 'hotel-admin';
    const hotelId = req.user.hotelId ? Number(req.user.hotelId) : null;
    if (isHotelAdmin && !hotelId) {
      return res.status(400).json({ message: 'Hotel not assigned to this user' });
    }

    let query = `SELECT b.*,
                        u.name as guest_name,
                        u.phone as guest_phone,
                        COALESCE(r.name, t.name) as property_name,
                        COALESCE(hr.name, ht.name) as hotel_name,
                        b.arrival_amount as due_on_arrival,
                        p.status as payment_record_status,
                        p.razorpay_payment_id as submitted_transaction_id,
                        p.razorpay_signature as submitted_method,
                        p.paid_at as payment_submitted_at
                 FROM bookings b
                 LEFT JOIN users u ON u.id = b.user_id
                 LEFT JOIN rooms r ON b.property_type = 'room' AND r.id = b.property_id
                 LEFT JOIN tents t ON b.property_type = 'tent' AND t.id = b.property_id
                 LEFT JOIN hotels hr ON hr.id = r.hotel_id
                 LEFT JOIN hotels ht ON ht.id = t.hotel_id
                 LEFT JOIN payments p ON p.id = (
                   SELECT p2.id
                   FROM payments p2
                   WHERE p2.booking_id = b.id
                   ORDER BY p2.id DESC
                   LIMIT 1
                 )
                 WHERE 1 = 1`;
    const params = [];

    if (isHotelAdmin) {
      query += ' AND COALESCE(r.hotel_id, t.hotel_id) = ?';
      params.push(hotelId);
    } else if (hotelIdFilter) {
      query += ' AND COALESCE(r.hotel_id, t.hotel_id) = ?';
      params.push(Number(hotelIdFilter));
    }

    if (isHotelAdmin) {
      query += " AND b.status = 'confirmed'";
    } else if (status) {
      query += ' AND b.status = ?';
      params.push(status);
    }
    if (propertyType) {
      query += ' AND b.property_type = ?';
      params.push(propertyType);
    }
    if (!isHotelAdmin && paymentStatus) {
      query += ' AND b.payment_status = ?';
      params.push(paymentStatus);
    }
    if (checkInFrom) {
      query += ' AND date(b.check_in) >= date(?)';
      params.push(checkInFrom);
    }
    if (checkInTo) {
      query += ' AND date(b.check_in) <= date(?)';
      params.push(checkInTo);
    }
    if (from) {
      query += ' AND date(b.created_at) >= date(?)';
      params.push(from);
    }
    if (to) {
      query += ' AND date(b.created_at) <= date(?)';
      params.push(to);
    }
    if (search) {
      query += ' AND (b.booking_ref LIKE ? OR u.name LIKE ? OR u.phone LIKE ? OR COALESCE(r.name, t.name) LIKE ?)';
      const like = `%${String(search).trim()}%`;
      params.push(like, like, like, like);
    }

    query += ' ORDER BY b.created_at DESC';

    const bookings = db.prepare(query).all(...params);
    if (!isHotelAdmin) {
      return res.json(bookings);
    }

    const hotelAdminBookings = bookings.map((booking) => ({
      id: booking.id,
      booking_ref: booking.booking_ref,
      guest_name: booking.guest_name,
      guest_phone: booking.guest_phone,
      hotel_name: booking.hotel_name,
      property_name: booking.property_name,
      property_type: booking.property_type,
      check_in: booking.check_in,
      check_out: booking.check_out,
      due_on_arrival: Number(booking.due_on_arrival || booking.arrival_amount || 0),
      status: booking.status
    }));
    return res.json(hotelAdminBookings);
  } catch (err) {
    console.error('Admin list bookings error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function updateBookingStatus(req, res) {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }
    const validStatuses = ['pending', 'confirmed', 'cancelled', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    const db = getDb();
    const existing = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'Booking not found' });
    }
    if (req.user.role === 'hotel-admin') {
      const bookingHotelId = getBookingHotelId(db, existing);
      if (!req.user.hotelId || Number(bookingHotelId) !== Number(req.user.hotelId)) {
        return res.status(403).json({ message: 'Not allowed to modify bookings of another hotel' });
      }
      if (status !== 'cancelled') {
        return res.status(403).json({ message: 'Hotel admin can only cancel bookings' });
      }
    }
    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, id);
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    return res.json(booking);
  } catch (err) {
    console.error('Admin update booking status error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function approveBookingPayment(req, res) {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }
    if (req.user.role === 'hotel-admin') {
      const bookingHotelId = getBookingHotelId(db, booking);
      if (!req.user.hotelId || Number(bookingHotelId) !== Number(req.user.hotelId)) {
        return res.status(403).json({ message: 'Not allowed to approve payments of another hotel' });
      }
    }
    if (booking.payment_status === 'paid') {
      return res.json({ success: true, booking });
    }
    if (booking.payment_status !== 'pending_verification') {
      return res.status(400).json({ message: 'Only pending-verification payments can be approved' });
    }

    const payment = db.prepare('SELECT * FROM payments WHERE booking_id = ?').get(id);
    if (!payment) {
      return res.status(400).json({ message: 'No payment submission found for this booking' });
    }

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE payments
       SET status = 'success',
           paid_at = COALESCE(paid_at, ?)
       WHERE booking_id = ?`
    ).run(now, id);

    db.prepare(
      `UPDATE bookings
       SET payment_status = 'paid',
           status = CASE
             WHEN status IN ('cancelled', 'completed') THEN status
             ELSE 'confirmed'
           END
       WHERE id = ?`
    ).run(id);

    const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    return res.json({ success: true, booking: updated });
  } catch (err) {
    console.error('Admin approve booking payment error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function listPriceSettings(req, res) {
  try {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM price_settings').all();
    return res.json(settings);
  } catch (err) {
    console.error('Admin list price settings error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function createPriceSetting(req, res) {
  try {
    const { propertyType, propertyId, season, pricePerNight, weekendSurcharge, taxPercent } =
      req.body;
    if (!propertyType || !propertyId || !pricePerNight) {
      return res.status(400).json({
        message: 'propertyType, propertyId and pricePerNight are required'
      });
    }
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO price_settings (
        property_type, property_id, season, price_per_night, weekend_surcharge, tax_percent
      ) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(
      propertyType,
      propertyId,
      season || 'all',
      pricePerNight,
      weekendSurcharge || 0,
      taxPercent != null ? taxPercent : Number(process.env.TAX_PERCENT || 18)
    );
    const setting = db.prepare('SELECT * FROM price_settings WHERE id = ?').get(info.lastInsertRowid);
    return res.status(201).json(setting);
  } catch (err) {
    console.error('Admin create price setting error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function updatePriceSetting(req, res) {
  try {
    const id = Number(req.params.id);
    const { season, pricePerNight, weekendSurcharge, taxPercent } = req.body;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM price_settings WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'Price setting not found' });
    }
    db.prepare(
      `UPDATE price_settings SET 
        season = ?, price_per_night = ?, weekend_surcharge = ?, tax_percent = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      season || existing.season,
      pricePerNight != null ? pricePerNight : existing.price_per_night,
      weekendSurcharge != null ? weekendSurcharge : existing.weekend_surcharge,
      taxPercent != null ? taxPercent : existing.tax_percent,
      id
    );
    const setting = db.prepare('SELECT * FROM price_settings WHERE id = ?').get(id);
    return res.json(setting);
  } catch (err) {
    console.error('Admin update price setting error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function deletePriceSetting(req, res) {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM price_settings WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'Price setting not found' });
    }
    db.prepare('DELETE FROM price_settings WHERE id = ?').run(id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin delete price setting error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function listEnquiries(req, res) {
  try {
    const { status } = req.query;
    const db = getDb();
    let query = 'SELECT * FROM enquiries WHERE 1 = 1';
    const params = [];
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    query += ' ORDER BY created_at DESC';
    const enquiries = db.prepare(query).all(...params);
    return res.json(enquiries);
  } catch (err) {
    console.error('Admin list enquiries error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function updateEnquiryStatus(req, res) {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }
    const validStatuses = ['new', 'read', 'replied'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    const db = getDb();
    const existing = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'Enquiry not found' });
    }
    db.prepare('UPDATE enquiries SET status = ? WHERE id = ?').run(status, id);
    const enquiry = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id);
    return res.json(enquiry);
  } catch (err) {
    console.error('Admin update enquiry status error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function deleteEnquiry(req, res) {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ message: 'Enquiry not found' });
    }
    db.prepare('DELETE FROM enquiries WHERE id = ?').run(id);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin delete enquiry error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function getAgentStats(req, res) {
  try {
    const db = getDb();
    const agentStats = db.prepare(`
      SELECT 
        u.id,
        u.name,
        u.email,
        u.phone,
        COUNT(DISTINCT ar.customer_id) as total_customers,
        COUNT(ar.id) as total_referrals,
        IFNULL(SUM(ar.discount_amount), 0) as total_discount_given,
        IFNULL(SUM(b.total_amount), 0) as total_revenue_generated,
        COUNT(DISTINCT b.id) as total_bookings
      FROM users u
      LEFT JOIN agent_referrals ar ON ar.agent_id = u.id
      LEFT JOIN bookings b ON b.id = ar.booking_id
      WHERE u.role = 'agent'
      GROUP BY u.id, u.name, u.email, u.phone
      ORDER BY total_revenue_generated DESC
    `).all();

    res.json(agentStats);
  } catch (err) {
    console.error('Admin get agent stats error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  getDashboard,
  listRooms,
  listInventory,
  listRoomBookings,
  listTentBookings,
  createManualRoomBooking,
  deleteManualRoomBooking,
  createRoom,
  updateRoom,
  deleteRoom,
  uploadRoomImages,
  deleteRoomImage,
  setPrimaryRoomImage,
  listTents,
  createTent,
  updateTent,
  deleteTent,
  uploadTentImages,
  deleteTentImage,
  setPrimaryTentImage,
  listHotels,
  createHotel,
  updateHotel,
  deleteHotel,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  listAdminBookings,
  updateBookingStatus,
  listPriceSettings,
  createPriceSetting,
  updatePriceSetting,
  deletePriceSetting,
  listEnquiries,
  updateEnquiryStatus,
  deleteEnquiry,
  getAgentStats,
  approveBookingPayment
};

