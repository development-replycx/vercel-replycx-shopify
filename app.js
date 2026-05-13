// State management
let campaigns = [];

// Constants
const API_URL = '/api/campaigns';
const WEBHOOK_BASE_URL = window.location.origin + '/api/webhook';

// DOM Elements
const views = {
    dashboard: document.getElementById('view-dashboard'),
    add: document.getElementById('view-add'),
    success: document.getElementById('view-success')
};

const navBtns = {
    dashboard: document.getElementById('nav-dashboard'),
    add: document.getElementById('nav-add')
};

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    fetchCampaigns();
    setupEventListeners();
});

function setupEventListeners() {
    navBtns.dashboard.addEventListener('click', () => showView('dashboard'));
    navBtns.add.addEventListener('click', () => {
        resetForm();
        showView('add');
    });

    document.getElementById('campaign-form').addEventListener('submit', handleFormSubmit);
    document.getElementById('add-mapping').addEventListener('click', addMappingRow);
    document.getElementById('mapping-container').addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-row')) {
            e.target.parentElement.remove();
        }
    });

    document.getElementById('copy-url-btn').addEventListener('click', copyWebhookUrl);
    document.getElementById('test-campaign-btn').addEventListener('click', runTest);
}

// Navigation
function showView(viewName) {
    Object.keys(views).forEach(v => views[v].classList.add('hidden'));
    views[viewName].classList.remove('hidden');
    
    // Update nav buttons
    Object.keys(navBtns).forEach(b => {
        if (b === viewName) navBtns[b]?.classList.add('active');
        else navBtns[b]?.classList.remove('active');
    });

    if (viewName === 'dashboard') fetchCampaigns();
}

// API Calls
async function fetchCampaigns() {
    try {
        const res = await fetch(API_URL);
        const contentType = res.headers.get("content-type");
        
        if (contentType && contentType.indexOf("application/json") !== -1) {
            const data = await res.json();
            if (res.ok) {
                campaigns = data;
                renderDashboard();
            } else {
                showToast(`Server Error: ${data.error || res.status}`, 'danger');
            }
        } else {
            const text = await res.text();
            console.error('Non-JSON Response:', text);
            showToast(`Critical Error: Check Vercel Logs (Status ${res.status})`, 'danger');
        }
    } catch (err) {
        showToast(`Connection Error: ${err.message}`, 'danger');
    }
}

async function handleFormSubmit(e) {
    e.preventDefault();
    
    const id = document.getElementById('campaign-id').value;
    const name = document.getElementById('name').value;
    const event_type = document.getElementById('eventType').value;
    const reply_url = document.getElementById('replyUrl').value;
    const reply_token = document.getElementById('replyToken').value;
    
    const mappings = [];
    document.querySelectorAll('.mapping-row').forEach(row => {
        const path = row.querySelector('.map-path').value;
        const varName = row.querySelector('.map-name').value;
        if (path && varName) mappings.push({ path, name: varName });
    });

    const payload = { id, name, event_type, reply_url, reply_token, mappings };

    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await res.json();
        if (res.ok) {
            showSuccess(data);
        } else {
            showToast(`Error: ${data.error || 'Failed to save'}`, 'danger');
        }
    } catch (err) {
        showToast(`System Error: ${err.message}`, 'danger');
    }
}

async function deleteCampaign(id) {
    if (!confirm('Are you sure?')) return;
    try {
        const res = await fetch(`${API_URL}?id=${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Deleted');
            fetchCampaigns();
        }
    } catch (err) {
        showToast('Error deleting', 'danger');
    }
}

// UI Rendering
function renderDashboard() {
    const list = document.getElementById('campaign-list');
    const count = document.getElementById('campaign-count');
    count.textContent = campaigns.length;
    
    if (campaigns.length === 0) {
        list.innerHTML = '<div class="card shadow" style="grid-column: 1/-1; text-align: center; color: var(--text-muted);">No campaigns found.</div>';
        return;
    }

    list.innerHTML = campaigns.map(c => `
        <div class="card campaign-card shadow">
            <h3>${c.name}</h3>
            <div class="campaign-meta">
                <div><strong>Event:</strong> ${c.event_type}</div>
                <div><strong>Status:</strong> <span style="color: var(--success)">${c.status}</span></div>
                <div><strong>Last:</strong> ${c.last_triggered ? new Date(c.last_triggered).toLocaleString() : 'Never'}</div>
            </div>
            <div class="campaign-actions">
                <button class="btn-text" onclick="editCampaign('${c.id}')">Edit</button>
                <button class="btn-text" style="color: var(--danger)" onclick="deleteCampaign('${c.id}')">Delete</button>
            </div>
        </div>
    `).join('');
}

function showSuccess(campaign) {
    const url = `${WEBHOOK_BASE_URL}?event=${campaign.event_type}`;
    document.getElementById('generated-url').textContent = url;
    showView('success');
}

function editCampaign(id) {
    const campaign = campaigns.find(c => c.id === id);
    if (!campaign) return;
    document.getElementById('campaign-id').value = campaign.id;
    document.getElementById('name').value = campaign.name;
    document.getElementById('eventType').value = campaign.event_type;
    document.getElementById('replyUrl').value = campaign.reply_url;
    document.getElementById('replyToken').value = campaign.reply_token;
    const container = document.getElementById('mapping-container');
    container.innerHTML = '';
    campaign.mappings.forEach(m => addMappingRow(null, m.path, m.name));
    document.getElementById('form-title').textContent = 'Edit Campaign';
    showView('add');
}

function resetForm() {
    document.getElementById('campaign-form').reset();
    document.getElementById('campaign-id').value = '';
    const container = document.getElementById('mapping-container');
    container.innerHTML = `
        <div class="mapping-row">
            <input type="text" value="shipping_address.phone" class="map-path" required>
            <span class="arrow">→</span>
            <input type="text" value="phone" class="map-name" required>
            <button type="button" class="btn-icon remove-row" disabled>×</button>
        </div>
        <div class="mapping-row">
            <input type="text" value="shipping_address.first_name" class="map-path" required>
            <span class="arrow">→</span>
            <input type="text" value="first_name" class="map-name" required>
            <button type="button" class="btn-icon remove-row">×</button>
        </div>
    `;
}

function addMappingRow(e, path = '', name = '') {
    const container = document.getElementById('mapping-container');
    const row = document.createElement('div');
    row.className = 'mapping-row';
    row.innerHTML = `
        <input type="text" value="${path}" class="map-path" required>
        <span class="arrow">→</span>
        <input type="text" value="${name}" class="map-name" required>
        <button type="button" class="btn-icon remove-row">×</button>
    `;
    container.appendChild(row);
}

function copyWebhookUrl() {
    const url = document.getElementById('generated-url').textContent;
    navigator.clipboard.writeText(url).then(() => showToast('Copied!'));
}

async function runTest() {
    const url = document.getElementById('generated-url').textContent;
    const testResult = document.getElementById('test-result');
    const testOutput = document.getElementById('test-output');
    const btn = document.getElementById('test-campaign-btn');
    btn.disabled = true;
    const dummyPayload = { shipping_address: { phone: "9876543210", first_name: "John" } };
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dummyPayload)
        });
        const data = await res.json();
        testResult.classList.remove('hidden');
        testOutput.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
        testResult.classList.remove('hidden');
        testOutput.textContent = 'Error: ' + err.message;
    } finally {
        btn.disabled = false;
    }
}

function showToast(msg, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.style.background = type === 'danger' ? 'var(--danger)' : 'var(--text-main)';
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 4000);
}

window.showView = showView;
window.editCampaign = editCampaign;
window.deleteCampaign = deleteCampaign;
