let editor;
let snippetEditor;
let currentFile = null;

// Declare modal elements (will be validated before use)
const snippetModal = document.getElementById('snippet-modal');
const modalTitle = document.getElementById('modal-title');

// Monaco Configuration
require.config({ paths: { 'vs': './node_modules/monaco-editor/min/vs' }});

require(['vs/editor/editor.main'], async function() {

    // --- 1. Fetch Keywords Async ---
    let nginxKeywords = [];
    try {
        nginxKeywords = await window.api.getNginxKeywords();
    } catch (e) {
        console.error("Failed to load keywords", e);
        // Fallback default keywords if file fails
        nginxKeywords = ['server', 'listen', 'location']; 
    }

    // --- 2. Register Custom Language (Nginx) ---
    monaco.languages.register({ id: 'nginx-custom' });

    monaco.languages.setMonarchTokensProvider('nginx-custom', {
        // Use the loaded keywords
        keywords: nginxKeywords,

        tokenizer: {
            root: [
                [/#.*/, 'comment'],
                [/[{}]/, 'delimiter.bracket'],
                [/[a-zA-Z_]\w*(?=[\s\t])/, {
                    cases: {
                        '@keywords': 'keyword',
                        '@default': 'identifier'
                    }
                }],
                [/[a-zA-Z_]\w*/, 'identifier'],
                [/\s+/, 'white']
            ]
        }
    });

    monaco.editor.defineTheme('nginx-theme', {
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: 'comment', foreground: '777777' },           
            { token: 'keyword', foreground: '8888ee' },           
            { token: 'delimiter.bracket', foreground: '22cc22' }  
        ],
        colors: { 'editor.background': '#1e1e1e' }
    });

    // Main Editor
    editor = monaco.editor.create(document.getElementById('editor-container'), {
        value: '# Select a config to edit',
        language: 'nginx-custom',
        theme: 'nginx-theme',
        automaticLayout: true,
        minimap: { enabled: false }
    });

    editor.onDidChangeModelContent(() => {
        if (currentFile) {
            document.getElementById('editor-container').style.borderTopColor = 'orange';
        }
    });

    // Snippet Editor (Read-Only)
    snippetEditor = monaco.editor.create(document.getElementById('snippet-editor-container'), {
        value: '',
        language: 'nginx-custom',
        theme: 'nginx-theme',
        automaticLayout: true,
        readOnly: true,
        minimap: { enabled: false },       // No minimap
        scrollBeyondLastLine: false,       // Prevent scrolling into empty space
        lineNumbersMinChars: 3,            // Tighter line numbers
        renderLineHighlight: 'none',       // No highlight current line
        contextmenu: false,                // No right-click menu
        overviewRulerLanes: 0,             // Remove scrollbar annotations
        scrollbar: {
            vertical: 'auto',              // Auto-hide scrollbar
            horizontal: 'auto',
            alwaysConsumeMouseWheel: false 
        }
    });

    // --- LOAD CACHED LOGIN CREDENTIALS ---
    try {
        const lastLogin = await window.api.getLastLogin();
        if (lastLogin.host) document.getElementById('ssh-host').value = lastLogin.host;
        if (lastLogin.username) document.getElementById('ssh-user').value = lastLogin.username;
    } catch (e) { console.error("Error loading cached login", e); }
});

const statusEl = document.getElementById('status-bar');
function setStatus(msg) { statusEl.textContent = msg; }

// --- CUSTOM ALERT LOGIC ---
const customAlertModal = document.getElementById('custom-alert-modal');
const customAlertTitle = document.getElementById('custom-alert-title');
const customAlertMessage = document.getElementById('custom-alert-message');
const btnCloseCustomAlert = document.getElementById('btn-close-custom-alert');
const btnCloseCustomAlertAction = document.getElementById('btn-close-custom-alert-action');

function showCustomAlert(title, message) {
    if (customAlertTitle) customAlertTitle.textContent = title;
    if (customAlertMessage) customAlertMessage.textContent = message;
    if (customAlertModal) {
        customAlertModal.classList.remove('hidden');
        if (btnCloseCustomAlertAction) btnCloseCustomAlertAction.focus();
    }
}

function closeCustomAlert() {
    if (customAlertModal) customAlertModal.classList.add('hidden');
    if (editor) editor.focus();
}

if (btnCloseCustomAlert) btnCloseCustomAlert.addEventListener('click', closeCustomAlert);
if (btnCloseCustomAlertAction) btnCloseCustomAlertAction.addEventListener('click', closeCustomAlert);

// --- LOGIN LOGIC ---
const loginScreen = document.getElementById('login-screen');
const appContainer = document.getElementById('app-container');
const loginError = document.getElementById('login-error');

function showApp() {
    if (loginScreen) loginScreen.style.display = 'none';
    if (appContainer) appContainer.style.display = 'flex';
    loadConfigs();
    loadSnippets();
}

const btnLoginLocal = document.getElementById('btn-login-local');
if (btnLoginLocal) {
    btnLoginLocal.addEventListener('click', async () => {
        try {
            await window.api.loginLocal();
            showApp();
        } catch (err) {
            loginError.textContent = "Local Login Failed: " + err;
        }
    });
}

const fileDisplay = document.getElementById('ssh-key-display');
const btnBrowseKey = document.getElementById('btn-browse-key');
if (btnBrowseKey) {
    btnBrowseKey.addEventListener('click', async () => {
        const path = await window.api.selectKeyFile();
        if (path) fileDisplay.value = path;
    });
}

const btnLoginRemote = document.getElementById('btn-login-remote');
if (btnLoginRemote) {
    btnLoginRemote.addEventListener('click', async () => {
        const host = document.getElementById('ssh-host').value.trim();
        const user = document.getElementById('ssh-user').value.trim();
        const password = document.getElementById('ssh-pass').value; // Allowed to be empty if key is present
        const keyPath = fileDisplay.value.trim();

        if (!host || !user) {
            loginError.textContent = "Host and Username are required";
            return;
        }

        if (!password && !keyPath) {
            loginError.textContent = "Please provide either a Password or a Key File";
            return;
        }

        loginError.textContent = "Connecting (Checking OS type...)...";
        try {
            await window.api.loginRemote({ host, username: user, password, keyPath });
            showApp();
        } catch (err) {
            loginError.textContent = err.message;
        }
    });
}

// --- SUDO PASSWORD PROMPT LOGIC ---
const sudoModal = document.getElementById('sudo-prompt-modal');
const sudoInput = document.getElementById('sudo-pass-input');
const btnSubmitSudo = document.getElementById('btn-submit-sudo');
const btnCancelSudo = document.getElementById('btn-cancel-sudo');
const btnCloseSudo = document.getElementById('btn-close-sudo-modal');

window.api.onPromptSudo(() => {
    sudoInput.value = '';
    sudoModal.classList.remove('hidden');
    sudoInput.focus();
});

if (btnSubmitSudo) {
    btnSubmitSudo.addEventListener('click', () => {
        const pass = sudoInput.value;
        window.api.sendSudoPassword(pass);
        sudoModal.classList.add('hidden');
    });
}

// New Cancel Logic
function cancelSudo() {
    window.api.cancelSudo();
    sudoModal.classList.add('hidden');
}

if (btnCancelSudo) btnCancelSudo.addEventListener('click', cancelSudo);
if (btnCloseSudo) btnCloseSudo.addEventListener('click', cancelSudo);

if (sudoInput) {
    sudoInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') btnSubmitSudo.click();
    });
}


// --- CONFIG LIST LOGIC ---

async function loadConfigs(selectFileName = null) {
    const listEl = document.getElementById('config-list');
    listEl.innerHTML = 'Loading...';
    
    try {
        const configs = await window.api.getConfigs();
        listEl.innerHTML = '';

        let itemToSelect = null;

        configs.forEach(conf => {
            const li = document.createElement('li');
            li.className = 'config-item';
            
            const nameSpan = document.createElement('span');
            nameSpan.textContent = conf.name;
            nameSpan.onclick = () => loadFile(conf.name, li);

            const label = document.createElement('label');
            label.className = 'switch';
            
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = conf.enabled;
            
            // Handle Locked Configs (conf.d)
            if (conf.locked) {
                input.disabled = true;
                label.title = "Always Enabled (Managed via conf.d)";
                label.style.opacity = '0.6';
                label.style.cursor = 'not-allowed';
            } else {
                input.addEventListener('change', async (e) => {
                    e.preventDefault(); 
                    const newState = input.checked;
                    try {
                        setStatus(`Toggling ${conf.name}...`);
                        await window.api.toggleSite(conf.name, !newState);
                        setStatus(`${conf.name} is now ${newState ? 'Enabled' : 'Disabled'}`);
                    } catch (err) {
                        input.checked = !newState; 
                        showCustomAlert('Error', 'Failed to toggle: ' + err.message);
                    }
                });
            }

            const slider = document.createElement('span');
            slider.className = 'slider';
            label.appendChild(input);
            label.appendChild(slider);
            li.appendChild(nameSpan);
            li.appendChild(label);
            listEl.appendChild(li);

            if (conf.name === selectFileName) itemToSelect = { name: conf.name, el: li };
        });

        if (itemToSelect) loadFile(itemToSelect.name, itemToSelect.el);
        else if (configs.length > 0) setStatus(`${configs.length} configs loaded.`);
        else setStatus('No configs found.');

    } catch (err) {
        listEl.innerHTML = "Error loading configs";
        showCustomAlert('Error', err.message);
    }
}

async function loadFile(fileName, liElement) {
    currentFile = fileName;
    
    document.querySelectorAll('.config-item').forEach(el => el.classList.remove('active'));
    if(liElement) liElement.classList.add('active');

    document.getElementById('current-file-label').textContent = fileName;
    
    document.getElementById('btn-test').disabled = false;
    document.getElementById('btn-save').disabled = false; 

    try {
        const content = await window.api.readConfig(fileName);
        editor.setValue(content);
        document.getElementById('editor-container').style.borderTopColor = '#000';
        setStatus(`Loaded ${fileName}`);
        editor.focus();
    } catch (err) {
        editor.setValue("# Error loading file");
        showCustomAlert('Error', "Error reading config: " + err.message);
    }
}

// --- TOOLBAR ACTIONS ---

// 1. SAVE
const btnSave = document.getElementById('btn-save');
if (btnSave) {
    btnSave.addEventListener('click', async () => {
        if (!currentFile) return;
        const content = editor.getValue();
        setStatus('Saving & Backing up...');

        try {
            await window.api.saveConfig(currentFile, content);
            document.getElementById('editor-container').style.borderTopColor = '#000';
            setStatus('Saved successfully');
            editor.focus();
        } catch (err) {
            showCustomAlert('Error', "Failed to save: " + err.message);
            setStatus('Error saving');
        }
    });
}

// 2. TEST
const testModal = document.getElementById('test-output-modal');
const testOutputText = document.getElementById('test-output-text');
const btnCloseTest = document.getElementById('btn-close-test');
const btnCloseTestAction = document.getElementById('btn-close-test-action');

function closeTestModal() { 
    if (testModal) testModal.classList.add('hidden'); 
    if (editor) editor.focus(); 
}
if (btnCloseTest) btnCloseTest.addEventListener('click', closeTestModal);
if (btnCloseTestAction) btnCloseTestAction.addEventListener('click', closeTestModal);

const btnTest = document.getElementById('btn-test');
if (btnTest) {
    btnTest.addEventListener('click', async () => {
        setStatus('Running nginx -t...');
        testOutputText.textContent = "Running...";
        testModal.classList.remove('hidden');

        try {
            const result = await window.api.testConfig();
            testOutputText.textContent = result.output;
            setStatus(result.success ? 'Test Syntax OK' : 'Test Failed');
        } catch (err) {
            testOutputText.textContent = "Error invoking test command: " + err.message;
            setStatus('Test execution failed');
        }
    });
}

// 3. RELOAD
const btnReload = document.getElementById('btn-reload');
if (btnReload) {
    btnReload.addEventListener('click', async () => {
        setStatus('Reloading Nginx...');
        try {
            await window.api.reloadNginx();
            setStatus('Nginx Reloaded Successfully');
            showCustomAlert('Success', "Nginx reloaded successfully.");
        } catch (err) {
            showCustomAlert('Error', "Reload failed: " + err.message);
            setStatus('Reload failed');
        }
    });
}


// --- NEW CONFIG LOGIC ---

const newConfigModal = document.getElementById('new-config-modal');
const newConfigInput = document.getElementById('new-config-name');
const btnCreateConfig = document.getElementById('btn-create-config');
const btnCloseNewConfig = document.getElementById('btn-close-new-config');

const btnNewConfig = document.getElementById('btn-new-config');
if (btnNewConfig) {
    btnNewConfig.addEventListener('click', () => {
        newConfigInput.value = '';
        newConfigModal.classList.remove('hidden');
        newConfigInput.focus();
    });
}

if (btnCloseNewConfig) {
    btnCloseNewConfig.addEventListener('click', () => { 
        newConfigModal.classList.add('hidden'); 
        if(editor) editor.focus();
    });
}

if (newConfigInput) {
    newConfigInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') btnCreateConfig.click();
    });
}

if (btnCreateConfig) {
    btnCreateConfig.addEventListener('click', async () => {
        const name = newConfigInput.value.trim();
        if (!name) return;

        if (!/^[a-zA-Z0-9_\-\.]+$/.test(name)) {
            showCustomAlert('Invalid Name', "Only letters, numbers, underscores, hyphens and dots allowed.");
            return;
        }

        const existingConfigs = await window.api.getConfigs();
        if (existingConfigs.find(c => c.name === name)) {
            showCustomAlert('Error', "Config already exists.");
            return;
        }

        const template = `server {
    listen 80;
    server_name ${name};
    root /var/www/${name};
    index index.html index.htm;
    access_log /var/log/nginx/${name}.access.log;
    error_log /var/log/nginx/${name}.error.log;
    location / {
        try_files $uri $uri/ =404;
    }
}`;

        setStatus('Creating new config...');
        try {
            await window.api.createConfig(name, template);
            setStatus('Config created');
            newConfigModal.classList.add('hidden');
            await loadConfigs(name);
            editor.focus();
        } catch (err) {
            showCustomAlert('Error', "Error creating config: " + err.message);
        }
    });
}

// --- SNIPPETS LOGIC ---

async function loadSnippets() {
    const list = document.getElementById('snippet-list');
    if (!list) return;

    // Safety: Handle error if reading snippets fails
    try {
        const snippets = await window.api.getSnippets();
        list.innerHTML = '';
        
        snippets.forEach(snip => {
            const btn = document.createElement('button');
            btn.className = 'snippet-btn';
            btn.textContent = snip.name;
            btn.onclick = () => showSnippetModal(snip);
            list.appendChild(btn);
        });
    } catch (err) {
        console.error("Failed to load snippets", err);
        list.innerHTML = '<p style="padding:10px; color:#aaa; font-size:0.8rem">Failed to load snippets</p>';
    }
}

function showSnippetModal(snippet) {
    if (!snippetEditor) {
        showCustomAlert("Error", "Editor not ready. Please try again in a moment.");
        return;
    }

    if (modalTitle) modalTitle.textContent = snippet.name;
    snippetEditor.setValue(snippet.content);
    
    // --- RESET TO STATIC LAYOUT ---
    const container = document.getElementById('snippet-editor-container');
    if (container) {
        container.style.height = ''; // Reset inline height override
        container.style.flex = '1';  // Restore flex expansion
    }

    if (snippetModal) snippetModal.classList.remove('hidden');
    
    // Defer layout until visible
    setTimeout(() => {
        snippetEditor.layout();
    }, 10);
}

// --- ROBUST SNIPPET MODAL EVENT LISTENERS ---
// Using DOMContentLoaded to ensure elements exist
document.addEventListener('DOMContentLoaded', () => {
    
    // 1. Close Button
    const btnCloseModal = document.getElementById('btn-close-modal');
    if (btnCloseModal) {
        btnCloseModal.addEventListener('click', () => {
            if (snippetModal) snippetModal.classList.add('hidden');
            if (editor) editor.focus();
        });
    }

    // 2. Copy Button
    const btnCopySnippet = document.getElementById('btn-copy-snippet');
    if (btnCopySnippet) {
        btnCopySnippet.addEventListener('click', () => {
            if (!snippetEditor) return;

            const val = snippetEditor.getValue();
            const el = document.createElement('textarea');
            el.value = val;
            document.body.appendChild(el);
            el.select();
            
            try {
                document.execCommand('copy');
                setStatus('Snippet copied');
            } catch (err) {
                setStatus('Copy failed');
            }
            
            document.body.removeChild(el);

            if (snippetModal) snippetModal.classList.add('hidden');
            if (editor) editor.focus();
        });
    }
});