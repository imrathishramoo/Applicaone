// Tab Navigation
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', function(e) {
    const tabId = this.getAttribute('data-tab');
    
    document.querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
    this.classList.add('active');
    document.getElementById('pageTitle').textContent = this.querySelector('span').textContent;
    document.querySelectorAll('.tab-content').forEach(content => {
      content.classList.remove('active');
    });
    document.getElementById(tabId).classList.add('active');
  });
});

// Trial tabs
document.querySelectorAll('[data-trial-tab]').forEach(tab => {
  tab.addEventListener('click', function() {
    const tabId = this.getAttribute('data-trial-tab');
    
    document.querySelectorAll('[data-trial-tab]').forEach(t => t.classList.remove('active'));
    this.classList.add('active');
    
    document.querySelectorAll('.trial-tab-content').forEach(content => {
      content.style.display = 'none';
    });
    document.getElementById(tabId + 'Trials').style.display = 'block';
  });
});

// Format bytes helper
function formatBytesStatic(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Bandwidth clear function (still used from dashboard section)
async function clearBandwidthLogs() {
  if (confirm('Are you sure you want to clear all bandwidth logs? This action cannot be undone.')) {
    try {
      const response = await fetch('/api/admin/bandwidth/clear', {
        method: 'POST',
        credentials: 'include'
      });
      const data = await response.json();
      if (data.success) {
        alert(`Cleared ${data.cleared} bandwidth records`);
        window.location.reload();
      } else {
        alert('Error: ' + data.error);
      }
    } catch (error) {
      alert('Error clearing bandwidth logs');
    }
  }
}

// Modal functions
function closeModal() {
  document.getElementById('licenseModal').classList.remove('active');
  document.getElementById('licenseForm').reset();
}

function closeViewModal() {
  document.getElementById('viewLicenseModal').classList.remove('active');
}

function closeResetModal() {
  document.getElementById('resetModal').classList.remove('active');
  document.getElementById('confirmText').value = '';
}

function closeServerInfoModal() {
  document.getElementById('serverInfoModal').classList.remove('active');
}

function closeDatabaseInfoModal() {
  document.getElementById('databaseInfoModal').classList.remove('active');
}

function showAddLicenseModal() {
  document.getElementById('modalTitle').textContent = 'Add License';
  document.getElementById('licenseForm').reset();
  document.getElementById('licenseId').value = '';
  document.getElementById('licenseModal').classList.add('active');
}

function editLicense(id) {
  fetch('/api/admin/license/' + id, { credentials: 'include' })
    .then(res => res.json())
    .then(license => {
      document.getElementById('modalTitle').textContent = 'Edit License';
      document.getElementById('licenseId').value = license.id;
      document.getElementById('licenseKey').value = license.license_key;
      document.getElementById('email').value = license.gumroad_email;
      document.getElementById('productName').value = license.product_name || '';
      document.getElementById('purchaseId').value = license.gumroad_purchase_id || '';
      document.getElementById('fingerprint').value = license.system_fingerprint || '';
      document.getElementById('maxActivations').value = license.max_activations || 1;
      document.getElementById('price').value = license.price_cents || 0;
      document.getElementById('currency').value = license.currency || 'USD';
      document.getElementById('notes').value = license.notes || '';
      document.getElementById('refunded').checked = license.refunded || false;
      
      document.getElementById('licenseModal').classList.add('active');
    });
}

function viewLicense(id) {
  fetch('/api/admin/license/' + id, { credentials: 'include' })
    .then(res => res.json())
    .then(license => {
      const content = document.getElementById('viewLicenseContent');
      content.innerHTML = `
        <div style="padding: 20px; background: #f8f9fa; border-radius: 6px; margin-bottom: 20px;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
            <div>
              <strong>License Key:</strong><br>
              <code style="background: white; padding: 5px 10px; border-radius: 4px; display: inline-block; margin-top: 5px;">
                ${license.license_key}
              </code>
            </div>
            <div>
              <strong>Email:</strong><br>
              <span>${license.gumroad_email}</span>
            </div>
            <div>
              <strong>Product:</strong><br>
              <span>${license.product_name}</span>
            </div>
            <div>
              <strong>Purchase ID:</strong><br>
              <span>${license.gumroad_purchase_id || 'N/A'}</span>
            </div>
            <div>
              <strong>Activations:</strong><br>
              <span class="badge ${license.activation_count >= license.max_activations ? 'badge-danger' : 'badge-success'}">
                ${license.activation_count}/${license.max_activations}
              </span>
            </div>
            <div>
              <strong>Status:</strong><br>
              <span class="badge ${license.refunded ? 'badge-danger' : 'badge-success'}">
                ${license.refunded ? 'Refunded' : 'Active'}
              </span>
            </div>
            <div>
              <strong>Created:</strong><br>
              <span>${new Date(license.created_at).toLocaleString()}</span>
            </div>
            <div>
              <strong>Last Validation:</strong><br>
              <span>${license.last_validation ? new Date(license.last_validation).toLocaleString() : 'Never'}</span>
            </div>
          </div>
        </div>
        
        <div style="margin-bottom: 20px;">
          <strong>System Fingerprint:</strong><br>
          <code style="background: #f8f9fa; padding: 5px 10px; border-radius: 4px; display: block; margin-top: 5px; word-break: break-all; font-size: 12px;">
            ${license.system_fingerprint || 'Not set'}
          </code>
        </div>
        
        <div style="margin-bottom: 20px;">
          <strong>Notes:</strong><br>
          <div style="background: #f8f9fa; padding: 10px; border-radius: 4px; margin-top: 5px;">
            ${license.notes || 'No notes'}
          </div>
        </div>
        
        <div>
          <strong>Gumroad Data:</strong><br>
          <pre style="background: #f8f9fa; padding: 10px; border-radius: 4px; margin-top: 5px; max-height: 200px; overflow-y: auto; font-size: 12px;">
            ${license.gumroad_sale_data ? JSON.stringify(JSON.parse(license.gumroad_sale_data), null, 2) : 'No Gumroad data'}
          </pre>
        </div>
      `;
      
      document.getElementById('viewLicenseModal').classList.add('active');
    });
}

function saveLicense() {
  const licenseId = document.getElementById('licenseId').value;
  const isEdit = !!licenseId;
  
  const licenseData = {
    license_key: document.getElementById('licenseKey').value,
    gumroad_email: document.getElementById('email').value,
    product_name: document.getElementById('productName').value,
    gumroad_purchase_id: document.getElementById('purchaseId').value,
    system_fingerprint: document.getElementById('fingerprint').value,
    max_activations: parseInt(document.getElementById('maxActivations').value),
    price_cents: parseInt(document.getElementById('price').value),
    currency: document.getElementById('currency').value,
    notes: document.getElementById('notes').value,
    refunded: document.getElementById('refunded').checked ? 1 : 0
  };
  
  const url = isEdit ? '/api/admin/license/' + licenseId : '/api/admin/license';
  const method = isEdit ? 'PUT' : 'POST';
  
  fetch(url, {
    method: method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(licenseData),
    credentials: 'include'
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      alert(data.message);
      closeModal();
      refreshData();
    } else {
      alert('Error: ' + data.error);
    }
  })
  .catch(error => {
    alert('Error: ' + error.message);
  });
}

function deleteLicense(licenseKey) {
  if (confirm('Delete license ' + licenseKey + '?')) {
    fetch('/api/admin/license/' + encodeURIComponent(licenseKey), { 
      method: 'DELETE',
      credentials: 'include'
    })
    .then(res => res.json())
    .then(data => {
      alert(data.message);
      refreshData();
    });
  }
}

function deleteTrial(fingerprint) {
  if (confirm('Delete trial for fingerprint ' + fingerprint.substring(0, 20) + '...?')) {
    fetch('/api/admin/trial/' + encodeURIComponent(fingerprint), { 
      method: 'DELETE',
      credentials: 'include'
    })
    .then(res => res.json())
    .then(data => {
      alert(data.message);
      refreshData();
    });
  }
}

function clearExpiredTrials() {
  if (confirm('Clear all expired trials?')) {
    fetch('/api/admin/trials/clear-expired', { 
      method: 'POST',
      credentials: 'include'
    })
    .then(res => res.json())
    .then(data => {
      alert('Cleared ' + data.cleared + ' expired trials');
      refreshData();
    });
  }
}

function clearLogs() {
  if (confirm('Clear all server logs?')) {
    fetch('/api/admin/logs/clear', { 
      method: 'POST',
      credentials: 'include'
    })
    .then(res => res.json())
    .then(data => {
      alert('Cleared ' + data.cleared + ' log entries');
      refreshData();
    });
  }
}

function exportData(format = 'json') {
  const endpoints = {
    json: '/api/admin/export',
    csv: '/api/admin/export/csv',
    zip: '/api/admin/export/zip'
  };
  
  const endpoint = endpoints[format];
  if (!endpoint) return;
  
  fetch(endpoint, { credentials: 'include' })
  .then(res => {
    if (format === 'csv') return res.blob();
    return res.json();
  })
  .then(data => {
    if (format === 'csv') {
      const url = window.URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'warriors-licenses-' + new Date().toISOString().split('T')[0] + '.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } else if (format === 'json') {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'warriors-export-' + new Date().toISOString().split('T')[0] + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } else if (format === 'zip') {
      const url = window.URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'warriors-export-' + new Date().toISOString().split('T')[0] + '.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  });
}

function showResetModal() {
  document.getElementById('resetModal').classList.add('active');
}

function resetDatabase() {
  const confirmText = document.getElementById('confirmText').value;
  if (confirmText !== 'RESET') {
    alert('Please type "RESET" to confirm');
    return;
  }
  
  if (confirm('This will PERMANENTLY delete ALL data. Are you absolutely sure?')) {
    fetch('/api/admin/reset-database', { 
      method: 'POST',
      credentials: 'include'
    })
    .then(res => res.json())
    .then(data => {
      alert(data.message);
      closeResetModal();
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    });
  }
}

function showServerInfoModal() {
  document.getElementById('serverInfoModal').classList.add('active');
}

function showDatabaseInfo() {
  fetch('/api/admin/database-info', { credentials: 'include' })
  .then(res => res.json())
  .then(data => {
    const content = document.getElementById('databaseInfoContent');
    content.innerHTML = `
      <div style="padding: 10px; background: #f8f9fa; border-radius: 6px; margin-bottom: 15px;">
        <strong>Database:</strong> PostgreSQL<br>
        <strong>Size:</strong> ${data.db_size}<br>
        <strong>Pool Total:</strong> ${data.pool_total}<br>
        <strong>Pool Idle:</strong> ${data.pool_idle}<br>
        <strong>Pool Waiting:</strong> ${data.pool_waiting}
      </div>
      
      <div style="padding: 10px; background: #f8f9fa; border-radius: 6px;">
        <strong>Table Statistics:</strong><br>
        <pre style="background: white; padding: 10px; border-radius: 4px; margin-top: 5px; overflow-y: auto; font-size: 12px;">
${JSON.stringify(data.table_stats, null, 2)}
        </pre>
      </div>
    `;
    
    document.getElementById('databaseInfoModal').classList.add('active');
  });
}

function vacuumDatabase() {
  if (confirm('Vacuum database to reclaim space?')) {
    fetch('/api/admin/database/vacuum', { 
      method: 'POST',
      credentials: 'include'
    })
    .then(res => res.json())
    .then(data => {
      alert(data.message);
    });
  }
}

function optimizeDatabase() {
  if (confirm('Optimize database?')) {
    fetch('/api/admin/database/optimize', { 
      method: 'POST',
      credentials: 'include'
    })
    .then(res => res.json())
    .then(data => {
      alert(data.message);
    });
  }
}

function deleteAllLicenses() {
  if (confirm('Delete ALL licenses? This cannot be undone!')) {
    fetch('/api/admin/licenses/delete-all', { 
      method: 'DELETE',
      credentials: 'include'
    })
    .then(res => res.json())
    .then(data => {
      alert('Deleted ' + data.deleted + ' licenses');
      refreshData();
    });
  }
}

function deleteAllTrials() {
  if (confirm('Delete ALL trials? This cannot be undone!')) {
    fetch('/api/admin/trials/delete-all', { 
      method: 'DELETE',
      credentials: 'include'
    })
    .then(res => res.json())
    .then(data => {
      alert('Deleted ' + data.deleted + ' trials');
      refreshData();
    });
  }
}

function refreshData() {
  window.location.reload();
}

function logout() {
  fetch('/api/admin/logout', { 
    method: 'POST',
    credentials: 'include'
  })
  .then(() => {
    window.location.href = '/admin/login';
  });
}

// Auto-refresh: only update dashboard stat cards via API, not a full page reload.
// This was previously doing window.location.reload() every 30s = ~115KB per cycle.
// Now it fetches ~1KB of JSON and updates the DOM in place.
setInterval(async () => {
  if (document.getElementById('dashboard').classList.contains('active')) {
    try {
      const res = await fetch('/api/admin/bandwidth-stats?period=all', { credentials: 'include' });
      const data = await res.json();
      if (data.success) {
        // Update bandwidth stat card
        const bwCard = document.querySelector('#dashboard .stat-card:nth-child(4) .value');
        if (bwCard) bwCard.textContent = data.total_bandwidth_formatted;
      }
    } catch (e) { /* silent fail */ }
  }
}, 60000); // extended to 60s — 30s was too aggressive