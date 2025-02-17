import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class LogManager {
    private static instance: LogManager;
    private logChannel: vscode.OutputChannel;
    private errorLogFile: string;
    private aiResponseLogFile: string;
    private statusBarItem: vscode.StatusBarItem;
    private logsDir: string;

    private constructor() {
        this.logChannel = vscode.window.createOutputChannel('Falalo AI');
        
        // Get extension path more robustly
        const extension = vscode.extensions.getExtension('falalo.falalo');
        if (!extension) {
            // Fallback to a user-specific directory if extension path is not available
            const homeDir = process.env.HOME || process.env.USERPROFILE;
            if (!homeDir) {
                throw new Error('Could not determine home directory for logs');
            }
            this.logsDir = path.join(homeDir, '.falalo', 'logs');
        } else {
            this.logsDir = path.join(extension.extensionPath, 'logs');
        }

        this.errorLogFile = path.join(this.logsDir, 'error.log');
        this.aiResponseLogFile = path.join(this.logsDir, 'ai_responses.log');
        
        // Initialize logs directory and files
        this.initializeLogsDirectory();

        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.updateStatusBarItem();
        this.statusBarItem.show();
    }

    private initializeLogsDirectory() {
        try {
            // Create logs directory if it doesn't exist
            if (!fs.existsSync(this.logsDir)) {
                fs.mkdirSync(this.logsDir, { recursive: true, mode: 0o755 });
            }

            // Ensure log files exist and are writable
            [this.errorLogFile, this.aiResponseLogFile].forEach(file => {
                if (!fs.existsSync(file)) {
                    fs.writeFileSync(file, '', { mode: 0o644 });
                }
                // Test write access
                fs.accessSync(file, fs.constants.W_OK);
            });
        } catch (error) {
            console.error('Error initializing logs directory:', error);
            vscode.window.showErrorMessage(`Failed to initialize logs directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private updateStatusBarItem(type?: 'error' | 'ai') {
        if (type === 'error') {
            this.statusBarItem.text = "$(error) Falalo Logs (Error)";
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            this.statusBarItem.tooltip = "Errors occurred - Click to view logs";
        } else if (type === 'ai') {
            this.statusBarItem.text = "$(sync~spin) Falalo Logs (AI)";
            this.statusBarItem.tooltip = "AI is processing - Click to view logs";
        } else {
            this.statusBarItem.text = "$(output) Falalo Logs";
            this.statusBarItem.backgroundColor = undefined;
            this.statusBarItem.tooltip = "Click to view Falalo AI logs";
        }
        this.statusBarItem.command = 'falalo.showLogs';
    }

    public static getInstance(): LogManager {
        if (!LogManager.instance) {
            LogManager.instance = new LogManager();
        }
        return LogManager.instance;
    }

    public log(message: string, type: 'info' | 'error' | 'ai' = 'info'): void {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;

        try {
            // Always show in output channel
            this.logChannel.appendLine(logMessage);

            // Update status bar and log to file based on type
            if (type === 'error') {
                this.updateStatusBarItem('error');
                fs.appendFileSync(this.errorLogFile, logMessage + '\n');
                console.error(logMessage);
                
                // Show error notification
                vscode.window.showErrorMessage(`Falalo Error: ${message}`, 'Show Logs').then(selection => {
                    if (selection === 'Show Logs') {
                        this.show();
                    }
                });
            } else if (type === 'ai') {
                this.updateStatusBarItem('ai');
                fs.appendFileSync(this.aiResponseLogFile, logMessage + '\n');
                console.log(logMessage);
            } else {
                console.log(logMessage);
            }

            // Reset status bar after delay for non-error messages
            if (type !== 'error') {
                setTimeout(() => {
                    this.updateStatusBarItem();
                }, 3000);
            }
        } catch (error) {
            console.error('Failed to write log:', error);
            // Attempt to show error in VS Code UI even if logging fails
            vscode.window.showErrorMessage(`Failed to write log: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    public logError(error: any, context?: string): void {
        const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
        const contextMessage = context ? ` [Context: ${context}]` : '';
        this.log(`Error${contextMessage}: ${errorMessage}`, 'error');
    }

    public logAIResponse(response: any, context?: string): void {
        let responseStr: string;
        try {
            responseStr = typeof response === 'string' ? response : JSON.stringify(response, null, 2);
        } catch (error) {
            responseStr = '[Unable to stringify response]';
            this.logError(error, 'Failed to stringify AI response');
        }

        const contextMessage = context ? ` [Context: ${context}]` : '';
        this.log(`AI Response${contextMessage}:\n${responseStr}`, 'ai');
    }

    public show(): void {
        this.logChannel.show();
    }

    public dispose(): void {
        this.statusBarItem.dispose();
        this.logChannel.dispose();
    }
} 