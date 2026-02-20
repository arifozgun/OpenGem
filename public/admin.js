// DOM Elements
let loadingView, loginView, dashboardView, loginForm, loginError;
let accountsBody, accountStatsBody, logsBody, keysBody;

// Navigation
const pages = {};
let isDataCached = { stats: false, accounts: false, logs: false, keys: false };

document.addEventListener('DOMContentLoaded', () => {
    loadingView = document.getElementById('loading-view');
    loginView = document.getElementById('login-view');
    dashboardView = document.getElementById('dashboard-view');
    loginForm = document.getElementById('loginForm');
    loginError = document.getElementById('loginError');
    accountsBody = document.getElementById('accountsBody');
    accountStatsBody = document.getElementById('accountStatsBody');
    logsBody = document.getElementById('logsBody');
    keysBody = document.getElementById('keysBody');

    // Setup pages
    document.querySelectorAll('.page').forEach(p => {
        pages[p.id.replace('page-', '')] = p;
    });

    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(item.dataset.page);
        });
    });

    // Auth
    checkSession();
    if (loginForm) loginForm.addEventListener('submit', handleLoginSubmit);

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', logoutAdmin);

    const connectBtn = document.getElementById('connectBtn');
    if (connectBtn) connectBtn.addEventListener('click', () => { window.location.href = '/api/auth/login'; });

    const refreshLogsBtn = document.getElementById('refreshLogsBtn');
    if (refreshLogsBtn) refreshLogsBtn.addEventListener('click', () => loadLogs(true));

    // API Keys UI
    const createKeyBtn = document.getElementById('createKeyBtn');
    const createKeyForm = document.getElementById('createKeyForm');
    const confirmCreateKey = document.getElementById('confirmCreateKey');
    const cancelCreateKey = document.getElementById('cancelCreateKey');
    const copyNewKey = document.getElementById('copyNewKey');

    if (createKeyBtn) createKeyBtn.addEventListener('click', () => {
        createKeyForm.classList.remove('hidden');
        document.getElementById('newKeyName').focus();
    });
    if (cancelCreateKey) cancelCreateKey.addEventListener('click', () => {
        createKeyForm.classList.add('hidden');
        document.getElementById('newKeyName').value = '';
    });
    if (confirmCreateKey) confirmCreateKey.addEventListener('click', createApiKey);
    if (copyNewKey) copyNewKey.addEventListener('click', () => {
        const key = document.getElementById('newKeyValue').textContent;
        navigator.clipboard.writeText(key).then(() => {
            const svgIcon = copyNewKey.querySelector('svg');
            const originalHTML = copyNewKey.innerHTML;
            if (svgIcon) {
                copyNewKey.innerHTML = svgIcon.outerHTML + ' Copied!';
            } else {
                copyNewKey.textContent = 'Copied!';
            }
            setTimeout(() => { copyNewKey.innerHTML = originalHTML; }, 2000);
        });
    });

    // Docs enhancements
    setupCodeTabs();
    setupPlayground();

    // Handle back/forward navigation
    window.addEventListener('popstate', (e) => {
        const path = window.location.pathname.replace('/', '') || 'overview';
        if (pages[path]) {
            navigateTo(path, false);
        }
    });
});

// ===== NAVIGATION =====

function navigateTo(pageName, pushState = true) {
    if (pushState && window.location.pathname !== '/' + pageName) {
        window.history.pushState({ page: pageName }, '', '/' + pageName);
    }

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === pageName);
    });

    // Show the correct page
    Object.entries(pages).forEach(([name, el]) => {
        el.classList.toggle('active', name === pageName);
    });

    // Load data for the page
    if (pageName === 'overview') loadStats();
    if (pageName === 'accounts') loadAccounts();
    if (pageName === 'logs') loadLogs();
    if (pageName === 'keys') loadApiKeys();
    if (pageName === 'docs') initDocs();
}

// ===== DOCUMENTATION =====

function initDocs() {
    const baseUrlEl = document.getElementById('docBaseUrl');
    if (baseUrlEl) {
        baseUrlEl.textContent = window.location.origin;
    }
    // Update all dynamic base URL placeholders in code examples
    document.querySelectorAll('.doc-base-url').forEach(el => {
        el.textContent = window.location.origin;
    });
}

// ===== AUTH =====

async function handleLoginSubmit(e) {
    e.preventDefault();
    loginError.classList.add('hidden');
    const username = document.getElementById('adminUsername').value;
    const password = document.getElementById('adminPassword').value;

    try {
        const res = await fetch('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (res.ok) {
            document.getElementById('adminUsername').value = '';
            document.getElementById('adminPassword').value = '';
            showDashboard();
        } else {
            const data = await res.json();
            loginError.textContent = data.error || 'Invalid credentials.';
            loginError.classList.remove('hidden');
        }
    } catch (err) {
        loginError.textContent = 'A network error occurred.';
        loginError.classList.remove('hidden');
    }
}

async function checkSession() {
    try {
        const res = await fetch('/api/admin/me');
        if (res.ok) {
            showDashboard();
        } else {
            showLogin();
        }
    } catch (err) {
        showLogin();
    }
}

function showLogin() {
    loadingView.classList.add('hidden');
    dashboardView.classList.add('hidden');
    loginView.classList.remove('hidden');
}

function showDashboard() {
    loadingView.classList.add('hidden');
    loginView.classList.add('hidden');
    dashboardView.classList.remove('hidden');

    // Check initial path
    const initialPath = window.location.pathname.replace('/', '') || 'overview';
    if (pages[initialPath]) {
        navigateTo(initialPath, false); // false to not pushstate on load
    } else {
        navigateTo('overview', true);
    }
}

async function logoutAdmin() {
    try {
        await fetch('/api/admin/logout', { method: 'POST' });
        showLogin();
    } catch (err) {
        console.error(err);
    }
}

// ===== STATS (Overview) =====

async function loadStats(force = false) {
    if (!force && isDataCached.stats) return;

    const statTotal = document.getElementById('stat-total');
    const statSuccess = document.getElementById('stat-success');
    const statAccounts = document.getElementById('stat-accounts');
    const statTokens = document.getElementById('stat-tokens');

    try {
        const res = await fetch('/api/stats');
        if (res.status === 401) { showLogin(); return; }
        const stats = await res.json();
        isDataCached.stats = true;

        // Update stat cards
        statTotal.textContent = formatNumber(stats.totalRequests);

        const rate = stats.totalRequests > 0
            ? Math.round((stats.successfulRequests / stats.totalRequests) * 100)
            : 0;
        statSuccess.textContent = rate + '%';

        statAccounts.textContent = stats.activeAccounts + ' / ' + stats.totalAccounts;
        statTokens.textContent = formatNumber(stats.totalTokensUsed);

        // Render account stats table
        renderAccountStats(stats.accountStats);
    } catch (e) {
        console.error('Failed to load stats:', e);
        statTotal.textContent = '—';
        statSuccess.textContent = '—';
        statAccounts.textContent = '—';
        statTokens.textContent = '—';
    }
}

function renderAccountStats(accountStats) {
    accountStatsBody.innerHTML = '';

    if (!accountStats || accountStats.length === 0) {
        accountStatsBody.innerHTML = '<tr><td colspan="6" class="table-empty">No account data yet.</td></tr>';
        return;
    }

    accountStats.forEach(acc => {
        const row = document.createElement('tr');

        const emailTd = document.createElement('td');
        emailTd.className = 'cell-email';
        emailTd.textContent = acc.email;

        const reqTd = document.createElement('td');
        reqTd.textContent = formatNumber(acc.totalRequests);

        const successTd = document.createElement('td');
        successTd.textContent = formatNumber(acc.successfulRequests);
        successTd.style.color = 'var(--green)';

        const failedTd = document.createElement('td');
        failedTd.textContent = formatNumber(acc.failedRequests);
        failedTd.style.color = acc.failedRequests > 0 ? 'var(--red)' : 'inherit';

        const tokensTd = document.createElement('td');
        tokensTd.textContent = formatNumber(acc.totalTokensUsed);

        const statusTd = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = acc.isActive ? 'badge badge-active' : 'badge badge-inactive';
        badge.textContent = acc.isActive ? 'Active' : 'Exhausted';
        statusTd.appendChild(badge);

        row.append(emailTd, reqTd, successTd, failedTd, tokensTd, statusTd);
        accountStatsBody.appendChild(row);
    });
}

// ===== ACCOUNTS =====

async function loadAccounts(force = false) {
    if (!force && isDataCached.accounts) return;
    accountsBody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading accounts...</td></tr>';
    try {
        const response = await fetch('/api/accounts');
        if (response.status === 401) { showLogin(); return; }

        const accounts = await response.json();
        isDataCached.accounts = true;
        accountsBody.innerHTML = '';

        if (accounts.length === 0) {
            accountsBody.innerHTML = '<tr><td colspan="5" class="table-empty">No accounts connected yet.</td></tr>';
            return;
        }

        accounts.forEach(acc => {
            const row = document.createElement('tr');

            const emailCell = document.createElement('td');
            emailCell.className = 'cell-email';
            emailCell.textContent = acc.email;

            const projectCell = document.createElement('td');
            projectCell.textContent = acc.projectId;
            projectCell.style.color = 'var(--text-secondary)';

            const statusCell = document.createElement('td');
            const badge = document.createElement('span');
            badge.className = acc.isActive ? 'badge badge-active' : 'badge badge-inactive';
            badge.textContent = acc.isActive ? 'Active' : 'Exhausted';
            statusCell.appendChild(badge);

            const timeCell = document.createElement('td');
            timeCell.className = 'cell-time';
            timeCell.textContent = formatTime(acc.lastUsedAt);

            const actionCell = document.createElement('td');

            if (!acc.isActive) {
                const reactivateBtn = document.createElement('button');
                reactivateBtn.className = 'btn btn-link';
                reactivateBtn.textContent = 'Reactivate';
                reactivateBtn.onclick = () => reactivateAccount(acc.id);
                actionCell.appendChild(reactivateBtn);
            }

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-danger-text';
            deleteBtn.textContent = 'Remove';
            deleteBtn.onclick = () => deleteAccount(acc.id);
            actionCell.appendChild(deleteBtn);

            row.append(emailCell, projectCell, statusCell, timeCell, actionCell);
            accountsBody.appendChild(row);
        });
    } catch (e) {
        console.error(e);
        accountsBody.innerHTML = '<tr><td colspan="5" class="table-empty" style="color:var(--red)">Failed to load accounts.</td></tr>';
    }
}

async function reactivateAccount(id) {
    try {
        const res = await fetch('/api/accounts/' + encodeURIComponent(id) + '/reactivate', { method: 'PUT' });
        if (res.status === 401) { showLogin(); return; }
        loadAccounts(true);
    } catch (err) {
        console.error(err);
        alert('Failed to reactivate account');
    }
}

async function deleteAccount(id) {
    if (!confirm('Are you sure you want to remove this account?')) return;
    try {
        const res = await fetch('/api/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
        if (res.status === 401) { showLogin(); return; }
        loadAccounts(true);
    } catch (err) {
        console.error(err);
        alert('Failed to delete account');
    }
}

// ===== LOGS =====

async function loadLogs(force = false) {
    if (!force && isDataCached.logs) return;
    logsBody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading logs...</td></tr>';
    try {
        const res = await fetch('/api/logs?limit=100');
        if (res.status === 401) { showLogin(); return; }
        const logs = await res.json();
        isDataCached.logs = true;
        logsBody.innerHTML = '';

        if (logs.length === 0) {
            logsBody.innerHTML = '<tr><td colspan="5" class="table-empty">No request logs yet. Logs will appear after API requests are made.</td></tr>';
            return;
        }

        logs.forEach(log => {
            const row = document.createElement('tr');

            const timeTd = document.createElement('td');
            timeTd.className = 'cell-time';
            timeTd.textContent = formatTime(log.timestamp);

            const emailTd = document.createElement('td');
            emailTd.className = 'cell-email';
            emailTd.textContent = log.accountEmail;

            const questionTd = document.createElement('td');
            questionTd.className = 'cell-truncate';
            questionTd.textContent = log.question || '—';
            questionTd.title = log.question || '';

            const answerTd = document.createElement('td');
            answerTd.className = 'cell-truncate';

            if (!log.success) {
                const errorSpan = document.createElement('span');
                errorSpan.className = 'badge badge-inactive';
                errorSpan.style.backgroundColor = 'var(--red-light, rgba(239, 68, 68, 0.1))';
                errorSpan.style.color = 'var(--red, #ef4444)';
                errorSpan.textContent = 'Error';

                const errText = document.createTextNode(' ' + (log.answer || '—'));
                answerTd.appendChild(errorSpan);
                answerTd.appendChild(errText);
                answerTd.title = log.answer || '';
            } else {
                answerTd.textContent = log.answer || '—';
                answerTd.title = log.answer || '';
            }

            const tokensTd = document.createElement('td');
            tokensTd.textContent = formatNumber(log.tokensUsed || 0);

            row.append(timeTd, emailTd, questionTd, answerTd, tokensTd);
            logsBody.appendChild(row);
        });
    } catch (e) {
        console.error('Failed to load logs:', e);
        logsBody.innerHTML = '<tr><td colspan="5" class="table-empty" style="color:var(--red)">Failed to load logs.</td></tr>';
    }
}

// ===== API KEYS =====

async function loadApiKeys(force = false) {
    if (!keysBody) return;
    if (!force && isDataCached.keys) return;
    keysBody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading API keys...</td></tr>';
    try {
        const res = await fetch('/api/keys');
        if (res.status === 401) { showLogin(); return; }
        const keys = await res.json();
        isDataCached.keys = true;
        keysBody.innerHTML = '';

        if (keys.length === 0) {
            keysBody.innerHTML = '<tr><td colspan="5" class="table-empty">No API keys yet. Create one to get started.</td></tr>';
            return;
        }

        keys.forEach(k => {
            const row = document.createElement('tr');

            const nameTd = document.createElement('td');
            nameTd.textContent = k.name;
            nameTd.style.fontWeight = '500';

            const keyTd = document.createElement('td');
            keyTd.style.fontFamily = "'SF Mono', monospace";
            keyTd.style.fontSize = '13px';
            keyTd.style.color = 'var(--text-secondary)';
            keyTd.textContent = k.key;

            const createdTd = document.createElement('td');
            createdTd.className = 'cell-time';
            createdTd.textContent = formatTime(k.createdAt);

            const reqTd = document.createElement('td');
            reqTd.textContent = formatNumber(k.totalRequests || 0);

            const actionTd = document.createElement('td');
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-danger-text';
            deleteBtn.textContent = 'Delete';
            deleteBtn.onclick = () => deleteApiKey(k.id, k.name);
            actionTd.appendChild(deleteBtn);

            row.append(nameTd, keyTd, createdTd, reqTd, actionTd);
            keysBody.appendChild(row);
        });
    } catch (e) {
        console.error('Failed to load keys:', e);
        keysBody.innerHTML = '<tr><td colspan="5" class="table-empty" style="color:var(--red)">Failed to load API keys.</td></tr>';
    }
}

async function createApiKey() {
    const nameInput = document.getElementById('newKeyName');
    const name = nameInput.value.trim();
    if (!name) {
        alert('Please enter a key name.');
        nameInput.focus();
        return;
    }

    try {
        const res = await fetch('/api/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });

        if (res.status === 401) { showLogin(); return; }
        const data = await res.json();

        if (!res.ok) {
            alert(data.error || 'Failed to create key.');
            return;
        }

        // Show the new key
        document.getElementById('newKeyValue').textContent = data.key;
        document.getElementById('newKeyDisplay').classList.remove('hidden');
        document.getElementById('createKeyForm').classList.add('hidden');
        nameInput.value = '';

        // Reload keys table
        loadApiKeys(true);
    } catch (e) {
        console.error('Create key error:', e);
        alert('Failed to create API key.');
    }
}

async function deleteApiKey(id, name) {
    if (!confirm(`Delete API key "${name}"? Applications using this key will stop working.`)) return;
    try {
        const res = await fetch('/api/keys/' + encodeURIComponent(id), { method: 'DELETE' });
        if (res.status === 401) { showLogin(); return; }
        loadApiKeys(true);
    } catch (e) {
        console.error('Delete key error:', e);
        alert('Failed to delete API key.');
    }
}

// ===== HELPERS =====

function formatNumber(n) {
    if (n === null || n === undefined) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
}

function formatTime(dateStr) {
    try {
        const d = new Date(dateStr);
        const now = new Date();
        const diffMs = now - d;
        const diffMins = Math.floor(diffMs / 60000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return diffMins + 'm ago';
        if (diffMins < 1440) return Math.floor(diffMins / 60) + 'h ago';
        if (diffMins < 10080) return Math.floor(diffMins / 1440) + 'd ago';

        return d.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return '—';
    }
}

// ===== CODE TABS & PLAYGROUND =====

function setupCodeTabs() {
    const tabs = document.querySelectorAll('.code-tab');
    const panels = document.querySelectorAll('.code-panel');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const lang = tab.dataset.lang;
            const panel = document.querySelector(`.code-panel[data-lang="${lang}"]`);
            if (panel) panel.classList.add('active');
        });
    });
}

function setupPlayground() {
    const sendBtn = document.getElementById('pgSendBtn');
    const responseContent = document.getElementById('pgResponseContent');
    const loadingEl = document.getElementById('pgLoading');

    if (!sendBtn) return;

    sendBtn.addEventListener('click', async () => {
        const apiKey = document.getElementById('pgApiKey').value.trim();
        const model = document.getElementById('pgModel').value;
        const message = document.getElementById('pgMessage').value.trim();

        if (!apiKey) {
            alert('Please enter an API Key to test the endpoint.');
            document.getElementById('pgApiKey').focus();
            return;
        }

        if (!message) {
            alert('Please enter a message.');
            document.getElementById('pgMessage').focus();
            return;
        }

        responseContent.textContent = '';
        loadingEl.classList.remove('hidden');
        sendBtn.disabled = true;

        try {
            const baseUrl = window.location.origin;
            const res = await fetch(`${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: message }] }]
                })
            });

            const data = await res.json();
            loadingEl.classList.add('hidden');

            responseContent.textContent = JSON.stringify(data, null, 2);
            responseContent.style.color = res.ok ? '#ffffff' : 'var(--red)';

        } catch (error) {
            loadingEl.classList.add('hidden');
            responseContent.textContent = `Error: ${error.message}`;
            responseContent.style.color = 'var(--red)';
        } finally {
            sendBtn.disabled = false;
        }
    });
}
