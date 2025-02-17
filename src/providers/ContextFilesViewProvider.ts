import * as vscode from 'vscode';
import * as path from 'path';
import { ContextManager } from '../services/ContextManager';

export class ContextFilesViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly contextManager: ContextManager
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this.extensionUri
            ]
        };

        webviewView.webview.html = this.getWebviewContent(webviewView.webview);
        this.setWebviewMessageListener(webviewView.webview);
        this.updateContextFiles();
    }

    private setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async message => {
            try {
                switch (message.type) {
                    case 'removeFile':
                        if (message.path) {
                            await this.handleRemoveFile(message.path);
                        }
                        break;
                    case 'refresh':
                        await this.updateContextFiles();
                        break;
                    case 'openFile':
                        if (message.path) {
                            await this.openFile(message.path);
                        }
                        break;
                    case 'loadAll':
                        await this.handleLoadAll();
                        break;
                    case 'excludeAll':
                        await this.handleExcludeAll();
                        break;
                }
            } catch (error: any) {
                this.handleError(error);
            }
        });
    }

    private async openFile(filePath: string) {
        try {
            const fullPath = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, filePath);
            const uri = vscode.Uri.file(fullPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            this.handleError(error);
        }
    }

    private async handleRemoveFile(filePath: string) {
        try {
            const fullPath = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, filePath);
            await this.contextManager.removeFromContext(fullPath);
            await this.updateContextFiles();
            
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'fileOperation',
                    success: true,
                    details: `Removed from context: ${filePath}`
                });
            }
        } catch (error) {
            this.handleError(error);
        }
    }

    private async handleLoadAll() {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                throw new Error('No workspace folder found');
            }

            // Get all files in the workspace
            const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
            
            // Add each file to context
            for (const file of files) {
                try {
                    await this.contextManager.addToContext(file.fsPath);
                } catch (error) {
                    console.warn(`Failed to add file to context: ${file.fsPath}`, error);
                }
            }

            await this.updateContextFiles();
            
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'status',
                    text: `Added ${files.length} files to context`,
                    status: 'success'
                });
            }
        } catch (error) {
            this.handleError(error);
        }
    }

    private async handleExcludeAll() {
        try {
            await this.contextManager.clearContext();
            await this.updateContextFiles();
            
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'status',
                    text: 'Cleared all files from context',
                    status: 'success'
                });
            }
        } catch (error) {
            this.handleError(error);
        }
    }

    private handleError(error: any) {
        console.error('Context Files View Error:', error);
        const errorMessage = error?.message || 'Unknown error occurred';
        vscode.window.showErrorMessage(`Context Files Error: ${errorMessage}`);
        
        if (this._view) {
            this._view.webview.postMessage({
                type: 'error',
                message: errorMessage
            });
        }
    }

    public async updateContextFiles() {
        if (!this._view) {
            return;
        }

        try {
            const contextFiles = await this.contextManager.getContextFiles();
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            
            if (!workspaceRoot) {
                throw new Error('No workspace folder found');
            }

            const fileInfo = await Promise.all(contextFiles.map(async (file: string) => {
                const relativePath = path.relative(workspaceRoot, file);
                const stats = await vscode.workspace.fs.stat(vscode.Uri.file(file));
                const isDirectory = (stats.type & vscode.FileType.Directory) !== 0;
                const extension = path.extname(file).toLowerCase();

                return {
                    path: relativePath,
                    name: path.basename(file),
                    isDirectory,
                    extension,
                    type: this.getFileType(extension, isDirectory)
                };
            }));

            this._view.webview.postMessage({
                type: 'updateFiles',
                files: fileInfo
            });
        } catch (error) {
            this.handleError(error);
        }
    }

    private getFileType(extension: string, isDirectory: boolean): string {
        if (isDirectory) return 'folder';

        const fileTypeMap: { [key: string]: string } = {
            '.ts': 'typescript',
            '.js': 'javascript',
            '.jsx': 'react',
            '.tsx': 'react',
            '.json': 'json',
            '.html': 'html',
            '.css': 'css',
            '.scss': 'sass',
            '.less': 'less',
            '.py': 'python',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
            '.h': 'header',
            '.md': 'markdown',
            '.txt': 'text',
            '.xml': 'xml',
            '.svg': 'svg',
            '.png': 'image',
            '.jpg': 'image',
            '.jpeg': 'image',
            '.gif': 'image',
            '.pdf': 'pdf',
            '.zip': 'archive',
            '.tar': 'archive',
            '.gz': 'archive',
            '.7z': 'archive'
        };

        return fileTypeMap[extension] || 'file';
    }

    private getWebviewContent(webview: vscode.Webview): string {
        const nonce = this.getNonce();
        const styleVscodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'css', 'style.css'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
    <link rel="stylesheet" href="${styleVscodeUri}">
    <title>Context Files</title>
    <style>
        .context-files-container {
            padding: 10px;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            padding: 5px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-sideBar-border);
        }
        .header h2 {
            margin: 0;
            font-size: 14px;
            font-weight: normal;
        }
        .header-buttons {
            display: flex;
            gap: 4px;
            align-items: center;
        }
        .action-button {
            background: none;
            border: none;
            color: var(--vscode-button-foreground);
            cursor: pointer;
            padding: 4px 8px;
            border-radius: 3px;
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
        }
        .action-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .refresh-button {
            background: none;
            border: none;
            color: var(--vscode-button-foreground);
            cursor: pointer;
            padding: 4px;
        }
        .refresh-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .file-list {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .file-item {
            display: flex;
            align-items: center;
            padding: 4px 8px;
            border-radius: 3px;
            cursor: pointer;
            user-select: none;
        }
        .file-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .file-icon {
            margin-right: 6px;
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .file-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .remove-button {
            opacity: 0;
            background: none;
            border: none;
            color: var(--vscode-errorForeground);
            cursor: pointer;
            padding: 2px 6px;
            font-size: 12px;
            border-radius: 3px;
        }
        .file-item:hover .remove-button {
            opacity: 1;
        }
        .remove-button:hover {
            background: var(--vscode-errorForeground);
            color: var(--vscode-button-foreground);
        }
        .empty-state {
            padding: 20px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
        .file-icon.folder::before { content: "📁"; }
        .file-icon.file::before { content: "📄"; }
        .file-icon.typescript::before { content: "TS"; }
        .file-icon.javascript::before { content: "JS"; }
        .file-icon.react::before { content: "⚛️"; }
        .file-icon.json::before { content: "{ }"; }
        .file-icon.html::before { content: "🌐"; }
        .file-icon.css::before { content: "🎨"; }
        .file-icon.markdown::before { content: "📝"; }
        .file-icon.image::before { content: "🖼️"; }
        .file-icon.archive::before { content: "📦"; }
    </style>
</head>
<body>
    <div class="context-files-container">
        <div class="header">
            <h2>Context Files</h2>
            <div class="header-buttons">
                <button id="loadAllButton" class="action-button" title="Load all files">
                    📥 Load All
                </button>
                <button id="excludeAllButton" class="action-button" title="Exclude all files">
                    🗑️ Exclude All
                </button>
                <button id="refreshButton" class="refresh-button" title="Refresh">
                    🔄
                </button>
            </div>
        </div>
        <div id="fileList" class="file-list"></div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const fileList = document.getElementById('fileList');
        const refreshButton = document.getElementById('refreshButton');
        const loadAllButton = document.getElementById('loadAllButton');
        const excludeAllButton = document.getElementById('excludeAllButton');

        refreshButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });

        loadAllButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'loadAll' });
        });

        excludeAllButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'excludeAll' });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'updateFiles':
                    updateFileList(message.files);
                    break;
                case 'error':
                    showError(message.message);
                    break;
            }
        });

        function updateFileList(files) {
            fileList.innerHTML = '';
            
            if (!files || files.length === 0) {
                const emptyState = document.createElement('div');
                emptyState.className = 'empty-state';
                emptyState.textContent = 'No files in context';
                fileList.appendChild(emptyState);
                return;
            }

            files.forEach(file => {
                const fileItem = document.createElement('div');
                fileItem.className = 'file-item';
                
                const fileIcon = document.createElement('span');
                fileIcon.className = \`file-icon \${file.type}\`;
                
                const fileName = document.createElement('span');
                fileName.className = 'file-name';
                fileName.textContent = file.path;
                fileName.title = file.path;
                
                const removeButton = document.createElement('button');
                removeButton.className = 'remove-button';
                removeButton.innerHTML = '✕';
                removeButton.title = 'Remove from context';
                
                fileItem.appendChild(fileIcon);
                fileItem.appendChild(fileName);
                fileItem.appendChild(removeButton);
                
                fileItem.addEventListener('click', (e) => {
                    if (e.target !== removeButton) {
                        vscode.postMessage({
                            type: 'openFile',
                            path: file.path
                        });
                    }
                });
                
                removeButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    vscode.postMessage({
                        type: 'removeFile',
                        path: file.path
                    });
                });
                
                fileList.appendChild(fileItem);
            });
        }

        function showError(message) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'error-message';
            errorDiv.textContent = message;
            fileList.innerHTML = '';
            fileList.appendChild(errorDiv);
        }
    </script>
</body>
</html>`;
    }

    private getNonce() {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
} 