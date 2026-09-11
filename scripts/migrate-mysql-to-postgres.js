require('dotenv').config();

const mysql = require('mysql2/promise');
const { Pool } = require('pg');

const source = mysql.createPool({ host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT || 3306), database: process.env.MYSQL_DATABASE || 'rentsystem', user: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD || '' });
const target = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const tables = [
  { name: 'users', columns: ['id', 'username', 'password', 'role'] },
  { name: 'equipment', columns: ['id', 'name', 'type', 'daily_price', 'status'] },
  { name: 'customers', columns: ['id', 'name', 'nic', 'phone', 'id_image'] },
  { name: 'rentals', columns: ['id', 'equipment_id', 'customer_id', 'rent_date', 'expected_return', 'actual_return', 'total_fee', 'amount_paid', 'signature'] },
  { name: 'calendar_events', columns: ['id', 'title', 'start_date', 'end_date', 'description'] },
  { name: 'payment_transactions', columns: ['id', 'rental_id', 'amount', 'payment_type', 'paid_at'] }
];

function pgValue(value) { return value instanceof Date ? value.toISOString() : value; }

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    for (const table of tables) {
      const [rows] = await source.query(`SELECT ${table.columns.join(', ')} FROM ${table.name}`);
      for (const row of rows) {
        const values = table.columns.map(column => pgValue(row[column]));
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        const updates = table.columns.filter(column => column !== 'id').map(column => `${column} = EXCLUDED.${column}`).join(', ');
        await client.query(`INSERT INTO ${table.name} (${table.columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updates}`, values);
      }
      if (rows.length) await client.query(`SELECT setval(pg_get_serial_sequence('${table.name}', 'id'), GREATEST((SELECT MAX(id) FROM ${table.name}), 1), true)`);
      console.log(`${table.name}: migrated ${rows.length} rows`);
    }
    await client.query('COMMIT');
    console.log('Migration completed successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await source.end();
    await target.end();
  }
}

migrate().catch(error => { console.error(error.message); process.exitCode = 1; });
