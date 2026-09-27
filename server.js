require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const receipts = require('./lib/receipts');

const app = express();
const port = Number(process.env.PORT || 3000);
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required. Add the Supabase Postgres connection string to the deployment environment.');
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 5
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
const uploadBucket = process.env.SUPABASE_STORAGE_BUCKET || 'rentmaster-uploads';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Vercel terminates TLS at the edge, so the function sees plain HTTP. Without this,
// req.protocol is "http" and the secure session cookie is silently dropped.
app.set('trust proxy', 1);
app.use(cookieSession({
  name: 'rentmaster-session',
  keys: [process.env.SESSION_SECRET || 'rentmaster-development-secret'],
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 1000 * 60 * 60 * 12
}));
app.use((req, res, next) => {
  res.locals.user = req.session?.user || null;
  res.locals.isAdmin = req.session?.user?.role === 'admin';
  res.locals.currentPath = req.path;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  if (req.session.user.role !== 'admin') return res.status(403).render('access-denied');
  next();
}

async function availableEquipment() {
  const { rows } = await pool.query("SELECT id, name, type, daily_price AS \"daily_price\", status FROM equipment WHERE status = 'Available' ORDER BY type, name");
  return rows;
}

async function activeRentals() {
  const { rows } = await pool.query('SELECT r.id, e.name AS "equipmentName", c.name AS "customerName", c.email, r.rent_date AS "rentDate", r.expected_return AS "expectedReturn", r.total_fee AS "totalFee", r.amount_paid AS "amountPaid", r.deposit, r.daily_price AS "dailyPrice", r.booked_days AS "bookedDays" FROM rentals r JOIN equipment e ON r.equipment_id = e.id JOIN customers c ON r.customer_id = c.id WHERE r.actual_return IS NULL ORDER BY r.expected_return ASC');
  // Project what the return would settle at right now, for the return dialog.
  return rows.map(row => {
    const actualDays = billableDays(row.rentDate, new Date());
    const bookedDays = Number(row.bookedDays) || billableDays(row.rentDate, row.expectedReturn);
    const originalTotal = Number(row.totalFee);
    const finalTotal = actualDays < bookedDays ? Math.min(originalTotal, Number(row.dailyPrice) * actualDays) : originalTotal;
    return { ...row, actualDays, bookedDays, finalTotal, balanceDue: Math.max(0, finalTotal - Number(row.amountPaid)), refundDue: Math.max(0, Number(row.amountPaid) - finalTotal) };
  });
}

async function uploadIdImage(file) {
  if (!file || !supabase) return null;
  const extension = path.extname(file.originalname || '').toLowerCase() || '.bin';
  const objectPath = `id-documents/${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`;
  const { error } = await supabase.storage.from(uploadBucket).upload(objectPath, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) throw error;
  return objectPath;
}

// Any started day counts as a full rental day; a rental is always at least one day.
function billableDays(from, to) {
  const start = new Date(from), end = new Date(to);
  if (isNaN(start) || isNaN(end) || end <= start) return 1;
  return Math.max(1, Math.ceil((end - start) / 86400000));
}

const PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'online']);
const PAYMENT_METHOD_LABELS = { cash: 'Cash', bank_transfer: 'Bank transfer', online: 'Online payment' };

// Bank and online advances must carry a traceable reference; cash takes an optional note.
function normalizePayment(method, reference, amount) {
  const chosen = String(method || 'cash').trim();
  if (!PAYMENT_METHODS.has(chosen)) throw new Error('Choose how the advance payment was received.');
  const note = String(reference || '').trim().slice(0, 120);
  if (amount > 0 && chosen !== 'cash' && !note) throw new Error('Add the bank or online transfer reference number for this advance payment.');
  return { method: chosen, reference: note || null };
}

function whatsappLink(phone, message) {
  const number = String(phone || '').replace(/\D/g, '').replace(/^0(?=\d{9}$)/, '94');
  return `https://wa.me/${encodeURIComponent(number)}?text=${encodeURIComponent(message)}`;
}

app.get('/', (req, res) => res.redirect(req.session?.user ? '/dashboard' : '/login'));
app.get('/login', (req, res) => req.session?.user ? res.redirect('/dashboard') : res.render('login', { error: null }));
app.post('/login', async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const { rows } = await pool.query('SELECT id, username, password, role FROM users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).render('login', { error: 'Invalid username or password.' });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.redirect('/dashboard');
  } catch (error) { next(error); }
});
app.post('/logout', (req, res) => { req.session = null; res.redirect('/login'); });

app.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const [{ rows: revenueRows }, { rows: gearRows }, { rows: outRows }, { rows: customerRows }, { rows: rentals }, { rows: activity }] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(amount_paid), 0) AS "totalPaid", COALESCE(SUM(total_fee) - SUM(amount_paid), 0) AS pending FROM rentals'),
      pool.query('SELECT COUNT(*)::int AS "totalGear" FROM equipment'),
      pool.query("SELECT COUNT(*)::int AS \"outGear\" FROM equipment WHERE status = 'Rented'"),
      pool.query('SELECT COUNT(*)::int AS "totalCustomers" FROM customers'),
      pool.query('SELECT r.id, e.name AS "equipmentName", c.name AS "customerName", r.expected_return AS "expectedReturn", r.total_fee AS "totalFee", r.amount_paid AS "amountPaid" FROM rentals r JOIN equipment e ON r.equipment_id = e.id JOIN customers c ON r.customer_id = c.id WHERE r.actual_return IS NULL ORDER BY r.expected_return ASC'),
      pool.query("SELECT DATE(rent_date) AS \"rentalDay\", COUNT(*)::int AS \"rentalCount\" FROM rentals WHERE rent_date >= CURRENT_DATE - INTERVAL '6 days' GROUP BY DATE(rent_date)")
    ]);
    const activityMap = Object.fromEntries(activity.map(row => [String(row.rentalDay).slice(0, 10), row.rentalCount]));
    const weekActivity = Array.from({ length: 7 }, (_, index) => { const date = new Date(); date.setDate(date.getDate() - (6 - index)); const key = date.toISOString().slice(0, 10); return { label: date.toLocaleDateString('en', { weekday: 'short' }), count: Number(activityMap[key] || 0) }; });
    res.render('dashboard', { revenue: revenueRows[0], totalGear: gearRows[0].totalGear, outGear: outRows[0].outGear, totalCustomers: customerRows[0].totalCustomers, activeRentals: rentals, weekActivity, maxActivity: Math.max(1, ...weekActivity.map(day => day.count)) });
  } catch (error) { next(error); }
});

app.get('/rent', requireAuth, async (req, res, next) => { try { res.render('rent', { equipment: await availableEquipment(), success: null, whatsappLink: null, error: null }); } catch (error) { next(error); } });
app.post('/rent', requireAuth, upload.single('nicImage'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { equipmentId, customerName, nic, phone, email, startDate, endDate, totalFee, amountPaid, deposit, paymentMethod, paymentReference, signature } = req.body;
    const clientEmail = String(email || '').trim().slice(0, 255) || null;
    const advance = Math.max(0, Number(amountPaid) || 0);
    const depositAmount = Math.max(0, Number(deposit) || 0);
    const payment = normalizePayment(paymentMethod, paymentReference, advance);
    await client.query('BEGIN');
    const { rows: itemRows } = await client.query("SELECT id, name, type, daily_price FROM equipment WHERE id = $1 AND status = 'Available' FOR UPDATE", [equipmentId]);
    const item = itemRows[0];
    if (!item) throw new Error('The selected equipment is no longer available.');
    const imageUrl = await uploadIdImage(req.file);
    const { rows: customerRows } = await client.query('SELECT id FROM customers WHERE nic = $1', [String(nic).trim()]);
    let customerId = customerRows[0]?.id;
    if (!customerId) { const created = await client.query('INSERT INTO customers (name, nic, phone, email, id_image) VALUES ($1, $2, $3, $4, $5) RETURNING id', [String(customerName).trim(), String(nic).trim(), String(phone).trim(), clientEmail, imageUrl]); customerId = created.rows[0].id; }
    else {
      if (imageUrl) await client.query('UPDATE customers SET id_image = $1 WHERE id = $2', [imageUrl, customerId]);
      if (clientEmail) await client.query('UPDATE customers SET email = $1 WHERE id = $2', [clientEmail, customerId]);
    }
    const bookedDays = billableDays(startDate, endDate);
    const agreedTotal = Math.max(0, Number(totalFee));
    const rental = await client.query('INSERT INTO rentals (equipment_id, customer_id, rent_date, expected_return, total_fee, amount_paid, deposit, daily_price, booked_days, signature) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id', [equipmentId, customerId, startDate, endDate, agreedTotal, advance, depositAmount, Number(item.daily_price), bookedDays, signature || null]);
    if (advance > 0) await client.query("INSERT INTO payment_transactions (rental_id, amount, payment_type, method, reference) VALUES ($1, $2, 'checkout', $3, $4)", [rental.rows[0].id, advance, payment.method, payment.reference]);
    await client.query("UPDATE equipment SET status = 'Rented' WHERE id = $1", [equipmentId]);
    await client.query('COMMIT');
    await receipts.send('checkout', {
      email: clientEmail, rentalId: rental.rows[0].id, customerName: String(customerName).trim(), nic: String(nic).trim(), phone: String(phone).trim(),
      equipmentName: item.name, equipmentType: item.type, startDate, endDate, bookedDays,
      dailyPrice: Number(item.daily_price), totalFee: agreedTotal, advance, deposit: depositAmount,
      method: payment.method, reference: payment.reference
    });
    const message = `Hi ${customerName}, thank you for renting from RentMaster. You rented ${item.name} from ${new Date(startDate).toLocaleString()} until ${new Date(endDate).toLocaleString()}. Advance paid: LKR ${advance.toFixed(2)} (${PAYMENT_METHOD_LABELS[payment.method]}). Refundable deposit: LKR ${depositAmount.toFixed(2)}. Please return it before ${new Date(endDate).toLocaleString()}. Thank you for choosing RentMaster!`;
    res.render('rent', { equipment: await availableEquipment(), success: 'Rental logged, documents saved, and signature secured!', whatsappLink: whatsappLink(phone, message), error: null });
  } catch (error) { await client.query('ROLLBACK'); const equipment = await availableEquipment(); res.status(400).render('rent', { equipment, success: null, whatsappLink: null, error: error.message }); } finally { client.release(); }
});

app.get('/customers/:id/document', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id_image FROM customers WHERE id = $1', [req.params.id]);
    const stored = rows[0]?.id_image;
    if (!stored) return res.status(404).send('No ID document is on file for this customer.');
    if (/^https?:\/\//i.test(stored)) return res.redirect(stored);
    if (!supabase) return res.status(503).send('Supabase Storage is not configured.');
    const { data, error } = await supabase.storage.from(uploadBucket).createSignedUrl(stored.replace(/^uploads\//, ''), 60);
    if (error) return res.status(404).send('That ID document could not be found in storage.');
    res.redirect(data.signedUrl);
  } catch (error) { next(error); }
});

app.get('/customers', requireAuth, async (req, res, next) => { try { const { rows: customers } = await pool.query('SELECT id, name, nic, phone, id_image FROM customers ORDER BY name ASC'); res.render('customers', { customers }); } catch (error) { next(error); } });

app.get('/equipment', requireAuth, async (req, res, next) => { try { const { rows: equipment } = await pool.query('SELECT id, name, type, daily_price, status FROM equipment ORDER BY type ASC'); res.render('equipment', { equipment, activeRentals: await activeRentals(), error: null }); } catch (error) { next(error); } });
app.post('/equipment', requireAuth, async (req, res, next) => {
  const { action, equipmentId, name, type, dailyPrice, status } = req.body;
  try {
    if (action === 'add') await pool.query('INSERT INTO equipment (name, type, daily_price, status) VALUES ($1, $2, $3, $4)', [name.trim(), type.trim(), Math.max(0, Number(dailyPrice)), status]);
    if (action === 'update') await pool.query('UPDATE equipment SET name = $1, type = $2, daily_price = $3, status = $4 WHERE id = $5', [name.trim(), type.trim(), Math.max(0, Number(dailyPrice)), status, equipmentId]);
    if (action === 'delete' && req.session.user.role === 'admin') await pool.query("DELETE FROM equipment WHERE id = $1 AND status != 'Rented'", [equipmentId]);
    if (action === 'return') {
      const client = await pool.connect();
      let finalReceipt = null;
      try {
        await client.query('BEGIN');
        const { rows } = await client.query("SELECT r.id, r.equipment_id, r.rent_date, r.expected_return, r.total_fee, r.amount_paid, r.deposit, r.daily_price, r.booked_days, e.name AS equipment_name, e.type AS equipment_type, c.name AS customer_name, c.email FROM rentals r JOIN equipment e ON r.equipment_id = e.id JOIN customers c ON r.customer_id = c.id WHERE r.id = $1 AND r.actual_return IS NULL FOR UPDATE OF r", [equipmentId]);
        const rental = rows[0];
        if (rental) {
          const returnedAt = new Date();
          const actualDays = billableDays(rental.rent_date, returnedAt);
          const bookedDays = Number(rental.booked_days) || billableDays(rental.rent_date, rental.expected_return);
          const originalTotal = Number(rental.total_fee);
          // An early return is recharged at the agreed daily rate, and can never
          // cost more than the total the client originally agreed to.
          const finalTotal = actualDays < bookedDays ? Math.min(originalTotal, Number(rental.daily_price) * actualDays) : originalTotal;
          const alreadyPaid = Number(rental.amount_paid);
          const collected = Math.min(Math.max(0, Number(req.body.returnPayment) || 0), Math.max(0, finalTotal - alreadyPaid));
          const refund = Math.max(0, alreadyPaid - finalTotal);
          const deduction = Math.min(Math.max(0, Number(req.body.depositDeduction) || 0), Number(rental.deposit));
          const reason = String(req.body.depositDeductionReason || '').trim().slice(0, 255) || null;
          const returnPay = normalizePayment(req.body.returnMethod, req.body.returnReference, collected);

          await client.query('UPDATE rentals SET actual_return = $1, actual_days = $2, total_fee = $3, amount_paid = amount_paid + $4 - $5, deposit_deduction = $6, deposit_deduction_reason = $7 WHERE id = $8', [returnedAt, actualDays, finalTotal, collected, refund, deduction, deduction > 0 ? reason : null, rental.id]);
          if (collected > 0) await client.query("INSERT INTO payment_transactions (rental_id, amount, payment_type, method, reference) VALUES ($1, $2, 'return', $3, $4)", [rental.id, collected, returnPay.method, returnPay.reference]);
          // Refunds are negative ledger rows so SUM(amount) stays truthful.
          if (refund > 0) await client.query("INSERT INTO payment_transactions (rental_id, amount, payment_type, method) VALUES ($1, $2, 'refund', $3)", [rental.id, -refund, returnPay.method]);
          await client.query("UPDATE equipment SET status = 'Available' WHERE id = $1", [rental.equipment_id]);

          finalReceipt = { email: rental.email, rentalId: rental.id, customerName: rental.customer_name, equipmentName: rental.equipment_name, equipmentType: rental.equipment_type, startDate: rental.rent_date, endDate: rental.expected_return, actualReturn: returnedAt, bookedDays, actualDays, dailyPrice: Number(rental.daily_price), originalTotal, finalTotal, advance: alreadyPaid, collected, refund, deposit: Number(rental.deposit), deduction, deductionReason: reason };
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      if (finalReceipt) await receipts.send('final', finalReceipt);
    }
    res.redirect('/equipment');
  } catch (error) { const { rows: equipment } = await pool.query('SELECT id, name, type, daily_price, status FROM equipment ORDER BY type ASC'); res.status(400).render('equipment', { equipment, activeRentals: await activeRentals(), error: 'This equipment cannot be deleted because it has rental history.' }); }
});

app.get('/calendar', requireAuth, async (req, res, next) => { try { const { rows: rentals } = await pool.query('SELECT r.id, e.name AS title, r.rent_date AS start, r.expected_return AS end, r.actual_return AS "actualReturn" FROM rentals r JOIN equipment e ON r.equipment_id = e.id'); const { rows: customEvents } = await pool.query('SELECT id, title, start_date AS start, end_date AS end FROM calendar_events'); const events = [...rentals.map(rental => ({ title: `Out: ${rental.title}`, start: rental.start, end: rental.end, color: rental.actualReturn ? '#2c3e50' : '#e34b3f' })), ...customEvents.map(event => ({ ...event, id: `custom-${event.id}`, color: '#f39c12', extendedProps: { customId: event.id } }))]; res.render('calendar', { events, activeRentalCount: rentals.filter(rental => !rental.actualReturn).length, manualEventCount: customEvents.length }); } catch (error) { next(error); } });
app.post('/calendar', requireAuth, async (req, res, next) => { try { if (req.body.action === 'delete') await pool.query('DELETE FROM calendar_events WHERE id = $1', [req.body.eventId]); if (req.body.action === 'save') { if (req.body.eventId) await pool.query('UPDATE calendar_events SET title = $1, start_date = $2, end_date = $3 WHERE id = $4', [req.body.title, req.body.startDate, req.body.endDate, req.body.eventId]); else await pool.query('INSERT INTO calendar_events (title, start_date, end_date) VALUES ($1, $2, $3)', [req.body.title, req.body.startDate, req.body.endDate]); } res.redirect('/calendar'); } catch (error) { next(error); } });

app.get('/payments', requireAdmin, async (req, res, next) => { try { const { rows: summaryRows } = await pool.query('SELECT COALESCE(SUM(amount_paid), 0) AS collected, COALESCE(SUM(GREATEST(total_fee - amount_paid, 0)), 0) AS outstanding, COUNT(*)::int AS rentals FROM rentals'); const { rows: payments } = await pool.query('SELECT p.id, p.amount, p.payment_type AS "paymentType", p.method, p.reference, p.paid_at AS "paidAt", c.name AS "customerName", c.phone, e.name AS "equipmentName", r.total_fee AS "totalFee", r.amount_paid AS "amountPaid", r.deposit FROM payment_transactions p JOIN rentals r ON p.rental_id = r.id JOIN customers c ON r.customer_id = c.id JOIN equipment e ON r.equipment_id = e.id ORDER BY p.paid_at DESC, p.id DESC'); res.render('payments', { summary: summaryRows[0], payments, methodLabels: PAYMENT_METHOD_LABELS }); } catch (error) { next(error); } });
app.get('/notifications', requireAdmin, async (req, res, next) => { try { const { rows: upcoming } = await pool.query("SELECT r.id, e.name AS \"equipmentName\", c.name AS \"customerName\", c.phone, r.expected_return AS \"expectedReturn\" FROM rentals r JOIN equipment e ON r.equipment_id = e.id JOIN customers c ON r.customer_id = c.id WHERE r.actual_return IS NULL AND DATE(r.expected_return) = CURRENT_DATE + INTERVAL '1 day'"); const { rows: overdue } = await pool.query("SELECT r.id, e.name AS \"equipmentName\", c.name AS \"customerName\", c.phone, r.expected_return AS \"expectedReturn\" FROM rentals r JOIN equipment e ON r.equipment_id = e.id JOIN customers c ON r.customer_id = c.id WHERE r.actual_return IS NULL AND r.expected_return < NOW()"); res.render('notifications', { upcoming: upcoming.map(item => ({ ...item, link: whatsappLink(item.phone, `Hi ${item.customerName}, this is a quick reminder from RentMaster. Your rental for the ${item.equipmentName} is due back tomorrow. Thank you!`) })), overdue: overdue.map(item => ({ ...item, link: whatsappLink(item.phone, `Alert from RentMaster: Hi ${item.customerName}, your equipment return for the ${item.equipmentName} is currently overdue. Please contact the studio immediately.`) })) }); } catch (error) { next(error); } });
app.get('/users', requireAdmin, async (req, res, next) => { try { const { rows: users } = await pool.query('SELECT id, username, role FROM users ORDER BY role ASC, username ASC'); res.render('users', { users, message: null, error: null }); } catch (error) { next(error); } });
app.post('/users', requireAdmin, async (req, res, next) => { try { let message = null; if (req.body.action === 'add') { await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [req.body.username.trim(), await bcrypt.hash(req.body.password, 10), req.body.role]); message = `New user '${req.body.username.trim()}' created successfully!`; } if (req.body.action === 'password') { await pool.query('UPDATE users SET password = $1 WHERE id = $2', [await bcrypt.hash(req.body.newPassword, 10), req.body.userId]); message = 'Password updated successfully!'; } const { rows: users } = await pool.query('SELECT id, username, role FROM users ORDER BY role ASC, username ASC'); res.render('users', { users, message, error: null }); } catch (error) { const { rows: users } = await pool.query('SELECT id, username, role FROM users ORDER BY role ASC, username ASC'); res.status(400).render('users', { users, message: null, error: 'Username may already exist in the system.' }); } });

app.use((error, req, res, next) => { console.error(error); res.status(500).send('RentMaster could not complete that request. Check the server log.'); });

if (!process.env.VERCEL) app.listen(port, () => console.log(`RentMaster V7 running at http://localhost:${port}`));

module.exports = app;
