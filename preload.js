const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    loginLocal: () => ipcRenderer.invoke('login-local'),
    loginRemote: (details) => ipcRenderer.invoke('login-remote', details),
    selectKeyFile: () => ipcRenderer.invoke('select-key-file'),
    getLastLogin: () => ipcRenderer.invoke('get-last-login'), // NEW
    
    getConfigs: () => ipcRenderer.invoke('get-configs'),
    readConfig: (fileName) => ipcRenderer.invoke('read-config', fileName),
    getSnippets: () => ipcRenderer.invoke('get-snippets'),
    toggleSite: (fileName, currentState) => ipcRenderer.invoke('toggle-site', { fileName, currentState }),
    
    saveConfig: (fileName, content) => ipcRenderer.invoke('save-config', { fileName, content }),
    createConfig: (fileName, content) => ipcRenderer.invoke('create-config', { fileName, content }),
    
    testConfig: () => ipcRenderer.invoke('test-config'),
    reloadNginx: () => ipcRenderer.invoke('reload-nginx'),

    onPromptSudo: (callback) => ipcRenderer.on('prompt-sudo', callback),
    sendSudoPassword: (password) => ipcRenderer.send('sudo-response', password),
    cancelSudo: () => ipcRenderer.send('sudo-cancel'),

    getNginxKeywords: () => ipcRenderer.invoke('get-nginx-keywords')
});