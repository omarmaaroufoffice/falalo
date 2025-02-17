import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { validatePath } from './helpers';
import { LogManager } from '../logManager';
import { FileOperation } from '../interfaces/types';

export async function handleFileOperations(operations: FileOperation[]): Promise<void> {
    const logger = LogManager.getInstance();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    
    if (!workspaceRoot) {
        throw new Error('No workspace folder found');
    }

    for (const operation of operations) {
        const fullPath = path.join(workspaceRoot, operation.path);
        
        try {
            // Always ensure the directory exists
            await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });

            switch (operation.type) {
                case 'create':
                    if (operation.content === undefined || operation.content === '') {
                        // This is a folder creation operation
                        await fs.promises.mkdir(fullPath, { recursive: true });
                        logger.log(`Created directory: ${operation.path}`, { type: 'info' });
                    } else {
                        // This is a file creation operation
                        await fs.promises.writeFile(fullPath, operation.content);
                        logger.log(`Created file: ${operation.path}`, { type: 'info' });
                    }
                    break;

                case 'update':
                    if (!operation.content) {
                        throw new Error('Content is required for update operation');
                    }
                    await fs.promises.writeFile(fullPath, operation.content);
                    logger.log(`Updated file: ${operation.path}`, { type: 'info' });
                    break;

                case 'delete':
                    await fs.promises.unlink(fullPath);
                    logger.log(`Deleted file: ${operation.path}`, { type: 'info' });
                    break;

                default:
                    throw new Error(`Unknown operation type: ${operation.type}`);
            }
        } catch (error) {
            logger.logError(error, `Failed to ${operation.type} file ${operation.path}`);
            throw error;
        }
    }
}

export function processResponseWithCodeBlocks(response: string): FileOperation[] {
    const operations: FileOperation[] = [];
    const codeBlockRegex = /```(?:[\w.]*\n)?File: ([^\n]+)\n([\s\S]*?)```/g;
    let match;

    while ((match = codeBlockRegex.exec(response)) !== null) {
        const [_, filePath, content] = match;
        if (filePath && content) {
            const trimmedPath = filePath.trim();
            const trimmedContent = content.trim();
            
            if (trimmedPath && trimmedContent) {
                operations.push({
                    type: 'create',
                    path: trimmedPath,
                    content: trimmedContent
                });
            }
        }
    }

    // Also handle folder creation
    const folderRegex = /\$\$\$ FOLDER_CREATE ([^\n%]+) %%%/g;
    while ((match = folderRegex.exec(response)) !== null) {
        const [_, folderPath] = match;
        if (folderPath) {
            const trimmedPath = folderPath.trim();
            if (trimmedPath) {
                operations.push({
                    type: 'create',
                    path: trimmedPath,
                    content: '' // Empty content for folders
                });
            }
        }
    }

    return operations;
}

function escapeHtml(text: string): string {
    const htmlEntities: { [key: string]: string } = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return text.replace(/[&<>"']/g, char => htmlEntities[char]);
}

export async function createFile(filePath: string, content: string, workspaceRoot: string): Promise<void> {
    const fullPath = path.join(workspaceRoot, filePath);
    
    if (!validatePath(fullPath)) {
        throw new Error(`Invalid file path: ${filePath}`);
    }

    const directory = path.dirname(fullPath);
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(fullPath, content);
}

export async function modifyFile(filePath: string, content: string, workspaceRoot: string): Promise<void> {
    const fullPath = path.join(workspaceRoot, filePath);
    
    if (!validatePath(fullPath)) {
        throw new Error(`Invalid file path: ${filePath}`);
    }

    if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    await fs.promises.writeFile(fullPath, content);
}

export async function createDirectory(dirPath: string, workspaceRoot: string): Promise<void> {
    const fullPath = path.join(workspaceRoot, dirPath);
    
    if (!validatePath(fullPath)) {
        throw new Error(`Invalid directory path: ${dirPath}`);
    }

    await fs.promises.mkdir(fullPath, { recursive: true });
}

export async function deleteFile(filePath: string, workspaceRoot: string): Promise<void> {
    const fullPath = path.join(workspaceRoot, filePath);
    
    if (!validatePath(fullPath)) {
        throw new Error(`Invalid file path: ${filePath}`);
    }

    if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    await fs.promises.unlink(fullPath);
}

export async function readFile(filePath: string, workspaceRoot: string): Promise<string> {
    const fullPath = path.join(workspaceRoot, filePath);
    
    if (!validatePath(fullPath)) {
        throw new Error(`Invalid file path: ${filePath}`);
    }

    if (!fs.existsSync(fullPath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    return fs.promises.readFile(fullPath, 'utf-8');
}

export async function listFiles(dirPath: string, workspaceRoot: string): Promise<string[]> {
    const fullPath = path.join(workspaceRoot, dirPath);
    
    if (!validatePath(fullPath)) {
        throw new Error(`Invalid directory path: ${dirPath}`);
    }

    if (!fs.existsSync(fullPath)) {
        throw new Error(`Directory not found: ${dirPath}`);
    }

    const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
    return entries
        .filter(entry => entry.isFile())
        .map(entry => entry.name);
}

export async function listDirectories(dirPath: string, workspaceRoot: string): Promise<string[]> {
    const fullPath = path.join(workspaceRoot, dirPath);
    
    if (!validatePath(fullPath)) {
        throw new Error(`Invalid directory path: ${dirPath}`);
    }

    if (!fs.existsSync(fullPath)) {
        throw new Error(`Directory not found: ${dirPath}`);
    }

    const entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
    return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
} 