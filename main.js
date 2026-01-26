const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const util = require('util');
const { Client } = require('ssh2');
const { exec } = require('child_process');

// --- Polyfills ---
if (!util.isObject) util.isObject = (arg) => typeof arg === 'object' && arg !== null;
if (!util.isFunction) util.isFunction = (arg) => typeof arg === 'function';

/**
 * Persistent Path Management
 */
const userDataPath = app.getPath('userData');
const BACKUP_DIR = path.join(userDataPath, 'backups');
const SNIPPETS_DIR = path.join(userDataPath, 'snippets');
const PREFS_FILE = path.join(userDataPath, 'preferences.json');

// Ensure directories exist
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(SNIPPETS_DIR)) fs.mkdirSync(SNIPPETS_DIR, { recursive: true });

// Global State
let mainWindow;
let currentAdapter = null;
let pendingPasswordResolve = null;
let pendingPasswordReject = null;

// --- PREFERENCE MANAGEMENT ---
const PreferenceManager = {
    save: (data) => {
        try {
            const current = PreferenceManager.load();
            const newPrefs = { ...current, ...data };
            fs.writeFileSync(PREFS_FILE, JSON.stringify(newPrefs, null, 2));
        } catch (e) { console.error("Failed to save prefs", e); }
    },
    load: () => {
        try {
            if (fs.existsSync(PREFS_FILE)) {
                return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
            }
        } catch (e) { console.error("Failed to load prefs", e); }
        return {};
    }
};

// --- ADAPTERS ---

/**
 * Local Adapter: Manages local Nginx installation
 */
class LocalAdapter {
    constructor(passwordPrompter) {
        // Paths config
        this.paths = {
            available: '/etc/nginx/sites-available',
            enabled: '/etc/nginx/sites-enabled',
            confd: '/etc/nginx/conf.d'
        };
        
        this.sudoPassword = null;
        this.passwordPrompter = passwordPrompter;
    }

    exec(command) {
        return new Promise((resolve, reject) => {
            const child = exec(command, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) reject(stderr || error.message);
                else resolve(stdout);
            });

            if (command.startsWith('sudo -S') && typeof this.sudoPassword === 'string') {
                child.stdin.write(this.sudoPassword + '\n');
                child.stdin.end();
            }
        });
    }

    async ensureSudo() {
        if (this.sudoPassword !== null && this.sudoPassword !== false) return;
        
        try {
            await this.exec('sudo -n true');
            this.sudoPassword = false; 
            return;
        } catch (err) {}

        try {
            this.sudoPassword = await this.passwordPrompter();
        } catch (cancelled) {
            throw new Error("Action cancelled by user");
        }
        
        try {
            await this.exec(this.getSudoCmd('true'));
        } catch (err) {
            this.sudoPassword = null; 
            throw new Error(`Sudo failed: ${err.trim()}`);
        }
    }

    getSudoCmd(cmd) {
        if (this.sudoPassword === false) return `sudo ${cmd}`;
        return `sudo -S -p '' ${cmd}`;
    }

    async listConfigs() {
        const results = [];
        
        // 1. Scan sites-available (Debian style)
        if (fs.existsSync(this.paths.available)) {
            const available = fs.readdirSync(this.paths.available);
            let enabledFiles = [];
            if (fs.existsSync(this.paths.enabled)) {
                enabledFiles = fs.readdirSync(this.paths.enabled);
            }
            available.forEach(file => {
                results.push({ 
                    name: file, 
                    enabled: enabledFiles.includes(file),
                    locked: false,
                    type: 'site'
                });
            });
        }

        // 2. Scan conf.d (Universal/RHEL style) - ALWAYS ENABLED/LOCKED
        if (fs.existsSync(this.paths.confd)) {
            const confFiles = fs.readdirSync(this.paths.confd).filter(f => f.endsWith('.conf'));
            confFiles.forEach(file => {
                // Avoid duplicates if same name exists (unlikely but possible)
                if (!results.find(r => r.name === file)) {
                    results.push({
                        name: file,
                        enabled: true, // Always on
                        locked: true,  // Cannot be toggled
                        type: 'conf'
                    });
                }
            });
        }

        return results.sort((a, b) => a.name.localeCompare(b.name));
    }

    async resolvePath(fileName) {
        // Check conf.d first
        const confPath = path.join(this.paths.confd, fileName);
        if (fs.existsSync(confPath)) return confPath;

        // Check sites-available
        const sitePath = path.join(this.paths.available, fileName);
        if (fs.existsSync(sitePath)) return sitePath;

        return null;
    }

    async readConfig(fileName) {
        const filePath = await this.resolvePath(fileName);
        if (filePath) return fs.readFileSync(filePath, 'utf-8');
        return "";
    }

    async toggleSite(fileName, currentState) {
        const resolved = await this.resolvePath(fileName);
        
        // If it's in conf.d, we cannot toggle it
        if (resolved && resolved.startsWith(this.paths.confd)) {
            throw new Error("Files in conf.d cannot be disabled via this manager.");
        }

        await this.ensureSudo();
        const availablePath = path.join(this.paths.available, fileName);
        const enabledPath = path.join(this.paths.enabled, fileName);
        
        // Double check existence
        if (!fs.existsSync(availablePath)) throw new Error("Config file not found in sites-available");

        const rawCmd = currentState ? `rm "${enabledPath}"` : `ln -s "${availablePath}" "${enabledPath}"`;
        return this.exec(this.getSudoCmd(rawCmd));
    }

    async saveConfig(fileName, content) {
        await this.ensureSudo();
        
        let targetPath = await this.resolvePath(fileName);
        
        // If file doesn't exist, decide where to put it
        if (!targetPath) {
            // Default to sites-available if it exists, else conf.d
            if (fs.existsSync(this.paths.available)) {
                targetPath = path.join(this.paths.available, fileName);
            } else {
                targetPath = path.join(this.paths.confd, fileName);
            }
        }

        // Backup
        if (fs.existsSync(targetPath)) {
            try {
                const existingContent = fs.readFileSync(targetPath, 'utf-8');
                const backupName = `local_${path.basename(targetPath)}.${Date.now()}`;
                fs.writeFileSync(path.join(BACKUP_DIR, backupName), existingContent);
            } catch (err) { console.error("Backup failed", err); }
        }

        const tempPath = path.join(userDataPath, `nginx_mgr_local_${Date.now()}_${fileName}`);
        try {
            fs.writeFileSync(tempPath, content);
            await this.exec(this.getSudoCmd(`mv "${tempPath}" "${targetPath}"`));
            await this.exec(this.getSudoCmd(`chown root:root "${targetPath}"`));
            return "Saved";
        } catch (err) {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            throw err;
        }
    }

    async createConfig(fileName, content) {
        if (!/^[a-zA-Z0-9_\-\.]+$/.test(fileName)) throw new Error("Invalid filename");
        const existing = await this.resolvePath(fileName);
        if (existing) throw new Error("File already exists");
        return this.saveConfig(fileName, content);
    }

    async testConfig() {
        await this.ensureSudo();
        return new Promise((resolve) => {
            this.exec(this.getSudoCmd('nginx -t')).then(stdout => {
                resolve({ success: true, output: stdout || "Syntax OK" });
            }).catch(err => resolve({ success: false, output: err }));
        });
    }

    async reloadNginx() {
        await this.ensureSudo();
        return this.exec(this.getSudoCmd('systemctl reload nginx'));
    }
}

/**
 * Remote Adapter: Manages remote Nginx via SSH
 */
class RemoteAdapter {
    constructor(config, passwordPrompter) {
        this.config = config; // host, username, password, privateKey
        this.conn = new Client();
        this.sudoPassword = null; 
        this.passwordPrompter = passwordPrompter;
        this.isReady = false;
        
        this.env = {
            hasSites: false,
            hasConfD: false,
            availableDir: '/etc/nginx/sites-available',
            enabledDir: '/etc/nginx/sites-enabled',
            confdDir: '/etc/nginx/conf.d'
        };

        this.conn.on('error', (err) => this._handleDisconnect(`SSH Error: ${err.message}`));
        this.conn.on('end', () => this._handleDisconnect('SSH Connection Ended'));
        this.conn.on('close', () => this._handleDisconnect('SSH Connection Closed'));
    }

    _handleDisconnect(reason) {
        this.isReady = false;
        if (currentAdapter === this) {
            currentAdapter = null;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ssh-disconnected', reason);
            }
        }
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.conn.on('ready', async () => {
                this.isReady = true;
                try {
                    await this.detectEnvironment();
                    resolve();
                } catch (e) {
                    reject("Environment Detection Failed: " + e.message);
                    this.conn.end();
                }
            });
            this.conn.on('error', (err) => reject(err));
            
            try {
                const connectConfig = {
                    host: this.config.host,
                    username: this.config.username,
                    readyTimeout: 20000,
                    keepaliveInterval: 10000
                };
                if (this.config.privateKey) connectConfig.privateKey = this.config.privateKey;
                if (this.config.password) connectConfig.password = this.config.password;
                this.conn.connect(connectConfig);
            } catch (err) { reject(err); }
        });
    }

    async detectEnvironment() {
        // Check Sites Available
        try {
            await this.exec(`test -d ${this.env.availableDir} && test -d ${this.env.enabledDir}`);
            this.env.hasSites = true;
        } catch (e) { this.env.hasSites = false; }

        // Check Conf.d
        try {
            await this.exec(`test -d ${this.env.confdDir}`);
            this.env.hasConfD = true;
        } catch (e) { this.env.hasConfD = false; }

        if (!this.env.hasSites && !this.env.hasConfD) {
             console.warn("Could not detect standard Nginx directories.");
        }
    }

    exec(command) {
        return new Promise((resolve, reject) => {
            if (!this.isReady) return reject("SSH Client not ready");
            
            this.conn.exec(command, (err, stream) => {
                if (err) return reject(err);
                
                if (command.startsWith('sudo -S') && typeof this.sudoPassword === 'string') {
                    try {
                        stream.write(this.sudoPassword + '\n');
                    } catch (writeErr) { console.error("Stream write failed", writeErr); }
                }
                stream.end();

                let stdout = '', stderr = '';
                stream.on('close', (code) => {
                    if (code === 0) resolve(stdout.trim());
                    else reject(stderr || `Command failed with code ${code}`);
                }).on('data', (data) => stdout += data)
                  .stderr.on('data', (data) => stderr += data);
            });
        });
    }

    async ensureSudo() {
        if (this.sudoPassword !== null && this.sudoPassword !== false) return;
        
        try {
            await this.exec('sudo -n true');
            this.sudoPassword = false;
            return;
        } catch (err) {}

        if (this.config.password) {
            try {
                this.sudoPassword = this.config.password;
                await this.exec(this.getSudoCmd('true'));
                return;
            } catch (err) {
                this.sudoPassword = null; 
            }
        }

        try {
            this.sudoPassword = await this.passwordPrompter();
        } catch (cancelled) {
             throw new Error("Sudo prompt cancelled by user.");
        }
        
        try {
            await this.exec(this.getSudoCmd('true'));
        } catch (err) {
            const stderr = err.toString().toLowerCase();
            this.sudoPassword = null;
            if (stderr.includes('requiretty')) throw new Error("Remote server requires TTY for sudo.");
            if (stderr.includes('incorrect password')) throw new Error("Invalid Sudo Password.");
            throw new Error(`Sudo verification failed: ${stderr.trim()}`);
        }
    }

    getSudoCmd(cmd) {
        if (this.sudoPassword === false) return `sudo ${cmd}`;
        return `sudo -S -p '' ${cmd}`;
    }

    async listConfigs() {
        const results = [];

        // 1. Sites-Available
        if (this.env.hasSites) {
            try {
                const availStr = await this.exec(`ls -1 ${this.env.availableDir}`);
                const enabledStr = await this.exec(`ls -1 ${this.env.enabledDir}`).catch(() => ''); 
                const available = availStr.split('\n').filter(Boolean);
                const enabled = enabledStr.split('\n').filter(Boolean);
                available.forEach(file => {
                    results.push({
                        name: file,
                        enabled: enabled.includes(file),
                        locked: false,
                        type: 'site'
                    });
                });
            } catch (e) {}
        }

        // 2. Conf.d
        if (this.env.hasConfD) {
            try {
                const confStr = await this.exec(`ls -1 ${this.env.confdDir}`);
                const confFiles = confStr.split('\n').filter(f => f.trim().endsWith('.conf'));
                confFiles.forEach(file => {
                    if (!results.find(r => r.name === file)) {
                        results.push({
                            name: file,
                            enabled: true, // Always active
                            locked: true,  // Read-only switch
                            type: 'conf'
                        });
                    }
                });
            } catch (e) {}
        }

        return results.sort((a, b) => a.name.localeCompare(b.name));
    }

    async resolvePath(fileName) {
        // Check conf.d
        if (this.env.hasConfD) {
            const confPath = path.posix.join(this.env.confdDir, fileName);
            try {
                await this.exec(`test -f "${confPath}"`);
                return confPath;
            } catch (e) {}
        }

        // Check sites-available
        if (this.env.hasSites) {
            const sitePath = path.posix.join(this.env.availableDir, fileName);
            try {
                await this.exec(`test -f "${sitePath}"`);
                return sitePath;
            } catch (e) {}
        }
        return null;
    }

    async readConfig(fileName) {
        const filePath = await this.resolvePath(fileName);
        if (filePath) return this.exec(`cat "${filePath}"`);
        return "";
    }

    async toggleSite(fileName, currentState) {
        const resolved = await this.resolvePath(fileName);
        
        if (resolved && resolved.startsWith(this.env.confdDir)) {
            throw new Error("Files in conf.d cannot be disabled via this manager (Always Active).");
        }

        await this.ensureSudo();
        
        if (this.env.hasSites) {
            const availablePath = path.posix.join(this.env.availableDir, fileName);
            const enabledPath = path.posix.join(this.env.enabledDir, fileName);
            const rawCmd = currentState ? `rm "${enabledPath}"` : `ln -s "${availablePath}" "${enabledPath}"`;
            return this.exec(this.getSudoCmd(rawCmd));
        }
        
        throw new Error("Cannot toggle: sites-enabled directory not found.");
    }

    async saveConfig(fileName, content) {
        await this.ensureSudo();
        
        let finalPath = await this.resolvePath(fileName);
        
        // If new file
        if (!finalPath) {
            if (this.env.hasSites) {
                finalPath = path.posix.join(this.env.availableDir, fileName);
            } else if (this.env.hasConfD) {
                finalPath = path.posix.join(this.env.confdDir, fileName);
            } else {
                throw new Error("No suitable directory found to save config.");
            }
        }

        try {
            const existingContent = await this.exec(`cat "${finalPath}"`);
            const backupName = `${this.config.host}_${path.basename(finalPath)}.${Date.now()}`;
            fs.writeFileSync(path.join(BACKUP_DIR, backupName), existingContent); 
        } catch (err) {}

        const tempPath = `/tmp/nginx_mgr_${Date.now()}_${path.basename(finalPath)}`;
        const base64Content = Buffer.from(content).toString('base64');
        
        try {
            await this.exec(`bash -c 'echo "${base64Content}" | base64 --decode > "${tempPath}"'`);
            await this.exec(this.getSudoCmd(`mv "${tempPath}" "${finalPath}"`));
            await this.exec(this.getSudoCmd(`chown root:root "${finalPath}"`));
            return "Saved";
        } catch (err) {
            this.exec(`rm "${tempPath}"`).catch(() => {});
            throw err;
        }
    }

    async createConfig(fileName, content) {
        if (!/^[a-zA-Z0-9_\-\.]+$/.test(fileName)) throw new Error("Invalid filename");
        const existing = await this.resolvePath(fileName);
        if (existing) throw new Error("File already exists");
        return this.saveConfig(fileName, content);
    }

    async testConfig() {
        await this.ensureSudo();
        return new Promise((resolve) => {
            if (!this.isReady) return resolve({ success: false, output: "SSH Connection Lost" });
            const cmd = this.getSudoCmd('nginx -t');
            this.conn.exec(cmd, (err, stream) => {
                if (err) return resolve({ success: false, output: err.message });
                if (typeof this.sudoPassword === 'string') stream.write(this.sudoPassword + '\n');
                stream.end();
                let output = '';
                stream.on('close', (code) => {
                    resolve({ success: code === 0, output: output });
                }).on('data', (data) => output += data)
                  .stderr.on('data', (data) => output += data);
            });
        });
    }

    async reloadNginx() {
        await this.ensureSudo();
        return this.exec(this.getSudoCmd('systemctl reload nginx'));
    }
}

// --- Window Management ---

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200, height: 800,
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false, contextIsolation: true,
        }
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// --- IPC Handlers ---

ipcMain.handle('select-key-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', 'showHiddenFiles'] });
    return (result.canceled || result.filePaths.length === 0) ? null : result.filePaths[0];
});

const createPasswordPrompter = () => new Promise((resolve, reject) => {
    pendingPasswordResolve = resolve;
    pendingPasswordReject = reject;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('prompt-sudo');
    }
});

ipcMain.handle('login-local', () => {
    currentAdapter = new LocalAdapter(createPasswordPrompter);
    return true;
});

ipcMain.handle('login-remote', async (event, { host, username, password, keyPath }) => {
    const config = { host, username, password };
    
    if (keyPath) {
        try {
            config.privateKey = fs.readFileSync(keyPath);
        } catch (err) {
            throw new Error(`Failed to read key file: ${err.message}`);
        }
    }
    if (!config.password && !config.privateKey) throw new Error("Either Password or Private Key is required.");

    const adapter = new RemoteAdapter(config, createPasswordPrompter);
    await adapter.connect();
    
    // Cache credentials on successful login
    PreferenceManager.save({ lastHost: host, lastUser: username });
    
    currentAdapter = adapter;
    return true;
});

// New: Get cached credentials
ipcMain.handle('get-last-login', () => {
    const prefs = PreferenceManager.load();
    return { host: prefs.lastHost || '', username: prefs.lastUser || '' };
});

ipcMain.on('sudo-response', (event, password) => {
    if (pendingPasswordResolve) {
        pendingPasswordResolve(password);
        pendingPasswordResolve = null;
        pendingPasswordReject = null;
    }
});

ipcMain.on('sudo-cancel', () => {
    if (pendingPasswordReject) {
        pendingPasswordReject(new Error("Cancelled"));
        pendingPasswordResolve = null;
        pendingPasswordReject = null;
    }
});

// --- Delegated Handlers ---

function checkAuth() { if (!currentAdapter) throw new Error("Not logged in"); }

ipcMain.handle('get-configs', () => currentAdapter ? currentAdapter.listConfigs() : []);
ipcMain.handle('read-config', (e, name) => { checkAuth(); return currentAdapter.readConfig(name); });
ipcMain.handle('toggle-site', (e, p) => { checkAuth(); return currentAdapter.toggleSite(p.fileName, p.currentState); });
ipcMain.handle('save-config', (e, p) => { checkAuth(); return currentAdapter.saveConfig(p.fileName, p.content); });
ipcMain.handle('create-config', (e, p) => { checkAuth(); return currentAdapter.createConfig(p.fileName, p.content); });
ipcMain.handle('test-config', () => { checkAuth(); return currentAdapter.testConfig(); });
ipcMain.handle('reload-nginx', () => { checkAuth(); return currentAdapter.reloadNginx(); });

// FIXED: Robust Snippet Loading (filters directories and errors)
ipcMain.handle('get-snippets', () => {
    try {
        if (!fs.existsSync(SNIPPETS_DIR)) {
            fs.mkdirSync(SNIPPETS_DIR, { recursive: true });
        }
        
        const defaultFile = path.join(SNIPPETS_DIR, 'LogsPath');
        if (!fs.existsSync(defaultFile)) {
             fs.writeFileSync(defaultFile, 'access_log /var/log/nginx/access.log;\nerror_log /var/log/nginx/error.log;');
        }
        
        const files = fs.readdirSync(SNIPPETS_DIR);
        return files.map(file => {
            try {
                const fullPath = path.join(SNIPPETS_DIR, file);
                const stat = fs.statSync(fullPath);
                if (stat.isFile()) {
                    return {
                        name: file,
                        content: fs.readFileSync(fullPath, 'utf-8')
                    };
                }
            } catch (err) { return null; }
        }).filter(item => item !== null);
    } catch (err) {
        console.error("Error getting snippets:", err);
        return [];
    }
});

ipcMain.handle('get-nginx-keywords', () => {
    const keywordsPath = path.join(__dirname, 'nginx-keywords.json');
    if (fs.existsSync(keywordsPath)) return JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
    return [];
});