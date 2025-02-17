// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';
import { OpenAI } from 'openai';
import type { Fetch } from 'openai/core';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { Minimatch } from 'minimatch';
import { FileOrganizer } from './fileOrganizer';
import { FileInfo, OrganizeOptions } from './fileOrganizer';
import { ScreenshotManager } from './screenshot';
import { LogManager } from './logManager';

// Add helper functions
function processResponseWithCodeBlocks(response: string): string {
	try {
		// Split by code block markers
		const parts = response.split(/(&&&\s*CODE_BLOCK_START.*?&&&\s*CODE_BLOCK_END)/gs);
		let processedParts: string[] = [];

		for (let part of parts) {
			if (!part.trim()) continue;

			if (part.startsWith('&&& CODE_BLOCK_START')) {
				// Extract language and code
				const match = part.match(/&&&\s*CODE_BLOCK_START\s*(.*?)\n([\s\S]*?)&&&\s*CODE_BLOCK_END/);
				if (match) {
					const [_, language, code] = match;
					processedParts.push(`
						<div class="code-container">
							<pre class="code-block ${language}"><code class="${language}">${code.trim()}</code></pre>
							<button class="copy-button">Copy</button>
						</div>
					`);
				}
			} else {
				// Process regular text
				const textWithBreaks = part.split('\n')
					.map(line => line.trim())
					.filter(line => line.length > 0)
					.join('<br>');
				if (textWithBreaks) {
					processedParts.push(`<div class="text-block">${textWithBreaks}</div>`);
				}
			}
		}

		return processedParts.join('\n');
	} catch (error: unknown) {
		console.error('Error processing response:', error);
		const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
		return `<div class="error-message">Error processing response: ${errorMessage}</div>`;
	}
}

function getFileOrganizerPreviewHtml(files: FileInfo[], options: OrganizeOptions): string {
	const groupedFiles = new Map<string, FileInfo[]>();
	
	// Group files by category
	for (const file of files) {
		let category = '';
		switch (options.by) {
			case 'type':
				category = file.type;
				break;
			case 'date':
				const date = new Date(file.modifiedDate);
				category = date.toLocaleDateString();
				break;
			case 'size':
				category = getSizeCategory(file.size);
				break;
			case 'name':
				category = file.name[0].toUpperCase();
				break;
		}

		if (!groupedFiles.has(category)) {
			groupedFiles.set(category, []);
		}
		groupedFiles.get(category)?.push(file);
	}

	return `<!DOCTYPE html>
	<html>
		<head>
			<style>
				body {
					padding: 20px;
					font-family: var(--vscode-font-family);
					color: var(--vscode-editor-foreground);
					background: var(--vscode-editor-background);
				}
				.category {
					margin-bottom: 30px;
				}
				.category-header {
					font-size: 18px;
					font-weight: bold;
					margin-bottom: 10px;
					padding: 5px;
					background: var(--vscode-editor-lineHighlightBackground);
					border-radius: 4px;
				}
				.file-grid {
					display: grid;
					grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
					gap: 10px;
				}
				.file-card {
					padding: 10px;
					background: var(--vscode-editor-inactiveSelectionBackground);
					border-radius: 4px;
					display: flex;
					flex-direction: column;
				}
				.file-name {
					font-weight: bold;
					margin-bottom: 5px;
				}
				.file-info {
					font-size: 12px;
					color: var(--vscode-descriptionForeground);
				}
				.summary {
					margin-bottom: 20px;
					padding: 10px;
					background: var(--vscode-editor-inactiveSelectionBackground);
					border-radius: 4px;
				}
			</style>
		</head>
		<body>
			<div class="summary">
				<h2>Organization Summary</h2>
				<p>Total Files: ${files.length}</p>
				<p>Organization Method: ${options.by}</p>
				<p>Sort Order: ${options.order}</p>
			</div>
			${Array.from(groupedFiles.entries()).map(([category, files]) => `
				<div class="category">
					<div class="category-header">${category} (${files.length} files)</div>
					<div class="file-grid">
						${files.map(file => `
							<div class="file-card">
								<div class="file-name">${file.name}</div>
								<div class="file-info">
									<div>Type: ${file.type}</div>
									<div>Size: ${formatFileSize(file.size)}</div>
									<div>Modified: ${new Date(file.modifiedDate).toLocaleString()}</div>
								</div>
							</div>
						`).join('')}
					</div>
				</div>
			`).join('')}
		</body>
	</html>`;
}

function formatFileSize(size: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let unitIndex = 0;
	
	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}
	
	return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function getSizeCategory(size: number): string {
	const kb = 1024;
	const mb = kb * 1024;
	const gb = mb * 1024;

	if (size < kb) return 'Tiny (< 1KB)';
	if (size < mb) return 'Small (< 1MB)';
	if (size < 10 * mb) return 'Medium (1-10MB)';
	if (size < 100 * mb) return 'Large (10-100MB)';
	if (size < gb) return 'Very Large (100MB-1GB)';
	return 'Huge (> 1GB)';
}

// Add AutoRetryHandler class after the imports
class AutoRetryHandler {
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

        // Check for nested dependency issues
        if (errorString.includes('node_modules')) {
            const nestedMatch = errorString.match(/node_modules[/\\]([^/\\]+)/);
            if (nestedMatch && nestedMatch[1]) {
                return nestedMatch[1].trim();
            }
        }

        return null;
    }

    private static async resolveDependencyIssue(dependency: string, context: string): Promise<boolean> {
        try {
            // First, check package.json for existing dependencies
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

            // Check if it's a transitive dependency
            const allDeps = {
                ...packageJson.dependencies,
                ...packageJson.devDependencies
            };

            // Get the dependency tree
            const depTree = await this.getDependencyTree(workspaceRoot);
            const transitiveVersions = this.findTransitiveDependencyVersions(depTree, dependency);

            if (transitiveVersions.length > 0) {
                // Install the most compatible version
                const version = transitiveVersions[0];
                console.log(`Installing ${dependency}@${version} as detected from dependency tree`);
                await executeCommands({
                    command: `npm install ${dependency}@${version}`,
                    description: `Installing missing dependency ${dependency}`
                }, workspaceRoot);
                return true;
            }

            // If not found in transitive dependencies, try installing latest
            console.log(`Installing latest version of ${dependency}`);
            await executeCommands({
                command: `npm install ${dependency}`,
                description: `Installing missing dependency ${dependency}`
            }, workspaceRoot);
            return true;

        } catch (error) {
            console.error(`Failed to resolve dependency ${dependency}:`, error);
            return false;
        }
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

            // Check direct dependencies
            if (node.dependencies[targetDep]) {
                versions.add(node.dependencies[targetDep].version);
            }

            // Traverse nested dependencies
            for (const dep of Object.values(node.dependencies)) {
                traverse(dep as any);
            }
        };

        traverse(tree);
        return Array.from(versions);
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

                // Check for missing dependencies
                const missingDep = await this.detectMissingDependency(error);
                if (missingDep && !resolvedDependencies.has(missingDep)) {
                    console.log(`Detected missing dependency: ${missingDep}`);
                    resolvedDependencies.add(missingDep);
                    
                    if (await this.resolveDependencyIssue(missingDep, context)) {
                        console.log(`Successfully resolved dependency: ${missingDep}`);
                        continue;
                    }
                }

                // If dependency resolution didn't work, try AI analysis
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
                const cleanedResponse = cleanAIResponse(completion.choices[0].message.content);
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
            // First, validate the solution format
            if (!solution || typeof solution !== 'string') {
                throw new Error('Invalid solution format');
            }

            // Create necessary directories before file operations
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

            // Handle different types of solutions
            if (solution.includes('FILE_MODIFY') || solution.includes('FILE_CREATE')) {
                // Handle file operations
                await handleFileOperations(solution, vscode.workspace.workspaceFolders![0].uri.fsPath);
            } else if (solution.startsWith('npm ') || solution.startsWith('yarn ') || solution.startsWith('pnpm ')) {
                // Handle package manager commands with directory creation
                const parts = solution.split(' ');
                if (parts[1] === 'init' || parts[1] === 'create') {
                    const projectDir = parts[parts.length - 1].replace(/['"]/g, '');
                    if (!validatePath(projectDir)) {
                        throw new Error(`Invalid project directory name: ${projectDir}`);
                    }
                    // Create the directory first
                    await fs.promises.mkdir(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, projectDir), { recursive: true });
                }
                // Execute the command
                await executeCommands({ 
                    command: solution,
                    description: `AI Fix: ${context}`,
                    cwd: vscode.workspace.workspaceFolders![0].uri.fsPath
                }, vscode.workspace.workspaceFolders![0].uri.fsPath);
            } else if (solution.includes('vscode.workspace') || solution.includes('vscode.window')) {
                // Handle VS Code API calls
                const sanitizedSolution = solution.replace(/[^\w\s.(){}[\]"'=]/g, '');
                const asyncFunction = new Function('vscode', `return (async () => { ${sanitizedSolution} })();`);
                await asyncFunction(vscode);
            } else {
                // Handle other types of solutions
                const sanitizedSolution = sanitizeCommand(solution);
                console.log('Applying general solution:', sanitizedSolution);
                if (sanitizedSolution) {
                    await executeCommands({ 
                        command: sanitizedSolution,
                        description: `AI Fix: ${context}`,
                        cwd: vscode.workspace.workspaceFolders![0].uri.fsPath
                    }, vscode.workspace.workspaceFolders![0].uri.fsPath);
                }
            }
        } catch (error) {
            console.error('Error executing AI solution:', error);
            throw new Error(`Failed to execute AI solution: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
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
}

// Add ChatViewProvider class
class ChatViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private chatHistory: { role: string; parts: { text: string }[] }[] = [];
	private tokenUsage: TokenUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cost: 0
	};
	private screenshotManager: ScreenshotManager;
	private summaryHistory: CodeSummary[] = [];
	private readonly O3_MINI_PRICES = {
		input: 0.0001,
		output: 0.0002
	};

	private updateTokenUsageFromCompletion(completion: any) {
		if (completion.usage) {
			// Update token counts from the API's usage data
			this.tokenUsage.inputTokens += completion.usage.prompt_tokens || 0;
			this.tokenUsage.outputTokens += completion.usage.completion_tokens || 0;
			this.tokenUsage.cachedInputTokens += completion.usage.cached_tokens || 0;
			
			// Calculate costs
			this.tokenUsage.cost = (
				(this.tokenUsage.inputTokens * this.O3_MINI_PRICES.input) +
				(this.tokenUsage.outputTokens * this.O3_MINI_PRICES.output)
			);

			if (this._view) {
				this._view.webview.postMessage({
					type: 'updateTokenUsage',
					usage: this.tokenUsage
				});
			}
		}
	}

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly model: any,
		private readonly contextManager: ContextManager
	) {
		this.screenshotManager = new ScreenshotManager(extensionUri.fsPath);
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		const screenshotsUri = vscode.Uri.file(path.join(this.extensionUri.fsPath, 'screenshots'));
		const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'media');
		const cssUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'css', 'style.css'));

		webviewView.webview.options = {
			enableScripts: true,
			enableCommandUris: true,
			localResourceRoots: [
				this.extensionUri,
				screenshotsUri,
				mediaUri
			]
		};

		// Create media directory if it doesn't exist
		const mediaPath = path.join(this.extensionUri.fsPath, 'media', 'css');
		if (!fs.existsSync(mediaPath)) {
			fs.mkdirSync(mediaPath, { recursive: true });
		}

		webviewView.webview.html = this.getWebviewContent(webviewView.webview);
		this.setWebviewMessageListener(webviewView.webview);
	}

	private setWebviewMessageListener(webview: vscode.Webview) {
		webview.onDidReceiveMessage(async message => {
			try {
				switch (message.type) {
					case 'userMessage':
						await AutoRetryHandler.executeWithRetry(async () => {
							console.log('Received user message:', message.text);
							
							webview.postMessage({
								type: 'status',
								text: 'Analyzing your request...',
								status: 'info'
							});
							
							// First, evaluate and plan the tasks
							webview.postMessage({
								type: 'status',
								text: 'Planning tasks...',
								status: 'info'
							});
							
							const taskPlan = await evaluateRequest(message.text);
							console.log('Task plan created:', taskPlan);
							
							// Show initial task plan
							webview.postMessage({
								type: 'updateProgress',
								data: {
									currentStep: taskPlan.currentStep,
									totalSteps: taskPlan.totalSteps,
									steps: taskPlan.steps
								}
							});

							// Process each step in the task plan
							while (taskPlan.currentStep < taskPlan.totalSteps) {
								const currentStep = taskPlan.steps[taskPlan.currentStep];
								currentStep.status = 'in-progress';
								
								// Update progress for current step
								webview.postMessage({
									type: 'updateProgress',
									data: {
										currentStep: taskPlan.currentStep,
										totalSteps: taskPlan.totalSteps,
										steps: taskPlan.steps
									}
								});

								webview.postMessage({
									type: 'status',
									text: `Executing step ${taskPlan.currentStep + 1}: ${currentStep.description}`,
									status: 'info'
								});

								// Get context for the current step
								const context = await getWorkspaceContext(this.contextManager);
								
								// Create completion for current step
								const completion = await model.chat.completions.create({
									model: "o3-mini",
									reasoning_effort: "medium",
									max_completion_tokens: 100000,
									messages: [
										{
											role: "system",
											content: `${SYSTEM_PROMPT}\n\nWorkspace Context:\n${context}\n\nCurrent Task Plan:\n${JSON.stringify(taskPlan, null, 2)}\n\nCurrent Step (${taskPlan.currentStep + 1}/${taskPlan.totalSteps}): ${currentStep.description}`
										},
										{
											role: "user",
											content: `Execute this step: ${currentStep.description}\n\nProvide the necessary code, file operations, or commands to complete this specific step.`
										}
									],
									store: true
								});

								if (!completion.choices || completion.choices.length === 0) {
									throw new Error('Empty response from AI');
								}

								// Update token usage
								this.updateTokenUsageFromCompletion(completion);

								const response = completion.choices[0].message.content;
								
								// Process and detect commands in the response
								await this.detectAndExecuteCommands(response, webview);

								// Process file operations if any
								const fileOperations = await handleFileOperations(response, vscode.workspace.workspaceFolders![0].uri.fsPath);
								if (fileOperations.length > 0) {
									currentStep.files = fileOperations;
								}

								// Process and display response
								let processedResponse = processResponseWithCodeBlocks(response);

								// Add step completion message
								processedResponse = `<div class="success-message">✓ Step ${taskPlan.currentStep + 1} completed: ${currentStep.description}</div>\n${processedResponse}`;
								
								// Update chat history
								this.chatHistory.push(
									{ role: 'user', parts: [{ text: currentStep.description }] },
									{ role: 'model', parts: [{ text: response }] }
								);

								// Mark step as completed
								currentStep.status = 'completed';
								
								// Show step response
								webview.postMessage({
									type: 'aiResponse',
									text: processedResponse,
									hasCode: response.includes('CODE_BLOCK_START')
								});

								// Move to next step
								taskPlan.currentStep++;
								
								// Update progress after step completion
								webview.postMessage({
									type: 'updateProgress',
									data: {
										currentStep: taskPlan.currentStep,
										totalSteps: taskPlan.totalSteps,
										steps: taskPlan.steps
									}
								});

								// Add a small delay between steps
								await new Promise(resolve => setTimeout(resolve, 1000));
							}

							// All steps completed
							webview.postMessage({
								type: 'status',
								text: 'All tasks completed successfully!',
								status: 'success'
							});
							
							webview.postMessage({
								type: 'aiResponse',
								text: `<div class="success-message">✨ All tasks completed successfully! The project has been set up according to your request.</div>`,
								isComplete: true
							});

							// Re-enable input through webview message
							webview.postMessage({
								type: 'enableInput',
								enabled: true
							});
							
						}, 'AI Chat Processing');
						break;

					case 'excludeFile':
						if (message.path) {
								await AutoRetryHandler.executeWithRetry(async () => {
									const fullPath = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, message.path);
									await this.contextManager.removeFromContext(fullPath);
									await this.updateContextFiles(webview);
									
									webview.postMessage({
										type: 'fileOperation',
										success: true,
										details: `Removed from context: ${message.path}`
									});
								}, 'File Exclusion');
						}
						break;
				}
			} catch (error: any) {
				console.error('Detailed AI Error:', error);
				
				webview.postMessage({
					type: 'status',
					text: 'An error occurred',
					status: 'error'
				});
				
				const errorMessage = error?.message || 'Unknown error occurred';
				vscode.window.showErrorMessage(`Error: ${errorMessage}`);
				
				webview.postMessage({
					type: 'aiResponse',
					text: `<div class="error-message">Error: ${errorMessage}</div>`,
					isError: true
				});

				// Re-enable input through webview message
				webview.postMessage({
					type: 'enableInput',
					enabled: true
				});
			}
		});
	}

	private async handleCommandExecution(command: string, webview: vscode.Webview): Promise<void> {
		try {
			// Execute the command
			const options = {
				shell: true,
				encoding: 'utf-8',
				cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath
			};

			// Special handling for npm commands
			if (command.startsWith('npm')) {
				webview.postMessage({
					type: 'status',
					text: `Executing npm command: ${command}`,
					status: 'info'
				});

				// If it's npm run build, use the webpack command directly
				if (command === 'npm run build') {
					command = 'webpack --mode production --config webpack.config.cjs';
				}
			}

			const { stdout, stderr } = require('child_process').spawnSync(command, [], options);

			if (stderr) {
				console.error('Command stderr:', stderr);
				// Check if it's a non-fatal npm warning
				if (!stderr.includes('ERR!')) {
					webview.postMessage({
						type: 'status',
						text: stderr,
						status: 'warning'
					});
				} else {
					throw new Error(stderr);
				}
			}

			if (stdout) {
				// Check if the command starts a server or opens a URL
				const urlMatch = stdout.match(/(https?:\/\/[^\s]+)/);
				if (urlMatch) {
					const url = urlMatch[1];
					
					// Take screenshot after a delay to allow the server to start
					setTimeout(async () => {
						try {
							const screenshotPath = await this.screenshotManager.takeScreenshot(url);
							const screenshotHtml = this.screenshotManager.getScreenshotHtml(screenshotPath, webview);
							
							webview.postMessage({
								type: 'screenshot',
								html: screenshotHtml
							});
						} catch (error) {
							console.error('Screenshot error:', error);
						}
					}, 5000);
				}

				webview.postMessage({
					type: 'aiResponse',
					text: `<div class="success-message">Command Output:<br><pre>${stdout}</pre></div>`,
					isCommand: true
				});

				// Check for additional commands or URLs in the output
				await this.detectAndExecuteCommands(stdout, webview);
			}
		} catch (error) {
			console.error('Command execution error:', error);
			webview.postMessage({
				type: 'aiResponse',
				text: `<div class="error-message">Error executing command: ${error instanceof Error ? error.message : 'Unknown error'}</div>`,
				isError: true
			});

			// Special handling for npm errors
			if (error instanceof Error && error.message.includes('npm ERR!')) {
				// Try to recover by installing dependencies
				try {
					webview.postMessage({
						type: 'status',
						text: 'Attempting to recover by installing dependencies...',
						status: 'info'
					});

					const { stdout: npmOutput } = require('child_process').spawnSync('npm', ['install'], {
						shell: true,
						encoding: 'utf-8',
						cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath
					});

					webview.postMessage({
						type: 'aiResponse',
						text: `<div class="success-message">Dependencies installed:<br><pre>${npmOutput}</pre></div>`,
						isCommand: true
					});

					// Retry the original command
					await this.handleCommandExecution(command, webview);
				} catch (recoveryError) {
					console.error('Recovery failed:', recoveryError);
					webview.postMessage({
						type: 'status',
						text: 'Recovery attempt failed',
						status: 'error'
					});
				}
			}
		}
	}

	private async detectAndExecuteCommands(response: string, webview: vscode.Webview): Promise<void> {
		// Detect shell commands with $ or > prefix
		const shellCommandRegex = /[$>]\s*([^\n]+)/g;
		let match;

		while ((match = shellCommandRegex.exec(response)) !== null) {
			const command = match[1].trim();
			if (command) {
				try {
					webview.postMessage({
						type: 'status',
						text: `Executing command: ${command}`,
						status: 'info'
					});

					await this.handleCommandExecution(command, webview);

					webview.postMessage({
						type: 'status',
						text: `Command executed successfully: ${command}`,
						status: 'success'
					});
				} catch (error) {
					console.error('Command execution error:', error);
					webview.postMessage({
						type: 'status',
						text: `Error executing command: ${error instanceof Error ? error.message : 'Unknown error'}`,
						status: 'error'
					});
				}
			}
		}

		// Detect file paths
		const filePathRegex = /(?:file:\/\/|\/[\w-]+\/|\.\/)([\w-]+(?:\/[\w-]+)*\.\w+)/g;
		while ((match = filePathRegex.exec(response)) !== null) {
			const filePath = match[1].trim();
			if (filePath) {
				try {
					const fullPath = path.join(this.extensionUri.fsPath, filePath);
					if (fs.existsSync(fullPath)) {
						const uri = vscode.Uri.file(fullPath);
						await vscode.commands.executeCommand('vscode.open', uri);
					}
				} catch (error) {
					console.error('Error opening file:', error);
				}
			}
		}

		// Detect URLs
		const urlRegex = /(https?:\/\/[^\s]+)/g;
		while ((match = urlRegex.exec(response)) !== null) {
			const url = match[1].trim();
			if (url) {
				try {
					await this.handleCommandExecution(`open ${url}`, webview);
				} catch (error) {
					console.error('Error opening URL:', error);
				}
			}
		}

		// Detect code execution blocks
		const codeBlockRegex = /```(\w+)\n([\s\S]*?)```/g;
		while ((match = codeBlockRegex.exec(response)) !== null) {
			const [_, language, code] = match;
			if (code && language) {
				try {
					// Create a temporary file with the code
					const tempFile = path.join(this.extensionUri.fsPath, `temp_${Date.now()}.${language}`);
					await fs.promises.writeFile(tempFile, code);

					// Execute based on language
					let execCommand = '';
					switch (language.toLowerCase()) {
						case 'python':
							execCommand = `python3 "${tempFile}"`;
							break;
						case 'node':
						case 'javascript':
							execCommand = `node "${tempFile}"`;
							break;
						case 'typescript':
							execCommand = `ts-node "${tempFile}"`;
							break;
						case 'shell':
						case 'bash':
							execCommand = `bash "${tempFile}"`;
							break;
					}

					if (execCommand) {
						await this.handleCommandExecution(execCommand, webview);
					}

					// Clean up temp file
					await fs.promises.unlink(tempFile);
				} catch (error) {
					console.error('Code execution error:', error);
					webview.postMessage({
						type: 'status',
						text: `Error executing code: ${error instanceof Error ? error.message : 'Unknown error'}`,
						status: 'error'
					});
				}
			}
		}
	}

	private getWebviewContent(webview: vscode.Webview): string {
		const styleVscodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'css', 'style.css'));
		const nonce = this.getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https:;">
    <link rel="stylesheet" href="${styleVscodeUri}">
    <title>Falalo AI Chat</title>
</head>
<body>
    <div class="main-container">
        <div class="chat-container">
            <div class="messages" id="messages"></div>
            <div class="input-container">
                <input type="text" id="messageInput" placeholder="Type your message..." />
                <button id="sendButton">Send</button>
            </div>
        </div>
        <div class="progress-container" id="progressContainer"></div>
    </div>
    <script nonce="${nonce}">
        // ... existing script ...
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

	private async updateContextFiles(webview: vscode.Webview) {
		const files = await this.contextManager.getContextFiles();
		const fileDetails = await Promise.all(files.map(async fileInfo => {
			const fullPath = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, fileInfo.relativePath);
			try {
				const stats = await fs.promises.stat(fullPath);
				const content = await fs.promises.readFile(fullPath, 'utf8');
				const preview = content.slice(0, 500) + (content.length > 500 ? '...' : '');
				const size = stats.size < 1024 ? `${stats.size} B` : 
							stats.size < 1024 * 1024 ? `${(stats.size/1024).toFixed(1)} KB` : 
							`${(stats.size/1024/1024).toFixed(1)} MB`;
				
				return {
					path: fileInfo.relativePath,
					name: path.basename(fileInfo.relativePath),
					size,
					preview
				};
			} catch (error) {
				console.error(`Error reading file ${fileInfo.relativePath}:`, error);
				return null;
			}
		}));

		webview.postMessage({
			type: 'updateContext',
			files: fileDetails.filter((file): file is NonNullable<typeof file> => file !== null)
		});
	}

	public dispose() {
		this.screenshotManager.cleanup();
	}

	private async handleUserMessage(message: string, webview: vscode.Webview): Promise<void> {
		try {
			// Generate and display code summary first
			const summary = await this.generateCodeSummary(message);
			const summaryHtml = this.formatSummaryForDisplay(summary);
			webview.postMessage({ type: 'addMessage', message: summaryHtml, isAi: true });

			// Continue with existing message handling
			this.chatHistory.push({ role: 'user', parts: [{ text: message }] });
			
			// Check if auto context selection is enabled
			const autoSelector = this.contextManager.getAutoSelector();
			if (autoSelector?.isEnabled()) {
				const selection = await autoSelector.selectRelevantFiles(message);
				
				// Clear existing context
				await this.contextManager.excludeAllFiles();
				
				// Add selected files to context
				for (const file of selection.selectedFiles) {
					await this.contextManager.addToContext(file);
				}

				// Update context files view
				await this.updateContextFiles(webview);

				// Show selection info in chat with improved formatting
				const confidencePercentage = Math.round(selection.confidence * 100);
				const confidenceEmoji = confidencePercentage > 80 ? '🟢' : confidencePercentage > 50 ? '🟡' : '🔴';
				
				const selectionMessage = `${confidenceEmoji} **Auto-selected context files** (${confidencePercentage}% confidence)\n\n` +
					`*Explanation:* ${selection.explanation}\n\n` +
					`*Selected files:*\n${selection.selectedFiles.map(file => `- \`${file}\``).join('\n')}`;

				webview.postMessage({
					type: 'addMessage',
					message: {
						role: 'system',
						content: selectionMessage
					}
				});
			}

			// ... rest of the existing code ...
		} catch (error) {
			LogManager.getInstance().logError(error, 'handleUserMessage');
			webview.postMessage({
				type: 'addMessage',
				message: {
					role: 'error',
					content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
				}
			});
		}
	}

	private async generateCodeSummary(userInput: string): Promise<CodeSummary> {
		try {
			const workspaceContext = await getWorkspaceContext(this.contextManager);
			const prompt = `As an expert code analyst, provide a comprehensive summary of the following user request in the context of their codebase. Format your response in these sections:

1. Overview: Brief summary of the user's request
2. Context Analysis: Analysis of how this request relates to the current codebase
3. Suggested Approach: High-level approach to implementing the request

Current workspace context:
${workspaceContext}

User request: ${userInput}`;

			const response = await this.model.chat.completions.create({
				model: 'gpt-4o-mini',
				messages: [
					{ role: 'system', content: 'You are an expert code analyst providing detailed summaries and implementation strategies.' },
					{ role: 'user', content: prompt }
				],
				temperature: 0.3,
				max_tokens: 1000
			});

			const summaryText = response.choices[0]?.message?.content || '';
			const sections = summaryText.split(/\d\.\s+/);

			const summary: CodeSummary = {
				overview: sections[1]?.trim() || 'No overview available',
				contextAnalysis: sections[2]?.trim() || 'No context analysis available',
				suggestedApproach: sections[3]?.trim() || 'No suggested approach available',
				timestamp: new Date().toISOString()
			};

			this.summaryHistory.push(summary);
			this.updateTokenUsageFromCompletion(response);

			return summary;
		} catch (error) {
			LogManager.getInstance().logError(error, 'Code summary generation');
			return {
				overview: 'Error generating summary',
				contextAnalysis: 'An error occurred during analysis',
				suggestedApproach: 'Please try again',
				timestamp: new Date().toISOString()
			};
		}
	}

	private formatSummaryForDisplay(summary: CodeSummary): string {
		return `
<div class="summary-container">
    <div class="summary-header">
        <span class="summary-title">🔍 Code Analysis Summary</span>
        <span class="summary-timestamp">${new Date(summary.timestamp).toLocaleString()}</span>
    </div>
    <div class="summary-section">
        <h3>📋 Overview</h3>
        <p>${summary.overview}</p>
    </div>
    <div class="summary-section">
        <h3>🔎 Context Analysis</h3>
        <p>${summary.contextAnalysis}</p>
    </div>
    <div class="summary-section">
        <h3>💡 Suggested Approach</h3>
        <p>${summary.suggestedApproach}</p>
    </div>
</div>`;
	}
}

// Add ContextFilesViewProvider class after ChatViewProvider
class ContextFilesViewProvider implements vscode.WebviewViewProvider {
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
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getWebviewContent(webviewView.webview);
        this.setWebviewMessageListener(webviewView.webview);

        // Initial file load
        this.updateContextFiles();

        // Listen for context updates
        this.contextManager.onDidUpdateContext(() => {
            this.updateContextFiles();
        });
    }

    private async updateContextFiles() {
        if (!this._view) {
            return;
        }

        try {
            const files = await this.contextManager.getContextFiles();
            const fileDetails = await Promise.all(
                files.map(file => this.contextManager.getFileDetails(file))
            );

            const fileTreeHtml = this.generateFileTree(fileDetails);
            this._view.webview.postMessage({
                type: 'updateFiles',
                files: fileTreeHtml
            });

            LogManager.getInstance().log('Context files updated', 'info');
        } catch (error) {
            LogManager.getInstance().logError(error, 'Updating context files');
        }
    }

    private setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async (message) => {
            const autoSelector = this.contextManager.getAutoSelector();

            switch (message.command) {
                case 'toggleAutoContext':
                    if (autoSelector) {
                        const isEnabled = autoSelector.toggleEnabled();
                        webview.postMessage({
                            type: 'autoContextStatus',
                            enabled: isEnabled
                        });
                        LogManager.getInstance().log(`Auto context ${isEnabled ? 'enabled' : 'disabled'}`, 'info');
                        this.updateContextFiles();
                    }
                    break;
                case 'removeFile':
                    if (message.path) {
                        const fullPath = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, message.path);
                        await this.contextManager.removeFromContext(fullPath);
                        await this.updateContextFiles();
                    }
                    break;
                case 'openFile':
                    if (message.path) {
                        const fullPath = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, message.path);
                        const doc = await vscode.workspace.openTextDocument(fullPath);
                        await vscode.window.showTextDocument(doc);
                    }
                    break;
                case 'includeAll':
                    await this.includeAllFiles();
                    break;
                case 'excludeAll':
                    await this.excludeAllFiles();
                    break;
                case 'includeStructure':
                    await this.includeStructureOnly();
                    break;
                case 'toggleFile':
                    if (message.path) {
                        const fullPath = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, message.path);
                        await this.contextManager.toggleFileInContext(fullPath);
                        this.updateContextFiles();
                    }
                    break;
            }
        });
    }

    private async includeAllFiles() {
        const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
        for (const file of files) {
            await this.contextManager.addToContext(file.fsPath);
        }
        await this.updateContextFiles();
    }

    private async excludeAllFiles() {
        const files = await this.contextManager.getContextFiles();
        for (const file of files) {
            await this.contextManager.removeFromContext(file.fullPath);
        }
        await this.updateContextFiles();
    }

    private async includeStructureOnly() {
        const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
        
        // First exclude all files
        await this.excludeAllFiles();
        
        // Then include only directories and important config files
        for (const file of files) {
            const stats = await fs.promises.stat(file.fsPath);
            const relativePath = path.relative(workspaceRoot, file.fsPath);
            
            if (stats.isDirectory() || 
                relativePath.endsWith('package.json') ||
                relativePath.endsWith('tsconfig.json') ||
                relativePath.endsWith('.gitignore') ||
                relativePath.endsWith('README.md')) {
                await this.contextManager.addToContext(file.fsPath);
            }
        }
        await this.updateContextFiles();
    }

    private getWebviewContent(webview: vscode.Webview): string {
        const autoSelector = this.contextManager.getAutoSelector();
        const isAutoContextEnabled = autoSelector?.isEnabled() || false;

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Context Files</title>
                <style>
                    /* ... existing styles ... */
                </style>
            </head>
            <body>
                <div class="context-container">
                    <div class="context-header">
                        <h2>Context Files</h2>
                        <div class="context-actions">
                            <button id="autoContextToggle" class="${isAutoContextEnabled ? 'enabled' : ''}" onclick="toggleAutoContext()">
                                ${isAutoContextEnabled ? '🤖 Auto Context: ON' : '🤖 Auto Context: OFF'}
                            </button>
                            <button onclick="excludeAll()">Clear All</button>
                            <button onclick="includeAll()">Include All</button>
                            <button onclick="includeStructure()">Structure Only</button>
                        </div>
                    </div>
                    <div class="file-tree-container">
                        <div id="fileTree" class="file-tree"></div>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    
                    function toggleAutoContext() {
                        vscode.postMessage({ command: 'toggleAutoContext' });
                    }

                    function excludeAll() {
                        vscode.postMessage({ command: 'excludeAll' });
                    }

                    function includeAll() {
                        vscode.postMessage({ command: 'includeAll' });
                    }

                    function includeStructure() {
                        vscode.postMessage({ command: 'includeStructure' });
                    }

                    function removeFile(path) {
                        vscode.postMessage({ command: 'removeFile', path });
                    }

                    function openFile(path) {
                        vscode.postMessage({ command: 'openFile', path });
                    }

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'updateFiles':
                                document.getElementById('fileTree').innerHTML = message.content;
                                break;
                            case 'autoContextStatus':
                                const button = document.getElementById('autoContextToggle');
                                if (button) {
                                    button.textContent = message.enabled ? '🤖 Auto Context: ON' : '🤖 Auto Context: OFF';
                                    button.className = message.enabled ? 'enabled' : '';
                                }
                                break;
                        }
                    });
                </script>
            </body>
            </html>`;
    }

    private generateFileTree(files: Array<{
        fullPath: string;
        relativePath: string;
        size: number;
        lastModified: Date;
        type: string;
    }>): string {
        const fileGroups = this.groupFilesByDirectory(files);
        return this.renderFileTree(fileGroups);
    }

    private groupFilesByDirectory(files: Array<{
        fullPath: string;
        relativePath: string;
        size: number;
        lastModified: Date;
        type: string;
    }>) {
        const groups: { [key: string]: any[] } = {};
        
        for (const file of files) {
            const parts = file.relativePath.split('/');
            const fileName = parts.pop() || '';
            const directory = parts.join('/');
            
            if (!groups[directory]) {
                groups[directory] = [];
            }
            
            groups[directory].push({
                ...file,
                name: fileName
            });
        }
        
        return groups;
    }

    private renderFileTree(fileGroups: { [key: string]: any[] }): string {
        let html = '';
        
        for (const [directory, files] of Object.entries(fileGroups)) {
            if (directory) {
                html += `
                    <div class="directory">
                        <div class="directory-header">
                            <span class="directory-icon">📁</span>
                            <span class="directory-name">${directory}</span>
                        </div>
                        <div class="file-list">
                `;
            }
            
            for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
                const icon = this.getFileIcon(file.type);
                const size = this.formatFileSize(file.size);
                const date = new Date(file.lastModified).toLocaleDateString();
                
                html += `
                    <div class="file-item" data-path="${file.relativePath}">
                        <span class="file-icon">${icon}</span>
                        <span class="file-name">${file.name}</span>
                        <span class="file-info">
                            <span class="file-size">${size}</span>
                            <span class="file-date">${date}</span>
                        </span>
                    </div>
                `;
            }
            
            if (directory) {
                html += '</div></div>';
            }
        }
        
        return html;
    }

    // ... rest of the existing code (getFileIcon, formatFileSize, etc.) ...

    private getNonce() {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    private getFileIcon(type: string): string {
        switch (type) {
            case 'directory':
                return '📁';
            case 'javascript':
            case 'typescript':
                return '📜';
            case 'json':
                return '📋';
            case 'markdown':
                return '📝';
            case 'image':
                return '🖼️';
            default:
                return '📄';
        }
    }

    private formatFileSize(size: number): string {
        const units = ['B', 'KB', 'MB', 'GB'];
        let unitIndex = 0;
        let fileSize = size;

        while (fileSize >= 1024 && unitIndex < units.length - 1) {
            fileSize /= 1024;
            unitIndex++;
        }

        return `${Math.round(fileSize * 100) / 100} ${units[unitIndex]}`;
    }
}

// Global model instance for AI functionality
let model: any;

// Task planning interfaces
interface TaskStep {
	description: string;
	status: 'pending' | 'in-progress' | 'completed';
	files?: string[];
	dependencies?: number[];
}

interface TaskPlan {
	totalSteps: number;
	currentStep: number;
	steps: TaskStep[];
	originalRequest: string;
}

interface FilePathInfo {
	fullPath: string;
	relativePath: string;
}

// Add new interface for command execution
interface CommandExecution {
	command: string;
	cwd?: string;
	isBackground?: boolean;
	description?: string;
}

// Add new interfaces for context management
interface ContextConfig {
	inclusions: string[];
	exclusions: string[];
	maxFiles: number;
}

// Add new interfaces for code review
interface CodeReviewResult {
	file: string;
	issues: CodeIssue[];
	suggestions: CodeSuggestion[];
	metrics: CodeMetrics;
}

interface CodeIssue {
	type: 'security' | 'performance' | 'best_practices' | 'architecture';
	severity: 'critical' | 'warning' | 'suggestion';
	line: number;
	message: string;
	suggestedFix?: string;
	autoFixable: boolean;
}

interface CodeSuggestion {
	type: 'improvement' | 'optimization' | 'pattern';
	line: number;
	description: string;
	codeSnippet: string;
	benefits: string[];
}

interface CodeMetrics {
	complexity: number;
	maintainability: number;
	testability: number;
	security: number;
	performance: number;
}

// Add context management class
class ContextManager {
	private config: ContextConfig;
	private workspaceRoot: string;
	private onContextUpdated: (() => void)[] = [];
	private readonly DEFAULT_MAX_FILES = 500;
	private readonly DEFAULT_EXCLUSIONS = [
		// Node.js related
		'node_modules/**',
		'**/node_modules/**',
		'package-lock.json',
		'yarn.lock',
		'pnpm-lock.yaml',

		// Build directories
		'build/**',
		'dist/**',
		'out/**',
		'*.vsix',
		'bin/**',
		'target/**',

		// Cache directories
		'.cache/**',
		'**/.cache/**',
		'.tmp/**',
		'temp/**',
		'tmp/**',

		// Python cache and packages
		'**/__pycache__/**',
		'*.pyc',
		'*.pyo',
		'*.pyd',
		'.Python',
		'*.so',
		'.env',
		'.venv',
		'env/**',
		'venv/**',
		'ENV/**',
		'env.bak/**',
		'venv.bak/**',
		'site-packages/**',
		'**/site-packages/**',
		'Lib/site-packages/**',
		'**/Lib/site-packages/**',
		'python*/site-packages/**',
		'**/python*/site-packages/**',
		'dist-packages/**',
		'**/dist-packages/**',
		'pip/**',
		'**/pip/**',
		'wheels/**',
		'**/wheels/**',

		// IDE and editor files
		'.idea/**',
		'.vscode/**',
		'*.swp',
		'*.swo',
		'*.swn',
		'*.bak',
		'*.log',

		// Version control
		'.git/**',
		'.svn/**',
		'.hg/**',
		'.DS_Store',
		'Thumbs.db'
	];
	private autoSelector: AutoContextSelector | null = null;

	constructor(workspaceRoot: string, model?: OpenAI) {
		this.workspaceRoot = workspaceRoot;
		this.config = {
			inclusions: vscode.workspace.getConfiguration('falalo').get('contextInclusions') || [],
			exclusions: vscode.workspace.getConfiguration('falalo').get('contextExclusions') || this.DEFAULT_EXCLUSIONS,
			maxFiles: vscode.workspace.getConfiguration('falalo').get('maxContextFiles') || this.DEFAULT_MAX_FILES
		};

		// Initialize auto context selector if model is provided
		if (model) {
			this.autoSelector = new AutoContextSelector(model, this);
			// Enable auto context by default
			this.autoSelector.toggleEnabled();
			LogManager.getInstance().log('Auto context selector initialized and enabled', 'info');
		} else {
			LogManager.getInstance().log('Auto context selector not initialized - OpenAI model not provided', 'info');
		}

		// Listen for configuration changes
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('falalo')) {
				this.updateConfig();
			}
		});
	}

	private async updateConfig() {
		this.config = {
			inclusions: vscode.workspace.getConfiguration('falalo').get('contextInclusions') || [],
			exclusions: vscode.workspace.getConfiguration('falalo').get('contextExclusions') || this.DEFAULT_EXCLUSIONS,
			maxFiles: vscode.workspace.getConfiguration('falalo').get('maxContextFiles') || this.DEFAULT_MAX_FILES
		};
		await this.notifyContextUpdated();
	}

	public onDidUpdateContext(callback: () => void): vscode.Disposable {
		this.onContextUpdated.push(callback);
		return {
			dispose: () => {
				const index = this.onContextUpdated.indexOf(callback);
				if (index !== -1) {
					this.onContextUpdated.splice(index, 1);
				}
			}
		};
	}

	private async notifyContextUpdated() {
		const files = await this.getContextFiles();
		console.log(`Context updated with ${files.length} files`);
		for (const callback of this.onContextUpdated) {
			try {
				await callback();
			} catch (error) {
				console.error('Error in context update callback:', error);
			}
		}
	}

	public async getFileDetails(filePath: string | FilePathInfo): Promise<{
		fullPath: string;
		relativePath: string;
		size: number;
		lastModified: Date;
		type: string;
	}> {
		const pathInfo = this.getPathInfo(filePath);
		const stats = await fs.promises.stat(pathInfo.fullPath);
		return {
			fullPath: pathInfo.fullPath,
			relativePath: pathInfo.relativePath,
			size: stats.size,
			lastModified: stats.mtime,
			type: path.extname(pathInfo.relativePath).slice(1) || 'text'
		};
	}

	async addToContext(resourcePath: string | FilePathInfo): Promise<void> {
		try {
			const pathInfo = this.getPathInfo(resourcePath);
			
			// Check if file exists
			try {
				await fs.promises.access(pathInfo.fullPath, fs.constants.R_OK);
			} catch {
				throw new Error(`File ${pathInfo.relativePath} does not exist or is not readable`);
			}
			
			const config = vscode.workspace.getConfiguration('falalo');
			const inclusions = config.get('contextInclusions') as string[];
			
			if (!inclusions.includes(pathInfo.relativePath)) {
				inclusions.push(pathInfo.relativePath);
				await config.update('contextInclusions', inclusions, vscode.ConfigurationTarget.Workspace);
				this.config.inclusions = inclusions;
				vscode.window.showInformationMessage(`Added ${pathInfo.relativePath} to AI chat context`);
				await this.notifyContextUpdated();
			}
		} catch (error) {
			console.error('Error adding to context:', error);
			vscode.window.showErrorMessage(`Failed to add file to context: ${error instanceof Error ? error.message : 'Unknown error'}`);
			throw error;
		}
	}

	async removeFromContext(resourcePath: string | FilePathInfo): Promise<void> {
		try {
			const pathInfo = this.getPathInfo(resourcePath);
			const config = vscode.workspace.getConfiguration('falalo');
			const inclusions = config.get('contextInclusions') as string[];
			
			const index = inclusions.indexOf(pathInfo.relativePath);
			if (index !== -1) {
				inclusions.splice(index, 1);
				await config.update('contextInclusions', inclusions, vscode.ConfigurationTarget.Workspace);
				this.config.inclusions = inclusions;
				vscode.window.showInformationMessage(`Removed ${pathInfo.relativePath} from AI chat context`);
				await this.notifyContextUpdated();
			}
		} catch (error) {
			console.error('Error removing from context:', error);
			vscode.window.showErrorMessage(`Failed to remove file from context: ${error instanceof Error ? error.message : 'Unknown error'}`);
			throw error;
		}
	}

	async getContextFiles(): Promise<FilePathInfo[]> {
		const allFiles: FilePathInfo[] = [];
		
		try {
			// Use glob with recursive option
			const globOptions = {
				cwd: this.workspaceRoot,
				dot: true, // Include dotfiles
				nodir: false, // Include directories
				follow: true, // Follow symlinks
				ignore: this.config.exclusions,
				absolute: true // Get absolute paths
			};

			// First, handle explicit inclusions
			for (const pattern of this.config.inclusions) {
				try {
					const matches = await this.globAsync(pattern);
					for (const match of matches) {
						const relativePath = path.relative(this.workspaceRoot, match);
						allFiles.push({
							fullPath: match,
							relativePath: relativePath
						});
					}
				} catch (error) {
					console.error(`Error processing inclusion pattern ${pattern}:`, error);
				}
			}

			// If no explicit inclusions, get all files except exclusions
			if (this.config.inclusions.length === 0) {
				const matches = await this.globAsync('**/*');
				for (const match of matches) {
					const relativePath = path.relative(this.workspaceRoot, match);
					allFiles.push({
						fullPath: match,
						relativePath: relativePath
					});
				}
			}

			// Filter out excluded files and ensure files are readable
			const filteredFiles = await Promise.all(
				allFiles.map(async (file) => {
					try {
						const stats = await fs.promises.stat(file.fullPath);
						
						// Skip if it matches any exclusion pattern
						if (this.config.exclusions.some(pattern => 
							new Minimatch(pattern).match(file.relativePath)
						)) {
							return null;
						}

						// Check if file is readable
						await fs.promises.access(file.fullPath, fs.constants.R_OK);
						
						// Include both files and directories
						return {
							...file,
							isDirectory: stats.isDirectory()
						};
					} catch {
						return null;
					}
				})
			);

			// Remove nulls and limit to max files
			return filteredFiles
				.filter((file): file is NonNullable<typeof file> => file !== null)
				.slice(0, this.config.maxFiles);

		} catch (error) {
			console.error('Error getting context files:', error);
			return [];
		}
	}

	private async globAsync(pattern: string): Promise<string[]> {
		return new Promise((resolve, reject) => {
				glob(pattern, {
			cwd: this.workspaceRoot, 
					dot: true,
					nodir: false,
					follow: true,
					ignore: this.config.exclusions,
					absolute: true
				}, (err: Error | null, matches: string[]) => {
					if (err) {
						reject(err);
					} else {
						resolve(matches);
					}
				});
		});
	}

	async showContextItems(): Promise<void> {
		const files = await this.getContextFiles();
		const panel = vscode.window.createWebviewPanel(
			'contextItems',
			'AI Chat Context Items',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true
			}
		);

		const fileListHtml = await Promise.all(files.map(async fileInfo => {
			const details = await this.getFileDetails(fileInfo.relativePath);
			return `<li class="file-item" data-path="${details.relativePath}">
				<span>📄 ${details.relativePath}</span>
				<div class="file-details">
					<small>Full path: ${details.fullPath}</small><br>
					<small>Size: ${formatFileSize(details.size)}</small>
				</div>
				<button class="remove-button" onclick="removeFile('${details.relativePath}')">Remove</button>
			</li>`;
		}));

		panel.webview.html = `
			<!DOCTYPE html>
			<html>
			<head>
				<style>
					body { 
						padding: 15px;
						font-family: var(--vscode-font-family);
						color: var(--vscode-editor-foreground);
						background: var(--vscode-editor-background);
					}
					.file-list { 
						list-style-type: none; 
						padding: 0;
						margin: 10px 0;
					}
					.file-item { 
						padding: 8px 12px;
						margin: 4px 0;
						background: var(--vscode-input-background);
						border: 1px solid var(--vscode-input-border);
						border-radius: 4px;
						display: flex;
						align-items: center;
						justify-content: space-between;
					}
					.file-item:hover {
						background: var(--vscode-list-hoverBackground);
					}
					.file-details {
						flex: 1;
						margin: 0 10px;
						color: var(--vscode-descriptionForeground);
					}
					.drop-zone {
						border: 2px dashed var(--vscode-input-border);
						border-radius: 8px;
						padding: 20px;
						text-align: center;
						margin: 20px 0;
						transition: all 0.3s ease;
						cursor: pointer;
					}
					.drop-zone.drag-over {
						background: var(--vscode-list-dropBackground);
						border-color: var(--vscode-focusBorder);
					}
					.remove-button {
						background: var(--vscode-button-secondaryBackground);
						color: var(--vscode-button-secondaryForeground);
						border: none;
						border-radius: 4px;
						padding: 4px 8px;
						cursor: pointer;
						margin-left: 8px;
					}
					.remove-button:hover {
						background: var(--vscode-button-secondaryHoverBackground);
					}
					.header {
						display: flex;
						justify-content: space-between;
						align-items: center;
						margin-bottom: 20px;
					}
					.file-count {
						font-size: 0.9em;
						color: var(--vscode-descriptionForeground);
					}
				</style>
			</head>
			<body>
				<div class="header">
					<h2>Files in AI Chat Context</h2>
					<span class="file-count">${files.length} / ${this.config.maxFiles} files</span>
				</div>
				
				<div id="dropZone" class="drop-zone">
					Drag and drop files here to add to context
				</div>

				<ul id="fileList" class="file-list">
					${fileListHtml.join('\n')}
				</ul>

				<script>
					const vscode = acquireVsCodeApi();
					const dropZone = document.getElementById('dropZone');
					const fileList = document.getElementById('fileList');

					// Handle messages from the webview
					window.addEventListener('message', event => {
						const message = event.data;
						if (message.type === 'updateFiles') {
							const files = message.files;
							const maxFiles = message.maxFiles;
							
							fileList.innerHTML = files.map(file => 
								'<li class="file-item" data-path="' + file.relativePath + '">' +
								'<span>📄 ' + file.relativePath + '</span>' +
								'<div class="file-details">' +
								'<small>Full path: ' + file.fullPath + '</small><br>' +
								'<small>Size: ' + file.size + '</small>' +
								'</div>' +
								'<button class="remove-button" onclick="removeFile(\'' + file.relativePath + '\')">Remove</button>' +
								'</li>'
							).join('\\n');

							document.querySelector('.file-count').textContent = 
								files.length + ' / ' + maxFiles + ' files';
						}
					});

					// Handle file removal
					window.removeFile = function(path) {
						vscode.postMessage({ type: 'removeFile', path: path });
					};

					// Handle file drops
					dropZone.addEventListener('drop', handleDrop, false);

					function handleDrop(e) {
						e.preventDefault();
						e.stopPropagation();
						dropZone.classList.remove('drag-over');

						const dt = e.dataTransfer;
						const files = dt.files;

						[...files].forEach(file => {
							vscode.postMessage({
								type: 'addFile',
								path: file.path
							});
						});
					}

					// Prevent default drag behaviors
					['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
						dropZone.addEventListener(eventName, preventDefaults, false);
						document.body.addEventListener(eventName, preventDefaults, false);
					});

					function preventDefaults(e) {
						e.preventDefault();
						e.stopPropagation();
					}

					// Highlight drop zone when dragging over it
					['dragenter', 'dragover'].forEach(eventName => {
						dropZone.addEventListener(eventName, highlight, false);
					});

					['dragleave', 'drop'].forEach(eventName => {
						dropZone.addEventListener(eventName, unhighlight, false);
					});

					function highlight(e) {
						dropZone.classList.add('drag-over');
					}

					function unhighlight(e) {
						dropZone.classList.remove('drag-over');
					}
				</script>
			</body>
			</html>`;

		// Handle messages from the webview
		panel.webview.onDidReceiveMessage(async message => {
			try {
				switch (message.type) {
					case 'removeFile':
						if (message.path) {
							await this.removeFromContext(message.path);
							const updatedFiles = await this.getContextFiles();
							panel.webview.postMessage({
								type: 'updateFiles',
								files: await Promise.all(updatedFiles.map(file => this.getFileDetails(file))),
								maxFiles: this.config.maxFiles
							});
						}
						break;
					case 'addFile':
						if (message.path) {
							await this.addToContext(message.path);
							const updatedFiles = await this.getContextFiles();
							panel.webview.postMessage({
								type: 'updateFiles',
								files: await Promise.all(updatedFiles.map(file => this.getFileDetails(file))),
								maxFiles: this.config.maxFiles
							});
						}
						break;
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
			}
		});
	}

	// Add new method to get path information
	private getPathInfo(filePath: string | FilePathInfo): FilePathInfo {
		if (typeof filePath === 'string') {
			const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);
			const relativePath = path.relative(this.workspaceRoot, fullPath);
			return { fullPath, relativePath };
		}
		return filePath;
	}

	public getWorkspaceRoot(): string {
		return this.workspaceRoot;
	}

	public getAutoSelector(): AutoContextSelector | null {
		return this.autoSelector;
	}

	public async excludeAllFiles(): Promise<void> {
		try {
			// Get all workspace files
			const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
			
			// Clear inclusions array
			this.config.inclusions = [];
			
			// Update configuration
			await vscode.workspace.getConfiguration('falalo').update('contextInclusions', [], vscode.ConfigurationTarget.Global);
			
			// Notify listeners
			await this.notifyContextUpdated();
			
			LogManager.getInstance().log('Excluded all files from context', 'info');
		} catch (error) {
			LogManager.getInstance().logError(error, 'excludeAllFiles');
			throw error;
		}
	}

	public async toggleFileInContext(filePath: string): Promise<void> {
		try {
			const isInContext = await this.isFileInContext(filePath);
			const fileInfo: FilePathInfo = {
				fullPath: filePath,
				relativePath: path.relative(this.workspaceRoot, filePath)
			};

			if (isInContext) {
				await this.removeFromContext(fileInfo);
			} else {
				await this.addToContext(fileInfo);
			}

			await this.notifyContextUpdated();
		} catch (error) {
			console.error('Error toggling file in context:', error);
			vscode.window.showErrorMessage('Failed to toggle file in context: ' + (error instanceof Error ? error.message : 'Unknown error'));
		}
	}

	private async isFileInContext(filePath: string): Promise<boolean> {
		const files = await this.getContextFiles();
		return files.some(file => file.fullPath === filePath);
	}
}

// Initialize OpenAI API with error handling
async function initializeOpenAI(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('falalo');
    const apiKey = config.get<string>('openAIApiKey') || '';
    
    const openai = new OpenAI({
        apiKey,
        baseURL: "https://api.openai.com/v1",
        defaultHeaders: {
            'Authorization': `Bearer ${apiKey}`,
            'OpenAI-Beta': 'assistants=v1'
        },
        fetch: globalThis.fetch as unknown as Fetch
    });
    
    return openai;
}

// Task Planning Prompt
const TASK_PLANNING_PROMPT = `You are a task planning AI. Analyze the user's request and break it down into detailed, actionable steps.

CRITICAL FORMATTING RULES:
1. DO NOT use markdown formatting
2. DO NOT use code blocks or backticks
3. DO NOT add any explanation text
4. ONLY return a raw JSON object
5. The response must start with { and end with }
6. NO additional characters before or after the JSON

The JSON must follow this exact format:
{
    "totalSteps": number,
    "steps": [
        {
            "description": "string (detailed step description)",
            "files": ["file/paths"],
            "dependencies": [step numbers],
            "status": "pending"
        }
    ]
}

Guidelines for creating steps:
1. Each step should be specific and actionable
2. Include all necessary file paths that will be created or modified
3. List dependencies accurately (which steps must complete before this one)
4. Break down complex tasks into smaller, manageable steps
5. Include setup steps (installing dependencies, creating directories)
6. Include configuration steps (setting up config files)
7. Include implementation steps (actual coding)
8. Include testing/verification steps if applicable

Example - for "Create a React todo app", respond with exactly (no backticks, no formatting):
{
    "totalSteps": 5,
    "steps": [
        {
            "description": "Initialize project and install core dependencies (React, ReactDOM, webpack, babel)",
            "files": ["package.json", "README.md"],
            "dependencies": [],
            "status": "pending"
        },
        {
            "description": "Set up project configuration (webpack.config.js, .babelrc, tsconfig.json)",
            "files": ["webpack.config.js", ".babelrc", "tsconfig.json"],
            "dependencies": [1],
            "status": "pending"
        },
        {
            "description": "Create basic React components (App, TodoList, TodoItem, AddTodo)",
            "files": [
                "src/components/App.tsx",
                "src/components/TodoList.tsx",
                "src/components/TodoItem.tsx",
                "src/components/AddTodo.tsx"
            ],
            "dependencies": [2],
            "status": "pending"
        },
        {
            "description": "Implement state management and core functionality",
            "files": [
                "src/store/todoStore.ts",
                "src/types/todo.ts",
                "src/utils/localStorage.ts"
            ],
            "dependencies": [3],
            "status": "pending"
        },
        {
            "description": "Add styling and final touches",
            "files": [
                "src/styles/App.css",
                "src/styles/TodoList.css",
                "src/styles/TodoItem.css"
            ],
            "dependencies": [4],
            "status": "pending"
        }
    ]
}`;

// Store active task plans
let activeTaskPlans: Map<string, TaskPlan> = new Map();

// Helper function to create folders
async function createFolderStructure(folderPath: string): Promise<void> {
	try {
		await fs.promises.mkdir(folderPath, { recursive: true });
		console.log(`Created folder structure: ${folderPath}`);
	} catch (error: unknown) {
		console.error(`Error creating folder structure ${folderPath}:`, error);
		const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
		throw new Error(`Failed to create folder structure: ${errorMessage}`);
	}
}

// Update the SYSTEM_PROMPT constant to use %%% markers
const SYSTEM_PROMPT = `You are an advanced AI coding assistant that can create and modify files, folders, and execute commands.
When providing code or creating files/folders/commands:

1. For regular code blocks, use:
   &&& CODE_BLOCK_START language
   ... code ...
   &&& CODE_BLOCK_END

2. For file creation, use:
   $$$ FILE_CREATE path/to/file.ext
   ... content ...
   $$$ FILE_END
   %%%

3. For file modifications, use:
   $$$ FILE_MODIFY path/to/file.ext
   ### REPLACE_BLOCK_START identifier
   ... old code ...
   ### REPLACE_BLOCK_END
   ### NEW_BLOCK_START identifier
   ... new code ...
   ### NEW_BLOCK_END
   ### INSERT_AFTER line:"specific line"
   ... code ...
   ### INSERT_END
   $$$ FILE_END
   %%%

4. For folder creation, use:
   $$$ FOLDER_CREATE path/to/folder
   %%%

5. For command execution, use:
   $$$ COMMAND_EXEC
   {
     "command": "npm install react",
     "cwd": "./project",
     "isBackground": false,
     "description": "Installing React dependencies"
   }
   $$$ COMMAND_END
   %%%

   Multiple commands:
   $$$ COMMAND_EXEC
   [
     {
       "command": "mkdir -p src/components",
       "description": "Creating components directory"
     },
     {
       "command": "npm install",
       "description": "Installing dependencies"
     }
   ]
   $$$ COMMAND_END
   %%%

Example:
I'll create a React project and install dependencies.

$$$ FOLDER_CREATE my-react-app
%%%

$$$ COMMAND_EXEC
[
  {
    "command": "cd my-react-app && npm init -y",
    "description": "Initializing npm project"
  },
  {
    "command": "npm install react react-dom",
    "cwd": "my-react-app",
    "description": "Installing React dependencies"
  }
]
$$$ COMMAND_END
%%%

$$$ FILE_CREATE my-react-app/src/App.js
import React from 'react';
// ... rest of the code ...
$$$ FILE_END
%%%`;

// Add this function after the imports
async function openInBrowser(filePath: string): Promise<void> {
	try {
		const platform = process.platform;
		let command = '';
		
		switch (platform) {
			case 'darwin': // macOS
				command = `open "${filePath}"`;
				break;
			case 'win32': // Windows
				command = `start "" "${filePath}"`;
				break;
			default: // Linux and others
				command = `xdg-open "${filePath}"`;
				break;
		}
		
		require('child_process').execSync(command, {
			stdio: 'ignore'
		});
	} catch (error) {
		console.error('Error opening file in browser:', error);
		throw error;
	}
}



// Helper function to handle Python-specific errors
function handlePythonError(errorOutput: string): string | null {
	// Common Python error patterns
	const syntaxErrorMatch = errorOutput.match(/SyntaxError: (.*)/);
	const indentationErrorMatch = errorOutput.match(/IndentationError: (.*)/);
	const importErrorMatch = errorOutput.match(/ImportError: (.*)/);
	const fileNotFoundMatch = errorOutput.match(/FileNotFoundError: (.*)/);

	if (syntaxErrorMatch) {
		return `Syntax error: ${syntaxErrorMatch[1]}`;
	} else if (indentationErrorMatch) {
		return `Indentation error: ${indentationErrorMatch[1]}`;
	} else if (importErrorMatch) {
		return `Import error: ${importErrorMatch[1]}`;
	} else if (fileNotFoundMatch) {
		return `File not found: ${fileNotFoundMatch[1]}`;
	}

	return null;
}

// Update the handleFileOperations function to handle %%% markers
async function handleFileOperations(content: string, workspaceRoot: string): Promise<string[]> {
	const createdItems: string[] = [];
	const contextManager = new ContextManager(workspaceRoot);
	
	// Folder creation regex with %%% marker
	const folderRegex = /\$\$\$ FOLDER_CREATE (.*?)(?=%%%|\n|$)/g;
	
	// File creation regex with %%% marker
	const fileCreateRegex = /\$\$\$ FILE_CREATE (.*?)\n([\s\S]*?)\$\$\$ FILE_END\s*%%%/g;
	
	// File modification regex with %%% marker
	const fileModifyStartRegex = /\$\$\$ FILE_MODIFY (.*?)\n/g;
	const fileModifyEndRegex = /\$\$\$ FILE_END\s*%%%/;
	const replaceBlockRegex = /### REPLACE_BLOCK_START (.*?)\n([\s\S]*?)### REPLACE_BLOCK_END\s*### NEW_BLOCK_START \1\n([\s\S]*?)### NEW_BLOCK_END/g;
	const insertAfterRegex = /### INSERT_AFTER line:"([^"]*?)"\n([\s\S]*?)### INSERT_END/g;
	const insertBeforeRegex = /### INSERT_BEFORE line:"([^"]*?)"\n([\s\S]*?)### INSERT_END/g;

	// New command execution regex with %%% marker
	const commandExecRegex = /\$\$\$ COMMAND_EXEC\n([\s\S]*?)\$\$\$ COMMAND_END\s*%%%/g;

	// Handle command execution
	let commandMatch;
	while ((commandMatch = commandExecRegex.exec(content)) !== null) {
		try {
			const commandJson = commandMatch[1].trim();
			const commands = JSON.parse(commandJson);
			const results = await executeCommands(commands, workspaceRoot);
			createdItems.push(...results);
		} catch (error: unknown) {
			console.error('Error executing commands:', error);
			throw new Error(`Failed to execute commands: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	// Handle folder creation
	let match;
	while ((match = folderRegex.exec(content)) !== null) {
		const relativePath = match[1].trim();
		const fullPath = path.join(workspaceRoot, relativePath);
		
		try {
			await createFolderStructure(fullPath);
			createdItems.push(`📁 ${relativePath}`);
		} catch (error) {
			console.error(`Error creating folder ${fullPath}:`, error);
			throw error;
		}
	}

	// Handle file creation
	while ((match = fileCreateRegex.exec(content)) !== null) {
		const [_, relativePath, fileContent] = match;
		const fullPath = path.join(workspaceRoot, relativePath.trim());
		
		try {
			await createFolderStructure(path.dirname(fullPath));
			await fs.promises.writeFile(fullPath, fileContent.trim());
			createdItems.push(`📄 ${relativePath.trim()}`);
			
			// Automatically add created file to context
			await contextManager.addToContext(fullPath);
			
			const doc = await vscode.workspace.openTextDocument(fullPath);
			await vscode.window.showTextDocument(doc, { preview: false });
		} catch (error: unknown) {
			console.error(`Error creating file ${fullPath}:`, error);
			throw new Error(`Failed to create file ${relativePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	// Handle file modifications
	let fileModifyMatch;
	while ((fileModifyMatch = fileModifyStartRegex.exec(content)) !== null) {
		const relativePath = fileModifyMatch[1].trim();
		const fullPath = path.join(workspaceRoot, relativePath);
		
		try {
			// Read existing file content
			const fileContent = await fs.promises.readFile(fullPath, 'utf8');
			let modifiedContent = fileContent;
			
			// Get the modification section
			const startIndex = fileModifyMatch.index;
			const endMatch = content.slice(startIndex).match(fileModifyEndRegex);
			if (!endMatch || typeof endMatch.index === 'undefined') continue;
			
			const modificationSection = content.slice(startIndex, startIndex + endMatch.index + endMatch[0].length);
			
			// Handle replacements
			let replaceMatch;
			while ((replaceMatch = replaceBlockRegex.exec(modificationSection)) !== null) {
				const [_, identifier, oldCode, newCode] = replaceMatch;
				modifiedContent = modifiedContent.replace(oldCode.trim(), newCode.trim());
			}
			
			// Handle insertions after specific lines
			let insertAfterMatch;
			while ((insertAfterMatch = insertAfterRegex.exec(modificationSection)) !== null) {
				const [_, targetLine, codeToInsert] = insertAfterMatch;
				const lines = modifiedContent.split('\n');
				const targetIndex = lines.findIndex(line => line.includes(targetLine));
				if (targetIndex !== -1) {
					lines.splice(targetIndex + 1, 0, codeToInsert.trim());
					modifiedContent = lines.join('\n');
				}
			}
			
			// Handle insertions before specific lines
			let insertBeforeMatch;
			while ((insertBeforeMatch = insertBeforeRegex.exec(modificationSection)) !== null) {
				const [_, targetLine, codeToInsert] = insertBeforeMatch;
				const lines = modifiedContent.split('\n');
				const targetIndex = lines.findIndex(line => line.includes(targetLine));
				if (targetIndex !== -1) {
					lines.splice(targetIndex, 0, codeToInsert.trim());
					modifiedContent = lines.join('\n');
				}
			}
			
			// Write modified content back to file
			await fs.promises.writeFile(fullPath, modifiedContent);
			createdItems.push(`✏️ ${relativePath.trim()} (modified)`);
			
			// Automatically add modified file to context if not already included
			await contextManager.addToContext(fullPath);
			
			const doc = await vscode.workspace.openTextDocument(fullPath);
			await vscode.window.showTextDocument(doc, { preview: false });
		} catch (error: unknown) {
			console.error(`Error modifying file ${fullPath}:`, error);
			throw new Error(`Failed to modify file ${relativePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	return createdItems;
}

// Update getWorkspaceContext function
async function getWorkspaceContext(contextManager: ContextManager): Promise<string> {
	let context = '';
	
	try {
		const contextFiles = await contextManager.getContextFiles();
		
		if (contextFiles.length > 0) {
			context += '### Workspace Context Files ###\n\n';
			let filesProcessed = 0;
			
            for (const fileInfo of contextFiles) {
                try {
                    const fileDetails = await contextManager.getFileDetails(fileInfo);
                    const content = await fs.promises.readFile(fileDetails.fullPath, 'utf8');
                    
                    // Add file content with enhanced metadata
                    context += `=== START FILE: ${fileDetails.relativePath} ===\n`;
                    context += `Full Path: ${fileDetails.fullPath}\n`;
                    context += `Relative Path: ${fileDetails.relativePath}\n`;
                    context += `Language: ${fileDetails.type}\n`;
                    context += `Size: ${formatFileSize(fileDetails.size)}\n`;
                    context += `Last Modified: ${fileDetails.lastModified.toISOString()}\n`;
                    context += `Content:\n\`\`\`${fileDetails.type}\n${content}\n\`\`\`\n`;
                    context += `=== END FILE: ${fileDetails.relativePath} ===\n\n`;
					
					filesProcessed++;
					
				} catch (error) {
                    console.error(`Error reading file ${fileInfo.relativePath}:`, error);
                    context += `Error reading file ${fileInfo.relativePath}: ${error instanceof Error ? error.message : 'Unknown error'}\n\n`;
				}
			}
			
			context += `Total context files processed: ${filesProcessed}\n\n`;
		} else {
			context += 'No workspace context files available.\n\n';
		}
		
		// Get current file context if any
		const activeEditor = vscode.window.activeTextEditor;
		if (activeEditor) {
			const document = activeEditor.document;
			const relativePath = vscode.workspace.asRelativePath(document.uri);
            const fullPath = document.uri.fsPath;
            const pathInfo: FilePathInfo = { fullPath, relativePath };
            
			context += '### Currently Active File ###\n\n';
			context += `=== START FILE: ${relativePath} (ACTIVE) ===\n`;
            context += `Full Path: ${fullPath}\n`;
            context += `Relative Path: ${relativePath}\n`;
			context += `Language: ${document.languageId}\n`;
			context += `Content:\n\`\`\`${document.languageId}\n${document.getText()}\n\`\`\`\n`;
			context += `=== END FILE: ${relativePath} ===\n\n`;
		}
		
		return context;
		
	} catch (error) {
		console.error('Error getting workspace context:', error);
		return `Error: Failed to get workspace context: ${error instanceof Error ? error.message : 'Unknown error'}`;
	}
}

// Function to validate task plan structure
function validateTaskPlan(plan: any): boolean {
	if (typeof plan !== 'object' || plan === null) {
		console.error('Plan is not an object:', plan);
		return false;
	}

	if (typeof plan.totalSteps !== 'number' || plan.totalSteps <= 0) {
		console.error('Invalid totalSteps:', plan.totalSteps);
		return false;
	}

	if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
		console.error('Invalid steps array:', plan.steps);
		return false;
	}

	for (const step of plan.steps) {
		if (typeof step.description !== 'string' || !step.description) {
			console.error('Invalid step description:', step);
			return false;
		}
		if (step.files && !Array.isArray(step.files)) {
			console.error('Invalid step files:', step);
			return false;
		}
		if (step.dependencies && !Array.isArray(step.dependencies)) {
			console.error('Invalid step dependencies:', step);
			return false;
		}
	}

	return true;
}

// Function to evaluate and plan tasks
async function evaluateRequest(request: string): Promise<TaskPlan> {
	try {
        const completion = await model.chat.completions.create({
            model: "o3-mini",
            reasoning_effort: "medium",
            max_completion_tokens: 100000,
            messages: [
                {
                    role: "system",
                    content: TASK_PLANNING_PROMPT
                },
                {
                    role: "user",
                    content: request
                }
            ],
            store: true
        });

        if (!completion.choices || completion.choices.length === 0) {
			throw new Error('Failed to generate task plan');
		}

        const rawText = completion.choices[0].message.content.trim();
        console.log('Raw response:', rawText);

		// Clean up the response to ensure it's valid JSON
		let planText = rawText
			.replace(/^```json\s*/, '') // Remove leading ```json
			.replace(/```$/, '') // Remove trailing 			.replace(/^`/, '') // Remove single backticks
			.replace(/`$/, '')
			.trim();

		// Ensure it starts with { and ends with }
		if (!planText.startsWith('{') || !planText.endsWith('}')) {
			throw new Error('Response is not a valid JSON object. It must start with { and end with }');
		}

		try {
			const plan = JSON.parse(planText);
			console.log('Parsed plan:', JSON.stringify(plan, null, 2)); // Debug log

			if (!validateTaskPlan(plan)) {
				throw new Error('Plan structure validation failed');
			}

			return {
				totalSteps: plan.totalSteps,
				currentStep: 0,
				steps: plan.steps.map((step: { description: string; files?: string[]; dependencies?: number[] }) => ({
					...step,
					status: 'pending'
				})),
				originalRequest: request
			};
		} catch (parseError) {
			console.error('JSON Parse Error. Raw text:', planText);
			console.error('Parse error details:', parseError);
			throw new Error('Failed to parse task plan: ' + (parseError instanceof Error ? parseError.message : 'Invalid JSON'));
		}
	} catch (error: unknown) {
		console.error('Error in task planning:', error);
		throw new Error('Failed to plan tasks: ' + (error instanceof Error ? error.message : 'Unknown error'));
	}
}

// Function to update chat panel with task progress
function updateTaskProgress(webview: vscode.Webview, taskPlan: TaskPlan) {
	webview.postMessage({
		type: 'updateProgress',
        data: {
            currentStep: taskPlan.currentStep,
            totalSteps: taskPlan.totalSteps,
            steps: taskPlan.steps.map((step, index) => ({
                ...step,
                status: index < taskPlan.currentStep ? 'completed' : 
                        index === taskPlan.currentStep ? 'in-progress' : 'pending'
            }))
        }
	});
}

// Add new class for code review functionality
class AICodeReviewer {
	private model: any;
	private context: vscode.ExtensionContext;

	constructor(model: any, context: vscode.ExtensionContext) {
		this.model = model;
		this.context = context;
	}

	async reviewFile(filePath: string): Promise<CodeReviewResult> {
		try {
			const fileContent = await fs.promises.readFile(filePath, 'utf8');
			const fileType = path.extname(filePath).slice(1);

			// Prepare the prompt for code review
			const reviewPrompt = `Perform a comprehensive code review of the following ${fileType} code.
			
			First, provide numerical metrics (0-100) for the following aspects:
			- Complexity: Rate the code's complexity (0 = simple, 100 = highly complex)
			- Maintainability: Rate how maintainable the code is (0 = poor, 100 = excellent)
			- Testability: Rate how testable the code is (0 = difficult, 100 = easy)
			- Security: Rate the code's security (0 = vulnerable, 100 = secure)
			- Performance: Rate the code's performance (0 = poor, 100 = excellent)

			Then provide detailed feedback on:
			1. Security vulnerabilities
			2. Performance optimizations
			3. Best practices
			4. Architecture improvements
			5. Code maintainability

			Format the metrics section as follows:
			METRICS:
			Complexity: [0-100]
			Maintainability: [0-100]
			Testability: [0-100]
			Security: [0-100]
			Performance: [0-100]

			Then provide specific, actionable feedback with code examples.

			Code to review:
			${fileContent}`;

			const chat = this.model.startChat({
				generationConfig: {
					temperature: 0.3,
					topP: 0.8,
					topK: 40,
				}
			});

			const result = await chat.sendMessage(reviewPrompt);
			const review = this.parseReviewResponse(result.response.text(), filePath);

			// Create diagnostic collection for VS Code
			const diagnostics = this.createDiagnostics(review);
			this.showReviewResults(review, diagnostics);

			return review;
		} catch (error) {
			console.error('Error performing code review:', error);
			throw new Error(`Failed to review file: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	private parseReviewResponse(response: string, filePath: string): CodeReviewResult {
		// Implementation of response parsing
		// Convert AI response to structured CodeReviewResult
		// This is a simplified version
		return {
			file: filePath,
			issues: this.extractIssues(response),
			suggestions: this.extractSuggestions(response),
			metrics: this.calculateMetrics(response)
		};
	}

	private extractIssues(response: string): CodeIssue[] {
		// Implementation of issue extraction
		// Parse AI response to find issues
		const issues: CodeIssue[] = [];
		// Add parsing logic here
		return issues;
	}

	private extractSuggestions(response: string): CodeSuggestion[] {
		// Implementation of suggestion extraction
		const suggestions: CodeSuggestion[] = [];
		// Add parsing logic here
		return suggestions;
	}

	private calculateMetrics(response: string): CodeMetrics {
		try {
			// Look for metrics in the response using regex patterns
			const complexityMatch = response.match(/complexity[:\s]+(\d+)/i);
			const maintainabilityMatch = response.match(/maintainability[:\s]+(\d+)/i);
			const testabilityMatch = response.match(/testability[:\s]+(\d+)/i);
			const securityMatch = response.match(/security[:\s]+(\d+)/i);
			const performanceMatch = response.match(/performance[:\s]+(\d+)/i);

			// Extract numeric values or default to 0
			return {
				complexity: complexityMatch ? parseInt(complexityMatch[1]) : 0,
				maintainability: maintainabilityMatch ? parseInt(maintainabilityMatch[1]) : 0,
				testability: testabilityMatch ? parseInt(testabilityMatch[1]) : 0,
				security: securityMatch ? parseInt(securityMatch[1]) : 0,
				performance: performanceMatch ? parseInt(performanceMatch[1]) : 0
			};
		} catch (error) {
			console.error('Error calculating metrics:', error);
			// Return default values if parsing fails
			return {
				complexity: 0,
				maintainability: 0,
				testability: 0,
				security: 0,
				performance: 0
			};
		}
	}

	private createDiagnostics(review: CodeReviewResult): vscode.DiagnosticCollection {
		const diagnostics = vscode.languages.createDiagnosticCollection('aiCodeReview');
		const fileUri = vscode.Uri.file(review.file);
		const fileDiagnostics: vscode.Diagnostic[] = [];

		// Convert issues to VS Code diagnostics
		review.issues.forEach(issue => {
			const range = new vscode.Range(
				new vscode.Position(issue.line - 1, 0),
				new vscode.Position(issue.line - 1, 100)
			);

			const diagnostic = new vscode.Diagnostic(
				range,
				issue.message,
				this.getSeverity(issue.severity)
			);

			diagnostic.source = 'AI Code Review';
			diagnostic.code = issue.type;
			fileDiagnostics.push(diagnostic);
		});

		diagnostics.set(fileUri, fileDiagnostics);
		return diagnostics;
	}

	private getSeverity(severity: string): vscode.DiagnosticSeverity {
		switch (severity) {
			case 'critical':
				return vscode.DiagnosticSeverity.Error;
			case 'warning':
				return vscode.DiagnosticSeverity.Warning;
			case 'suggestion':
				return vscode.DiagnosticSeverity.Information;
			default:
				return vscode.DiagnosticSeverity.Hint;
		}
	}

	private async showReviewResults(review: CodeReviewResult, diagnostics: vscode.DiagnosticCollection) {
		// Create and show a webview with the review results
		const panel = vscode.window.createWebviewPanel(
			'codeReview',
			'AI Code Review Results',
			vscode.ViewColumn.Two,
			{
				enableScripts: true,
				retainContextWhenHidden: true
			}
		);

		panel.webview.html = this.getReviewWebviewContent(review);

		// Handle webview messages
		panel.webview.onDidReceiveMessage(async message => {
			switch (message.type) {
				case 'applyFix':
					await this.applyAutoFix(message.fix, review.file);
					break;
				case 'showDiff':
					await this.showDiffView(message.original, message.suggested, review.file);
					break;
			}
		});
	}

	private getReviewWebviewContent(review: CodeReviewResult): string {
	return `<!DOCTYPE html>
	<html>
		<head>
			<style>
				body {
						padding: 20px;
					font-family: var(--vscode-font-family);
						color: var(--vscode-editor-foreground);
						background: var(--vscode-editor-background);
					}
					.metrics-container {
						display: grid;
						grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
					gap: 20px;
						margin-bottom: 30px;
					}
					.metric-card {
						background: var(--vscode-editor-inactiveSelectionBackground);
						border-radius: 8px;
						padding: 15px;
						text-align: center;
					}
					.metric-value {
						font-size: 24px;
					font-weight: bold;
						margin: 10px 0;
					}
					.issues-container {
						margin-top: 30px;
					}
					.issue-card {
					background: var(--vscode-editor-inactiveSelectionBackground);
						border-radius: 8px;
						padding: 15px;
						margin-bottom: 15px;
					}
					.issue-header {
					display: flex;
						justify-content: space-between;
						align-items: center;
						margin-bottom: 10px;
				}
					.issue-type {
					padding: 4px 8px;
					border-radius: 4px;
					font-size: 12px;
					font-weight: bold;
					}
					.issue-type.critical {
						background: var(--vscode-errorForeground);
						color: var(--vscode-editor-background);
					}
					.issue-type.warning {
						background: var(--vscode-warningForeground);
						color: var(--vscode-editor-background);
					}
					.issue-type.suggestion {
						background: var(--vscode-infoForeground);
						color: var(--vscode-editor-background);
					}
					.code-block {
						background: var(--vscode-textBlockQuote-background);
						padding: 10px;
					border-radius: 4px;
						margin: 10px 0;
						font-family: var(--vscode-editor-font-family);
						white-space: pre-wrap;
					}
					.action-button {
					background: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
						border: none;
						padding: 6px 12px;
					border-radius: 4px;
						cursor: pointer;
					font-size: 12px;
						transition: background-color 0.2s;
				}
					.action-button:hover {
						background: var(--vscode-button-hoverBackground);
				}
			</style>
		</head>
		<body>
				<h1>Code Review Results</h1>
				
				<div class="metrics-container">
					${Object.entries(review.metrics).map(([key, value]) => `
						<div class="metric-card">
							<div class="metric-label">${key.charAt(0).toUpperCase() + key.slice(1)}</div>
							<div class="metric-value">${value}</div>
					</div>
					`).join('')}
				</div>
				
				<div class="issues-container">
					<h2>Issues and Suggestions</h2>
					${review.issues.map(issue => `
						<div class="issue-card">
							<div class="issue-header">
								<span class="issue-type ${issue.severity}">${issue.type}</span>
								<span class="issue-location">Line ${issue.line}</span>
					</div>
							<div class="issue-message">${issue.message}</div>
							${issue.suggestedFix ? `
								<div class="code-block">${issue.suggestedFix}</div>
								${issue.autoFixable ? `
									<button class="action-button" onclick="applyFix(${JSON.stringify(issue)})">
										Apply Fix
									</button>
								` : ''}
							` : ''}
						</div>
					`).join('')}
					</div>

				<div class="suggestions-container">
					<h2>Improvement Suggestions</h2>
					${review.suggestions.map(suggestion => `
						<div class="issue-card">
							<div class="issue-header">
								<span class="issue-type suggestion">${suggestion.type}</span>
								<span class="issue-location">Line ${suggestion.line}</span>
						</div>
							<div class="suggestion-description">${suggestion.description}</div>
							<div class="code-block">${suggestion.codeSnippet}</div>
							<div class="benefits">
								<h4>Benefits:</h4>
								<ul>
									${suggestion.benefits.map(benefit => `<li>${benefit}</li>`).join('')}
								</ul>
					</div>
							<button class="action-button" onclick="showDiff(${JSON.stringify({
								line: suggestion.line,
								original: suggestion.codeSnippet,
								suggested: suggestion.codeSnippet
							})})">
								Show Diff
							</button>
				</div>
					`).join('')}
			</div>

			<script>
				const vscode = acquireVsCodeApi();

					function applyFix(issue) {
						vscode.postMessage({
							type: 'applyFix',
							fix: issue
						});
					}

					function showDiff(diffInfo) {
						vscode.postMessage({
							type: 'showDiff',
							...diffInfo
						});
					}
				</script>
			</body>
		</html>`;
	}

	private async applyAutoFix(fix: CodeIssue, filePath: string) {
		try {
			const document = await vscode.workspace.openTextDocument(filePath);
			const edit = new vscode.WorkspaceEdit();
			
			const range = new vscode.Range(
				new vscode.Position(fix.line - 1, 0),
				new vscode.Position(fix.line, 0)
			);

			edit.replace(document.uri, range, fix.suggestedFix || '');
			await vscode.workspace.applyEdit(edit);
		} catch (error) {
			console.error('Error applying fix:', error);
			vscode.window.showErrorMessage('Failed to apply fix: ' + (error instanceof Error ? error.message : 'Unknown error'));
		}
	}

	private async showDiffView(original: string, suggested: string, filePath: string) {
		try {
			const originalUri = vscode.Uri.parse('untitled:Original');
			const suggestedUri = vscode.Uri.parse('untitled:Suggested');

			await vscode.workspace.openTextDocument(originalUri)
				.then(doc => vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One }))
				.then(editor => editor.edit(edit => edit.insert(new vscode.Position(0, 0), original)));

			await vscode.workspace.openTextDocument(suggestedUri)
				.then(doc => vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two }))
				.then(editor => editor.edit(edit => edit.insert(new vscode.Position(0, 0), suggested)));

			await vscode.commands.executeCommand('vscode.diff', originalUri, suggestedUri, 'Code Suggestion Diff');
		} catch (error) {
			console.error('Error showing diff:', error);
			vscode.window.showErrorMessage('Failed to show diff: ' + (error instanceof Error ? error.message : 'Unknown error'));
		}
	}
}

// Register the code review command
// Note: Using global model variable declared at the top

// Update the activate function
export async function activate(context: vscode.ExtensionContext) {
	console.log('Extension "falalo" is now active!');

	try {
		// Initialize OpenAI
		const model = await initializeOpenAI(context);
		
		// Get workspace root
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			throw new Error('No workspace folder found');
		}

		// Initialize managers
		const contextManager = new ContextManager(workspaceRoot, model);
		const logManager = LogManager.getInstance();

		// Register the showLogs command
		context.subscriptions.push(
			vscode.commands.registerCommand('falalo.showLogs', () => {
				logManager.show();
			})
		);

		// Register other commands and providers
		context.subscriptions.push(
			vscode.commands.registerCommand('falalo.startChat', 
				AutoRetryHandler.wrapCommand(async () => {
					await vscode.commands.executeCommand('falalo.chatView.focus');
				}, 'Start Chat')
			),
			vscode.commands.registerCommand('falalo.screenshot',
				AutoRetryHandler.wrapCommand(async () => {
					const url = await vscode.window.showInputBox({
						prompt: 'Enter the URL to capture',
						placeHolder: 'https://example.com'
					});

					if (url) {
						const screenshotManager = new ScreenshotManager(context.extensionUri.fsPath, model);
						try {
							vscode.window.showInformationMessage(`Taking screenshot of ${url}...`);
							const screenshotPath = await screenshotManager.takeScreenshot(url);
							
							// Show progress notification
							vscode.window.withProgress({
								location: vscode.ProgressLocation.Notification,
								title: "Analyzing screenshot...",
								cancellable: false
							}, async (progress) => {
								try {
									// Analyze the screenshot
									const analysis = await screenshotManager.analyzeScreenshot(screenshotPath, url);
									
									// Create and show the analysis webview
									const panel = vscode.window.createWebviewPanel(
										'screenshotAnalysis',
										'Screenshot Analysis',
										vscode.ViewColumn.Beside,
										{
											enableScripts: true,
											localResourceRoots: [
												vscode.Uri.file(path.dirname(screenshotPath)),
												vscode.Uri.file(context.extensionUri.fsPath)
											]
										}
									);

									// Convert the screenshot to a webview URI
									const screenshotUri = panel.webview.asWebviewUri(vscode.Uri.file(screenshotPath));
									
									// Create the HTML content
									panel.webview.html = `
										<!DOCTYPE html>
										<html lang="en">
										<head>
											<meta charset="UTF-8">
											<meta name="viewport" content="width=device-width, initial-scale=1.0">
											<title>Screenshot Analysis</title>
											<style>
												body {
													padding: 20px;
													font-family: var(--vscode-font-family);
													color: var(--vscode-editor-foreground);
													background: var(--vscode-editor-background);
												}
												.screenshot {
													max-width: 100%;
													margin-bottom: 20px;
													border: 1px solid var(--vscode-input-border);
												}
												.analysis-section {
													margin-bottom: 20px;
													padding: 15px;
													background: var(--vscode-editor-inactiveSelectionBackground);
													border-radius: 6px;
												}
												.suggestion {
													margin: 10px 0;
													padding: 10px;
													background: var(--vscode-inputValidation-infoBackground);
													border-left: 3px solid var(--vscode-inputValidation-infoBorder);
												}
												.action {
													margin: 10px 0;
													padding: 10px;
													background: var(--vscode-inputValidation-warningBackground);
													border-left: 3px solid var(--vscode-inputValidation-warningBorder);
												}
												button {
													background: var(--vscode-button-background);
													color: var(--vscode-button-foreground);
													border: none;
													padding: 8px 12px;
													cursor: pointer;
													margin: 5px;
												}
												button:hover {
													background: var(--vscode-button-hoverBackground);
												}
											</style>
										</head>
										<body>
											<h2>Screenshot Analysis for ${url}</h2>
											<img src="${screenshotUri}" alt="Screenshot" class="screenshot">
											
											<div class="analysis-section">
												<h3>Analysis</h3>
												<p>${analysis.analysis.replace(/\n/g, '<br>')}</p>
											</div>

											<div class="analysis-section">
												<h3>Suggestions</h3>
												${analysis.suggestions.map(suggestion => `
													<div class="suggestion">${suggestion}</div>
												`).join('')}
											</div>

											<div class="analysis-section">
												<h3>Actionable Improvements</h3>
												${analysis.actions.map((action, index) => `
													<div class="action">
														<p>${action.description}</p>
														${action.code ? `
															<button onclick="implementAction(${index})">
																Implement This Improvement
															</button>
														` : ''}
													</div>
												`).join('')}
											</div>

											<script>
												const vscode = acquireVsCodeApi();
												function implementAction(index) {
													vscode.postMessage({
														type: 'implementAction',
														actionIndex: index
													});
												}
											</script>
										</body>
										</html>
									`;

									// Handle messages from the webview
									panel.webview.onDidReceiveMessage(async message => {
										if (message.type === 'implementAction') {
											const action = analysis.actions[message.actionIndex];
											if (action) {
												await screenshotManager.implementSuggestedActions([action], panel.webview);
											}
										}
									});

								} catch (error) {
									vscode.window.showErrorMessage(`Error analyzing screenshot: ${error instanceof Error ? error.message : 'Unknown error'}`);
								}
							});

							// Open the screenshot
							const uri = vscode.Uri.file(screenshotPath);
							await vscode.commands.executeCommand('vscode.open', uri);
						} catch (error) {
							vscode.window.showErrorMessage(`Failed to take screenshot: ${error instanceof Error ? error.message : 'Unknown error'}`);
						} finally {
							await screenshotManager.cleanup();
						}
					}
				}, 'Take Screenshot')
			),
			vscode.commands.registerCommand('falalo.reviewCode',
				AutoRetryHandler.wrapCommand(async () => {
					const activeEditor = vscode.window.activeTextEditor;
					if (!activeEditor) {
						throw new Error('No active editor');
					}

					const reviewer = new AICodeReviewer(model, context);
					await reviewer.reviewFile(activeEditor.document.uri.fsPath);
				}, 'Code Review')
			),
			vscode.commands.registerCommand('falalo.includeInContext',
				AutoRetryHandler.wrapCommand(async (resource: vscode.Uri) => {
					if (resource) {
						await contextManager.addToContext(resource.fsPath);
					}
				}, 'Include in Context')
			),
			vscode.commands.registerCommand('falalo.excludeFromContext',
				AutoRetryHandler.wrapCommand(async (resource: vscode.Uri) => {
					if (resource) {
						await contextManager.removeFromContext(resource.fsPath);
					}
				}, 'Exclude from Context')
			),
			vscode.commands.registerCommand('falalo.showContextItems',
				AutoRetryHandler.wrapCommand(async () => {
					await contextManager.showContextItems();
				}, 'Show Context Items')
			),
			vscode.commands.registerCommand('falalo.organizeFiles',
				AutoRetryHandler.wrapCommand(async () => {
					if (!vscode.workspace.workspaceFolders) {
						throw new Error('Please open a workspace folder first');
					}

					const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
					const organizer = new FileOrganizer(workspaceRoot);

					// Show organization options
					const organizationType = await vscode.window.showQuickPick([
						{ label: 'By Type', description: 'Organize files by their type (images, documents, etc.)', value: 'type' },
						{ label: 'By Date', description: 'Organize files by their modification date', value: 'date' },
						{ label: 'By Size', description: 'Organize files by their size', value: 'size' },
						{ label: 'By Name', description: 'Organize files alphabetically', value: 'name' }
					], {
						placeHolder: 'How would you like to organize the files?'
					});

					if (!organizationType) {
						return;
					}

					const sortOrder = await vscode.window.showQuickPick([
						{ label: 'Ascending', description: 'A to Z, Oldest to Newest, Smallest to Largest', value: 'asc' },
						{ label: 'Descending', description: 'Z to A, Newest to Oldest, Largest to Smallest', value: 'desc' }
					], {
						placeHolder: 'Choose sort order'
					});

					if (!sortOrder) {
						return;
					}

					const createFolders = await vscode.window.showQuickPick([
						{ label: 'Yes', description: 'Create organized folders and move files', value: true },
						{ label: 'No', description: 'Just show organization preview', value: false }
					], {
						placeHolder: 'Create organized folders?'
					});

					if (!createFolders) {
						return;
					}

					// Show progress
					await vscode.window.withProgress({
						location: vscode.ProgressLocation.Notification,
						title: 'Organizing files...',
						cancellable: false
					}, async (progress) => {
						progress.report({ increment: 0 });

						const options: OrganizeOptions = {
							by: organizationType.value as 'type' | 'date' | 'size' | 'name',
							order: sortOrder.value as 'asc' | 'desc',
							createFolders: createFolders.value,
							excludePatterns: ['node_modules/**', '.git/**', 'out/**', 'dist/**']
						};

						const result = await organizer.organizeFiles(options);
						progress.report({ increment: 100 });

						if (result.success) {
							if (options.createFolders) {
								vscode.window.showInformationMessage(
									`Successfully organized ${result.organized.length} files into folders.`
								);
							} else {
								// Show preview in a new webview
								const panel = vscode.window.createWebviewPanel(
									'fileOrganizer',
									'File Organization Preview',
									vscode.ViewColumn.One,
									{ enableScripts: true }
								);

								panel.webview.html = getFileOrganizerPreviewHtml(result.organized, options);
							}
						} else {
							vscode.window.showErrorMessage(result.message);
						}
					});

				}, 'Organize Files')
			)
		);

		// Register the providers with auto-retry
		const chatViewProvider = new ChatViewProvider(context.extensionUri, model, contextManager);
		const contextFilesViewProvider = new ContextFilesViewProvider(context.extensionUri, contextManager);

		context.subscriptions.push(
			vscode.window.registerWebviewViewProvider('falalo.chatView', chatViewProvider, {
				webviewOptions: { retainContextWhenHidden: true }
			}),
			vscode.window.registerWebviewViewProvider('falalo.contextFilesView', contextFilesViewProvider, {
				webviewOptions: { retainContextWhenHidden: true }
			})
		);

	} catch (error) {
		console.error('Failed to initialize extension:', error);
		vscode.window.showErrorMessage('Failed to initialize extension: ' + (error instanceof Error ? error.message : 'Unknown error'));
	}
}



// Update the cleanAIResponse function to handle %%% markers
function cleanAIResponse(response: string): string {
    // Remove %%% markers
    response = response.replace(/%%%\s*$/, '');
    // Remove any backticks (in case they're still present)
    response = response.replace(/`/g, '');
    // Ensure it's valid JSON structure
    response = response.trim();
    if (!response.startsWith('{')) {
        response = '{' + response;
    }
    if (!response.endsWith('}')) {
        response = response + '}';
    }
    return response;
}

function validatePath(path: string): boolean {
    // Check if path contains invalid characters
    const invalidChars = /[<>:"|?*]/;
    if (invalidChars.test(path)) {
        return false;
    }
    // Check for directory traversal attempts
    if (path.includes('..')) {
        return false;
    }
    return true;
}

function sanitizeCommand(command: string): string {
    // Prevent HTML content from being executed as commands
    if (command.includes('<') || command.includes('>')) {
        throw new Error('Invalid command: Contains HTML-like content');
    }

    // Remove any unmatched quotes and escape existing quotes
    let sanitized = command.replace(/(['"])((?:\\\1|.)*?)\1|(['"])(.*)$/g, (match, q1, c1, q2, c2) => {
        if (q2) {
            // Unmatched quote - remove it
            return c2 ? c2.replace(/["']/g, '\\"') : '';
        }
        return match;
    });

    // Ensure no process IDs are treated as commands
    if (/^\d+$/.test(sanitized.trim())) {
        throw new Error('Invalid command: Cannot execute process ID as command');
    }

    // Escape special characters
    sanitized = sanitized.replace(/([&;|<>$`\\"])/g, '\\$1');

    return sanitized;
}

// Add new interfaces for token usage tracking
interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cost: number;
}

// Add new interface for command execution
interface CommandExecution {
    command: string;
    cwd?: string;
    isBackground?: boolean;
    description?: string;
}

const outputChannel = vscode.window.createOutputChannel('Falalo AI Logs');

interface AutoContextResult {
    selectedFiles: string[];
    explanation: string;
    confidence: number;
}

class AutoContextSelector {
    private model: OpenAI;
    private contextManager: ContextManager;
    private enabled: boolean = false;
    private lastSelection: AutoContextResult | null = null;

    constructor(model: OpenAI, contextManager: ContextManager) {
        this.model = model;
        this.contextManager = contextManager;
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    public toggleEnabled(): boolean {
        this.enabled = !this.enabled;
        return this.enabled;
    }

    public getLastSelection(): AutoContextResult | null {
        return this.lastSelection;
    }

    private async getAllWorkspaceFiles(): Promise<string[]> {
        const workspaceRoot = this.contextManager.getWorkspaceRoot();
        const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
        return files.map(file => vscode.workspace.asRelativePath(file));
    }

    public async selectRelevantFiles(userQuery: string): Promise<AutoContextResult> {
        const workspaceFiles = await this.getAllWorkspaceFiles();
        const fileStructure = workspaceFiles.join('\n');

        try {
            const response = await this.model.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: `You are an expert at determining which files would be most relevant for answering coding-related questions.
                        Given a user query and a list of files in the workspace, select the most relevant files that would help in answering the query.
                        Consider:
                        1. Direct file references in the query
                        2. Related configuration files
                        3. Files that might contain relevant code
                        4. Files that provide necessary context
                        
                        Respond in JSON format:
                        {
                            "selectedFiles": ["file1", "file2"],
                            "explanation": "Detailed explanation of why these files were selected",
                            "confidence": 0.9 // 0-1 scale
                        }`
                    },
                    {
                        role: 'user',
                        content: `User Query: ${userQuery}\n\nAvailable Files:\n${fileStructure}`
                    }
                ],
                temperature: 0.3,
                max_tokens: 1000
            });

            const content = response.choices[0]?.message?.content || '{}';
            const result: AutoContextResult = JSON.parse(content);
            this.lastSelection = result;

            // Log the selection
            LogManager.getInstance().log(
                `Auto Context Selection:\n${JSON.stringify(result, null, 2)}`,
                'info'
            );

            return result;
        } catch (error) {
            LogManager.getInstance().logError(error, 'AutoContextSelector.selectRelevantFiles');
            throw error;
        }
    }
}

async function fixCommandIssues(command: string, error: any): Promise<string | null> {
    const errorMsg = error.message || error.toString();
    
    // Handle specific error cases
    if (errorMsg.includes('unexpected EOF')) {
        // Fix unmatched quotes
        return command.replace(/(['"])((?:\\\1|.)*?)\1|(['"])(.*)$/g, '$2$4');
    }
    
    if (errorMsg.includes('command not found')) {
        // Check if it's trying to execute a number
        if (/^\d+$/.test(command.trim())) {
            return null;
        }
        
        // Try to fix path issues
        if (!command.startsWith('./') && !command.startsWith('/')) {
            return `./${command}`;
        }
    }
    
    return null;
}

async function executeCommands(commands: CommandExecution | CommandExecution[], workspaceRoot: string): Promise<string[]> {
    const results: string[] = [];
    const commandArray = Array.isArray(commands) ? commands : [commands];
    const { execSync, spawn } = require('child_process');

    for (const cmd of commandArray) {
        try {
            if (!cmd.command || typeof cmd.command !== 'string') {
                throw new Error('Invalid command: Command must be a non-empty string');
            }

            // Log the command before sanitization
            LogManager.getInstance().log(`Executing command: ${cmd.command}`, 'info');

            const sanitizedCommand = sanitizeCommand(cmd.command);
            if (!sanitizedCommand) {
                throw new Error('Command was invalid after sanitization');
            }

            const options = {
                cwd: cmd.cwd || workspaceRoot,
                shell: process.platform === 'darwin' ? '/bin/zsh' : process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
                encoding: 'utf8' as const,
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer
                env: { 
                    ...process.env, 
                    FORCE_COLOR: '1',
                    LANG: 'en_US.UTF-8',
                    LC_ALL: 'en_US.UTF-8'
                },
                windowsHide: true
            };

            if (cmd.isBackground) {
                const childProcess = spawn(sanitizedCommand, [], {
                    ...options,
                    detached: true,
                    stdio: 'ignore'
                });
                
                childProcess.unref();
                const message = `Started background process: ${cmd.command}`;
                results.push(message);
                LogManager.getInstance().log(message, 'info');
                
                childProcess.on('error', (error: Error) => {
                    LogManager.getInstance().logError(error, `Background command: ${cmd.command}`);
                });
            } else {
                try {
                    const output = execSync(sanitizedCommand, options);
                    const result = output.toString().trim();
                    
                    if (result) {
                        results.push(result);
                        LogManager.getInstance().log(`Command output: ${result}`, 'info');
                    }
                } catch (error: any) {
                    // Log the original error with full details
                    LogManager.getInstance().logError(
                        error,
                        `Command failed: ${cmd.command}\nStderr: ${error.stderr?.toString() || 'No stderr'}`
                    );
                    
                    // Try to fix the command
                    const fixedCommand = await fixCommandIssues(sanitizedCommand, error);
                    if (fixedCommand && fixedCommand !== sanitizedCommand) {
                        try {
                            const retryOutput = execSync(fixedCommand, options);
                            const retryResult = retryOutput.toString().trim();
                            
                            if (retryResult) {
                                results.push(retryResult);
                                LogManager.getInstance().log(`Fixed command output: ${retryResult}`, 'info');
                            }
                        } catch (retryError) {
                            // If retry also fails, throw the original error with context
                            throw new Error(`Command failed: ${cmd.command}\nError: ${error.message}\nStderr: ${error.stderr?.toString() || 'No stderr'}`);
                        }
                    } else {
                        throw error;
                    }
                }
            }
        } catch (error: any) {
            const errorMessage = error.message || error.toString();
            const stderr = error.stderr?.toString() || '';
            
            LogManager.getInstance().logError(
                error,
                `Command execution failed: ${cmd.command}\nError: ${errorMessage}\nStderr: ${stderr}`
            );
            
            throw new Error(`Command execution failed: ${errorMessage}${stderr ? `\nStderr: ${stderr}` : ''}`);
        }
    }

    return results;
}

interface CodeSummary {
    overview: string;
    contextAnalysis: string;
    suggestedApproach: string;
    timestamp: string;
}