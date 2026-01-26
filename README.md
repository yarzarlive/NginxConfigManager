# Nginx Config Manager

Nginx Config Manager is a desktop graphical user interface (GUI) built with Electron for managing Nginx server configurations. It provides a centralized dashboard to edit, enable, disable, and test server blocks on both local machines and remote servers via SSH.

Designed for system administrators and DevOps engineers, this tool streamlines the workflow of managing Nginx `sites-available` and `sites-enabled` directories, integrating a powerful code editor with syntax highlighting and automated service management commands.

## Features

### Core Functionality
* **Dual Operation Modes:**
    * **Local Mode:** Manage Nginx directly on the machine running the application.
    * **Remote Mode:** Connect to remote Linux servers via SSH using key-based authentication.
* **Configuration Management:**
    * View all available configurations.
    * Toggle sites (enable/disable) via symbolic links between `/etc/nginx/sites-available` and `/etc/nginx/sites-enabled`.
    * Create new configuration files from templates.
    * Edit existing configurations safely.
* **Integrated Editor:**
    * Embedded Monaco Editor (the core of VS Code).
    * Custom Nginx syntax highlighting.
    * Automatic layout adjustment.
* **Service Control:**
    * **Test Config:** Run `nginx -t` to validate syntax before reloading.
    * **Reload Service:** Execute `systemctl reload nginx` directly from the UI.
* **Safety & Backups:**
    * Automatic local backups of configuration files before saving changes.
    * Privilege escalation handling (Sudo) for protected system files.

### Technical Capabilities
* **SSH Integration:** Uses the `ssh2` library for secure remote connections.
* **Sudo Management:** Detects passwordless sudo or prompts the user for credentials when root privileges are required for file operations or service restarts.
* **Snippets System:** Built-in library for common Nginx configuration blocks (e.g., logging paths) with clipboard integration.

## Architecture

The application is built on the Electron framework and follows a modular architecture separating the main process (system logic) from the renderer process (UI).

* **Main Process (`main.js`):** Handles the application lifecycle, window management, and native system interactions. It utilizes an Adapter pattern (`LocalAdapter` and `RemoteAdapter`) to abstract file system operations, ensuring the UI code remains agnostic to whether the target is local or remote.
* **Renderer Process (`renderer.js`):** Manages the DOM, event listeners, and the Monaco Editor instance.
* **Preload Script (`preload.js`):** Uses `contextBridge` to expose specific, secure API methods to the frontend, maintaining Context Isolation.

## Prerequisites

To run this application, the following requirements must be met:

1.  **Node.js:** Version 16.x or higher is recommended.
2.  **Nginx:** The target machine (local or remote) must have Nginx installed with the standard directory structure:
    * `/etc/nginx/sites-available`
    * `/etc/nginx/sites-enabled`
3.  **SSH Access (For Remote Mode):**
    * SSH Private Key file (OpenSSH format).
    * The user must have `sudo` privileges on the remote server.
    * Run `sudo visudo` command, add new line `ubuntu ALL=(ALL) NOPASSWD:ALL`. Replace `ubuntu` with your linux server username.

## File paths

### Code Snippet files were save in the following dir
```
# Linux
~/.config/nginx-config-manager/snippets

# Windows
C:\Users\<User>\AppData\Roaming\nginx-config-manager\snippets\

```

### Backup nginx config files were saved in the following path
```
# Linux
~/.config/nginx-config-manager/backups

# Windows
C:\Users\<User>\AppData\Roaming\nginx-config-manager\backups\
```

## Installation

Clone the repository and install the dependencies:

```bash
git clone [https://github.com/your-username/nginx-config-manager.git](https://github.com/your-username/nginx-config-manager.git)
cd nginx-config-manager
npm install
