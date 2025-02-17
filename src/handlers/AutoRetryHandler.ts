import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { LogManager } from '../logManager';
import { cleanAIResponse, validatePath, sanitizeCommand } from '../utils/helpers';
import { model } from '../services/openai';
import { handleFileOperations } from '../utils/fileOperations';
import { executeCommands } from '../utils/commandExecutor';

export class AutoRetryHandler {
    private static readonly MAX_RETRIES = 50;
    private static readonly RETRY_DELAY = 2000; // 2 seconds
    private static readonly DEPENDENCY_PATTERNS = {
        MODULE_NOT_FOUND: /Cannot find module '([^']+)'/,
        REQUIRE_ERROR: /Error: require\(\) of '([^']+)'/,
        IMPORT_ERROR: /ImportError: No module named '([^']+)'/,
        NPM_MISSING: /npm ERR! missing: ([^@]+)/,
        PYTHON_IMPORT: /ModuleNotFoundError: No module named '([^']+)'/
    };

    private static async detectMissingDependency(error: any): Promise<string | null> {
        const errorString = error?.message || error?.toString() || '';
        
        for (const [key, pattern] of Object.entries(this.DEPENDENCY_PATTERNS)) {
            const match = errorString.match(pattern);
            if (match && match[1]) {
                return match[1].trim();
            }
        }

        if (errorString.includes('node_modules')) {
            const nestedMatch = errorString.match(/node_modules[/\\]([^/\\]+)/);
            if (nestedMatch && nestedMatch[1]) {
                return nestedMatch[1].trim();
            }
        }

        return null;
    }

    private static async getDependencyTree(workspaceRoot: string): Promise<any> {
        try {
            const { execSync } = require('child_process');
            const output = execSync('npm ls --json', { cwd: workspaceRoot });
            return JSON.parse(output.toString());
        } catch (error) {
            console.error('Failed to get dependency tree:', error);
            return {};
        }
    }

    private static findTransitiveDependencyVersions(tree: any, targetDep: string): string[] {
        const versions = new Set<string>();

        const traverse = (node: any) => {
            if (!node || !node.dependencies) return;

            if (node.dependencies[targetDep]) {
                versions.add(node.dependencies[targetDep].version);
            }

            for (const dep of Object.values(node.dependencies)) {
                traverse(dep as any);
            }
        };

        traverse(tree);
        return Array.from(versions);
    }

    private static async resolveDependencyIssue(dependency: string, context: string): Promise<boolean> {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) return false;

            const packageJsonPath = path.join(workspaceRoot, 'package.json');
            let packageJson: any;

            try {
                const packageJsonContent = await fs.promises.readFile(packageJsonPath, 'utf-8');
                packageJson = JSON.parse(packageJsonContent);
            } catch (e) {
                console.log('No package.json found or invalid format');
                return false;
            }

            const allDeps = {
                ...packageJson.dependencies,
                ...packageJson.devDependencies
            };

            const depTree = await this.getDependencyTree(workspaceRoot);
            const transitiveVersions = this.findTransitiveDependencyVersions(depTree, dependency);

            if (transitiveVersions.length > 0) {
                const version = transitiveVersions[0];
                console.log(`Installing ${dependency}@${version} as detected from dependency tree`);
                await executeCommands({
                    commands: [
                        `npm install ${dependency}@${version}`
                    ],
                    description: `Installing missing dependency ${dependency}`
                }, workspaceRoot);
                return true;
            }

            console.log(`Installing latest version of ${dependency}`);
            await executeCommands({
                commands: [
                    `npm install ${dependency}`
                ],
                description: `Installing missing dependency ${dependency}`
            }, workspaceRoot);
            return true;

        } catch (error) {
            console.error(`Failed to resolve dependency ${dependency}:`, error);
            return false;
        }
    }

    static async executeWithRetry<T>(
        operation: () => Promise<T>,
        context: string,
        onError?: (error: any, attempt: number) => void,
        onRetry?: (attempt: number) => void
    ): Promise<T> {
        let lastError: any;
        let lastSolution: string | null = null;
        let resolvedDependencies = new Set<string>();
        
        for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
            try {
                const result = await operation();
                return result;
            } catch (error) {
                lastError = error;
                console.error(`Error in ${context} (Attempt ${attempt}/${this.MAX_RETRIES}):`, error);
                
                if (onError) {
                    onError(error, attempt);
                }

                const missingDep = await this.detectMissingDependency(error);
                if (missingDep && !resolvedDependencies.has(missingDep)) {
                    console.log(`Detected missing dependency: ${missingDep}`);
                    resolvedDependencies.add(missingDep);
                    
                    if (await this.resolveDependencyIssue(missingDep, context)) {
                        console.log(`Successfully resolved dependency: ${missingDep}`);
                        continue;
                    }
                }

                try {
                    const errorAnalysis = await this.getAIErrorAnalysis(error, context, lastSolution, attempt);
                    
                    if (errorAnalysis.shouldStop) {
                        throw new Error(`AI suggests stopping: ${errorAnalysis.explanation}`);
                    }

                    if (errorAnalysis.solution) {
                        lastSolution = errorAnalysis.solution;
                        console.log(`Applying AI suggested fix (Attempt ${attempt}):`, errorAnalysis.solution);
                        
                        try {
                            await this.executeAISolution(errorAnalysis.solution, context);
                            console.log('AI solution applied successfully');
                            
                            vscode.window.showInformationMessage(
                                `Applied AI fix (Attempt ${attempt}): ${errorAnalysis.explanation}`
                            );
                            
                            continue;
                        } catch (solutionError) {
                            console.error('Error applying AI solution:', solutionError);
                        }
                    }
                } catch (aiError) {
                    console.error('Error getting AI analysis:', aiError);
                }

                if (attempt === this.MAX_RETRIES) {
                    throw new Error(`Failed after ${this.MAX_RETRIES} attempts in ${context}. Last error: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }

                await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
            }
        }

        throw lastError;
    }

    static wrapCommand(command: (...args: any[]) => Promise<any>, commandName: string): (...args: any[]) => Promise<any> {
        return async (...args: any[]) => {
            return this.executeWithRetry(
                async () => await command(...args),
                commandName,
                (error, attempt) => {
                    vscode.window.showErrorMessage(
                        `Error in ${commandName} (Attempt ${attempt}/${this.MAX_RETRIES}): ${error instanceof Error ? error.message : 'Unknown error'}`
                    );
                },
                (attempt) => {
                    vscode.window.showInformationMessage(
                        `Analyzing error and attempting fix (Attempt ${attempt + 1}/${this.MAX_RETRIES})...`
                    );
                }
            );
        };
    }

    private static async getAIErrorAnalysis(error: any, context: string, lastSolution: string | null, attempt: number) {
        try {
            const completion = await model.chat.completions.create({
                model: "o3-mini",
                reasoning_effort: "medium",
                max_completion_tokens: 100000,
                messages: [
                    {
                        role: "system",
                        content: "You are an expert debugging AI. Analyze this error and suggest a solution."
                    },
                    {
                        role: "user",
                        content: `Context: ${context}
Error Details: ${JSON.stringify(error instanceof Error ? {
    message: error.message,
    stack: error.stack,
    name: error.name,
    code: (error as any).code,
    command: (error as any).command
} : error, null, 2)}
Attempt: ${attempt}
Previous Solution Tried: ${lastSolution || 'None'}
Workspace Root: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'Unknown'}`
                    }
                ],
                store: true
            });

            if (!completion.choices || completion.choices.length === 0) {
                throw new Error('Failed to get AI analysis');
            }
            try {
                const cleanedResponse = cleanAIResponse(completion.choices[0].message.content || '');
                    const parsed = JSON.parse(cleanedResponse);

                if (!parsed.analysis || !parsed.explanation || !parsed.solution) {
                    throw new Error('Incomplete AI response structure');
                }

                return parsed;
            } catch (parseError) {
                console.error('Error parsing AI response:', parseError);
                return {
                    analysis: 'Failed to parse AI response',
                    explanation: 'There was an error understanding the AI\'s suggestion',
                    solution: null,
                    shouldStop: true,
                    confidence: 0,
                    requiresUserInput: true,
                    userMessage: 'Please provide more details about what you\'re trying to do'
                };
            }
        } catch (error) {
            console.error('Error getting AI analysis:', error);
            throw new Error('Failed to get AI analysis');
        }
    }

    private static async executeAISolution(solution: string, context: string) {
        try {
            if (!solution || typeof solution !== 'string') {
                throw new Error('Invalid solution format');
            }

            if (solution.includes('FILE_CREATE') || solution.includes('FILE_MODIFY')) {
                const dirMatch = solution.match(/(?:FILE_CREATE|FILE_MODIFY)\s+(.*?)(?:\n|$)/);
                if (dirMatch) {
                    const filePath = dirMatch[1].trim();
                    if (!validatePath(filePath)) {
                        throw new Error(`Invalid file path: ${filePath}`);
                    }
                    const dirPath = path.dirname(filePath);
                    await fs.promises.mkdir(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, dirPath), { recursive: true });
                }
            }
            if (solution.includes('FILE_MODIFY') || solution.includes('FILE_CREATE')) {
                const fileOperations = solution.split('\n')
                    .filter(line => line.startsWith('FILE_MODIFY') || line.startsWith('FILE_CREATE'))
                    .map(line => {
                        const [operation, ...rest] = line.split(' ');
                        return {
                            type: operation === 'FILE_CREATE' ? 'create' as const : 'update' as const,
                            path: rest.join(' ').trim()
                        };
                    });
                await handleFileOperations(fileOperations);
            } else if (solution.startsWith('npm ') || solution.startsWith('yarn ') || solution.startsWith('pnpm ')) {
                const parts = solution.split(' ');
                if (parts[1] === 'init' || parts[1] === 'create') {
                    const projectDir = parts[parts.length - 1].replace(/['"]/g, '');
                    if (!validatePath(projectDir)) {
                        throw new Error(`Invalid project directory name: ${projectDir}`);
                    }
                    await fs.promises.mkdir(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, projectDir), { recursive: true });
                }
                await executeCommands({ 
                    commands: [solution],
                    description: `Installing missing dependency ${context}`,
                    cwd: vscode.workspace.workspaceFolders![0].uri.fsPath
                }, vscode.workspace.workspaceFolders![0].uri.fsPath);
            } else if (solution.includes('vscode.workspace') || solution.includes('vscode.window')) {
                const sanitizedSolution = solution.replace(/[^\w\s.(){}[\]"'=]/g, '');
                const asyncFunction = new Function('vscode', `return (async () => { ${sanitizedSolution} })();`);
                await asyncFunction(vscode);
            } else {
                const sanitizedSolution = sanitizeCommand(solution);
                console.log('Applying general solution:', sanitizedSolution);
                if (sanitizedSolution) {
                    await executeCommands({ 
                        commands: [sanitizedSolution],
                        description: `Executing AI solution for ${context}`,
                        cwd: vscode.workspace.workspaceFolders![0].uri.fsPath
                    }, vscode.workspace.workspaceFolders![0].uri.fsPath);
                }
            }
        } catch (error) {
            console.error('Error executing AI solution:', error);
            throw new Error(`Failed to execute AI solution: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
} 