import * as vscode from 'vscode';
import * as path from 'path';
import { ContextManager } from '../services/ContextManager';

export async function getWorkspaceContext(contextManager: ContextManager): Promise<string> {
    const files = await contextManager.getContextFiles();
    if (files.length === 0) {
        return 'No files in context.';
    }
    return files.join('\n');
}

export async function addFileToContext(filePath: string, contextManager: ContextManager): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        throw new Error('No workspace folder found');
    }

    const absolutePath = path.isAbsolute(filePath) 
        ? filePath 
        : path.join(workspaceRoot, filePath);

    await contextManager.addToContext(absolutePath);
}

export async function removeFileFromContext(filePath: string, contextManager: ContextManager): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        throw new Error('No workspace folder found');
    }

    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(workspaceRoot, filePath);

    await contextManager.removeFromContext(absolutePath);
}

export async function addCurrentFileToContext(contextManager: ContextManager): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        throw new Error('No active text editor');
    }

    await contextManager.addToContext(activeEditor.document.uri.fsPath);
}

export async function addSelectedFilesToContext(contextManager: ContextManager): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        throw new Error('No workspace folder found');
    }

    const result = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        defaultUri: vscode.Uri.file(workspaceRoot),
        filters: {
            'All Files': ['*']
        }
    });

    if (!result) {
        return;
    }

    for (const uri of result) {
        await contextManager.addToContext(uri.fsPath);
    }
}

export async function addWorkspaceFilesToContext(contextManager: ContextManager, pattern: string = '**/*'): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        throw new Error('No workspace folder found');
    }

    const files = await vscode.workspace.findFiles(pattern);
    for (const file of files) {
        try {
            await contextManager.addToContext(file.fsPath);
        } catch (error) {
            console.warn(`Failed to add file to context: ${file.fsPath}`, error);
        }
    }
}

export async function clearContext(contextManager: ContextManager): Promise<void> {
    await contextManager.clearContext();
}

export async function analyzeContext(query: string, contextManager: ContextManager): Promise<string> {
    return await contextManager.analyzeContext(query);
}

export function getRelativePath(filePath: string): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        return filePath;
    }
    return path.relative(workspaceRoot, filePath);
}

export function getAbsolutePath(relativePath: string): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        throw new Error('No workspace folder found');
    }

    return path.join(workspaceRoot, relativePath);
} 