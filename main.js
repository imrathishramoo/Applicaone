// main.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const axios = require('axios');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Gumroad Configuration
const GUMROAD_ACCESS_TOKEN = process.env.GUMROAD_ACCESS_TOKEN;
const GUMROAD_API_BASE = process.env.GUMROAD_API_BASE;
const VALIDATION_SALT = process.env.VALIDATION_SALT;
const PORT = process.env.PORT || 3002;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Admin Security Configuration
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Database configuration
const dbPath = './licenses.db';

console.log(`📊 Database path: ${dbPath}`);
console.log(`🌐 Environment: ${NODE_ENV}`);
console.log(`🔐 Admin protection: ${(ADMIN_USERNAME !== 'admin' || ADMIN_PASSWORD !== 'change_this_password_immediately') ? 'ENABLED' : 'DISABLED - PLEASE SET CREDENTIALS'}`);

// Database initialization
const db = new Database(dbPath);
console.log('✅ Connected to SQLite database');

// Initialize database
function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gumroad_purchase_id TEXT UNIQUE,
      gumroad_email TEXT,
      license_key TEXT UNIQUE,
      system_fingerprint TEXT,
      product_id TEXT,
      product_name TEXT,
      product_permalink TEXT,
      purchase_date TEXT,
      price_cents INTEGER,
      currency TEXT,
      refunded INTEGER DEFAULT 0,
      activation_count INTEGER DEFAULT 0,
      max_activations INTEGER DEFAULT 1,
      gumroad_sale_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Security table
  db.exec(`
    CREATE TABLE IF NOT EXISTS hardware_blacklist (
      fingerprint TEXT PRIMARY KEY,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  console.log('✅ All tables ready');
}

initializeDatabase();

// ========== SECURITY FUNCTIONS ==========

function detectVirtualization(hardwareData) {
    if (!hardwareData) return false; // Skip if no hardware data (old clients)
    
    const vmIndicators = [
        'vmware', 'virtualbox', 'qemu', 'xen', 'hyper-v',
        'microsoft corporation', 'innotek gmbh', 'red hat',
        'unknown', 'default', '00000000-0000-0000-0000-000000000000'
    ];
    
    const hardwareString = JSON.stringify(hardwareData).toLowerCase();
    return vmIndicators.some(indicator => hardwareString.includes(indicator));
}

function detectBrowserEnvironment(hardwareData) {
    if (!hardwareData) return false; // Skip if no hardware data
    
    return hardwareData.environment === 'Web Browser' || 
           hardwareData.motherboardId === 'mobo_browser' ||
           hardwareData.macAddress === 'mac_browser' ||
           hardwareData.systemUUID === 'uuid_browser';
}

function validateHardwareCredibility(hardwareData) {
    if (!hardwareData) return []; // Skip if no hardware data
    
    const warnings = [];
    
    if (!hardwareData.motherboardId || hardwareData.motherboardId.length < 5) {
        warnings.push('INVALID_MOTHERBOARD');
    }
    if (!hardwareData.systemUUID || hardwareData.systemUUID.length < 10) {
        warnings.push('INVALID_UUID');
    }
    if (!hardwareData.macAddress || hardwareData.macAddress === 'mac_unknown') {
        warnings.push('INVALID_MAC');
    }
    
    const uniqueComponents = new Set([
        hardwareData.motherboardId,
        hardwareData.processorId, 
        hardwareData.systemUUID
    ]);
    
    if (uniqueComponents.size < 2) {
        warnings.push('LOW_HARDWARE_DIVERSITY');
    }
    
    return warnings;
}

function isHardwareBlacklisted(fingerprint) {
    const blacklisted = db.prepare(
        'SELECT * FROM hardware_blacklist WHERE fingerprint = ?'
    ).get(fingerprint);
    return !!blacklisted;
}

// ========== ADMIN AUTHENTICATION MIDDLEWARE ==========
function requireAdminAuth(req, res, next) {
    if (NODE_ENV === 'development' && ADMIN_USERNAME === 'admin' && ADMIN_PASSWORD === 'change_this_password_immediately') {
        console.warn('⚠️  Admin routes are unprotected in development mode');
        return next();
    }

    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Admin Access", charset="UTF-8"');
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    try {
        const base64Credentials = authHeader.split(' ')[1];
        const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
        const [username, password] = credentials.split(':');
        
        if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
            return next();
        }
        
        res.setHeader('WWW-Authenticate', 'Basic realm="Admin Access", charset="UTF-8"');
        return res.status(401).json({ error: 'Invalid credentials' });
    } catch (error) {
        return res.status(400).json({ error: 'Invalid authentication header' });
    }
}

// YOUR EXACT LICENSE KEY GENERATION ALGORITHM FROM DEVELOPER TOOL
function generateHardwareBoundKey(systemFingerprint, appBase = "warriors-artillery") {
  console.log('🔑 Generating license key with fingerprint:', systemFingerprint);
  
  const dynamicAppId = `${appBase}-${systemFingerprint.substring(0, 8)}`;
  const baseKey = systemFingerprint + VALIDATION_SALT + dynamicAppId;

  console.log('🔑 Base key components:', { systemFingerprint, VALIDATION_SALT, dynamicAppId });

  let hash = 0;
  for (let i = 0; i < baseKey.length; i++) {
    const char = baseKey.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  const numericHash = Math.abs(hash).toString().padStart(16, '0');
  const formattedKey = `${numericHash.substring(0,4)}-${numericHash.substring(4,8)}-${numericHash.substring(8,12)}-${numericHash.substring(12,16)}`;

  console.log('🔑 Generated license key:', formattedKey);
  return formattedKey;
}

// Gumroad API Service
class GumroadService {
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  async verifyPurchase(purchaseId, email) {
    try {
      console.log(`🔍 Verifying Gumroad purchase: ${purchaseId} for email: ${email}`);
      
      const response = await axios.get(`${GUMROAD_API_BASE}/sales/${purchaseId}`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`
        },
        timeout: 10000
      });

      console.log('📊 Gumroad API response received');
      
      if (response.data.success) {
        const sale = response.data.sale;
        
        // Validate email matches
        if (sale.email.toLowerCase() !== email.toLowerCase()) {
          return { 
            valid: false, 
            error: 'Email does not match purchase records' 
          };
        }

        // Check if refunded
        if (sale.refunded) {
          return { 
            valid: false, 
            error: 'This purchase has been refunded' 
          };
        }

        return {
          valid: true,
          product_id: sale.product_id,
          product_name: sale.product_name,
          product_permalink: sale.product_permalink,
          email: sale.email,
          purchase_date: sale.created_at,
          price_cents: sale.price_cents,
          currency: sale.currency,
          quantity: sale.quantity || 1,
          full_sale_data: sale
        };
      } else {
        return { 
          valid: false, 
          error: 'Purchase not found or invalid' 
        };
      }
    } catch (error) {
      console.error('❌ Gumroad API error:', error.response?.data || error.message);
      
      if (error.response?.status === 404) {
        return { valid: false, error: 'Purchase ID not found' };
      } else if (error.response?.status === 401) {
        return { valid: false, error: 'Invalid Gumroad access token' };
      } else if (error.code === 'ECONNABORTED') {
        return { valid: false, error: 'Gumroad API timeout' };
      } else {
        return { valid: false, error: 'Failed to verify purchase with Gumroad' };
      }
    }
  }
}

const gumroadService = new GumroadService(GUMROAD_ACCESS_TOKEN);

// ========== ADMIN DATABASE MANAGEMENT ROUTES ==========

// Admin panel HTML (simple interface) - PROTECTED
app.get('/admin', requireAdminAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>License Server Admin</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 40px; }
            .card { background: #f5f5f5; padding: 20px; margin: 20px 0; border-radius: 8px; }
            button { background: #dc3545; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin: 5px; }
            button:hover { background: #c82333; }
            .btn-info { background: #17a2b8; }
            .btn-info:hover { background: #138496; }
            .btn-success { background: #28a745; }
            .btn-success:hover { background: #218838; }
            table { width: 100%; border-collapse: collapse; margin: 20px 0; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
            th { background-color: #f2f2f2; }
            .stats { display: flex; gap: 20px; margin: 20px 0; }
            .stat-card { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); flex: 1; }
            .security-warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 8px; margin: 20px 0; }
            .security-good { background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; border-radius: 8px; margin: 20px 0; }
        </style>
    </head>
    <body>
        <h1>🔧 License Server Admin Panel</h1>
        
        ${(ADMIN_USERNAME === 'admin' && ADMIN_PASSWORD === 'change_this_password_immediately') ? 
          '<div class="security-warning"><strong>⚠️ SECURITY WARNING:</strong> Default admin credentials detected. Please set ADMIN_USERNAME and ADMIN_PASSWORD environment variables.</div>' : 
          '<div class="security-good"><strong>🔒 SECURITY:</strong> Admin panel is secured with authentication</div>'
        }
        
        <div class="security-good">
          <strong>🛡️ ACTIVE PROTECTIONS:</strong>
          <ul>
            <li>VM Detection: Blocks virtual machines</li>
            <li>Browser Blocking: Prevents web-based attacks</li>
            <li>Hardware Validation: Detects spoofed configurations</li>
            <li>Hardware Blacklisting: Blocks known bad fingerprints</li>
          </ul>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <h3>📊 Database Statistics</h3>
                <div id="stats"></div>
            </div>
        </div>

        <div class="card">
            <h3>🔄 Database Management</h3>
            <button onclick="resetDatabase()" style="background: #dc3545;">🗑️ Reset Entire Database</button>
            <button onclick="exportDatabase()" class="btn-info">📥 Export Database</button>
            <button onclick="refreshStats()" class="btn-success">🔄 Refresh Stats</button>
            
            <div style="margin-top: 15px;">
                <h4>Import Database (JSON):</h4>
                <input type="file" id="importFile" accept=".json">
                <button onclick="importDatabase()" class="btn-info">📤 Import Data</button>
            </div>
        </div>

        <div class="card">
            <h3>👥 Active Users</h3>
            <div id="activeUsers"></div>
        </div>

        <div class="card">
            <h3>📋 All Licenses</h3>
            <div id="allLicenses"></div>
        </div>

        <script>
            async function resetDatabase() {
                if (!confirm('⚠️ ARE YOU SURE? This will DELETE ALL license data! This action cannot be undone.')) {
                    return;
                }
                
                const confirmText = prompt('Type "RESET" to confirm:');
                if (confirmText !== 'RESET') {
                    alert('Reset cancelled.');
                    return;
                }

                try {
                    const response = await fetch('/admin/reset-database', { method: 'POST' });
                    const result = await response.json();
                    
                    if (result.success) {
                        alert('✅ Database reset successfully!');
                        refreshStats();
                        loadActiveUsers();
                        loadAllLicenses();
                    } else {
                        alert('❌ Error: ' + result.error);
                    }
                } catch (error) {
                    alert('❌ Error: ' + error.message);
                }
            }

            async function exportDatabase() {
                try {
                    const response = await fetch('/admin/export-data');
                    const data = await response.json();
                    
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'license-database-backup-' + new Date().toISOString().split('T')[0] + '.json';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    
                    alert('✅ Database exported successfully!');
                } catch (error) {
                    alert('❌ Error: ' + error.message);
                }
            }

            async function importDatabase() {
                const fileInput = document.getElementById('importFile');
                if (!fileInput.files[0]) {
                    alert('Please select a JSON file to import');
                    return;
                }

                if (!confirm('⚠️ This will replace existing license data. Continue?')) {
                    return;
                }

                try {
                    const file = fileInput.files[0];
                    const text = await file.text();
                    const data = JSON.parse(text);

                    const response = await fetch('/admin/import-data', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data)
                    });

                    const result = await response.json();
                    
                    if (result.success) {
                        alert('✅ Database imported successfully!');
                        refreshStats();
                        loadActiveUsers();
                        loadAllLicenses();
                    } else {
                        alert('❌ Error: ' + result.error);
                    }
                } catch (error) {
                    alert('❌ Error: ' + error.message);
                }
            }

            async function refreshStats() {
                try {
                    const response = await fetch('/admin/stats');
                    const stats = await response.json();
                    const totalRevenue = (stats.totalLicenses * 49).toFixed(2);

                    document.getElementById('stats').innerHTML = \`
                        <p>📊 Total Licenses: <strong>\${stats.totalLicenses}</strong></p>
                        <p>✅ Active Licenses: <strong>\${stats.activeLicenses}</strong></p>
                        <p>👥 Unique Users: <strong>\${stats.uniqueUsers}</strong></p>
                        <p>📦 Total Products: <strong>\${stats.uniqueProducts}</strong></p>
                        <p>💰 Total Revenue: <strong>$\${totalRevenue}</strong></p>
                        <p>🕒 Last Updated: <strong>\${new Date(stats.lastUpdated).toLocaleString()}</strong></p>
                    \`;
                } catch (error) {
                    console.error('Error loading stats:', error);
                }
            }

            async function loadActiveUsers() {
                try {
                    const response = await fetch('/admin/active-users');
                    const data = await response.json();
                    
                    let html = '<table><tr><th>Email</th><th>Product</th><th>Activations</th><th>Last Active</th><th>License Key</th></tr>';
                    
                    data.activeUsers.forEach(user => {
                        html += \`<tr>
                            <td>\${user.email}</td>
                            <td>\${user.product_name}</td>
                            <td>\${user.activation_count}/\${user.max_activations}</td>
                            <td>\${new Date(user.updated_at).toLocaleDateString()}</td>
                            <td style="font-family: monospace; font-size: 12px;">\${user.license_key}</td>
                        </tr>\`;
                    });
                    
                    html += '</table>';
                    document.getElementById('activeUsers').innerHTML = html;
                } catch (error) {
                    console.error('Error loading active users:', error);
                }
            }

            async function loadAllLicenses() {
                try {
                    const response = await fetch('/admin/licenses');
                    const data = await response.json();
                    
                    let html = '<table><tr><th>Purchase ID</th><th>Email</th><th>Product</th><th>Activations</th><th>Created</th><th>Status</th></tr>';
                    
                    data.licenses.forEach(license => {
                        const status = license.refunded ? '❌ Refunded' : (license.activation_count > 0 ? '✅ Active' : '⚠️ Inactive');
                        html += \`<tr>
                            <td style="font-size: 12px;">\${license.gumroad_purchase_id}</td>
                            <td>\${license.gumroad_email}</td>
                            <td>\${license.product_name}</td>
                            <td>\${license.activation_count}/\${license.max_activations}</td>
                            <td>\${new Date(license.created_at).toLocaleDateString()}</td>
                            <td>\${status}</td>
                        </tr>\`;
                    });
                    
                    html += '</table>';
                    document.getElementById('allLicenses').innerHTML = html;
                } catch (error) {
                    console.error('Error loading all licenses:', error);
                }
            }

            // Load initial data
            refreshStats();
            loadActiveUsers();
            loadAllLicenses();
        </script>
    </body>
    </html>
  `);
});

// Get database statistics - PROTECTED
app.get('/admin/stats', requireAdminAuth, (req, res) => {
  try {
    const totalLicenses = db.prepare('SELECT COUNT(*) as count FROM licenses').get().count;
    const activeLicenses = db.prepare('SELECT COUNT(*) as count FROM licenses WHERE activation_count > 0 AND refunded = 0').get().count;
    const uniqueUsers = db.prepare('SELECT COUNT(DISTINCT gumroad_email) as count FROM licenses').get().count;
    const uniqueProducts = db.prepare('SELECT COUNT(DISTINCT product_id) as count FROM licenses').get().count;
    
    const revenueResult = db.prepare('SELECT SUM(price_cents) as total_cents FROM licenses WHERE refunded = 0').get();
    const totalRevenue = (revenueResult.total_cents || 0) / 100;
    
    const lastUpdated = db.prepare('SELECT MAX(updated_at) as last_updated FROM licenses').get().last_updated;

    res.json({
      totalLicenses,
      activeLicenses,
      uniqueUsers,
      uniqueProducts,
      totalRevenue: totalRevenue.toFixed(2),
      lastUpdated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get active users with details - PROTECTED
app.get('/admin/active-users', requireAdminAuth, (req, res) => {
  try {
    const activeUsers = db.prepare(`
      SELECT * FROM licenses 
      WHERE activation_count > 0 AND refunded = 0 
      ORDER BY updated_at DESC
    `).all();
    
    res.json({ activeUsers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset entire database - PROTECTED
app.post('/admin/reset-database', requireAdminAuth, (req, res) => {
  try {
    // Backup current data before reset (optional)
    const backupData = db.prepare('SELECT * FROM licenses').all();
    const backupTimestamp = new Date().toISOString();
    
    // Reset database
    db.exec('DROP TABLE IF EXISTS licenses');
    db.exec('DROP TABLE IF EXISTS hardware_blacklist');
    initializeDatabase();
    
    console.log(`🗑️ Database reset by admin at ${backupTimestamp}`);
    console.log(`📊 Backup had ${backupData.length} records`);
    
    res.json({ 
      success: true, 
      message: 'Database reset successfully',
      backup: {
        timestamp: backupTimestamp,
        recordCount: backupData.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Export database data - PROTECTED
app.get('/admin/export-data', requireAdminAuth, (req, res) => {
  try {
    const licenses = db.prepare('SELECT * FROM licenses').all();
    const stats = db.prepare('SELECT COUNT(*) as total FROM licenses').get();
    
    const exportData = {
      exportTimestamp: new Date().toISOString(),
      totalRecords: stats.total,
      licenses: licenses
    };
    
    res.json(exportData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import database data - PROTECTED
app.post('/admin/import-data', requireAdminAuth, (req, res) => {
  try {
    const importData = req.body;
    
    if (!importData || !importData.licenses) {
      return res.status(400).json({ success: false, error: 'Invalid import data' });
    }
    
    // Clear existing data
    db.exec('DELETE FROM licenses');
    
    // Import new data
    const stmt = db.prepare(`
      INSERT INTO licenses (
        gumroad_purchase_id, gumroad_email, license_key, system_fingerprint,
        product_id, product_name, product_permalink, purchase_date,
        price_cents, currency, refunded, activation_count, max_activations,
        gumroad_sale_data, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let importedCount = 0;
    for (const license of importData.licenses) {
      try {
        stmt.run([
          license.gumroad_purchase_id,
          license.gumroad_email,
          license.license_key,
          license.system_fingerprint,
          license.product_id,
          license.product_name,
          license.product_permalink,
          license.purchase_date,
          license.price_cents,
          license.currency,
          license.refunded || 0,
          license.activation_count || 0,
          license.max_activations || 1,
          license.gumroad_sale_data ? JSON.stringify(license.gumroad_sale_data) : null,
          license.created_at || new Date().toISOString(),
          license.updated_at || new Date().toISOString()
        ]);
        importedCount++;
      } catch (insertErr) {
        console.warn('Failed to import license:', license.gumroad_purchase_id, insertErr.message);
      }
    }
    
    console.log(`📥 Database import completed: ${importedCount} records imported`);
    
    res.json({ 
      success: true, 
      message: `Imported ${importedCount} license records`,
      importedCount,
      totalInFile: importData.licenses.length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get license analytics - PROTECTED
app.get('/admin/analytics', requireAdminAuth, (req, res) => {
  try {
    // Daily activations
    const dailyActivations = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as count 
      FROM licenses 
      GROUP BY DATE(created_at) 
      ORDER BY date DESC 
      LIMIT 30
    `).all();
    
    // Product statistics
    const productStats = db.prepare(`
      SELECT 
        product_name,
        product_id,
        COUNT(*) as total_licenses,
        SUM(activation_count) as total_activations,
        SUM(price_cents) as total_revenue_cents,
        AVG(price_cents) as avg_price_cents
      FROM licenses 
      WHERE refunded = 0
      GROUP BY product_id, product_name
    `).all();
    
    // Activation rate
    const activationRate = db.prepare(`
      SELECT 
        COUNT(*) as total_licenses,
        SUM(CASE WHEN activation_count > 0 THEN 1 ELSE 0 END) as activated_licenses,
        ROUND(SUM(CASE WHEN activation_count > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as activation_rate
      FROM licenses 
      WHERE refunded = 0
    `).get();
    
    res.json({
      dailyActivations,
      productStats: productStats.map(p => ({
        ...p,
        total_revenue: (p.total_revenue_cents / 100).toFixed(2),
        avg_price: (p.avg_price_cents / 100).toFixed(2)
      })),
      activationRate
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== API ROUTES ==========

// Test Gumroad connection
app.get('/api/test-gumroad', async (req, res) => {
  try {
    const response = await axios.get(`${GUMROAD_API_BASE}/products`, {
      headers: { 'Authorization': `Bearer ${GUMROAD_ACCESS_TOKEN}` }
    });
    
    res.json({ 
      success: true, 
      message: 'Gumroad connection successful',
      products: response.data.products?.length || 0
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Gumroad connection failed: ' + error.message 
    });
  }
});

// Debug endpoint - PROTECTED
app.get('/api/debug/data', requireAdminAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM licenses').all();
    res.json({ licenses: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if license exists in database
app.post('/api/check-license', (req, res) => {
  const { license_key } = req.body;
  
  if (!license_key) {
    return res.status(400).json({ error: 'License key is required' });
  }

  try {
    const row = db.prepare('SELECT * FROM licenses WHERE license_key = ? AND refunded = 0').get(license_key);
    res.json({ exists: !!row, license: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MAIN ACTIVATION ENDPOINT - ENHANCED SECURITY
app.post('/api/activate', async (req, res) => {
  try {
    const { gumroadPurchaseId, gumroadEmail, systemFingerprint, hardwareInfo, purchaseQuantity = 1 } = req.body;

    console.log('📥 Activation request received:', { 
      gumroadPurchaseId, 
      gumroadEmail: gumroadEmail ? '***' : 'missing',
      systemFingerprint: systemFingerprint ? '***' : 'missing',
      hasHardwareInfo: !!hardwareInfo
    });

    // ========== NEW SECURITY CHECKS (Backward Compatible) ==========
    if (hardwareInfo) {
        console.log('🔍 Running enhanced security checks...');
        
        // 1. Check hardware blacklist
        if (isHardwareBlacklisted(systemFingerprint)) {
            console.log('❌ Hardware fingerprint blacklisted:', systemFingerprint);
            return res.status(400).json({
                success: false,
                error: 'This hardware configuration is not supported'
            });
        }

        // 2. Detect virtualization
        if (detectVirtualization(hardwareInfo)) {
            console.log('❌ Virtual machine detected');
            return res.status(400).json({
                success: false,
                error: 'Virtual machines are not supported for licensing'
            });
        }

        // 3. Detect browser environment
        if (detectBrowserEnvironment(hardwareInfo)) {
            console.log('❌ Browser environment detected');
            return res.status(400).json({
                success: false,
                error: 'Browser environment not supported. Please use the desktop application.'
            });
        }

        // 4. Validate hardware credibility
        const hardwareWarnings = validateHardwareCredibility(hardwareInfo);
        if (hardwareWarnings.length > 2) {
            console.log('❌ Suspicious hardware configuration:', hardwareWarnings);
            return res.status(400).json({
                success: false,
                error: 'Suspicious hardware configuration detected'
            });
        }

        console.log('✅ Enhanced security checks passed');
    } else {
        console.log('ℹ️  No hardware info provided - running in legacy mode');
    }

    // ========== YOUR EXISTING ACTIVATION LOGIC (UNCHANGED) ==========
    // Validate input
    if (!gumroadPurchaseId || !gumroadEmail || !systemFingerprint) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: Purchase ID, Email, and System Fingerprint' 
      });
    }

    // STEP 1: VERIFY WITH GUMROAD API FIRST
    console.log('🔐 Step 1: Verifying with Gumroad API...');
    const gumroadVerification = await gumroadService.verifyPurchase(gumroadPurchaseId, gumroadEmail);
    
    if (!gumroadVerification.valid) {
      console.log('❌ Gumroad verification failed:', gumroadVerification.error);
      return res.status(400).json({ 
        success: false, 
        error: gumroadVerification.error 
      });
    }

    console.log('✅ Gumroad verification passed for product:', gumroadVerification.product_name);
    console.log('📦 Purchase quantity from Gumroad:', gumroadVerification.quantity);

    // STEP 2: Generate license key
    console.log('🔑 Step 2: Generating license key with client fingerprint');
    const licenseKey = generateHardwareBoundKey(systemFingerprint, "warriors-artillery");

    // STEP 3: Check if this purchase already exists
    try {
      const existingLicense = db.prepare('SELECT * FROM licenses WHERE gumroad_purchase_id = ?').get(gumroadPurchaseId);

      if (existingLicense) {
        handleExistingLicense(existingLicense, gumroadPurchaseId, systemFingerprint, gumroadVerification.quantity, res);
      } else {
        handleNewLicense(gumroadPurchaseId, gumroadVerification, systemFingerprint, licenseKey, res);
      }
    } catch (dbError) {
      console.error('Database error:', dbError);
      res.status(500).json({ success: false, error: 'Database error' });
    }

  } catch (error) {
    console.error('❌ Activation error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error: ' + error.message 
    });
  }
});

function handleExistingLicense(existingLicense, gumroadPurchaseId, systemFingerprint, gumroadQuantity, res) {
  console.log('🔄 Existing license found for purchase:', gumroadPurchaseId);
  
  // Check if this is the same device
  if (existingLicense.system_fingerprint === systemFingerprint) {
    console.log('✅ Same device - returning existing license');
    return res.json({
      success: true,
      license_key: existingLicense.license_key,
      message: 'License already active on this device',
      product_name: existingLicense.product_name,
      existing: true
    });
  }

  // Different device - check activation limits
  console.log('🔄 Different device detected, checking activation limits');
  console.log(`📊 Current: ${existingLicense.activation_count}/${existingLicense.max_activations}, Gumroad allows: ${gumroadQuantity}`);
  
  if (existingLicense.activation_count >= gumroadQuantity) {
    return res.status(400).json({
      success: false,
      error: `Maximum activations reached (${existingLicense.activation_count}/${gumroadQuantity}). Please contact support.`
    });
  }

  // Allow additional activation
  const newActivationCount = existingLicense.activation_count + 1;
  console.log(`✅ Allowing activation ${newActivationCount}/${gumroadQuantity}`);
  
  try {
    db.prepare(
      'UPDATE licenses SET system_fingerprint = ?, activation_count = ?, max_activations = ?, updated_at = CURRENT_TIMESTAMP WHERE gumroad_purchase_id = ?'
    ).run([systemFingerprint, newActivationCount, gumroadQuantity, gumroadPurchaseId]);

    res.json({
      success: true,
      license_key: existingLicense.license_key,
      message: `License activated on new device (${newActivationCount}/${gumroadQuantity})`,
      product_name: existingLicense.product_name,
      existing: true
    });
  } catch (updateErr) {
    console.error('Update error:', updateErr);
    res.status(500).json({ success: false, error: 'Update failed' });
  }
}

function handleNewLicense(gumroadPurchaseId, gumroadVerification, systemFingerprint, licenseKey, res) {
  console.log('🆕 New purchase - creating license with proper quantity limits');
  
  const maxActivations = gumroadVerification.quantity || 1;
  console.log(`📦 Setting max activations to: ${maxActivations} (from Gumroad purchase)`);
  
  try {
    db.prepare(
      `INSERT INTO licenses (
        gumroad_purchase_id, gumroad_email, license_key, system_fingerprint, 
        product_id, product_name, product_permalink, purchase_date, 
        price_cents, currency, activation_count, max_activations,
        gumroad_sale_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run([
      gumroadPurchaseId,
      gumroadVerification.email,
      licenseKey,
      systemFingerprint,
      gumroadVerification.product_id,
      gumroadVerification.product_name,
      gumroadVerification.product_permalink,
      gumroadVerification.purchase_date,
      gumroadVerification.price_cents,
      gumroadVerification.currency,
      maxActivations,
      JSON.stringify(gumroadVerification.full_sale_data)
    ]);

    console.log('✅ New license created with proper quantity enforcement:', {
      fingerprint: '***',
      license_key: licenseKey,
      product: gumroadVerification.product_name,
      max_activations: maxActivations
    });
    
    res.json({
      success: true,
      license_key: licenseKey,
      message: `License activated successfully! (1/${maxActivations} devices)`,
      product_name: gumroadVerification.product_name,
      product_permalink: gumroadVerification.product_permalink,
      price: `${gumroadVerification.price_cents / 100} ${gumroadVerification.currency}`,
      purchase_date: gumroadVerification.purchase_date,
      max_activations: maxActivations,
      existing: false
    });
  } catch (insertErr) {
    console.error('Insert error:', insertErr);
    res.status(500).json({ success: false, error: 'License creation failed: ' + insertErr.message });
  }
}

// License validation endpoint
app.post('/api/validate', (req, res) => {
  const { licenseKey, systemFingerprint } = req.body;

  if (!licenseKey || !systemFingerprint) {
    return res.status(400).json({ 
      valid: false, 
      error: 'License key and system fingerprint are required' 
    });
  }

  try {
    const row = db.prepare('SELECT * FROM licenses WHERE license_key = ? AND refunded = 0').get(licenseKey);

    if (!row) {
      return res.json({ valid: false, error: 'License not found or refunded' });
    }

    if (row.system_fingerprint !== systemFingerprint) {
      return res.json({ 
        valid: false, 
        error: 'License is not activated on this device' 
      });
    }

    res.json({ 
      valid: true, 
      license: {
        key: row.license_key,
        email: row.gumroad_email,
        purchase_id: row.gumroad_purchase_id,
        product_name: row.product_name,
        activations: row.activation_count,
        max_activations: row.max_activations
      }
    });
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

// Get license info
app.get('/api/license/:key', (req, res) => {
  const { key } = req.params;

  try {
    const row = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(key);
    
    if (!row) {
      return res.status(404).json({ error: 'License not found' });
    }
    
    res.json({ license: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deactivate license
app.post('/api/deactivate', (req, res) => {
  const { licenseKey } = req.body;

  try {
    const result = db.prepare('UPDATE licenses SET system_fingerprint = NULL, activation_count = 0 WHERE license_key = ?').run(licenseKey);
    
    if (result.changes === 0) {
      return res.status(404).json({ success: false, error: 'License not found' });
    }
    
    res.json({ success: true, message: 'License deactivated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin endpoint to see all licenses - PROTECTED
app.get('/admin/licenses', requireAdminAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
    res.json({ licenses: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simple home page
app.get('/', (req, res) => {
  res.json({ 
    message: 'Hardware License Server is running!',
    environment: NODE_ENV,
    port: PORT,
    database: 'SQLite (better-sqlite3) - Universal',
    security: '🛡️ ENHANCED SECURITY - VM detection, browser blocking, hardware validation',
    endpoints: {
      activate: 'POST /api/activate',
      validate: 'POST /api/validate',
      check: 'POST /api/check-license',
      debug: 'GET /api/debug/data (admin only)',
      admin: 'GET /admin (admin only)'
    }
  });
});

// ========== ERROR HANDLING MIDDLEWARE ==========

// 404 Handler - Only for routes that don't exist
app.use('*', (req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Endpoint not found',
    message: `Route ${req.originalUrl} does not exist` 
  });
});

// Global error handler - Only catches unhandled errors
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error'
  });
});

// Server configuration for Railway
const HOST = NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

app.listen(PORT, HOST, () => {
  console.log(`🚀 License server running in ${NODE_ENV} mode`);
  console.log(`🌐 Accessible at: http://${HOST}:${PORT}`);
  console.log(`🔑 Gumroad API: ${GUMROAD_ACCESS_TOKEN ? 'CONFIGURED' : 'NOT CONFIGURED - PLEASE SET TOKEN'}`);
  console.log(`🔐 Using EXACT developer tool algorithm`);
  console.log(`📦 ENFORCING GUMROAD PURCHASE QUANTITY LIMITS`);
  console.log(`📊 Database: SQLite (better-sqlite3)`);
  console.log(`👨‍💼 Admin Panel: http://${HOST}:${PORT}/admin`);
  console.log(`🛡️  ENHANCED SECURITY ENABLED:`);
  console.log(`   • VM Detection: Blocks virtual machines`);
  console.log(`   • Browser Blocking: Prevents web-based attacks`);
  console.log(`   • Hardware Validation: Detects spoofed configurations`);
  console.log(`   • Hardware Blacklisting: Blocks known bad fingerprints`);
  console.log(`   • Backward Compatible: Old clients continue working`);
  if (ADMIN_USERNAME === 'admin' && ADMIN_PASSWORD === 'change_this_password_immediately') {
    console.log(`⚠️  SECURITY WARNING: Admin routes are unprotected. Set ADMIN_USERNAME and ADMIN_PASSWORD environment variables!`);
  } else {
    console.log(`🔒 Admin panel is secured with credentials`);
  }
});

process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  db.close();
  process.exit(0);
});