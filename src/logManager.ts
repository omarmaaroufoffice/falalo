import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class LogManager {
    private static instance: LogManager;
    private logChannel: vscode.OutputChannel;
    private errorLogFile: string;
    private aiResponseLogFile: string;
    private statusBarItem: vscode.StatusBarItem;

    private constructor() {
        this.logChannel = vscode.window.createOutputChannel('Falalo AI');
        const extensionPath = vscode.extensions.getExtension('falalo')?.extensionPath || '';
        const logsDir = path.join(extensionPath, 'logs');
        
        // Create logs directory if it doesn't exist
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        this.errorLogFile = path.join(logsDir, 'error.log');
        this.aiResponseLogFile = path.join(logsDir, 'ai_responses.log');

        // Create status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.text = "$(output) Falalo Logs";
        this.statusBarItem.tooltip = "Click to show Falalo AI logs";
        this.statusBarItem.command = 'falalo.showLogs';
        this.statusBarItem.show();

        // Register command to show logs
        vscode.commands.registerCommand('falalo.showLogs', () => {
            this.show();
        });
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

        // Always show in output channel
        this.logChannel.appendLine(logMessage);

        // Log errors to error log file
        if (type === 'error') {
            fs.appendFileSync(this.errorLogFile, logMessage + '\n');
            // Update status bar for errors
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            this.statusBarItem.text = "$(error) Falalo Logs (Error)";
            setTimeout(() => {
                this.statusBarItem.backgroundColor = undefined;
                this.statusBarItem.text = "$(output) Falalo Logs";
            }, 3000);
        }

        // Log AI responses to AI log file
        if (type === 'ai') {
            fs.appendFileSync(this.aiResponseLogFile, logMessage + '\n');
            // Update status bar for AI responses
            this.statusBarItem.text = "$(sync~spin) Falalo Logs (AI)";
            setTimeout(() => {
                this.statusBarItem.text = "$(output) Falalo Logs";
            }, 1000);
        }

        // Show errors in the console as well
        if (type === 'error') {
            console.error(logMessage);
            vscode.window.showErrorMessage(`Falalo Error: ${message}`, 'Show Logs').then(selection => {
                if (selection === 'Show Logs') {
                    this.show();
                }
            });
        } else {
            console.log(logMessage);
        }
    }

    public logError(error: any, context?: string): void {
        const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
        const contextMessage = context ? ` [Context: ${context}]` : '';
        this.log(`Error${contextMessage}: ${errorMessage}`, 'error');
    }

    public logAIResponse(response: any, context?: string): void {
        const contextMessage = context ? ` [Context: ${context}]` : '';
        this.log(`AI Response${contextMessage}:\n${JSON.stringify(response, null, 2)}`, 'ai');
    }

    public show(): void {
        this.logChannel.show();
    }

    public dispose(): void {
        this.statusBarItem.dispose();
        this.logChannel.dispose();
    }
} 