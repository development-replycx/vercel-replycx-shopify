// State management
let campaigns = [];

// Constants
const API_URL = '/api/campaigns';
const WEBHOOK_BASE_URL = window.location.origin + '/api/webhook';

// DOM Elements
const views = {
    dashboard: document.getElementById('view-dashboard'),
    add: document.getElementById('view-add'),
    abandoned: document.getElementById('view-abandoned'),
    success: document.getElementById('view-success')
};

const navBtns = {
    dashboard: document.getElementById('nav-dashboard'),
    abandoned: document.getElementById('nav-abandoned'),
    add: document.getElementById('nav-add')
};

// Initialization
document.addEventListener('DOMContentLoaded', () => {
    // Auth check
    if (localStorage.getItem('isLoggedIn') !== 'true') {
        window.location.href = 'login.html';
        return;
    }

    fetchCampaigns();
    setupEventListeners();
    setupAbandonedCartCopyBtns();
});

function setupAbandonedCartCopyBtns() {
    const copyCheckoutBtn = document.getElementById('copy-checkout-url-btn');
    if (copyCheckoutBtn) {
        copyCheckoutBtn.addEventListener('click', () => {
            const url = document.getElementById('abandoned-checkout-webhook-url').textContent;
            navigator.clipboard.writeText(url).then(() => showToast('Copied Checkout webhook URL!'));
        });
    }

    const copyOrderBtn = document.getElementById('copy-order-url-btn');
    if (copyOrderBtn) {
        copyOrderBtn.addEventListener('click', () => {
            const url = document.getElementById('abandoned-order-webhook-url').textContent;
            navigator.clipboard.writeText(url).then(() => showToast('Copied Order webhook URL!'));
        });
    }
}

function setupEventListeners() {
    navBtns.dashboard.addEventListener('click', () => showView('dashboard'));
    navBtns.abandoned.addEventListener('click', () => {
        loadAbandonedCartSettings();
        showView('abandoned');
    });
    navBtns.add.addEventListener('click', () => {
        resetForm();
        showView('add');
    });

    document.getElementById('logout-btn').addEventListener('click', () => {
        localStorage.removeItem('isLoggedIn');
        window.location.href = 'login.html';
    });

    document.getElementById('campaign-form').addEventListener('submit', handleFormSubmit);
    document.getElementById('abandoned-form').addEventListener('submit', handleAbandonedSubmit);
    document.getElementById('add-mapping').addEventListener('click', addMappingRow);
    document.getElementById('phone-country-enabled').addEventListener('change', updatePhoneCountryVisibility);
    document.getElementById('mapping-container').addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-row')) {
            e.target.parentElement.remove();
        }
    });
    
    document.getElementById('bot-add-mapping').addEventListener('click', () => addBotMappingRow());
    document.getElementById('bot-mapping-container').addEventListener('click', (e) => {
        if (e.target.classList.contains('remove-row')) {
            e.target.parentElement.remove();
        }
    });

    const copyUrlBtn = document.getElementById('copy-url-btn');
    if (copyUrlBtn) {
        copyUrlBtn.addEventListener('click', copyWebhookUrl);
    }
    document.getElementById('test-campaign-btn').addEventListener('click', runTest);
}

function parseCampaignMappings(rawMappings) {
    let parsed = rawMappings || [];
    if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) { parsed = []; }
    }

    if (Array.isArray(parsed)) {
        return {
            fields: parsed,
            phoneCountryCode: { enabled: false, countryCode: '91' }
        };
    }

    const phoneConfig = parsed.phone_country_code || parsed.phoneCountryCode || {};
    return {
        fields: Array.isArray(parsed.fields) ? parsed.fields : [],
        phoneCountryCode: {
            enabled: !!phoneConfig.enabled,
            countryCode: phoneConfig.country_code || phoneConfig.countryCode || '91'
        }
    };
}

function updatePhoneCountryVisibility() {
    const enabled = document.getElementById('phone-country-enabled').checked;
    document.getElementById('phone-country-code-group').classList.toggle('hidden', !enabled);
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

    const addCountryCode = document.getElementById('phone-country-enabled').checked;
    const countryCode = (document.getElementById('phone-country-code').value || '91').replace(/\D/g, '') || '91';
    const payload = {
        id,
        name,
        event_type,
        reply_url,
        reply_token,
        mappings: {
            fields: mappings,
            phone_country_code: {
                enabled: addCountryCode,
                country_code: countryCode
            }
        }
    };

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
    
    // Filter out the special Abandoned Cart setting so it is kept separate
    const filteredCampaigns = campaigns.filter(c => c.id !== '11111111-1111-1111-1111-111111111111');
    count.textContent = filteredCampaigns.length;
    
    if (filteredCampaigns.length === 0) {
        list.innerHTML = '<div class="card shadow" style="grid-column: 1/-1; text-align: center; color: var(--text-muted);">No campaigns found.</div>';
        return;
    }

    list.innerHTML = filteredCampaigns.map(c => `
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
    const eventTypes = campaign.event_type.split(',').map(e => e.trim()).filter(Boolean);
    const container = document.getElementById('webhook-urls-container');
    
    if (container) {
        container.innerHTML = eventTypes.map((evt, idx) => {
            const url = `${WEBHOOK_BASE_URL}?event=${encodeURIComponent(evt)}`;
            return `
                <div class="webhook-url-box" style="margin: 0.75rem 0;">
                    <code id="generated-url-${idx}">${url}</code>
                    <button type="button" class="btn-copy" onclick="copyDynamicUrl('${url}', this)">Copy</button>
                </div>
            `;
        }).join('');
    }

    // Set first event URL as test target
    const testBtn = document.getElementById('test-campaign-btn');
    if (testBtn && eventTypes.length > 0) {
        testBtn.dataset.url = `${WEBHOOK_BASE_URL}?event=${encodeURIComponent(eventTypes[0])}`;
    }
    
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
    const mappingConfig = parseCampaignMappings(campaign.mappings);
    document.getElementById('phone-country-enabled').checked = mappingConfig.phoneCountryCode.enabled;
    document.getElementById('phone-country-code').value = mappingConfig.phoneCountryCode.countryCode || '91';
    updatePhoneCountryVisibility();
    const container = document.getElementById('mapping-container');
    container.innerHTML = '';
    mappingConfig.fields.forEach(m => addMappingRow(null, m.path, m.name));
    document.getElementById('form-title').textContent = 'Edit Campaign';
    showView('add');
}

function resetForm() {
    document.getElementById('campaign-form').reset();
    document.getElementById('campaign-id').value = '';
    document.getElementById('phone-country-enabled').checked = false;
    document.getElementById('phone-country-code').value = '91';
    updatePhoneCountryVisibility();
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

function addBotMappingRow(path = '', name = '') {
    const container = document.getElementById('bot-mapping-container');
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
    const btn = document.getElementById('test-campaign-btn');
    const url = btn.dataset.url || `${WEBHOOK_BASE_URL}?event=${encodeURIComponent(campaigns.find(c => c.id === document.getElementById('campaign-id').value)?.event_type?.split(',')[0]?.trim() || '')}`;
    const testResult = document.getElementById('test-result');
    const testOutput = document.getElementById('test-output');
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

async function loadAbandonedCartSettings() {
    const baseWebhookUrl = window.location.origin + '/api/webhook';
    document.getElementById('abandoned-checkout-webhook-url').textContent = `${baseWebhookUrl}?event=checkouts/update`;
    document.getElementById('abandoned-order-webhook-url').textContent = `${baseWebhookUrl}?event=orders/create`;

    try {
        const res = await fetch(API_URL);
        if (res.ok) {
            const list = await res.json();
            const setting = list.find(c => c.id === '11111111-1111-1111-1111-111111111111');
            if (setting) {
                document.getElementById('abandoned-enabled').checked = setting.status === 'active';
                document.getElementById('abandoned-reply-url').value = setting.reply_url || '';
                document.getElementById('abandoned-reply-token').value = setting.reply_token || '';
                
                let delay = 60;
                let botTrigger = { url: '', token: '', mappings: [] };
                if (setting.mappings) {
                    let parsedMappings = setting.mappings;
                    if (typeof setting.mappings === 'string') {
                        try { parsedMappings = JSON.parse(setting.mappings); } catch (e) {}
                    }
                    if (parsedMappings && parsedMappings.delay_minutes !== undefined) {
                        delay = parsedMappings.delay_minutes;
                    }
                    if (parsedMappings && parsedMappings.bot_trigger) {
                        botTrigger = parsedMappings.bot_trigger;
                    }
                }
                document.getElementById('abandoned-delay').value = delay;
                
                document.getElementById('bot-trigger-url').value = botTrigger.url || '';
                document.getElementById('bot-trigger-token').value = botTrigger.token || '';
                const botContainer = document.getElementById('bot-mapping-container');
                botContainer.innerHTML = '';
                if (botTrigger.mappings && botTrigger.mappings.length > 0) {
                    botTrigger.mappings.forEach(m => addBotMappingRow(m.path, m.name));
                }
            } else {
                document.getElementById('abandoned-enabled').checked = false;
                document.getElementById('abandoned-reply-url').value = '';
                document.getElementById('abandoned-reply-token').value = '';
                document.getElementById('abandoned-delay').value = 60;
                document.getElementById('bot-trigger-url').value = '';
                document.getElementById('bot-trigger-token').value = '';
                document.getElementById('bot-mapping-container').innerHTML = '';
            }
        }
    } catch (err) {
        showToast('Error loading settings: ' + err.message, 'danger');
    }
}

async function handleAbandonedSubmit(e) {
    e.preventDefault();
    
    const enabled = document.getElementById('abandoned-enabled').checked;
    const reply_url = document.getElementById('abandoned-reply-url').value;
    const reply_token = document.getElementById('abandoned-reply-token').value;
    const delay_minutes = parseInt(document.getElementById('abandoned-delay').value, 10) || 60;

    const bot_url = document.getElementById('bot-trigger-url').value;
    const bot_token = document.getElementById('bot-trigger-token').value;
    const bot_mappings = [];
    document.querySelectorAll('#bot-mapping-container .mapping-row').forEach(row => {
        const path = row.querySelector('.map-path').value;
        const name = row.querySelector('.map-name').value;
        if (path && name) bot_mappings.push({ path, name });
    });

    const payload = {
        id: '11111111-1111-1111-1111-111111111111',
        name: 'Abandoned Cart Flow',
        event_type: 'checkouts/update',
        reply_url,
        reply_token,
        status: enabled ? 'active' : 'inactive',
        mappings: { 
            delay_minutes,
            bot_trigger: {
                url: bot_url,
                token: bot_token,
                mappings: bot_mappings
            }
        }
    };

    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        const data = await res.json();
        if (res.ok) {
            showToast('Abandoned Cart settings saved successfully!');
        } else {
            showToast(`Error: ${data.error || 'Failed to save settings'}`, 'danger');
        }
    } catch (err) {
        showToast(`System Error: ${err.message}`, 'danger');
    }
}

window.showView = showView;
window.editCampaign = editCampaign;
window.deleteCampaign = deleteCampaign;
window.copyDynamicUrl = function(url, btn) {
    navigator.clipboard.writeText(url).then(() => {
        const origText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.style.backgroundColor = 'var(--success)';
        setTimeout(() => {
            btn.textContent = origText;
            btn.style.backgroundColor = '';
        }, 1500);
    });
};
