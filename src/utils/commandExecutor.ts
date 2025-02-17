import * as vscode from 'vscode';
import { exec } from 'child_process';
import { LogManager } from '../logManager';
import { CommandOptions, CommandExecution, LogOptions } from '../interfaces/types';

export async function executeCommand(command: string, options: Partial<CommandExecution> = {}): Promise<string> {
    const logger = LogManager.getInstance();

    const defaultOptions: CommandExecution = {
        command: command,
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
        isBackground: false,
        description: 'Executing command'
    };

    const finalOptions = { ...defaultOptions, ...options };

    logger.log(`${finalOptions.description}: ${finalOptions.command}`);

    return new Promise((resolve, reject) => {
        const childProcess = exec(
            finalOptions.command,
            {
                cwd: finalOptions.cwd,
                env: process.env
            },
            (error, stdout, stderr) => {
                if (error) {
                    logger.logError(error, `Command execution failed: ${finalOptions.command}`);
                    reject(new Error(`Command failed: ${error.message}\n${stderr}`));
                    return;
                }

                if (stderr) {
                    logger.log(`Command stderr: ${stderr}`, { type: 'info' } as LogOptions);
                }

                resolve(stdout.trim());
            }
        );

        if (finalOptions.isBackground) {
            childProcess.unref();
            resolve('Command started in background');
        }
    });
}

export async function executeCommands(options: CommandOptions, workspaceRoot: string): Promise<string> {
    const logger = LogManager.getInstance();
    const maxRetries = options.maxRetries || 1;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            for (const command of options.commands) {
                await new Promise<void>((resolve, reject) => {
                    exec(command, { cwd: options.cwd || workspaceRoot }, (error, stdout, stderr) => {
                        if (error) {
                            logger.logError(error, `Command execution failed: ${command}`);
                            reject(error);
                            return;
                        }

                        if (stderr) {
                            logger.log(stderr, { type: 'info' } as LogOptions);
                        }

                        if (stdout) {
                            logger.log(stdout, { type: 'info' } as LogOptions);
                        }

                        resolve();
                    });
                });
            }

            if (options.description) {
                logger.log(options.description, { type: 'info' } as LogOptions);
            }

            return 'Commands executed successfully';
        } catch (error) {
            lastError = error as Error;
            logger.logError(error, `Command execution attempt ${attempt}/${maxRetries}`);

            if (attempt === maxRetries) {
                throw lastError;
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    throw lastError;
}

export async function executeCommandWithRetry(
    command: string,
    options: Partial<CommandExecution> = {},
    maxRetries: number = 3,
    retryDelay: number = 1000
): Promise<string> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await executeCommand(command, options);
        } catch (error: any) {
            lastError = error;
            LogManager.getInstance().log(
                `Command failed (attempt ${attempt}/${maxRetries}): ${error.message}`,
                { type: 'info' } as LogOptions
            );

            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }

    throw lastError || new Error(`Command failed after ${maxRetries} attempts`);
}

export async function executeCommandWithTimeout(
    command: string,
    options: Partial<CommandExecution> = {},
    timeoutMs: number = 30000
): Promise<string> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
        }, timeoutMs);

        executeCommand(command, options)
            .then(result => {
                clearTimeout(timeoutId);
                resolve(result);
            })
            .catch(error => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

export async function executeCommandWithProgress(
    command: string,
    options: Partial<CommandExecution> = {}
): Promise<string> {
    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: options.description || 'Executing command...',
            cancellable: false
        },
        async (progress) => {
            progress.report({ increment: 0 });
            
            try {
                const result = await executeCommand(command, options);
                progress.report({ increment: 100 });
                return result;
            } catch (error) {
                progress.report({ increment: 100 });
                throw error;
            }
        }
    );
}

export async function executeCommandWithInput(
    command: string,
    input: string,
    options: Partial<CommandExecution> = {}
): Promise<string> {
    const logger = LogManager.getInstance();

    const defaultOptions: CommandExecution = {
        command: command,
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
        isBackground: false,
        description: 'Executing command with input'
    };

    const finalOptions = { ...defaultOptions, ...options };

    logger.log(`${finalOptions.description}: ${finalOptions.command}`);

    return new Promise((resolve, reject) => {
        const childProcess = exec(
            finalOptions.command,
            {
                cwd: finalOptions.cwd,
                env: process.env
            },
            (error, stdout, stderr) => {
                if (error) {
                    logger.logError(error, `Command execution failed: ${finalOptions.command}`);
                    reject(new Error(`Command failed: ${error.message}\n${stderr}`));
                    return;
                }

                if (stderr) {
                    logger.log(`Command stderr: ${stderr}`, { type: 'info' } as LogOptions);
                }

                resolve(stdout.trim());
            }
        );

        childProcess.stdin?.write(input);
        childProcess.stdin?.end();
    });
} 