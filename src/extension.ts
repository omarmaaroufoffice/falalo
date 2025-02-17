import * as vscode from 'vscode';
import { OpenAI } from 'openai';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { ContextFilesViewProvider } from './providers/ContextFilesViewProvider';
import { ContextManager } from './services/ContextManager';
import { LogManager } from './logManager';
import { initializeTaskPlanner } from './services/taskPlanner';
import { initializeOpenAI } from './services/openai';

export async function activate(context: vscode.ExtensionContext) {
    try {
        // Initialize OpenAI client
        const openai = await initializeOpenAI(context);
        if (!openai) {
            throw new Error('Failed to initialize OpenAI client');
        }

        // Initialize task planner
        initializeTaskPlanner(openai);

        // Initialize context manager
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('No workspace folder found');
        }
        const contextManager = new ContextManager(openai, workspaceRoot);

        // Register Chat View Provider
        const chatViewProvider = new ChatViewProvider(
            context.extensionUri,
            openai,
            contextManager
        );
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('falalo.chatView', chatViewProvider)
        );

        // Register Context Files View Provider
        const contextFilesViewProvider = new ContextFilesViewProvider(
            context.extensionUri,
            contextManager
        );
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('falalo.contextFilesView', contextFilesViewProvider)
        );

        // Register commands
        context.subscriptions.push(
            vscode.commands.registerCommand('falalo.startChat', () => {
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
        LogManager.getInstance().log('Falalo AI Assistant activated', { type: 'info' });
        vscode.window.showInformationMessage('Falalo AI Assistant is ready!');

    } catch (error) {
        LogManager.getInstance().logError(error, 'Extension activation');
        vscode.window.showErrorMessage(`Failed to activate Falalo: ${error instanceof Error ? error.message : 'Unknown error'}`);
        throw error;
    }
}

export function deactivate() {
    // Clean up resources
    LogManager.getInstance().dispose();
} 