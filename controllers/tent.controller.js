const path = require('path');
const { getDb } = require('../db/database');
require('dotenv').config();

function buildImageUrl(req, relativePath) {
  if (!relativePath) return null;
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized;
  }
  return `${baseUrl}/${normalized.replace(/^\.?\//, '')}`;
}

function parseAmenities(rawAmenities) {
  if (rawAmenities == null) {
    return [];
  }
  if (Array.isArray(rawAmenities)) {
    return rawAmenities.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof rawAmenities === 'string') {
    const trimmed = rawAmenities.trim();
    if (!trimmed) {
      return [];
    }
    try {
      return parseAmenities(JSON.parse(trimmed));
    } catch (_) {
      return [trimmed];
    }
  }
  return [String(rawAmenities)];
}

function getFullyBookedRanges(bookings, manualBookings, quantity) {
  const totalInventory = Math.max(Number(quantity || 1), 1);
  const hasBookingData = Array.isArray(bookings) && bookings.length;
  const hasManualData = Array.isArray(manualBookings) && manualBookings.length;
  if (!hasBookingData && !hasManualData) {
    return [];
  }

  const deltasByDate = new Map();
  (bookings || []).forEach((booking) => {
    if (!booking?.check_in || !booking?.check_out || booking.check_out <= booking.check_in) {
      return;
    }
    deltasByDate.set(booking.check_in, (deltasByDate.get(booking.check_in) || 0) + 1);
    deltasByDate.set(booking.check_out, (deltasByDate.get(booking.check_out) || 0) - 1);
  });
  (manualBookings || []).forEach((booking) => {
    const quantityDelta = Number(booking?.booked_quantity || 0);
    if (
      !booking?.check_in ||
      !booking?.check_out ||
      booking.check_out <= booking.check_in ||
      quantityDelta <= 0
    ) {
      return;
    }
    deltasByDate.set(booking.check_in, (deltasByDate.get(booking.check_in) || 0) + quantityDelta);
    deltasByDate.set(booking.check_out, (deltasByDate.get(booking.check_out) || 0) - quantityDelta);
  });

  const dates = Array.from(deltasByDate.keys()).sort((a, b) => a.localeCompare(b));
  const ranges = [];
  let active = 0;

  for (let i = 0; i < dates.length - 1; i += 1) {
    const currentDate = dates[i];
    const nextDate = dates[i + 1];
    active += deltasByDate.get(currentDate) || 0;

    if (currentDate >= nextDate || active < totalInventory) {
      continue;
    }

    const lastRange = ranges.length ? ranges[ranges.length - 1] : null;
    if (lastRange && lastRange.checkOut === currentDate) {
      lastRange.checkOut = nextDate;
    } else {
      ranges.push({ checkIn: currentDate, checkOut: nextDate, status: 'full' });
    }
  }

  return ranges;
}

async function listTents(req, res) {
  try {
    const { type, minPrice, maxPrice, capacity } = req.query;
    const db = getDb();

    let query =
      "SELECT t.*, h.name as hotel_name FROM tents t LEFT JOIN hotels h ON h.id = t.hotel_id WHERE t.status = 'active'";
    const params = [];

    if (type) {
      query += ' AND t.type = ?';
      params.push(type);
    }
    if (minPrice) {
      query += ' AND t.totalPrice >= ?';
      params.push(Number(minPrice));
    }
    if (maxPrice) {
      query += ' AND t.totalPrice <= ?';
      params.push(Number(maxPrice));
    }
    if (capacity) {
      query += ' AND t.capacity >= ?';
      params.push(Number(capacity));
    }

    const tents = db.prepare(query).all(...params);

    const tentIds = tents.map((t) => t.id);
    let imagesByTent = {};
    if (tentIds.length) {
      const placeholders = tentIds.map(() => '?').join(',');
      const images = db
        .prepare(
          `SELECT * FROM tent_images WHERE tent_id IN (${placeholders}) ORDER BY is_primary DESC, id ASC`
        )
        .all(...tentIds);
      imagesByTent = images.reduce((acc, img) => {
        if (!acc[img.tent_id]) acc[img.tent_id] = [];
        acc[img.tent_id].push(img);
        return acc;
      }, {});
    }

    const result = tents.map((tent) => {
      const images = (imagesByTent[tent.id] || []).map((img) => ({
        id: img.id,
        isPrimary: !!img.is_primary,
        url: buildImageUrl(req, path.join('uploads', 'tents', path.basename(img.image_path)))
      }));
      return {
        ...tent,
        amenities: parseAmenities(tent.amenities),
        images
      };
    });

    return res.json(result);
  } catch (err) {
    console.error('List tents error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function searchTents(req, res) {
  try {
    const { checkin, checkout, guests, type } = req.query;
    if (!checkin || !checkout || !guests) {
      return res.status(400).json({ message: 'checkin, checkout and guests are required' });
    }

    const db = getDb();
    const params = [Number(guests)];
    let query =
      "SELECT t.*, h.name as hotel_name FROM tents t LEFT JOIN hotels h ON h.id = t.hotel_id WHERE t.status = 'active' AND t.capacity >= ?";

    if (type) {
      query += ' AND t.type = ?';
      params.push(type);
    }

    const tents = db.prepare(query).all(...params);

    const availableTents = tents.filter((tent) => {
      const overlappingBookingsCount = db
        .prepare(
          `SELECT COUNT(*) as c FROM bookings 
           WHERE property_type = 'tent'
             AND property_id = ?
             AND status != 'cancelled'
             AND NOT (date(check_out) <= date(?) OR date(check_in) >= date(?))`
        )
        .get(tent.id, checkin, checkout).c;
      const overlappingManualCount = db
        .prepare(
          `SELECT IFNULL(SUM(booked_quantity), 0) as c
           FROM tent_manual_bookings
           WHERE tent_id = ?
             AND NOT (date(check_out) <= date(?) OR date(check_in) >= date(?))`
        )
        .get(tent.id, checkin, checkout).c;
      const totalInventory = Math.max(Number(tent.quantity || 1), 1);
      return Number(overlappingBookingsCount || 0) + Number(overlappingManualCount || 0) < totalInventory;
    });

    const tentIds = availableTents.map((t) => t.id);
    let imagesByTent = {};
    if (tentIds.length) {
      const placeholders = tentIds.map(() => '?').join(',');
      const images = db
        .prepare(
          `SELECT * FROM tent_images WHERE tent_id IN (${placeholders}) ORDER BY is_primary DESC, id ASC`
        )
        .all(...tentIds);
      imagesByTent = images.reduce((acc, img) => {
        if (!acc[img.tent_id]) acc[img.tent_id] = [];
        acc[img.tent_id].push(img);
        return acc;
      }, {});
    }

    const result = availableTents.map((tent) => {
      const images = (imagesByTent[tent.id] || []).map((img) => ({
        id: img.id,
        isPrimary: !!img.is_primary,
        url: buildImageUrl(req, path.join('uploads', 'tents', path.basename(img.image_path)))
      }));
      return {
        ...tent,
        amenities: parseAmenities(tent.amenities),
        images
      };
    });

    return res.json(result);
  } catch (err) {
    console.error('Search tents error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function getTentById(req, res) {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const tent = db
      .prepare(
        `SELECT t.*, h.name as hotel_name
         FROM tents t
         LEFT JOIN hotels h ON h.id = t.hotel_id
         WHERE t.id = ?`
      )
      .get(id);
    if (!tent) {
      return res.status(404).json({ message: 'Tent not found' });
    }

    const images = db
      .prepare('SELECT * FROM tent_images WHERE tent_id = ? ORDER BY is_primary DESC, id ASC')
      .all(id)
      .map((img) => ({
        id: img.id,
        isPrimary: !!img.is_primary,
        url: buildImageUrl(req, path.join('uploads', 'tents', path.basename(img.image_path)))
      }));

    const activeBookings = db
      .prepare(
        `SELECT check_in, check_out, status
         FROM bookings
         WHERE property_type = 'tent'
           AND property_id = ?
           AND status != 'cancelled'
           AND date(check_out) >= date('now')
         ORDER BY date(check_in) ASC`
      )
      .all(id);
    const activeManualBookings = db
      .prepare(
        `SELECT check_in, check_out, booked_quantity
         FROM tent_manual_bookings
         WHERE tent_id = ?
           AND booked_quantity > 0
           AND date(check_out) >= date('now')
         ORDER BY date(check_in) ASC`
      )
      .all(id);
    const bookedDateRanges = getFullyBookedRanges(activeBookings, activeManualBookings, tent.quantity);

    return res.json({
      ...tent,
      amenities: parseAmenities(tent.amenities),
      images,
      bookedDateRanges
    });
  } catch (err) {
    console.error('Get tent by id error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

async function getTentImages(req, res) {
  try {
    const id = Number(req.params.id);
    const db = getDb();
    const images = db
      .prepare('SELECT * FROM tent_images WHERE tent_id = ? ORDER BY is_primary DESC, id ASC')
      .all(id)
      .map((img) => ({
        id: img.id,
        isPrimary: !!img.is_primary,
        url: buildImageUrl(req, path.join('uploads', 'tents', path.basename(img.image_path)))
      }));
    return res.json(images);
  } catch (err) {
    console.error('Get tent images error', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
}

module.exports = {
  listTents,
  searchTents,
  getTentById,
  getTentImages
};

