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

    function showStep(step) {
        currentStep = step;

        // Update step indicators
        steps.forEach((s, i) => {
            const stepNum = i + 1;
            s.classList.remove('active', 'completed');
            if (stepNum === step) s.classList.add('active');
            else if (stepNum < step) s.classList.add('completed');
        });

        // Update connecting lines
        stepLines.forEach((line, i) => {
            line.classList.toggle('active', i < step - 1);
        });

        // Show relevant content
        stepContents.forEach(content => {
            content.classList.remove('active');
        });
        document.getElementById(`step-${step}`).classList.add('active');

        // Hide errors
        errorEl.classList.add('hidden');
    }

    function showError(msg) {
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
    }

    // Step 1 → 2
    document.getElementById('nextToStep2').addEventListener('click', () => {
        const fields = ['fb-apiKey', 'fb-authDomain', 'fb-projectId', 'fb-storageBucket', 'fb-messagingSenderId', 'fb-appId'];
        const missing = fields.filter(id => !document.getElementById(id).value.trim());

        if (missing.length > 0) {
            showError('Please fill in all required Firebase fields.');
            document.getElementById(missing[0]).focus();
            return;
        }

        showStep(2);
    });

    // Step 2 → 1
    document.getElementById('backToStep1').addEventListener('click', () => {
        showStep(1);
    });

    // Paste Firebase JSON config
    document.getElementById('pasteJsonBtn').addEventListener('click', async () => {
        try {
            let text = '';
            // Try clipboard first
            if (navigator.clipboard && navigator.clipboard.readText) {
                text = await navigator.clipboard.readText();
            } else {
                text = prompt('Paste your Firebase config JSON here:');
            }

            if (!text) return;

            // Handle both `const firebaseConfig = {...}` and raw JSON/HTML snippets
            let config = null;
            try {
                // Try raw JSON parse
                config = JSON.parse(text);
            } catch {
                // Extract fields using Regex to support any JS/HTML format
                const extract = (key) => {
                    // Matches key: "value", "key": "value", or 'key': 'value'
                    const regex = new RegExp(`(?:["']?${key}["']?\\s*:\\s*)(["'])(.*?)\\1`);
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

                // If we found at least an apiKey, consider it a valid config extraction
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

                showError('');
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
            const res = await fetch('/api/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firebase: {
                        apiKey: document.getElementById('fb-apiKey').value.trim(),
                        authDomain: document.getElementById('fb-authDomain').value.trim(),
                        projectId: document.getElementById('fb-projectId').value.trim(),
                        storageBucket: document.getElementById('fb-storageBucket').value.trim(),
                        messagingSenderId: document.getElementById('fb-messagingSenderId').value.trim(),
                        appId: document.getElementById('fb-appId').value.trim(),
                        measurementId: document.getElementById('fb-measurementId').value.trim(),
                    },
                    admin: {
                        username,
                        password,
                    }
                })
            });

            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Setup failed.');
                btn.innerHTML = originalContent;
                btn.disabled = false;
                return;
            }

            // Show success
            showStep(3);

        } catch (err) {
            showError('Network error. Please try again.');
            btn.innerHTML = originalContent;
            btn.disabled = false;
        }
    });

    // Copy API Key
    document.getElementById('copyKeyBtn').addEventListener('click', () => {
        const key = document.getElementById('generatedApiKey').textContent;
        navigator.clipboard.writeText(key).then(() => {
            const btn = document.getElementById('copyKeyBtn');
            btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
            setTimeout(() => {
                btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
            }, 2000);
        });
    });
});
