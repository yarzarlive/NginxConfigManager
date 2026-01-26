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
 * FIXED: Persistent Path Management
 * In packaged Electron apps, __dirname is read-only (inside app.asar).
 * We use app.getPath('userData') for any directory we need to write to.
 */
const userDataPath = app.getPath('userData');
const BACKUP_DIR = path.join(userDataPath, 'backups');
const SNIPPETS_DIR = path.join(userDataPath, 'snippets');

// Ensure directories exist at startup
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}
if (!fs.existsSync(SNIPPETS_DIR)) {
    fs.mkdirSync(SNIPPETS_DIR, { recursive: true });
}

// Global State
let mainWindow;
let currentAdapter = null;
let pendingPasswordResolve = null;

// --- ADAPTERS ---

class LocalAdapter {
    constructor(passwordPrompter) {
        this.sitesAvailable = '/etc/nginx/sites-available';
        this.sitesEnabled = '/etc/nginx/sites-enabled';
        this.sudoPassword = null;
        this.passwordPrompter = passwordPrompter;
    }

    exec(command) {
        return new Promise((resolve, reject) => {
            // FIXED: We now handle password writing to stdin instead of echoing it in shell
            const child = exec(command, (error, stdout, stderr) => {
                if (error) {
                    reject(stderr || error.message);
                } else {
                    resolve(stdout);
                }
            });

            // If this is a sudo command and we have a password, pipe it securely
            if (command.startsWith('sudo -S') && typeof this.sudoPassword === 'string') {
                child.stdin.write(this.sudoPassword + '\n');
                child.stdin.end();
            }
        });
    }

    async ensureSudo() {
        if (this.sudoPassword !== null) return; 

        try {
            await this.exec('sudo -n true');
            this.sudoPassword = false;
        } catch (err) {
            this.sudoPassword = await this.passwordPrompter();
        }
    }

    getSudoCmd(cmd) {
        if (this.sudoPassword === false) return `sudo ${cmd}`;
        
        // FIXED: Removed insecure `echo "pass" | sudo`. 
        // We now use `sudo -S` which reads from stdin, and we write to it in exec().
        return `sudo -S -p '' ${cmd}`;
    }

    async listConfigs() {
        if (!fs.existsSync(this.sitesAvailable)) return [];
        const available = fs.readdirSync(this.sitesAvailable);
        let enabled = [];
        if (fs.existsSync(this.sitesEnabled)) {
            enabled = fs.readdirSync(this.sitesEnabled);
        }
        return available.map(file => ({
            name: file,
            enabled: enabled.includes(file)
        }));
    }

    async readConfig(fileName) {
        return fs.readFileSync(path.join(this.sitesAvailable, fileName), 'utf-8');
    }

    async toggleSite(fileName, currentState) {
        await this.ensureSudo();
        const availablePath = path.join(this.sitesAvailable, fileName);
        const enabledPath = path.join(this.sitesEnabled, fileName);
        const rawCmd = currentState 
            ? `rm "${enabledPath}"` 
            : `ln -s "${availablePath}" "${enabledPath}"`;
        return this.exec(this.getSudoCmd(rawCmd));
    }

    async saveConfig(fileName, content) {
        await this.ensureSudo();
        
        const sourcePath = path.join(this.sitesAvailable, fileName);
        if (fs.existsSync(sourcePath)) {
            try {
                const existingContent = fs.readFileSync(sourcePath, 'utf-8');
                const backupName = `local_${fileName}.${Date.now()}`;
                fs.writeFileSync(path.join(BACKUP_DIR, backupName), existingContent);
            } catch (err) { console.error("Backup failed", err); }
        }

        const filePath = path.join(this.sitesAvailable, fileName);
        const tempPath = path.join(userDataPath, `nginx_mgr_local_${Date.now()}_${fileName}`);
        
        try {
            fs.writeFileSync(tempPath, content);
            await this.exec(this.getSudoCmd(`mv "${tempPath}" "${filePath}"`));
            await this.exec(this.getSudoCmd(`chown root:root "${filePath}"`));
            return "Saved";
        } catch (err) {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            throw err;
        }
    }

    async createConfig(fileName, content) {
        if (!/^[a-zA-Z0-9_\-]+$/.test(fileName)) throw new Error("Invalid filename");
        const filePath = path.join(this.sitesAvailable, fileName);
        if (fs.existsSync(filePath)) throw new Error("File already exists");
        return this.saveConfig(fileName, content);
    }

    async testConfig() {
        await this.ensureSudo();
        return new Promise((resolve) => {
            const cmd = this.getSudoCmd('nginx -t');
            
            // Special handling for testConfig since it needs custom error parsing
            // We duplicate the exec logic here to access the child process directly if needed,
            // or just use the class exec. Using class exec for consistency.
            this.exec(cmd).then(stdout => {
                resolve({ success: true, output: stdout || "Syntax OK" });
            }).catch(err => {
                resolve({ success: false, output: err });
            });
        });
    }

    async reloadNginx() {
        await this.ensureSudo();
        return this.exec(this.getSudoCmd('systemctl reload nginx'));
    }
}

class RemoteAdapter {
    constructor(config, passwordPrompter) {
        this.config = config;
        this.conn = new Client();
        this.sitesAvailable = '/etc/nginx/sites-available';
        this.sitesEnabled = '/etc/nginx/sites-enabled';
        this.sudoPassword = config.sudoPassword || null; 
        this.passwordPrompter = passwordPrompter;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.conn.on('ready', () => resolve());
            this.conn.on('error', (err) => reject(err));
            try {
                this.conn.connect({
                    host: this.config.host,
                    username: this.config.username,
                    privateKey: this.config.privateKey,
                });
            } catch (err) {
                reject(err);
            }
        });
    }

    exec(command) {
        return new Promise((resolve, reject) => {
            this.conn.exec(command, (err, stream) => {
                if (err) return reject(err);
                
                // FIXED: Write password to stdin if command requests it (sudo -S)
                if (command.startsWith('sudo -S') && typeof this.sudoPassword === 'string') {
                    stream.write(this.sudoPassword + '\n');
                }
                stream.end();

                let stdout = '';
                let stderr = '';
                stream.on('close', (code) => {
                    if (code === 0) resolve(stdout);
                    else reject(stderr || `Command failed with code ${code}`);
                }).on('data', (data) => stdout += data)
                  .stderr.on('data', (data) => stderr += data);
            });
        });
    }

    async ensureSudo() {
        if (this.sudoPassword !== null) return;
        try {
            await this.exec('sudo -n true');
            this.sudoPassword = false;
        } catch (err) {
            this.sudoPassword = await this.passwordPrompter();
        }
    }

    getSudoCmd(cmd) {
        if (this.sudoPassword === false) return `sudo ${cmd}`;
        
        // FIXED: Removed insecure `echo "pass" | sudo`. 
        // We now use `sudo -S` which reads from stdin.
        return `sudo -S -p '' ${cmd}`;
    }

    async listConfigs() {
        try {
            const availStr = await this.exec(`ls -1 ${this.sitesAvailable}`);
            const enabledStr = await this.exec(`ls -1 ${this.sitesEnabled}`).catch(() => ''); 
            const available = availStr.split('\n').filter(Boolean);
            const enabled = enabledStr.split('\n').filter(Boolean);
            return available.map(file => ({ name: file, enabled: enabled.includes(file) }));
        } catch (err) {
            console.error(err);
            return [];
        }
    }

    async readConfig(fileName) {
        return this.exec(`cat ${path.posix.join(this.sitesAvailable, fileName)}`);
    }

    async toggleSite(fileName, currentState) {
        await this.ensureSudo();
        const availablePath = path.posix.join(this.sitesAvailable, fileName);
        const enabledPath = path.posix.join(this.sitesEnabled, fileName);
        const rawCmd = currentState ? `rm "${enabledPath}"` : `ln -s "${availablePath}" "${enabledPath}"`;
        return this.exec(this.getSudoCmd(rawCmd));
    }

    async saveConfig(fileName, content) {
        await this.ensureSudo();
        try {
            const existingContent = await this.exec(`cat ${path.posix.join(this.sitesAvailable, fileName)}`);
            const backupName = `${this.config.host}_${fileName}.${Date.now()}`;
            fs.writeFileSync(path.join(BACKUP_DIR, backupName), existingContent); 
        } catch (err) { console.log("Skipping backup", err); }

        const tempPath = `/tmp/nginx_mgr_${Date.now()}_${fileName}`;
        const finalPath = path.posix.join(this.sitesAvailable, fileName);
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
        await this.ensureSudo();
        if (!/^[a-zA-Z0-9_\-]+$/.test(fileName)) throw new Error("Invalid filename");
        try {
            await this.exec(`test -f ${path.posix.join(this.sitesAvailable, fileName)}`);
            throw new Error("File already exists");
        } catch (e) {
            if (e.message === 'File already exists') throw e;
        }
        return this.saveConfig(fileName, content);
    }

    async testConfig() {
        await this.ensureSudo();
        return new Promise((resolve) => {
            const cmd = this.getSudoCmd('nginx -t');
            this.conn.exec(cmd, (err, stream) => {
                if (err) return resolve({ success: false, output: err.message });
                
                // FIXED: Must also handle password write here since we aren't using this.exec() wrapper
                if (typeof this.sudoPassword === 'string') {
                    stream.write(this.sudoPassword + '\n');
                }
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
        width: 1200,
        height: 800,
        // ADDED: App Icon for window title bar and taskbar (dev/runtime)
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        }
    });

    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

ipcMain.handle('select-key-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'showHiddenFiles'],
        title: 'Select SSH Private Key'
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

const createPasswordPrompter = () => {
    return new Promise((resolve) => {
        pendingPasswordResolve = resolve;
        mainWindow.webContents.send('prompt-sudo');
    });
};

ipcMain.handle('login-local', async () => {
    currentAdapter = new LocalAdapter(createPasswordPrompter);
    return true;
});

ipcMain.handle('login-remote', async (event, { host, username, keyPath }) => {
    try {
        const privateKey = fs.readFileSync(keyPath);
        const adapter = new RemoteAdapter(
            { host, username, privateKey }, 
            createPasswordPrompter
        );
        await adapter.connect();
        currentAdapter = adapter;
        return true;
    } catch (err) {
        throw new Error(`Connection failed: ${err.message}`);
    }
});

ipcMain.on('sudo-response', (event, password) => {
    if (pendingPasswordResolve) {
        pendingPasswordResolve(password);
        pendingPasswordResolve = null;
    }
});

// --- Delegated Handlers ---

function checkAuth() { if (!currentAdapter) throw new Error("Not logged in"); }

ipcMain.handle('get-configs', async () => {
    if (!currentAdapter) return [];
    return currentAdapter.listConfigs();
});

ipcMain.handle('read-config', async (event, fileName) => {
    checkAuth();
    return currentAdapter.readConfig(fileName);
});

ipcMain.handle('toggle-site', async (event, params) => {
    checkAuth();
    return currentAdapter.toggleSite(params.fileName, params.currentState);
});

ipcMain.handle('save-config', async (event, params) => {
    checkAuth();
    return currentAdapter.saveConfig(params.fileName, params.content);
});

ipcMain.handle('create-config', async (event, params) => {
    checkAuth();
    return currentAdapter.createConfig(params.fileName, params.content);
});

ipcMain.handle('test-config', async () => {
    checkAuth();
    return currentAdapter.testConfig();
});

ipcMain.handle('reload-nginx', async () => {
    checkAuth();
    return currentAdapter.reloadNginx();
});

ipcMain.handle('get-snippets', async () => {
    if (!fs.existsSync(path.join(SNIPPETS_DIR, 'LogsPath'))) {
        fs.writeFileSync(path.join(SNIPPETS_DIR, 'LogsPath'), 'access_log /var/log/nginx/access.log;\nerror_log /var/log/nginx/error.log;');
    }
    const files = fs.readdirSync(SNIPPETS_DIR);
    return files.map(file => ({
        name: file,
        content: fs.readFileSync(path.join(SNIPPETS_DIR, file), 'utf-8')
    }));
});

ipcMain.handle('get-nginx-keywords', async () => {
    const keywordsPath = path.join(__dirname, 'nginx-keywords.json');
    try {
        if (fs.existsSync(keywordsPath)) {
            const data = fs.readFileSync(keywordsPath, 'utf-8');
            return JSON.parse(data);
        }
        return [];
    } catch (e) {
        console.error("Failed to load keywords", e);
        return [];
    }
});