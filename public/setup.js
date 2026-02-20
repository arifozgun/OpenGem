// ===== Setup Wizard Logic =====

document.addEventListener('DOMContentLoaded', async () => {
    // Check if already configured
    try {
        const res = await fetch('/api/setup/status');
        const data = await res.json();
        if (data.configured) {
            window.location.href = '/';
            return;
        }
    } catch (e) {
        // Continue with setup
    }

    // Elements
    const steps = document.querySelectorAll('.step');
    const stepLines = document.querySelectorAll('.step-line');
    const stepContents = document.querySelectorAll('.step-content');
    const errorEl = document.getElementById('setupError');

    let currentStep = 1;
    let selectedBackend = 'local'; // default

    // --- Backend Selector ---
    document.querySelectorAll('.backend-card').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('.backend-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            selectedBackend = card.dataset.backend;
        });
    });

    // Set default 'local' as selected on load
    document.getElementById('backendLocal').classList.add('selected');

    function showStep(step) {
        currentStep = step;

        steps.forEach((s, i) => {
            const stepNum = i + 1;
            s.classList.remove('active', 'completed');
            if (stepNum === step) s.classList.add('active');
            else if (stepNum < step) s.classList.add('completed');
        });

        stepLines.forEach((line, i) => {
            line.classList.toggle('active', i < step - 1);
        });

        stepContents.forEach(content => {
            content.classList.remove('active');
        });
        document.getElementById(`step-${step}`).classList.add('active');

        // Update step 2 label
        document.getElementById('step2Label').textContent = selectedBackend === 'firebase' ? 'Firebase' : 'Local DB';

        errorEl.classList.add('hidden');
    }

    function showError(msg) {
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
        errorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // --- Step 1 → 2 ---
    document.getElementById('nextToStep2').addEventListener('click', () => {
        // Update step 2 visuals based on selected backend
        const step2Firebase = document.getElementById('step2Firebase');
        const step2Local = document.getElementById('step2Local');

        if (selectedBackend === 'firebase') {
            step2Firebase.classList.remove('hidden');
            step2Local.classList.add('hidden');
        } else {
            step2Firebase.classList.add('hidden');
            step2Local.classList.remove('hidden');
        }

        showStep(2);
    });

    // --- Step 2 Firebase → 3 ---
    document.getElementById('nextToStep3').addEventListener('click', () => {
        const fields = ['fb-apiKey', 'fb-authDomain', 'fb-projectId', 'fb-storageBucket', 'fb-messagingSenderId', 'fb-appId'];
        const missing = fields.filter(id => !document.getElementById(id).value.trim());

        if (missing.length > 0) {
            showError('Please fill in all required Firebase fields.');
            document.getElementById(missing[0]).focus();
            return;
        }
        showStep(3);
    });

    // --- Step 2 Local → 3 ---
    document.getElementById('nextToStep3Local').addEventListener('click', () => {
        showStep(3);
    });

    // --- Back buttons ---
    document.getElementById('backToStep1').addEventListener('click', () => showStep(1));
    document.getElementById('backToStep1Local').addEventListener('click', () => showStep(1));
    document.getElementById('backToStep2').addEventListener('click', () => showStep(2));

    // Paste Firebase JSON config
    document.getElementById('pasteJsonBtn').addEventListener('click', async () => {
        try {
            let text = '';
            if (navigator.clipboard && navigator.clipboard.readText) {
                text = await navigator.clipboard.readText();
            } else {
                text = prompt('Paste your Firebase config JSON here:');
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
                    measurementId: extract('measurementId')
                };

                if (extracted.apiKey) {
                    config = extracted;
                }
            }

            if (config) {
                const fieldMap = {
                    'apiKey': 'fb-apiKey',
                    'authDomain': 'fb-authDomain',
                    'projectId': 'fb-projectId',
                    'storageBucket': 'fb-storageBucket',
                    'messagingSenderId': 'fb-messagingSenderId',
                    'appId': 'fb-appId',
                    'measurementId': 'fb-measurementId'
                };

                Object.entries(fieldMap).forEach(([key, inputId]) => {
                    if (config[key]) {
                        document.getElementById(inputId).value = config[key];
                    }
                });

                errorEl.classList.add('hidden');
            } else {
                showError('Could not parse Firebase config. Please paste a valid JSON object.');
            }
        } catch (err) {
            showError('Failed to read clipboard. Please paste the config manually.');
        }
    });

    // Complete Setup
    document.getElementById('completeSetup').addEventListener('click', async () => {
        const username = document.getElementById('admin-username').value.trim();
        const password = document.getElementById('admin-password').value;
        const confirmPassword = document.getElementById('admin-password-confirm').value;

        if (!username) {
            showError('Please enter an admin username.');
            return;
        }

        if (!password || password.length < 8) {
            showError('Password must be at least 8 characters.');
            return;
        }

        if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
            showError('Password must contain at least one uppercase letter, one lowercase letter, and one digit.');
            return;
        }

        if (password !== confirmPassword) {
            showError('Passwords do not match.');
            return;
        }

        const btn = document.getElementById('completeSetup');
        const originalContent = btn.innerHTML;
        btn.innerHTML = '<span class="spinner"></span> Setting up...';
        btn.disabled = true;

        try {
            const body = {
                dbBackend: selectedBackend,
                admin: { username, password }
            };

            if (selectedBackend === 'firebase') {
                body.firebase = {
                    apiKey: document.getElementById('fb-apiKey').value.trim(),
                    authDomain: document.getElementById('fb-authDomain').value.trim(),
                    projectId: document.getElementById('fb-projectId').value.trim(),
                    storageBucket: document.getElementById('fb-storageBucket').value.trim(),
                    messagingSenderId: document.getElementById('fb-messagingSenderId').value.trim(),
                    appId: document.getElementById('fb-appId').value.trim(),
                    measurementId: document.getElementById('fb-measurementId').value.trim(),
                };
            }

            const res = await fetch('/api/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Setup failed.');
                btn.innerHTML = originalContent;
                btn.disabled = false;
                return;
            }

            showStep(4);

        } catch (err) {
            showError('Network error. Please try again.');
            btn.innerHTML = originalContent;
            btn.disabled = false;
        }
    });
});
