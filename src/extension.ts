import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { OpenAI } from 'openai';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { ContextFilesViewProvider } from './providers/ContextFilesViewProvider';
import { ContextManager } from './services/ContextManager';
import { LogManager } from './logManager';
import { initializeTaskPlanner } from './services/taskPlanner';
import { initializeOpenAI } from './services/openai';

export async function activate(context: vscode.ExtensionContext) {
    const logger = LogManager.getInstance();
    logger.log('Activating Falalo extension...', { type: 'info' });

    try {
        // Ensure required directories exist
        const requiredDirs = [
            path.join(context.extensionUri.fsPath, 'media', 'css'),
            path.join(context.extensionUri.fsPath, 'screenshots'),
            path.join(context.extensionUri.fsPath, 'logs')
        ];

        for (const dir of requiredDirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                logger.log(`Created directory: ${dir}`, { type: 'info' });
            }
        }

        // Initialize OpenAI client
        logger.log('Initializing OpenAI client...', { type: 'info' });
        const openai = await initializeOpenAI(context);
        if (!openai) {
            throw new Error('Failed to initialize OpenAI client');
        }

        // Initialize task planner
        logger.log('Initializing task planner...', { type: 'info' });
        initializeTaskPlanner(openai);

        // Initialize context manager
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('No workspace folder found. Please open a workspace to use Falalo.');
        }
        logger.log('Initializing context manager...', { type: 'info' });
        const contextManager = new ContextManager(openai, workspaceRoot);

        // Register Chat View Provider
        logger.log('Registering chat view provider...', { type: 'info' });
        const chatViewProvider = new ChatViewProvider(
            context.extensionUri,
            openai,
            contextManager
        );
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('falalo.chatView', chatViewProvider, {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            })
        );

        // Register Context Files View Provider
        logger.log('Registering context files view provider...', { type: 'info' });
        const contextFilesViewProvider = new ContextFilesViewProvider(
            context.extensionUri,
            contextManager
        );
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('falalo.contextFilesView', contextFilesViewProvider)
        );

        // Register commands
        logger.log('Registering commands...', { type: 'info' });
        context.subscriptions.push(
            vscode.commands.registerCommand('falalo.startChat', () => {
                vscode.commands.executeCommand('workbench.view.extension.falalo-sidebar');
                vscode.commands.executeCommand('falalo.chatView.focus');
            }),

            vscode.commands.registerCommand('falalo.includeInContext', async () => {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    await contextManager.addToContext(activeEditor.document.uri.fsPath);
                    vscode.window.showInformationMessage('File added to AI context');
                }
            }),

            vscode.commands.registerCommand('falalo.excludeFromContext', async () => {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    await contextManager.removeFromContext(activeEditor.document.uri.fsPath);
                    vscode.window.showInformationMessage('File removed from AI context');
                }
            }),

            vscode.commands.registerCommand('falalo.showContextItems', async () => {
                const files = await contextManager.getContextFiles();
                if (files.length === 0) {
                    vscode.window.showInformationMessage('No files in AI context');
                    return;
                }

                const items = files.map(file => ({
                    label: vscode.workspace.asRelativePath(file),
                    description: 'In AI Context'
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Files in AI Context'
                });

                if (selected) {
                    const uri = vscode.Uri.file(files[items.indexOf(selected)]);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc);
                }
            }),

            vscode.commands.registerCommand('falalo.showLogs', () => {
                LogManager.getInstance().show();
            })
        );

        // Log successful activation
        logger.log('Falalo AI Assistant activated successfully', { type: 'info' });
        vscode.window.showInformationMessage('Falalo AI Assistant is ready!');

    } catch (error) {
        logger.logError(error, 'Extension activation');
        vscode.window.showErrorMessage(`Failed to activate Falalo: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
    }
}

export function deactivate() {
    LogManager.getInstance().log('Deactivating Falalo extension...', { type: 'info' });
    LogManager.getInstance().dispose();
} 