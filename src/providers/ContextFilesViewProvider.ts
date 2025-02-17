import * as vscode from 'vscode';
import * as path from 'path';
import { ContextManager } from '../services/ContextManager';

interface TreeNode {
    name: string;
    path: string;
    children: { [key: string]: TreeNode };
    type: 'file' | 'directory';
    isIncluded: boolean;
    extension: string | null;
}

interface TreeItem {
    name: string;
    path: string;
    children: TreeItem[];
    type: 'file' | 'directory';
    isIncluded: boolean;
    extension: string | null;
}

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
                    case 'toggleFile':
                        if (message.path !== undefined) {
                            await this.handleToggleFile(message.path, message.include);
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

    private async handleToggleFile(filePath: string, include: boolean) {
        try {
            const fullPath = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, filePath);
            
            if (include) {
                await this.contextManager.addToContext(fullPath);
            } else {
                await this.contextManager.removeFromContext(fullPath);
            }

            await this.updateContextFiles();
            
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'status',
                    text: `${include ? 'Added to' : 'Removed from'} context: ${filePath}`,
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
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                throw new Error('No workspace folder found');
            }

            // Get all files in workspace
            const allFiles = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
            
            // Get current context files
            const contextFiles = await this.contextManager.getContextFiles();
            const contextFileSet = new Set(contextFiles);

            // Build tree structure
            const tree = this.buildFileTree(allFiles.map(f => ({
                path: path.relative(workspaceRoot, f.fsPath),
                isIncluded: contextFileSet.has(f.fsPath)
            })));

            this._view.webview.postMessage({
                type: 'updateTree',
                tree: tree
            });
        } catch (error) {
            this.handleError(error);
        }
    }

    private buildFileTree(files: { path: string; isIncluded: boolean }[]): TreeItem[] {
        const root: TreeNode = { name: 'root', path: '', children: {}, type: 'directory', isIncluded: false, extension: null };

        for (const file of files) {
            const parts = file.path.split(path.sep);
            let current = root;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const isLast = i === parts.length - 1;
                
                if (!current.children[part]) {
                    current.children[part] = {
                        name: part,
                        path: parts.slice(0, i + 1).join(path.sep),
                        children: {},
                        type: isLast ? 'file' : 'directory',
                        isIncluded: isLast ? file.isIncluded : false,
                        extension: isLast ? path.extname(part).toLowerCase() : null
                    };
                }
                current = current.children[part];
            }
        }

        return this.convertToArray(root);
    }

    private convertToArray(node: TreeNode): TreeItem[] {
        const children = Object.values(node.children).map((child: TreeNode): TreeItem => ({
            ...child,
            children: this.convertToArray(child)
        }));

        return children.sort((a: TreeItem, b: TreeItem) => {
            if (a.type === b.type) {
                return a.name.localeCompare(b.name);
            }
            return a.type === 'directory' ? -1 : 1;
        });
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
        .tree-item {
            display: flex;
            align-items: center;
            padding: 2px 4px;
            cursor: pointer;
            user-select: none;
            border-radius: 3px;
            margin: 1px 0;
            transition: background-color 0.1s;
        }
        .tree-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .tree-item.included {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .tree-item-indent {
            width: 16px;
            height: 100%;
            flex-shrink: 0;
            position: relative;
        }
        .tree-item-indent::after {
            content: '';
            position: absolute;
            left: 50%;
            top: 0;
            bottom: 0;
            width: 1px;
            background-color: var(--vscode-list-inactiveSelectionBackground);
            opacity: 0.3;
        }
        .tree-item-content {
            display: flex;
            align-items: center;
            gap: 4px;
            flex: 1;
            min-width: 0;
            padding: 2px 0;
        }
        .tree-item-icon {
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            font-size: 14px;
            opacity: 0.8;
        }
        .tree-item-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 13px;
        }
        .tree-item-actions {
            opacity: 0;
            display: flex;
            gap: 4px;
            transition: opacity 0.1s;
        }
        .tree-item:hover .tree-item-actions {
            opacity: 1;
        }
        .tree-toggle {
            width: 16px;
            height: 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            font-size: 10px;
            opacity: 0.7;
            transition: transform 0.1s;
        }
        .tree-toggle.expanded {
            transform: rotate(90deg);
        }
        .file-icon {
            font-family: codicon;
            font-size: 16px;
            line-height: 1;
        }
        .file-icon.folder { color: var(--vscode-gitDecoration-untrackedResourceForeground); }
        .file-icon.typescript { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
        .file-icon.javascript { color: var(--vscode-gitDecoration-addedResourceForeground); }
        .file-icon.react { color: var(--vscode-gitDecoration-conflictingResourceForeground); }
        .file-icon.json { color: var(--vscode-gitDecoration-submoduleResourceForeground); }
        .file-icon.html { color: var(--vscode-errorForeground); }
        .file-icon.css { color: var(--vscode-textLink-foreground); }
        .file-icon.markdown { color: var(--vscode-textPreformat-foreground); }
        .file-icon.python { color: var(--vscode-debugIcon-breakpointForeground); }
        .file-icon.java { color: var(--vscode-symbolIcon-classForeground); }
        .status {
            padding: 4px 8px;
            margin-top: 8px;
            border-radius: 3px;
            font-size: 12px;
            display: none;
            animation: fadeIn 0.2s ease-in-out;
        }
        .status.success {
            background: var(--vscode-gitDecoration-addedResourceForeground);
            color: var(--vscode-editor-background);
        }
        .status.error {
            background: var(--vscode-errorForeground);
            color: var(--vscode-editor-background);
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }
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
        <div id="fileTree" class="file-list"></div>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const fileTree = document.getElementById('fileTree');
        const refreshButton = document.getElementById('refreshButton');
        const loadAllButton = document.getElementById('loadAllButton');
        const excludeAllButton = document.getElementById('excludeAllButton');
        const expandedDirs = new Set();

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
                case 'updateTree':
                    renderTree(message.tree);
                    break;
                case 'error':
                    showError(message.message);
                    break;
                case 'status':
                    showStatus(message.text, message.status);
                    break;
            }
        });

        function renderTree(items, level = 0) {
            fileTree.innerHTML = '';
            
            if (!items || items.length === 0) {
                const emptyState = document.createElement('div');
                emptyState.className = 'empty-state';
                emptyState.textContent = 'No files in context';
                fileTree.appendChild(emptyState);
                return;
            }

            function renderItem(item, level) {
                const itemDiv = document.createElement('div');
                itemDiv.className = \`tree-item \${item.isIncluded ? 'included' : ''}\`;
                
                // Add indentation
                for (let i = 0; i < level; i++) {
                    const indent = document.createElement('div');
                    indent.className = 'tree-item-indent';
                    itemDiv.appendChild(indent);
                }

                const content = document.createElement('div');
                content.className = 'tree-item-content';

                // Add toggle for directories
                if (item.type === 'directory') {
                    const toggle = document.createElement('span');
                    toggle.className = \`tree-toggle \${expandedDirs.has(item.path) ? 'expanded' : ''}\`;
                    toggle.textContent = expandedDirs.has(item.path) ? '▼' : '▶';
                    toggle.onclick = (e) => {
                        e.stopPropagation();
                        if (expandedDirs.has(item.path)) {
                            expandedDirs.delete(item.path);
                        } else {
                            expandedDirs.add(item.path);
                        }
                        renderTree(items, level);
                    };
                    content.appendChild(toggle);
                }

                // Add icon
                const icon = document.createElement('span');
                icon.className = \`tree-item-icon file-icon \${item.type === 'directory' ? 'folder' : getFileType(item.extension)}\`;
                icon.textContent = item.type === 'directory' ? '📁' : getFileIcon(item.extension);
                content.appendChild(icon);

                // Add name
                const name = document.createElement('span');
                name.className = 'tree-item-name';
                name.textContent = item.name;
                name.title = item.path;
                content.appendChild(name);

                // Add actions
                if (item.type === 'file') {
                    const actions = document.createElement('div');
                    actions.className = 'tree-item-actions';
                    
                    const toggleButton = document.createElement('button');
                    toggleButton.className = 'action-button';
                    toggleButton.textContent = item.isIncluded ? '❌' : '➕';
                    toggleButton.title = item.isIncluded ? 'Exclude from context' : 'Include in context';
                    toggleButton.onclick = (e) => {
                        e.stopPropagation();
                        vscode.postMessage({
                            type: 'toggleFile',
                            path: item.path,
                            include: !item.isIncluded
                        });
                    };
                    actions.appendChild(toggleButton);
                    content.appendChild(actions);
                }

                itemDiv.appendChild(content);

                // Handle click
                itemDiv.onclick = () => {
                    if (item.type === 'file') {
                        vscode.postMessage({
                            type: 'openFile',
                            path: item.path
                        });
                    } else {
                        if (expandedDirs.has(item.path)) {
                            expandedDirs.delete(item.path);
                        } else {
                            expandedDirs.add(item.path);
                        }
                        renderTree(items, level);
                    }
                };

                fileTree.appendChild(itemDiv);

                // Render children if directory is expanded
                if (item.type === 'directory' && expandedDirs.has(item.path)) {
                    item.children.forEach(child => renderItem(child, level + 1));
                }
            }

            items.forEach(item => renderItem(item, level));
        }

        function getFileIcon(extension) {
            const iconMap = {
                '.ts': 'TS',
                '.js': 'JS',
                '.jsx': '⚛️',
                '.tsx': '⚛️',
                '.json': '{ }',
                '.html': '🌐',
                '.css': '🎨',
                '.md': '📝',
                '.py': '🐍',
                '.java': '☕',
                '.cpp': 'C++',
                '.c': 'C',
                '.h': 'H',
                '.xml': '📄',
                '.svg': '🎨',
                '.png': '🖼️',
                '.jpg': '🖼️',
                '.jpeg': '🖼️',
                '.gif': '🖼️',
                '.pdf': '📕',
                '.zip': '📦',
                '.tar': '📦',
                '.gz': '📦',
                '.7z': '📦'
            };
            return iconMap[extension] || '📄';
        }

        function getFileType(extension) {
            const typeMap = {
                '.ts': 'typescript',
                '.js': 'javascript',
                '.jsx': 'react',
                '.tsx': 'react',
                '.json': 'json',
                '.html': 'html',
                '.css': 'css',
                '.md': 'markdown',
                '.py': 'python',
                '.java': 'java'
            };
            return typeMap[extension] || 'file';
        }

        function showStatus(message, type = 'info') {
            const statusDiv = document.createElement('div');
            statusDiv.className = \`status \${type}\`;
            statusDiv.textContent = message;
            fileTree.insertAdjacentElement('afterend', statusDiv);
            
            setTimeout(() => {
                statusDiv.remove();
            }, 3000);
        }

        function showError(message) {
            showStatus(message, 'error');
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