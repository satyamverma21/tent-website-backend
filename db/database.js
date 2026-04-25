const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const dbPath = process.env.DB_PATH || './db/booking.sqlite';
const resolvedPath = path.resolve(__dirname, '..', dbPath);

// Ensure directory exists
const dir = path.dirname(resolvedPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

let db;

function getDb() {
  if (!db) {
    db = new Database(resolvedPath);
    db.pragma('foreign_keys = ON');
  }
  return db;
}

module.exports = {
  getDb
};

