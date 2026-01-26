let editor;
let snippetEditor;
let currentFile = null;

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
        minimap: { enabled: false }
    });
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
    customAlertTitle.textContent = title;
    customAlertMessage.textContent = message;
    customAlertModal.classList.remove('hidden');
    btnCloseCustomAlertAction.focus();
}

function closeCustomAlert() {
    customAlertModal.classList.add('hidden');
    if (editor) editor.focus();
}

btnCloseCustomAlert.addEventListener('click', closeCustomAlert);
btnCloseCustomAlertAction.addEventListener('click', closeCustomAlert);

// --- LOGIN LOGIC ---
const loginScreen = document.getElementById('login-screen');
const appContainer = document.getElementById('app-container');
const loginError = document.getElementById('login-error');

function showApp() {
    loginScreen.style.display = 'none';
    appContainer.style.display = 'flex';
    loadConfigs();
    loadSnippets();
}

document.getElementById('btn-login-local').addEventListener('click', async () => {
    try {
        await window.api.loginLocal();
        showApp();
    } catch (err) {
        loginError.textContent = "Local Login Failed: " + err;
    }
});

const fileDisplay = document.getElementById('ssh-key-display');
document.getElementById('btn-browse-key').addEventListener('click', async () => {
    const path = await window.api.selectKeyFile();
    if (path) fileDisplay.value = path;
});

document.getElementById('btn-login-remote').addEventListener('click', async () => {
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

// --- SUDO PASSWORD PROMPT LOGIC ---
const sudoModal = document.getElementById('sudo-prompt-modal');
const sudoInput = document.getElementById('sudo-pass-input');
const btnSubmitSudo = document.getElementById('btn-submit-sudo');

window.api.onPromptSudo(() => {
    sudoInput.value = '';
    sudoModal.classList.remove('hidden');
    sudoInput.focus();
});

btnSubmitSudo.addEventListener('click', () => {
    const pass = sudoInput.value;
    window.api.sendSudoPassword(pass);
    sudoModal.classList.add('hidden');
});

sudoInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btnSubmitSudo.click();
});


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
            
            input.addEventListener('change', async (e) => {
                e.preventDefault(); 
                const newState = input.checked;
                try {
                    setStatus(`Toggling ${conf.name}...`);
                    await window.api.toggleSite(conf.name, !newState);
                    setStatus(`${conf.name} is now ${newState ? 'Enabled' : 'Disabled'}`);
                } catch (err) {
                    input.checked = !newState; 
                    showCustomAlert('Error', 'Failed to toggle: ' + err);
                }
            });

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
        showCustomAlert('Error', "Error reading config: " + err);
    }
}

// --- TOOLBAR ACTIONS ---

// 1. SAVE
document.getElementById('btn-save').addEventListener('click', async () => {
    if (!currentFile) return;
    const content = editor.getValue();
    setStatus('Saving & Backing up...');

    try {
        await window.api.saveConfig(currentFile, content);
        document.getElementById('editor-container').style.borderTopColor = '#000';
        setStatus('Saved successfully');
        editor.focus();
    } catch (err) {
        showCustomAlert('Error', "Failed to save: " + err);
        setStatus('Error saving');
    }
});

// 2. TEST
const testModal = document.getElementById('test-output-modal');
const testOutputText = document.getElementById('test-output-text');
const btnCloseTest = document.getElementById('btn-close-test');
const btnCloseTestAction = document.getElementById('btn-close-test-action');

function closeTestModal() { 
    testModal.classList.add('hidden'); 
    editor.focus(); 
}
btnCloseTest.addEventListener('click', closeTestModal);
btnCloseTestAction.addEventListener('click', closeTestModal);

document.getElementById('btn-test').addEventListener('click', async () => {
    setStatus('Running nginx -t...');
    testOutputText.textContent = "Running...";
    testModal.classList.remove('hidden');

    try {
        const result = await window.api.testConfig();
        testOutputText.textContent = result.output;
        setStatus(result.success ? 'Test Syntax OK' : 'Test Failed');
    } catch (err) {
        testOutputText.textContent = "Error invoking test command: " + err;
        setStatus('Test execution failed');
    }
});

// 3. RELOAD
document.getElementById('btn-reload').addEventListener('click', async () => {
    setStatus('Reloading Nginx...');
    try {
        await window.api.reloadNginx();
        setStatus('Nginx Reloaded Successfully');
        showCustomAlert('Success', "Nginx reloaded successfully.");
    } catch (err) {
        showCustomAlert('Error', "Reload failed: " + err);
        setStatus('Reload failed');
    }
});


// --- NEW CONFIG LOGIC ---

const newConfigModal = document.getElementById('new-config-modal');
const newConfigInput = document.getElementById('new-config-name');
const btnCreateConfig = document.getElementById('btn-create-config');
const btnCloseNewConfig = document.getElementById('btn-close-new-config');

document.getElementById('btn-new-config').addEventListener('click', () => {
    newConfigInput.value = '';
    newConfigModal.classList.remove('hidden');
    newConfigInput.focus();
});

btnCloseNewConfig.addEventListener('click', () => { 
    newConfigModal.classList.add('hidden'); 
    if(editor) editor.focus();
});

newConfigInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btnCreateConfig.click();
});

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
        showCustomAlert('Error', "Error creating config: " + err);
    }
});

// --- SNIPPETS LOGIC ---

async function loadSnippets() {
    const list = document.getElementById('snippet-list');
    const snippets = await window.api.getSnippets();
    list.innerHTML = '';
    
    snippets.forEach(snip => {
        const btn = document.createElement('button');
        btn.className = 'snippet-btn';
        btn.textContent = snip.name;
        btn.onclick = () => showSnippetModal(snip);
        list.appendChild(btn);
    });
}

const snippetModal = document.getElementById('snippet-modal');
const modalTitle = document.getElementById('modal-title');

function showSnippetModal(snippet) {
    modalTitle.textContent = snippet.name;
    snippetEditor.setValue(snippet.content);
    
    snippetModal.classList.remove('hidden');
    setTimeout(() => {
        snippetEditor.layout();
    }, 10);
}

document.getElementById('btn-close-modal').onclick = () => {
    snippetModal.classList.add('hidden');
    editor.focus();
};

document.getElementById('btn-copy-snippet').onclick = () => {
    const val = snippetEditor.getValue();
    const el = document.createElement('textarea');
    el.value = val;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);

    setStatus('Snippet copied');
    snippetModal.classList.add('hidden');
    editor.focus();
};