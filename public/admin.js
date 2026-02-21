// DOM Elements
let loadingView, loginView, dashboardView, loginForm, loginError;
let accountsBody, accountStatsBody, logsBody, keysBody;

// Navigation
const pages = {};
let isDataCached = { stats: false, accounts: false, logs: false, keys: false };

// Lazy loading state
const LAZY_BATCH_SIZE = 20;
let logsAllData = [], accountsAllData = [], keysAllData = [];
let logsRendered = 0, accountsRendered = 0, keysRendered = 0;
let logsHasMore = false, accountsHasMore = false, keysHasMore = false;

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
    setupChat();

    // Handle back/forward navigation
    window.addEventListener('popstate', (e) => {
        const path = window.location.pathname.replace('/', '') || 'overview';
        if (pages[path]) {
            navigateTo(path, false);
        }
    });

    // Lazy loading scroll listener on main-content
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
        mainContent.addEventListener('scroll', () => {
            const { scrollTop, scrollHeight, clientHeight } = mainContent;
            if (scrollHeight - scrollTop - clientHeight < 150) {
                // Determine which page is active and load more
                const activePage = document.querySelector('.page.active');
                if (activePage) {
                    const pageId = activePage.id.replace('page-', '');
                    if (pageId === 'logs' && logsHasMore) renderLogsBatch();
                    if (pageId === 'accounts' && accountsHasMore) renderAccountsBatch();
                    if (pageId === 'keys' && keysHasMore) renderKeysBatch();
                }
            }
        });
    }
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
    if (pageName === 'settings') loadSettings();
    if (pageName === 'chat') initChat();
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

// ===== SETTINGS =====

let currentDbBackend = null;

async function loadSettings() {
    const el = document.getElementById('currentDbBackend');
    const noteEl = document.getElementById('dbBackendNote');
    if (!el) return;

    try {
        const res = await fetch('/api/admin/db-status');
        if (res.status === 401) { showLogin(); return; }
        const data = await res.json();
        currentDbBackend = data.backend;

        if (data.backend === 'local') {
            el.innerHTML = '<span class="badge-db badge-db-local"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg> Local File (data/db.json)</span>';
            if (noteEl) noteEl.innerHTML = '<div class="db-note">Data is stored locally on your server. Back up <code>data/db.json</code> periodically.</div>';
        } else {
            el.innerHTML = '<span class="badge-db badge-db-firebase"><img src="/icons/firebase.png" alt="Firebase" width="14" height="14" style="object-fit:contain;vertical-align:middle;margin-right:4px;"> Firebase Firestore</span>';
            if (noteEl) noteEl.innerHTML = '<div class="db-note">Data is stored in Google Firebase Firestore.</div>';
        }
    } catch (e) {
        el.textContent = 'Error loading status';
    }
}

// DB Switch Modal
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('dbSwitchModal');
    const switchBtn = document.getElementById('switchDbBtn');
    const closeBtn = document.getElementById('dbModalClose');
    const cancelBtn = document.getElementById('dbModalCancel');
    const confirmBtn = document.getElementById('dbModalConfirm');
    const titleEl = document.getElementById('dbModalTitle');
    const fbFields = document.getElementById('modalFirebaseFields');
    const errorEl = document.getElementById('modalSwitchError');

    if (!switchBtn) return; // Settings page not loaded yet

    function openModal() {
        const target = currentDbBackend === 'local' ? 'firebase' : 'local';
        if (titleEl) titleEl.textContent = `Switch to ${target === 'firebase' ? 'Firebase Firestore' : 'Local File'}`;
        if (fbFields) fbFields.classList.toggle('hidden', target !== 'firebase');
        if (errorEl) errorEl.classList.add('hidden');
        if (modal) modal.classList.remove('hidden');
    }

    function closeModal() {
        if (modal) modal.classList.add('hidden');
        // Clear Firebase fields
        ['mfb-apiKey', 'mfb-authDomain', 'mfb-projectId', 'mfb-storageBucket', 'mfb-messagingSenderId', 'mfb-appId'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
    }

    if (switchBtn) switchBtn.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // Paste Firebase Config JSON button (same logic as setup wizard)
    const pasteBtn = document.getElementById('modalPasteJsonBtn');
    if (pasteBtn) pasteBtn.addEventListener('click', async () => {
        try {
            let text = '';
            if (navigator.clipboard && navigator.clipboard.readText) {
                text = await navigator.clipboard.readText();
            } else {
                text = prompt('Paste your Firebase config JSON here:') || '';
            }
            if (!text) return;

            let config = null;
            try {
                config = JSON.parse(text);
            } catch {
                const extract = (key) => {
                    const regex = new RegExp(`(?:[\"']?${key}[\"']?\\s*:\\s*)([\"'])(.*?)\\1`);
                    const match = text.match(regex);
                    return match ? match[2] : null;
                };
                const extracted = {
                    apiKey: extract('apiKey'),
                    authDomain: extract('authDomain'),
                    projectId: extract('projectId'),
                    storageBucket: extract('storageBucket'),
                    messagingSenderId: extract('messagingSenderId'),
                    appId: extract('appId'),
                };
                if (extracted.apiKey) config = extracted;
            }

            if (config) {
                const fieldMap = {
                    apiKey: 'mfb-apiKey',
                    authDomain: 'mfb-authDomain',
                    projectId: 'mfb-projectId',
                    storageBucket: 'mfb-storageBucket',
                    messagingSenderId: 'mfb-messagingSenderId',
                    appId: 'mfb-appId',
                };
                Object.entries(fieldMap).forEach(([key, inputId]) => {
                    if (config[key]) {
                        const el = document.getElementById(inputId);
                        if (el) el.value = config[key];
                    }
                });
                if (errorEl) errorEl.classList.add('hidden');
            } else {
                if (errorEl) { errorEl.textContent = 'Could not parse Firebase config. Paste a valid JSON object.'; errorEl.classList.remove('hidden'); }
            }
        } catch {
            if (errorEl) { errorEl.textContent = 'Clipboard access denied. Paste the config manually.'; errorEl.classList.remove('hidden'); }
        }
    });

    if (confirmBtn) confirmBtn.addEventListener('click', async () => {
        const target = currentDbBackend === 'local' ? 'firebase' : 'local';

        let body = { to: target };
        if (target === 'firebase') {
            const fields = ['mfb-apiKey', 'mfb-authDomain', 'mfb-projectId', 'mfb-storageBucket', 'mfb-messagingSenderId', 'mfb-appId'];
            const missing = fields.filter(id => !document.getElementById(id)?.value.trim());
            if (missing.length) {
                if (errorEl) { errorEl.textContent = 'Please fill in all Firebase fields.'; errorEl.classList.remove('hidden'); }
                return;
            }
            body.firebase = {
                apiKey: document.getElementById('mfb-apiKey').value.trim(),
                authDomain: document.getElementById('mfb-authDomain').value.trim(),
                projectId: document.getElementById('mfb-projectId').value.trim(),
                storageBucket: document.getElementById('mfb-storageBucket').value.trim(),
                messagingSenderId: document.getElementById('mfb-messagingSenderId').value.trim(),
                appId: document.getElementById('mfb-appId').value.trim(),
            };
        }

        const originalContent = confirmBtn.innerHTML;
        confirmBtn.innerHTML = '<span class="btn-spinner"></span> Switching...';
        confirmBtn.disabled = true;
        if (errorEl) errorEl.classList.add('hidden');

        try {
            const res = await fetch('/api/admin/db-switch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            const data = await res.json();
            if (!res.ok) {
                if (errorEl) { errorEl.textContent = data.error || 'Switch failed.'; errorEl.classList.remove('hidden'); }
                confirmBtn.innerHTML = originalContent;
                confirmBtn.disabled = false;
                return;
            }

            closeModal();
            currentDbBackend = target;
            // Invalidate all cache
            isDataCached = { stats: false, accounts: false, logs: false, keys: false };
            loadSettings();

            // Show success note
            const note = document.getElementById('dbBackendNote');
            if (note) note.innerHTML = `<div class="db-note db-note-success">✅ Switched successfully. ${data.migrated?.accounts ?? 0} accounts and ${data.migrated?.logs ?? 0} logs migrated. <strong>Please regenerate your API keys.</strong></div>`;

        } catch (e) {
            if (errorEl) { errorEl.textContent = 'Network error. Please try again.'; errorEl.classList.remove('hidden'); }
            confirmBtn.innerHTML = originalContent;
            confirmBtn.disabled = false;
        }
    });
});

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

        let emailHtml = acc.email;
        if (acc.isPro) {
            emailHtml += ' <span class="badge badge-pro" style="margin-left: 6px; font-family: var(--font); cursor: help;" title="Google AI Pro / Advanced Tier">PRO</span>';
        }
        emailTd.innerHTML = emailHtml;

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

        accountsAllData = await response.json();
        isDataCached.accounts = true;
        accountsRendered = 0;
        accountsBody.innerHTML = '';

        if (accountsAllData.length === 0) {
            accountsBody.innerHTML = '<tr><td colspan="5" class="table-empty">No accounts connected yet.</td></tr>';
            accountsHasMore = false;
            return;
        }

        accountsHasMore = true;
        renderAccountsBatch();
    } catch (e) {
        console.error(e);
        accountsBody.innerHTML = '<tr><td colspan="5" class="table-empty" style="color:var(--red)">Failed to load accounts.</td></tr>';
    }
}

function renderAccountsBatch() {
    if (!accountsHasMore) return;
    const start = accountsRendered;
    const end = Math.min(start + LAZY_BATCH_SIZE, accountsAllData.length);

    // Remove existing loader row
    const existingLoader = accountsBody.querySelector('.lazy-loader-row');
    if (existingLoader) existingLoader.remove();

    for (let i = start; i < end; i++) {
        const acc = accountsAllData[i];
        const row = document.createElement('tr');
        row.className = 'lazy-fade-in';

        const emailCell = document.createElement('td');
        emailCell.className = 'cell-email';

        let emailHtml = acc.email;
        if (acc.isPro) {
            emailHtml += ' <span class="badge badge-pro" style="margin-left: 6px; font-family: var(--font); cursor: help;" title="Google AI Pro / Advanced Tier">PRO</span>';
        }
        emailCell.innerHTML = emailHtml;

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
    }

    accountsRendered = end;
    accountsHasMore = accountsRendered < accountsAllData.length;

    if (accountsHasMore) {
        const loaderRow = document.createElement('tr');
        loaderRow.className = 'lazy-loader-row';
        loaderRow.innerHTML = '<td colspan="5" class="table-loader"><div class="lazy-spinner"></div> Loading more...</td>';
        accountsBody.appendChild(loaderRow);
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
        const res = await fetch('/api/logs?limit=500');
        if (res.status === 401) { showLogin(); return; }
        logsAllData = await res.json();
        isDataCached.logs = true;
        logsRendered = 0;
        logsBody.innerHTML = '';

        if (logsAllData.length === 0) {
            logsBody.innerHTML = '<tr><td colspan="5" class="table-empty">No request logs yet. Logs will appear after API requests are made.</td></tr>';
            logsHasMore = false;
            return;
        }

        logsHasMore = true;
        renderLogsBatch();
    } catch (e) {
        console.error('Failed to load logs:', e);
        logsBody.innerHTML = '<tr><td colspan="5" class="table-empty" style="color:var(--red)">Failed to load logs.</td></tr>';
    }
}

function renderLogsBatch() {
    if (!logsHasMore) return;
    const start = logsRendered;
    const end = Math.min(start + LAZY_BATCH_SIZE, logsAllData.length);

    // Remove existing loader row
    const existingLoader = logsBody.querySelector('.lazy-loader-row');
    if (existingLoader) existingLoader.remove();

    for (let i = start; i < end; i++) {
        const log = logsAllData[i];
        const row = document.createElement('tr');
        row.className = 'lazy-fade-in';

        const isTask = log.question && (
            log.question.includes('[TASK RESUMPTION]') ||
            log.question.includes('<task>') ||
            log.question.includes('toolConfig') ||
            (log.question === 'Unknown' && log.answer && log.answer.includes('**'))
        );

        const timeTd = document.createElement('td');
        timeTd.className = 'cell-time';
        timeTd.textContent = formatTime(log.timestamp);

        const emailTd = document.createElement('td');
        emailTd.className = 'cell-email';

        let emailHtml = log.accountEmail;
        if (isTask) {
            emailHtml += ' <span class="badge badge-task" style="margin-left: 6px;" title="This request appears to be an automated agent task">Task</span>';
        }
        emailTd.innerHTML = emailHtml;

        const questionTd = document.createElement('td');
        questionTd.className = 'cell-truncate';
        if (isTask) {
            questionTd.style.fontFamily = 'var(--font)';
            questionTd.style.color = 'var(--accent)';
            questionTd.style.fontWeight = '600';
            questionTd.textContent = 'Automated Agent Task';
        } else {
            questionTd.textContent = log.question || '—';
            questionTd.title = log.question || '';
        }

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
        row.addEventListener('click', () => showLogDetail(log));
        logsBody.appendChild(row);
    }

    logsRendered = end;
    logsHasMore = logsRendered < logsAllData.length;

    if (logsHasMore) {
        const loaderRow = document.createElement('tr');
        loaderRow.className = 'lazy-loader-row';
        loaderRow.innerHTML = '<td colspan="5" class="table-loader"><div class="lazy-spinner"></div> Loading more...</td>';
        logsBody.appendChild(loaderRow);
    }
}

function showLogDetail(log) {
    const modal = document.getElementById('logDetailModal');
    const body = document.getElementById('logDetailBody');
    if (!modal || !body) return;

    // Format full timestamp
    let fullTime = '—';
    try {
        const d = new Date(log.timestamp);
        fullTime = d.toLocaleString('en-US', {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
    } catch { }

    const statusBadge = log.success
        ? '<span class="badge badge-active">Success</span>'
        : '<span class="badge badge-inactive">Error</span>';

    const isTask = log.question && (
        log.question.includes('[TASK RESUMPTION]') ||
        log.question.includes('<task>') ||
        log.question.includes('toolConfig') ||
        (log.question === 'Unknown' && log.answer && log.answer.includes('**'))
    );

    const taskBadge = isTask ? '<span class="badge badge-task" style="margin-left: 8px;">Agent Task</span>' : '';

    const renderText = (text) => {
        if (!text) return '—';
        return escapeHtml(text);
    };

    body.innerHTML = `
        <div class="log-detail-grid">
            <div class="log-detail-item">
                <span class="log-detail-label">Time</span>
                <span class="log-detail-value">${fullTime}${taskBadge}</span>
            </div>
            <div class="log-detail-item">
                <span class="log-detail-label">Account</span>
                <span class="log-detail-value" style="font-family:'SF Mono',monospace;font-size:13px;">${log.accountEmail || '—'}</span>
            </div>
            <div class="log-detail-item">
                <span class="log-detail-label">Status</span>
                <span class="log-detail-value">${statusBadge}</span>
            </div>
            <div class="log-detail-item">
                <span class="log-detail-label">Tokens Used</span>
                <span class="log-detail-value">${formatNumber(log.tokensUsed || 0)}</span>
            </div>
        </div>
        <div class="log-detail-section">
            <div class="log-detail-section-title">Question</div>
            <div class="log-detail-text">${renderText(log.question)}</div>
        </div>
        <div class="log-detail-section">
            <div class="log-detail-section-title">Answer</div>
            <div class="log-detail-text">${renderText(log.answer)}</div>
        </div>
    `;

    modal.classList.remove('hidden');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Log detail modal close handlers
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('logDetailModal');
    const closeBtn = document.getElementById('logDetailClose');

    if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
            modal.classList.add('hidden');
        }
    });
});

// ===== API KEYS =====

async function loadApiKeys(force = false) {
    if (!keysBody) return;
    if (!force && isDataCached.keys) return;
    keysBody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading API keys...</td></tr>';
    try {
        const res = await fetch('/api/keys');
        if (res.status === 401) { showLogin(); return; }
        keysAllData = await res.json();
        isDataCached.keys = true;
        keysRendered = 0;
        keysBody.innerHTML = '';

        if (keysAllData.length === 0) {
            keysBody.innerHTML = '<tr><td colspan="5" class="table-empty">No API keys yet. Create one to get started.</td></tr>';
            keysHasMore = false;
            return;
        }

        keysHasMore = true;
        renderKeysBatch();
    } catch (e) {
        console.error('Failed to load keys:', e);
        keysBody.innerHTML = '<tr><td colspan="5" class="table-empty" style="color:var(--red)">Failed to load API keys.</td></tr>';
    }
}

function renderKeysBatch() {
    if (!keysHasMore) return;
    const start = keysRendered;
    const end = Math.min(start + LAZY_BATCH_SIZE, keysAllData.length);

    // Remove existing loader row
    const existingLoader = keysBody.querySelector('.lazy-loader-row');
    if (existingLoader) existingLoader.remove();

    for (let i = start; i < end; i++) {
        const k = keysAllData[i];
        const row = document.createElement('tr');
        row.className = 'lazy-fade-in';

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
    }

    keysRendered = end;
    keysHasMore = keysRendered < keysAllData.length;

    if (keysHasMore) {
        const loaderRow = document.createElement('tr');
        loaderRow.className = 'lazy-loader-row';
        loaderRow.innerHTML = '<td colspan="5" class="table-loader"><div class="lazy-spinner"></div> Loading more...</td>';
        keysBody.appendChild(loaderRow);
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
    // Scope tabs to their parent section so each tab group works independently
    const tabGroups = document.querySelectorAll('.code-tabs');

    tabGroups.forEach(group => {
        const section = group.closest('.doc-section') || group.closest('.card');
        if (!section) return;

        const tabs = group.querySelectorAll('.code-tab');
        const panels = section.querySelectorAll('.code-panel');

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                panels.forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                const lang = tab.dataset.lang;
                const panel = section.querySelector(`.code-panel[data-lang="${lang}"]`);
                if (panel) panel.classList.add('active');
            });
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
            responseContent.style.color = res.ok ? 'var(--text-primary)' : 'var(--red)';

        } catch (error) {
            loadingEl.classList.add('hidden');
            responseContent.textContent = `Error: ${error.message}`;
            responseContent.style.color = 'var(--red)';
        } finally {
            sendBtn.disabled = false;
        }
    });
}

// ===== AI CHAT =====

let chatHistory = []; // Multi-turn conversation array
let chatInitialized = false;

function initChat() {
    // Focus the input when navigating to chat
    const input = document.getElementById('chatInput');
    if (input) setTimeout(() => input.focus(), 100);
}

function setupChat() {
    const sendBtn = document.getElementById('chatSendBtn');
    const input = document.getElementById('chatInput');
    const newChatBtn = document.getElementById('newChatBtn');

    if (!sendBtn || !input) return;

    // Send on button click
    sendBtn.addEventListener('click', sendChatMessage);

    // Send on Enter (Shift+Enter for newline)
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });

    // Auto-grow textarea
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 150) + 'px';
    });

    // New Chat button
    if (newChatBtn) {
        newChatBtn.addEventListener('click', () => {
            chatHistory = [];
            const messagesEl = document.getElementById('chatMessages');
            if (messagesEl) {
                messagesEl.innerHTML = `
                    <div class="chat-welcome" id="chatWelcome">
                        <div class="chat-welcome-logo">
                            <img src="/icons/gemini.png" alt="Gemini" width="52" height="52" style="object-fit: contain;">
                        </div>
                        <h2>How can I help you today?</h2>
                        <p>Choose a model above and start chatting with Gemini AI through your OpenGem gateway.</p>
                        <div class="chat-suggestions">
                            <button class="chat-suggestion-chip" data-prompt="Explain how OpenGem proxies Gemini API requests.">How does OpenGem work?</button>
                            <button class="chat-suggestion-chip" data-prompt="Write a short Python script that calls the Gemini API.">Python API example</button>
                            <button class="chat-suggestion-chip" data-prompt="What are the differences between Gemini 3 Pro and Gemini 2.5 Pro?">Compare Gemini models</button>
                            <button class="chat-suggestion-chip" data-prompt="Show me how to use streaming with the Gemini API.">Streaming example</button>
                        </div>
                    </div>
                `;
            }
            if (input) {
                input.value = '';
                input.style.height = 'auto';
                input.focus();
            }
        });
    }

    // Suggestion chip clicks (delegated from messages area)
    const messagesArea = document.getElementById('chatMessages');
    if (messagesArea) {
        messagesArea.addEventListener('click', (e) => {
            const chip = e.target.closest('.chat-suggestion-chip');
            if (!chip) return;
            const prompt = chip.dataset.prompt;
            if (prompt && input) {
                input.value = prompt;
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 150) + 'px';
                input.focus();
                sendChatMessage();
            }
        });
    }

    chatInitialized = true;
}

async function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSendBtn');
    const messagesEl = document.getElementById('chatMessages');
    const modelSelect = document.getElementById('chatModelSelect');
    const welcomeEl = document.getElementById('chatWelcome');

    if (!input || !messagesEl) return;

    const message = input.value.trim();
    if (!message) return;

    const model = modelSelect ? modelSelect.value : 'gemini-3-pro-preview';

    // Hide welcome screen
    if (welcomeEl) welcomeEl.remove();

    // Add user message to chat history
    chatHistory.push({
        role: 'user',
        parts: [{ text: message }]
    });

    // Render user bubble
    const userBubble = document.createElement('div');
    userBubble.className = 'chat-bubble chat-bubble-user';
    userBubble.textContent = message;
    messagesEl.appendChild(userBubble);

    // Clear input
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;

    // Add typing indicator
    const typingEl = document.createElement('div');
    typingEl.className = 'chat-bubble chat-bubble-assistant';
    typingEl.style.display = 'flex';
    typingEl.style.gap = '16px';
    typingEl.style.alignItems = 'flex-start';

    const typingAvatar = document.createElement('div');
    typingAvatar.style.width = '28px';
    typingAvatar.style.height = '28px';
    typingAvatar.style.borderRadius = '50%';
    typingAvatar.style.display = 'flex';
    typingAvatar.style.alignItems = 'center';
    typingAvatar.style.justifyContent = 'center';
    typingAvatar.style.flexShrink = '0';
    typingAvatar.style.marginTop = '2px';
    typingAvatar.innerHTML = `<img src="/icons/gemini.png" width="28" height="28" style="border-radius:50%; object-fit:cover;">`;

    const typingDots = document.createElement('div');
    typingDots.style.display = 'flex';
    typingDots.style.alignItems = 'center';
    typingDots.style.gap = '4px';
    typingDots.style.marginTop = '12px';
    typingDots.innerHTML = '<div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div>';

    typingEl.appendChild(typingAvatar);
    typingEl.appendChild(typingDots);
    messagesEl.appendChild(typingEl);

    // Scroll to bottom
    messagesEl.scrollTop = messagesEl.scrollHeight;

    try {
        const res = await fetch('/api/admin/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: model,
                contents: chatHistory,
                generationConfig: {
                    thinkingConfig: {
                        includeThoughts: true
                    }
                },
                systemInstruction: {
                    parts: [{
                        text: `You are an AI assistant running inside OpenGem — an open-source, self-hosted reverse proxy gateway for the Google Gemini API.

Key facts about OpenGem:
- OpenGem lets users access the Gemini API for free by rotating multiple Google OAuth accounts.
- It acts as a drop-in replacement for the official Gemini API endpoint. Developers can point their apps to an OpenGem server instead of Google's API.
- Built with Node.js, Express, and TypeScript on the backend; vanilla HTML/CSS/JS on the frontend.
- Supports both Firebase Realtime Database and a local JSON database as storage backends.
- Features: multi-account rotation with automatic failover, API key management, request logging, admin dashboard, streaming (SSE) support, model fallback (primary model → fallback on 429 errors), and automatic account reactivation after cooldown.
- Supported models include Gemini 3 Pro Preview, Gemini 3.1 Pro Preview, Gemini 2.5 Flash, and others.
- The admin dashboard (where this chat lives) provides an overview of usage stats, account management, API key management, request logs, documentation, and this AI chat interface.
- The project is hosted on GitHub and designed for educational & personal use.

You are helpful, concise, and knowledgeable. When users ask about OpenGem, answer accurately using the facts above. For general questions, respond naturally as a capable AI assistant. Use Markdown formatting for clarity.`
                    }]
                }
            })
        });

        if (res.status === 401) {
            showLogin();
            return;
        }

        // Render assistant bubble skeleton
        const assistantBubble = document.createElement('div');
        assistantBubble.className = 'chat-bubble chat-bubble-assistant';
        assistantBubble.style.display = 'flex';
        assistantBubble.style.gap = '16px';
        assistantBubble.style.alignItems = 'flex-start';

        const avatar = document.createElement('div');
        avatar.style.width = '28px';
        avatar.style.height = '28px';
        avatar.style.borderRadius = '50%';
        avatar.style.display = 'flex';
        avatar.style.alignItems = 'center';
        avatar.style.justifyContent = 'center';
        avatar.style.flexShrink = '0';
        avatar.style.marginTop = '2px';
        avatar.innerHTML = `<img src="/icons/gemini.png" width="28" height="28" style="border-radius:50%; object-fit:cover;">`;

        const content = document.createElement('div');
        content.style.flex = '1';
        content.style.minWidth = '0'; // Prevent text overflow
        content.innerHTML = ''; // Start empty

        assistantBubble.appendChild(avatar);
        assistantBubble.appendChild(content);
        messagesEl.appendChild(assistantBubble);

        let thoughtText = '';
        let thoughtContainer = null;
        let thoughtContent = null;

        // Read SSE stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let fullResponseText = '';
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process lines
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);

                if (line.startsWith('data: ')) {
                    const dataStr = line.slice(6);
                    if (dataStr === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(dataStr);
                        if (parsed.error) {
                            throw new Error(parsed.error.message);
                        }
                        const candidates = parsed.candidates || parsed.response?.candidates;
                        if (candidates?.[0]?.content?.parts) {
                            let chunkText = '';
                            let chunkThought = '';

                            for (const part of candidates[0].content.parts) {
                                if (part.thought === true) {
                                    // Gemini 3 Flash returns thought as a boolean and the content in text
                                    if (part.text) chunkThought += part.text;
                                } else if (typeof part.thought === 'string') {
                                    // Older Gemini 2.0 format
                                    chunkThought += part.thought;
                                } else {
                                    // Normal text output
                                    if (part.text) chunkText += part.text;
                                }
                            }

                            // Handle thoughts
                            if (chunkThought) {
                                // If we don't have a container yet, create it
                                if (!thoughtContainer) {
                                    if (typingEl && typingEl.parentNode) typingEl.remove();

                                    thoughtContainer = document.createElement('details');
                                    thoughtContainer.className = 'chat-thought-container';

                                    const summary = document.createElement('summary');
                                    summary.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg> Thinking...';

                                    thoughtContent = document.createElement('div');
                                    thoughtContent.className = 'chat-thought-content';

                                    thoughtContainer.appendChild(summary);
                                    thoughtContainer.appendChild(thoughtContent);
                                    content.appendChild(thoughtContainer);

                                    // Make details open by default while streaming
                                    thoughtContainer.open = true;
                                }

                                thoughtText += chunkThought;
                                thoughtContent.innerHTML = marked.parse(thoughtText);
                                // Auto scroll thought box if open
                                if (thoughtContainer.open) {
                                    thoughtContent.scrollTop = thoughtContent.scrollHeight;
                                }
                                messagesEl.scrollTop = messagesEl.scrollHeight;
                            }

                            // Handle standard text
                            if (chunkText) {
                                if (typingEl && typingEl.parentNode) {
                                    typingEl.remove();
                                }
                                // Auto-collapse thought container once real text starts arriving
                                if (thoughtContainer && thoughtContainer.open) {
                                    thoughtContainer.open = false;
                                }

                                fullResponseText += chunkText;

                                // If we don't have a dedicated text container yet, create it
                                let textContainer = content.querySelector('.chat-text-container');
                                if (!textContainer) {
                                    textContainer = document.createElement('div');
                                    textContainer.className = 'chat-text-container';
                                    content.appendChild(textContainer);
                                }

                                textContainer.innerHTML = marked.parse(fullResponseText); // Use marked to parse markdown
                                messagesEl.scrollTop = messagesEl.scrollHeight;
                            }
                        }
                    } catch (e) {
                        // ignore parse error for incomplete chunks
                    }
                }
            }
        }

        // Update thought summary label once streaming is done
        if (thoughtContainer) {
            const summaryEl = thoughtContainer.querySelector('summary');
            if (summaryEl) {
                const wordCount = thoughtText.split(/\s+/).filter(Boolean).length;
                summaryEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path></svg> Thinking Process <span style="font-weight:400;opacity:0.65;margin-left:4px;">(~${wordCount} words)</span>`;
            }
        }

        // Add assistant response to history
        chatHistory.push({
            role: 'model',
            parts: [{ text: fullResponseText }]
        });

        // Add action bar
        const actionBar = document.createElement('div');
        actionBar.className = 'chat-action-bar';

        const btnCopy = document.createElement('button');
        btnCopy.className = 'chat-action-btn';
        btnCopy.title = 'Copy';
        btnCopy.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
        btnCopy.onclick = () => {
            navigator.clipboard.writeText(fullResponseText);
            const originalSvg = btnCopy.innerHTML;
            btnCopy.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
            setTimeout(() => btnCopy.innerHTML = originalSvg, 2000);
        };

        const btnReload = document.createElement('button');
        btnReload.className = 'chat-action-btn';
        btnReload.title = 'Regenerate';
        btnReload.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;
        btnReload.onclick = () => {
            // Remove the last model response from history
            if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'model') {
                chatHistory.pop();
            }
            // Remove the assistant bubble (the parent of this action bar)
            if (assistantBubble && assistantBubble.parentNode) {
                assistantBubble.remove();
            }
            // Re-send: get the last user message from history
            if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'user') {
                const lastUserMsg = chatHistory[chatHistory.length - 1].parts[0].text;
                // Remove user msg from history too since sendChatMessage will re-add it
                chatHistory.pop();
                const input = document.getElementById('chatInput');
                if (input) {
                    input.value = lastUserMsg;
                    sendChatMessage();
                }
            }
        };

        // Model ID label
        const modelLabel = document.createElement('span');
        modelLabel.className = 'chat-model-label';
        modelLabel.textContent = model;

        actionBar.appendChild(btnCopy);
        actionBar.appendChild(btnReload);
        actionBar.appendChild(modelLabel);

        content.appendChild(actionBar);

    } catch (error) {
        typingEl.remove();
        const errorBubble = document.createElement('div');
        errorBubble.className = 'chat-bubble-error';
        errorBubble.textContent = `Network error: ${error.message}`;
        messagesEl.appendChild(errorBubble);

        // Remove the failed user message from history
        chatHistory.pop();
    } finally {
        if (typingEl && typingEl.parentNode) {
            typingEl.remove();
        }
        sendBtn.disabled = false;
        input.focus();
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
