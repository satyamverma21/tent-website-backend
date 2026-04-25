const { getDb } = require('../db/database');

function normalizeAmenities(value) {
  if (value === null || value === undefined) {
    return JSON.stringify([]);
  }

  let parsed = value;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed) {
      return JSON.stringify([]);
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch (_) {
      parsed = [trimmed];
    }
  }

  if (!Array.isArray(parsed)) {
    parsed = parsed == null ? [] : [String(parsed)];
  }

  const normalized = parsed
    .map((item) => String(item).trim())
    .filter(Boolean);

  return JSON.stringify(normalized);
}

function cleanupTable(db, tableName) {
  const rows = db.prepare(`SELECT id, amenities FROM ${tableName}`).all();
  const updateStmt = db.prepare(`UPDATE ${tableName} SET amenities = ? WHERE id = ?`);

  let updated = 0;
  const updatedIds = [];

  for (const row of rows) {
    const normalized = normalizeAmenities(row.amenities);
    if (row.amenities !== normalized) {
      updateStmt.run(normalized, row.id);
      updated += 1;
      updatedIds.push(row.id);
    }
  }

  return { total: rows.length, updated, updatedIds };
}

function main() {
  const db = getDb();

  const runCleanup = db.transaction(() => {
    const roomResult = cleanupTable(db, 'rooms');
    const tentResult = cleanupTable(db, 'tents');
    return { roomResult, tentResult };
  });

  const { roomResult, tentResult } = runCleanup();

  console.log('Amenities cleanup completed.');
  console.log(
    `Rooms: ${roomResult.updated}/${roomResult.total} row(s) normalized` +
      (roomResult.updated ? ` (IDs: ${roomResult.updatedIds.join(', ')})` : '')
  );
  console.log(
    `Tents: ${tentResult.updated}/${tentResult.total} row(s) normalized` +
      (tentResult.updated ? ` (IDs: ${tentResult.updatedIds.join(', ')})` : '')
  );
}

main();
