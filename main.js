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

// Ensure directories exist
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(SNIPPETS_DIR)) fs.mkdirSync(SNIPPETS_DIR, { recursive: true });

// Global State
let mainWindow;
let currentAdapter = null;
let pendingPasswordResolve = null;
let pendingPasswordReject = null; // New: Handle cancellation

// --- ADAPTERS ---

/**
 * Local Adapter: Manages local Nginx installation
 */
class LocalAdapter {
    constructor(passwordPrompter) {
        // Default to Debian style for local, can be improved to detect
        this.paths = {
            available: '/etc/nginx/sites-available',
            enabled: '/etc/nginx/sites-enabled',
            strategy: 'symlink'
        };
        
        // Quick check for RHEL style locally
        if (!fs.existsSync(this.paths.available) && fs.existsSync('/etc/nginx/conf.d')) {
            this.paths = {
                available: '/etc/nginx/conf.d',
                enabled: '/etc/nginx/conf.d',
                strategy: 'rename'
            };
        }

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
        
        // 1. Try without password first (root or NOPASSWD)
        try {
            await this.exec('sudo -n true');
            this.sudoPassword = false; 
            return;
        } catch (err) {}

        // 2. Prompt
        try {
            this.sudoPassword = await this.passwordPrompter();
        } catch (cancelled) {
            throw new Error("Action cancelled by user");
        }
        
        // 3. Verify
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
        if (this.paths.strategy === 'symlink') {
            if (!fs.existsSync(this.paths.available)) return [];
            const available = fs.readdirSync(this.paths.available);
            let enabled = [];
            if (fs.existsSync(this.paths.enabled)) enabled = fs.readdirSync(this.paths.enabled);
            return available.map(file => ({ name: file, enabled: enabled.includes(file) }));
        } else {
            // Rename strategy
            if (!fs.existsSync(this.paths.available)) return [];
            const files = fs.readdirSync(this.paths.available);
            return files
                .filter(f => f.endsWith('.conf') || f.endsWith('.disabled'))
                .map(f => ({
                    name: f.replace(/\.disabled$/, '.conf'), 
                    realName: f,
                    enabled: f.endsWith('.conf')
                }));
        }
    }

    async readConfig(fileName) {
        if (this.paths.strategy === 'rename') {
            let p = path.join(this.paths.available, fileName);
            if (!fs.existsSync(p)) p = path.join(this.paths.available, fileName.replace('.conf', '.disabled'));
            return fs.readFileSync(p, 'utf-8');
        }
        return fs.readFileSync(path.join(this.paths.available, fileName), 'utf-8');
    }

    async toggleSite(fileName, currentState) {
        await this.ensureSudo();
        
        if (this.paths.strategy === 'symlink') {
            const availablePath = path.join(this.paths.available, fileName);
            const enabledPath = path.join(this.paths.enabled, fileName);
            const rawCmd = currentState ? `rm "${enabledPath}"` : `ln -s "${availablePath}" "${enabledPath}"`;
            return this.exec(this.getSudoCmd(rawCmd));
        } else {
            const baseName = fileName.replace(/\.(conf|disabled)$/, '');
            const confName = baseName + '.conf';
            const disabledName = baseName + '.disabled';
            
            const src = currentState ? confName : disabledName;
            const dest = currentState ? disabledName : confName;
            
            const srcPath = path.join(this.paths.available, src);
            const destPath = path.join(this.paths.available, dest);
            
            return this.exec(this.getSudoCmd(`mv "${srcPath}" "${destPath}"`));
        }
    }

    async saveConfig(fileName, content) {
        await this.ensureSudo();
        
        let targetPath;
        if (this.paths.strategy === 'rename') {
             const confPath = path.join(this.paths.available, fileName);
             const disabledPath = path.join(this.paths.available, fileName.replace('.conf', '.disabled'));
             targetPath = fs.existsSync(disabledPath) ? disabledPath : confPath;
        } else {
            targetPath = path.join(this.paths.available, fileName);
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
        if (this.paths.strategy === 'rename' && !fileName.endsWith('.conf')) fileName += '.conf';
        
        const filePath = path.join(this.paths.available, fileName);
        if (fs.existsSync(filePath)) throw new Error("File already exists");
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
            type: 'debian',
            availableDir: '/etc/nginx/sites-available',
            enabledDir: '/etc/nginx/sites-enabled'
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
        try {
            await this.exec('test -d /etc/nginx/sites-available && test -d /etc/nginx/sites-enabled');
            this.env = { type: 'debian', availableDir: '/etc/nginx/sites-available', enabledDir: '/etc/nginx/sites-enabled' };
            return;
        } catch (e) {}

        try {
            await this.exec('test -d /etc/nginx/conf.d');
            this.env = { type: 'rhel', availableDir: '/etc/nginx/conf.d', enabledDir: '/etc/nginx/conf.d' };
            return;
        } catch (e) {}
        console.warn("Could not strictly detect Nginx structure, defaulting to Debian style.");
    }

    exec(command) {
        return new Promise((resolve, reject) => {
            if (!this.isReady) return reject("SSH Client not ready");
            
            this.conn.exec(command, (err, stream) => {
                if (err) return reject(err);
                
                if (command.startsWith('sudo -S') && typeof this.sudoPassword === 'string') {
                    // Safety check for write errors
                    try {
                        stream.write(this.sudoPassword + '\n');
                    } catch (writeErr) {
                        console.error("Stream write failed", writeErr);
                    }
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
        // If we already have a validated password, use it.
        if (this.sudoPassword !== null && this.sudoPassword !== false) return;
        
        // 1. Try NOPASSWD or Root
        try {
            await this.exec('sudo -n true');
            this.sudoPassword = false;
            return;
        } catch (err) {}

        // 2. Optimization: Try SSH Login Password IF available
        if (this.config.password) {
            try {
                this.sudoPassword = this.config.password;
                await this.exec(this.getSudoCmd('true'));
                return; // It worked!
            } catch (err) {
                // Login password didn't work for sudo, clear it and proceed to prompt
                this.sudoPassword = null; 
            }
        }

        // 3. Prompt User
        try {
            this.sudoPassword = await this.passwordPrompter();
        } catch (cancelled) {
             throw new Error("Sudo prompt cancelled by user.");
        }
        
        // 4. Verify
        try {
            await this.exec(this.getSudoCmd('true'));
        } catch (err) {
            const stderr = err.toString().toLowerCase();
            this.sudoPassword = null;
            
            // SPECIFIC ERROR DETECTION
            if (stderr.includes('requiretty')) {
                 throw new Error("Remote server requires TTY for sudo. Please disable 'requiretty' in /etc/sudoers.");
            }
            if (stderr.includes('incorrect password')) {
                 throw new Error("Invalid Sudo Password.");
            }
            // Pass the actual error message back to the user
            throw new Error(`Sudo verification failed: ${stderr.trim()}`);
        }
    }

    getSudoCmd(cmd) {
        if (this.sudoPassword === false) return `sudo ${cmd}`;
        return `sudo -S -p '' ${cmd}`;
    }

    async listConfigs() {
        try {
            if (this.env.type === 'debian') {
                const availStr = await this.exec(`ls -1 ${this.env.availableDir}`);
                const enabledStr = await this.exec(`ls -1 ${this.env.enabledDir}`).catch(() => ''); 
                const available = availStr.split('\n').filter(Boolean);
                const enabled = enabledStr.split('\n').filter(Boolean);
                return available.map(file => ({ name: file, enabled: enabled.includes(file) }));
            } else {
                const filesStr = await this.exec(`ls -1 ${this.env.availableDir}`);
                const files = filesStr.split('\n').filter(Boolean);
                return files
                    .filter(f => f.endsWith('.conf') || f.endsWith('.disabled'))
                    .map(f => ({
                        name: f.replace(/\.disabled$/, '.conf'),
                        realName: f,
                        enabled: f.endsWith('.conf')
                    }));
            }
        } catch (err) { return []; }
    }

    async readConfig(fileName) {
        let filePath;
        if (this.env.type === 'debian') {
            filePath = path.posix.join(this.env.availableDir, fileName);
        } else {
            const confPath = path.posix.join(this.env.availableDir, fileName); 
            try {
                await this.exec(`test -f "${confPath}"`);
                filePath = confPath;
            } catch (e) {
                filePath = path.posix.join(this.env.availableDir, fileName.replace('.conf', '.disabled'));
            }
        }
        return this.exec(`cat "${filePath}"`);
    }

    async toggleSite(fileName, currentState) {
        await this.ensureSudo();
        
        if (this.env.type === 'debian') {
            const availablePath = path.posix.join(this.env.availableDir, fileName);
            const enabledPath = path.posix.join(this.env.enabledDir, fileName);
            const rawCmd = currentState ? `rm "${enabledPath}"` : `ln -s "${availablePath}" "${enabledPath}"`;
            return this.exec(this.getSudoCmd(rawCmd));
        } else {
            const base = fileName.replace(/\.(conf|disabled)$/, '');
            const confName = base + '.conf';
            const disName = base + '.disabled';
            const src = currentState ? confName : disName;
            const dst = currentState ? disName : confName;
            const srcPath = path.posix.join(this.env.availableDir, src);
            const dstPath = path.posix.join(this.env.availableDir, dst);
            return this.exec(this.getSudoCmd(`mv "${srcPath}" "${dstPath}"`));
        }
    }

    async saveConfig(fileName, content) {
        await this.ensureSudo();
        
        let finalPath;
        if (this.env.type === 'debian') {
            finalPath = path.posix.join(this.env.availableDir, fileName);
        } else {
            const confPath = path.posix.join(this.env.availableDir, fileName);
            const disPath = path.posix.join(this.env.availableDir, fileName.replace('.conf', '.disabled'));
            try {
                await this.exec(`test -f "${disPath}"`);
                finalPath = disPath;
            } catch (e) {
                finalPath = confPath;
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
        if (this.env.type === 'rhel' && !fileName.endsWith('.conf')) fileName += '.conf';
        let targetPath = path.posix.join(this.env.availableDir, fileName);
        try {
            await this.exec(`test -f "${targetPath}"`);
            throw new Error("File already exists");
        } catch (e) {
            if (e.message === 'File already exists') throw e;
        }
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
    currentAdapter = adapter;
    return true;
});

ipcMain.on('sudo-response', (event, password) => {
    if (pendingPasswordResolve) {
        pendingPasswordResolve(password);
        pendingPasswordResolve = null;
        pendingPasswordReject = null;
    }
});

// New cancellation handler
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

ipcMain.handle('get-snippets', () => {
    if (!fs.existsSync(path.join(SNIPPETS_DIR, 'LogsPath'))) {
        fs.writeFileSync(path.join(SNIPPETS_DIR, 'LogsPath'), 'access_log /var/log/nginx/access.log;\nerror_log /var/log/nginx/error.log;');
    }
    return fs.readdirSync(SNIPPETS_DIR).map(file => ({
        name: file,
        content: fs.readFileSync(path.join(SNIPPETS_DIR, file), 'utf-8')
    }));
});

ipcMain.handle('get-nginx-keywords', () => {
    const keywordsPath = path.join(__dirname, 'nginx-keywords.json');
    if (fs.existsSync(keywordsPath)) return JSON.parse(fs.readFileSync(keywordsPath, 'utf-8'));
    return [];
});