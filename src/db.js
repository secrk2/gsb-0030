'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

let pool;

async function initDb(customPool) {
  if (customPool) {
    pool = customPool;
  } else {
    pool = new Pool({
      host: process.env.PGHOST || 'db',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'xuliu',
      password: process.env.PGPASSWORD || 'xuliu123',
      database: process.env.PGDATABASE || 'xuliu',
      max: 10,
    });
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'init.sql'), 'utf8');
  await pool.query(sql);
  return pool;
}

function db() {
  if (!pool) throw new Error('数据库尚未初始化，请先 await initDb()');
  return pool;
}

async function waitForDb(retries = 30, delayMs = 1000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { initDb, db, waitForDb };
