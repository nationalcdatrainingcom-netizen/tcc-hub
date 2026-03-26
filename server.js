const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'tcc-hub-jwt-secret-change-in-production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'tcc-hub-session-secret-2026';

// ── Database ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ── Middleware ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new PgSession({ pool, tableName: 'hub_sessions', createTableIfMissing: true }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));

// ── Auth middleware ──
function auth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Not authenticated' });
}
function adminOnly(req, res, next) {
  if (req.session && req.session.role === 'owner') return next();
  res.status(403).json({ error: 'Admin access required' });
}

// ── Initialize Database Tables ──
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS hub_apps (
        id SERIAL PRIMARY KEY,
        app_key VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        category VARCHAR(50) NOT NULL,
        icon VARCHAR(10) NOT NULL,
        color VARCHAR(20),
        url TEXT NOT NULL,
        description TEXT,
        display_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS hub_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(30) NOT NULL DEFAULT 'staff',
        center VARCHAR(30) DEFAULT 'all',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        last_login TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS hub_user_apps (
        user_id INT REFERENCES hub_users(id) ON DELETE CASCADE,
        app_id INT REFERENCES hub_apps(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, app_id)
      );

      CREATE TABLE IF NOT EXISTS hub_favorites (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES hub_users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        url TEXT NOT NULL,
        icon VARCHAR(10) DEFAULT '🔗',
        display_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS hub_activity_log (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES hub_users(id) ON DELETE SET NULL,
        action VARCHAR(50) NOT NULL,
        app_key VARCHAR(50),
        details TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── Seed apps if empty ──
    const { rows: existingApps } = await client.query('SELECT COUNT(*) FROM hub_apps');
    if (parseInt(existingApps[0].count) === 0) {
      const apps = [
        ['payroll', 'Payroll Hub', 'Daily Operations', '💰', '#2D6A4F', 'https://tcc-payroll-hub.onrender.com', 'Four-step payroll workflow', 1],
        ['cacfp', 'CACFP Suite', 'Daily Operations', '🍎', '#E76F51', 'https://tcc-cacfp-suite.onrender.com', 'Meal tracking & claims', 2],
        ['staff-time', 'Staff Time & Attendance', 'Daily Operations', '⏱️', '#264653', 'https://tcc-staff-time.onrender.com', 'Time tracking & signatures', 3],
        ['inventory', 'Supply Inventory', 'Daily Operations', '📦', '#E9C46A', 'https://tcc-inventory.onrender.com', 'Shopping lists & orders', 4],
        ['master-organizer', 'Master Organizer', 'Daily Operations', '📋', '#457B9D', 'https://tcc-master-organizer.onrender.com', 'Email, tours & projects', 5],
        ['policy', 'Policy Assistant', 'Compliance & Quality', '📜', '#6A4C93', 'https://tcc-policy-assistant-1.onrender.com', 'Handbook & licensing', 6],
        ['gsq', 'GSQ Self-Reflection', 'Compliance & Quality', '🔍', '#1D3557', 'https://tcc-gsq-reflection.onrender.com', 'Director assignments & evidence', 7],
        ['compliance', 'TCC Compliance', 'Compliance & Quality', '✅', '#2A9D8F', 'https://tcc-compliance.onrender.com', 'Inspection forms', 8],
        ['gsrp-invoice', 'GSRP Invoice', 'Administration', '🧾', '#3A5A40', 'https://tcc-gsrp-invoice.onrender.com', 'GSRP billing', 9],
        ['curriculum', 'Faithful Foundations', 'Professional Development', '📖', '#CB997E', 'https://tcc-curriculum-generator.onrender.com', 'Faith-based curriculum platform', 10],
        ['cda', 'CDA Certificate Generator', 'Professional Development', '🎓', '#B5838D', 'https://cda-certificate-generator.onrender.com', '42-page certificate packages', 11],
        ['vision-center', "Mary's Vision Center", "Mary's Personal", '🌟', '#38bdf8', 'https://mary-vision-center.onrender.com', 'Vision, prosperity & abundance', 12],
        ['msa-organizer', 'MSA Organizer', "Mary's Personal", '🎯', '#f59e0b', 'https://msa-organizer.onrender.com', 'Mentor Success Academy hub', 13],
        ['doc-organizer', 'Document Organizer', "Mary's Personal", '📬', '#6366f1', 'https://home-document-organizer.onrender.com', 'Mail scanning & filing', 14],
        ['family-vault', 'Family Vault', "Mary's Personal", '🔐', '#1a1a2e', 'https://family-vault.onrender.com', 'Family password vault', 15],
      ];
      for (const a of apps) {
        await client.query(
          'INSERT INTO hub_apps (app_key, name, category, icon, color, url, description, display_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          a
        );
      }
      console.log('✓ Seeded', apps.length, 'apps');
    }

    // ── Seed users if empty ──
    const { rows: existingUsers } = await client.query('SELECT COUNT(*) FROM hub_users');
    if (parseInt(existingUsers[0].count) === 0) {
      const defaultPw = await bcrypt.hash('tcc2026', 10);
      const users = [
        ['mary', defaultPw, 'Mary Wardlaw', 'owner', 'all'],
        ['jared', defaultPw, 'Jared Wardlaw', 'payroll', 'all'],
        ['amy', defaultPw, 'Amy Gutierrez', 'hr', 'all'],
        ['gabby', defaultPw, 'Gabby Fountain', 'director', 'peace'],
        ['kirsten', defaultPw, 'Kirsten Swem', 'director', 'niles'],
        ['shari', defaultPw, 'Shari Phillips', 'director', 'montessori'],
        ['jay', defaultPw, 'Jay Wardlaw', 'supply', 'all'],
        ['kelsey', defaultPw, 'Kelsey Wardlaw', 'staff', 'all'],
      ];

      // App assignments per user
      const userApps = {
        'mary': null, // gets ALL apps
        'jared': ['payroll', 'master-organizer'],
        'amy': ['payroll', 'gsq', 'compliance', 'policy', 'curriculum', 'cda'],
        'gabby': ['payroll', 'cacfp', 'staff-time', 'gsq', 'policy', 'compliance', 'inventory'],
        'kirsten': ['payroll', 'cacfp', 'staff-time', 'gsq', 'policy', 'compliance', 'inventory'],
        'shari': ['payroll', 'cacfp', 'staff-time', 'gsq', 'policy', 'compliance', 'inventory'],
        'jay': ['inventory'],
        'kelsey': ['policy', 'compliance'],
      };

      for (const u of users) {
        const { rows } = await client.query(
          'INSERT INTO hub_users (username, password_hash, name, role, center) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          u
        );
        const userId = rows[0].id;
        const username = u[0];
        const appKeys = userApps[username];

        if (appKeys === null) {
          // Owner gets all apps
          await client.query(
            'INSERT INTO hub_user_apps (user_id, app_id) SELECT $1, id FROM hub_apps',
            [userId]
          );
        } else {
          for (const key of appKeys) {
            await client.query(
              'INSERT INTO hub_user_apps (user_id, app_id) SELECT $1, id FROM hub_apps WHERE app_key = $2',
              [userId, key]
            );
          }
        }
      }
      console.log('✓ Seeded', users.length, 'users with app assignments');

      // Seed Mary's default favorites
      const { rows: maryRows } = await client.query("SELECT id FROM hub_users WHERE username = 'mary'");
      if (maryRows.length) {
        const maryId = maryRows[0].id;
        const favs = [
          ['Mentor Success Academy', 'https://msa-app.onrender.com', '🌟', 1],
          ['SELCS Mentor Training', 'https://selcs-training.onrender.com', '🎯', 2],
          ['QIF Observation Tool', 'https://msa-qif-observation.onrender.com', '📝', 3],
        ];
        for (const f of favs) {
          await client.query(
            'INSERT INTO hub_favorites (user_id, name, url, icon, display_order) VALUES ($1,$2,$3,$4,$5)',
            [maryId, ...f]
          );
        }
        console.log('✓ Seeded Mary default favorites');
      }
    }

    console.log('✓ Database initialized');
  } finally {
    client.release();
  }
}

// ── Log activity ──
async function logActivity(userId, action, appKey, details) {
  try {
    await pool.query(
      'INSERT INTO hub_activity_log (user_id, action, app_key, details) VALUES ($1,$2,$3,$4)',
      [userId, action, appKey || null, details || null]
    );
  } catch (e) { console.error('Activity log error:', e.message); }
}

// ═══════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const { rows } = await pool.query(
      'SELECT id, username, password_hash, name, role, center, is_active FROM hub_users WHERE LOWER(username) = LOWER($1)',
      [username.trim()]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid username or password' });

    const user = rows[0];
    if (!user.is_active) return res.status(401).json({ error: 'Account is deactivated' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    // Update last login
    await pool.query('UPDATE hub_users SET last_login = NOW() WHERE id = $1', [user.id]);

    // Set session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.name = user.name;
    req.session.role = user.role;
    req.session.center = user.center;

    await logActivity(user.id, 'login', null, null);

    res.json({ ok: true, user: { id: user.id, username: user.username, name: user.name, role: user.role, center: user.center } });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', (req, res) => {
  if (req.session.userId) logActivity(req.session.userId, 'logout', null, null);
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const { rows: userRows } = await pool.query(
      'SELECT id, username, name, role, center FROM hub_users WHERE id = $1',
      [req.session.userId]
    );
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });

    // Get user's apps
    const { rows: appRows } = await pool.query(`
      SELECT a.app_key, a.name, a.category, a.icon, a.color, a.url, a.description, a.display_order
      FROM hub_apps a
      JOIN hub_user_apps ua ON ua.app_id = a.id
      WHERE ua.user_id = $1
      ORDER BY a.display_order
    `, [req.session.userId]);

    // Get user's favorites
    const { rows: favRows } = await pool.query(
      'SELECT id, name, url, icon, display_order FROM hub_favorites WHERE user_id = $1 ORDER BY display_order',
      [req.session.userId]
    );

    res.json({
      user: userRows[0],
      apps: appRows,
      favorites: favRows
    });
  } catch (e) {
    console.error('Me error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════
// APP ACTIVITY LOGGING
// ═══════════════════════════════════════════════════

app.post('/api/log-app-open', auth, async (req, res) => {
  const { appKey } = req.body;
  await logActivity(req.session.userId, 'app_open', appKey, null);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════
// SSO TOKEN (for future use by individual apps)
// ═══════════════════════════════════════════════════

app.get('/api/sso-token', auth, (req, res) => {
  const token = jwt.sign(
    { userId: req.session.userId, username: req.session.username, name: req.session.name, role: req.session.role, center: req.session.center },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
  res.json({ token });
});

// ═══════════════════════════════════════════════════
// FAVORITES
// ═══════════════════════════════════════════════════

app.post('/api/favorites', auth, async (req, res) => {
  const { name, url, icon } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO hub_favorites (user_id, name, url, icon) VALUES ($1,$2,$3,$4) RETURNING id, name, url, icon',
      [req.session.userId, name, url, icon || '🔗']
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Failed to add favorite' });
  }
});

app.delete('/api/favorites/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM hub_favorites WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════
// ADMIN: User Management
// ═══════════════════════════════════════════════════

app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  try {
    const { rows: users } = await pool.query(`
      SELECT u.id, u.username, u.name, u.role, u.center, u.is_active, u.last_login,
        COALESCE(json_agg(json_build_object('app_key', a.app_key, 'name', a.name, 'icon', a.icon))
          FILTER (WHERE a.app_key IS NOT NULL), '[]') as apps
      FROM hub_users u
      LEFT JOIN hub_user_apps ua ON ua.user_id = u.id
      LEFT JOIN hub_apps a ON a.id = ua.app_id
      GROUP BY u.id
      ORDER BY u.id
    `);
    res.json(users);
  } catch (e) {
    console.error('Admin users error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/apps', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM hub_apps ORDER BY display_order');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/users', auth, adminOnly, async (req, res) => {
  const { username, name, role, center, apps } = req.body;
  if (!username || !name) return res.status(400).json({ error: 'Username and name required' });

  try {
    const hash = await bcrypt.hash('tcc2026', 10);
    const { rows } = await pool.query(
      'INSERT INTO hub_users (username, password_hash, name, role, center) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [username.toLowerCase().trim(), hash, name, role || 'staff', center || 'all']
    );
    const userId = rows[0].id;

    if (apps && apps.length) {
      for (const appKey of apps) {
        await pool.query(
          'INSERT INTO hub_user_apps (user_id, app_id) SELECT $1, id FROM hub_apps WHERE app_key = $2',
          [userId, appKey]
        );
      }
    }

    await logActivity(req.session.userId, 'user_created', null, `Created user: ${name}`);
    res.json({ ok: true, userId });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  const { name, role, center, is_active, apps } = req.body;
  const userId = parseInt(req.params.id);

  try {
    await pool.query(
      'UPDATE hub_users SET name = COALESCE($1, name), role = COALESCE($2, role), center = COALESCE($3, center), is_active = COALESCE($4, is_active) WHERE id = $5',
      [name, role, center, is_active, userId]
    );

    if (apps !== undefined) {
      await pool.query('DELETE FROM hub_user_apps WHERE user_id = $1', [userId]);
      for (const appKey of apps) {
        await pool.query(
          'INSERT INTO hub_user_apps (user_id, app_id) SELECT $1, id FROM hub_apps WHERE app_key = $2',
          [userId, appKey]
        );
      }
    }

    await logActivity(req.session.userId, 'user_updated', null, `Updated user #${userId}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/users/:id/reset-password', auth, adminOnly, async (req, res) => {
  const hash = await bcrypt.hash('tcc2026', 10);
  await pool.query('UPDATE hub_users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
  await logActivity(req.session.userId, 'password_reset', null, `Reset password for user #${req.params.id}`);
  res.json({ ok: true });
});

// Admin: Add new app
app.post('/api/admin/apps', auth, adminOnly, async (req, res) => {
  const { app_key, name, category, icon, color, url, description } = req.body;
  if (!app_key || !name || !url) return res.status(400).json({ error: 'app_key, name, and url required' });

  try {
    const { rows: maxOrder } = await pool.query('SELECT COALESCE(MAX(display_order), 0) + 1 as next FROM hub_apps');
    const { rows } = await pool.query(
      'INSERT INTO hub_apps (app_key, name, category, icon, color, url, description, display_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [app_key, name, category || 'Other', icon || '📱', color || '#666', url, description || '', maxOrder[0].next]
    );
    // Auto-assign to owner (Mary)
    await pool.query(`
      INSERT INTO hub_user_apps (user_id, app_id)
      SELECT u.id, $1 FROM hub_users u WHERE u.role = 'owner'
    `, [rows[0].id]);

    await logActivity(req.session.userId, 'app_added', app_key, `Added app: ${name}`);
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'App key already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: Activity log
app.get('/api/admin/activity', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT al.*, u.name as user_name
      FROM hub_activity_log al
      LEFT JOIN hub_users u ON u.id = al.user_id
      ORDER BY al.created_at DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════
// CHANGE PASSWORD (any authenticated user)
// ═══════════════════════════════════════════════════

app.post('/api/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  try {
    const { rows } = await pool.query('SELECT password_hash FROM hub_users WHERE id = $1', [req.session.userId]);
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE hub_users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
    await logActivity(req.session.userId, 'password_changed', null, null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Catch-all ──
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ──
initDB()
  .then(() => app.listen(PORT, () => console.log(`TCC Hub running on port ${PORT}`)))
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
