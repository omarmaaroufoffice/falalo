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
                }
            } catch (error: any) {
                this.handleError(error);
            }
        });
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

            const relativePaths = contextFiles.map((file: string) => {
                return path.relative(workspaceRoot, file);
            });

            this._view.webview.postMessage({
                type: 'updateFiles',
                files: relativePaths
            });
        } catch (error) {
            this.handleError(error);
        }
    }

    private getWebviewContent(webview: vscode.Webview): string {
        const nonce = this.getNonce();
        const styleVscodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'css', 'style.css'));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleVscodeUri}">
    <title>Context Files</title>
</head>
<body>
    <div class="context-files-container">
        <div class="header">
            <h2>Context Files</h2>
            <button id="refreshButton" class="icon-button">
                <span class="codicon codicon-refresh"></span>
            </button>
        </div>
        <div id="fileList" class="file-list"></div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const fileList = document.getElementById('fileList');
        const refreshButton = document.getElementById('refreshButton');

        refreshButton.addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
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
            files.forEach(file => {
                const fileItem = document.createElement('div');
                fileItem.className = 'file-item';
                
                const fileName = document.createElement('span');
                fileName.className = 'file-name';
                fileName.textContent = file;
                
                const removeButton = document.createElement('button');
                removeButton.className = 'remove-button';
                removeButton.innerHTML = '&times;';
                removeButton.title = 'Remove from context';
                removeButton.onclick = () => {
                    vscode.postMessage({
                        type: 'removeFile',
                        path: file
                    });
                };
                
                fileItem.appendChild(fileName);
                fileItem.appendChild(removeButton);
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