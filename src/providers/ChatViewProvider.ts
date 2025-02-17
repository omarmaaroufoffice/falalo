import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { OpenAI } from 'openai';
import { ContextManager } from '../services/ContextManager';
import { ScreenshotManager } from '../services/ScreenshotManager';
import { LogManager } from '../logManager';
import { TokenUsage, CodeSummary, TaskPlan } from '../interfaces/types';
import { SYSTEM_PROMPT } from '../constants/prompts';
import { processResponseWithCodeBlocks, handleFileOperations } from '../utils/fileOperations';
import { evaluateRequest, initializeTaskPlanner } from '../services/taskPlanner';
import { getWorkspaceContext } from '../utils/contextHelper';
import { executeCommand } from '../utils/commandExecutor';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private chatHistory: { role: string; parts: { text: string }[] }[] = [];
    private tokenUsage: TokenUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
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

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly model: OpenAI,
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

    private updateTokenUsageFromCompletion(completion: any) {
        if (completion.usage) {
            this.tokenUsage.inputTokens += completion.usage.prompt_tokens || 0;
            this.tokenUsage.outputTokens += completion.usage.completion_tokens || 0;
            this.tokenUsage.cachedInputTokens += completion.usage.cached_tokens || 0;
            
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

    private setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(async message => {
            try {
                switch (message.type) {
                    case 'userMessage':
                        await this.handleUserMessage(message.text, webview);
                        break;
                    case 'excludeFile':
                        if (message.path) {
                            await this.handleExcludeFile(message.path, webview);
                        }
                        break;
                }
            } catch (error: any) {
                this.handleError(error, webview);
            }
        });
    }

    private async handleUserMessage(message: string, webview: vscode.Webview) {
        try {
            webview.postMessage({
                type: 'status',
                text: 'Analyzing your request...',
                status: 'info'
            });

            const summary = await this.generateCodeSummary(message);
            const summaryHtml = this.formatSummaryForDisplay(summary);
            webview.postMessage({ 
                type: 'aiResponse', 
                text: summaryHtml,
                isAnalysis: true
            });

            const taskPlan = await evaluateRequest(message);
            webview.postMessage({
                type: 'updateProgress',
                data: {
                    currentStep: taskPlan.currentStep,
                    totalSteps: taskPlan.totalSteps,
                    steps: taskPlan.steps
                }
            });

            await this.executeTaskPlan(taskPlan, webview);

        } catch (error) {
            this.handleError(error, webview);
        }
    }

    private async handleExcludeFile(filePath: string, webview: vscode.Webview) {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                throw new Error('No workspace folder found');
            }
            
            const fullPath = path.join(workspaceRoot, filePath);
            await this.contextManager.removeFromContext(fullPath);
            await this.updateContextFiles(webview);
            
            webview.postMessage({
                type: 'fileOperation',
                success: true,
                details: `Removed from context: ${filePath}`
            });
        } catch (error) {
            this.handleError(error, webview);
        }
    }

    private handleError(error: any, webview: vscode.Webview) {
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

        webview.postMessage({
            type: 'enableInput',
            enabled: true
        });
    }

    private async executeTaskPlan(taskPlan: any, webview: vscode.Webview) {
        while (taskPlan.currentStep < taskPlan.totalSteps) {
            const currentStep = taskPlan.steps[taskPlan.currentStep];
            currentStep.status = 'in-progress';
            
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

            const context = await getWorkspaceContext(this.contextManager);
            
            const completion = await this.model.chat.completions.create({
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

            this.updateTokenUsageFromCompletion(completion);

            const response = completion.choices[0]?.message?.content || '';
            await this.detectAndExecuteCommands(response, webview);

            const operations = processResponseWithCodeBlocks(response);
            await handleFileOperations(operations);
            if (operations.length > 0) {
                currentStep.files = operations.map(op => op.path);
            }

            webview.postMessage({
                type: 'aiResponse',
                text: response,
                hasCode: response.includes('CODE_BLOCK_START')
            });

            currentStep.status = 'completed';
            
            webview.postMessage({
                type: 'updateProgress',
                data: {
                    currentStep: taskPlan.currentStep,
                    totalSteps: taskPlan.totalSteps,
                    steps: taskPlan.steps
                }
            });

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

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

        webview.postMessage({
            type: 'enableInput',
            enabled: true
        });
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
                content: summaryText,
                language: 'markdown',
                path: 'analysis.md',
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
                content: 'Error generating summary',
                language: 'markdown',
                path: 'analysis.md',
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
        const vscode = acquireVsCodeApi();
        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendButton = document.getElementById('sendButton');
        const progressContainer = document.getElementById('progressContainer');

        // Initialize message history
        const state = vscode.getState() || { messages: [] };
        updateMessages();

        // Handle input events
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        sendButton.addEventListener('click', () => {
            sendMessage();
        });

        function sendMessage() {
            const message = messageInput.value.trim();
            if (message) {
                // Disable input while processing
                messageInput.disabled = true;
                sendButton.disabled = true;

                // Add user message to UI
                addMessage(message, 'user');

                // Send to extension
                vscode.postMessage({
                    type: 'userMessage',
                    text: message
                });

                // Clear input
                messageInput.value = '';
            }
        }

        function addMessage(text, type = 'ai', options = {}) {
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${type}-message\`;
            
            if (options.isAnalysis) {
                messageDiv.innerHTML = text;
            } else {
                messageDiv.textContent = text;
            }
            
            messagesContainer.appendChild(messageDiv);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;

            // Update state
            state.messages.push({ text, type, options });
            vscode.setState(state);
        }

        function updateMessages() {
            messagesContainer.innerHTML = '';
            state.messages.forEach(msg => {
                addMessage(msg.text, msg.type, msg.options);
            });
        }

        function updateProgress(data) {
            progressContainer.innerHTML = \`
                <div class="task-progress">
                    <div class="progress-header">
                        <span class="progress-title">Task Progress</span>
                        <span class="progress-stats">\${data.currentStep + 1}/\${data.totalSteps}</span>
                    </div>
                    <div class="steps-list">
                        \${data.steps.map((step, index) => \`
                            <div class="step \${step.status}">
                                <div class="step-number">\${index + 1}</div>
                                <div class="step-content">
                                    <div class="step-description">\${step.description}</div>
                                    \${step.files ? \`
                                        <div class="file-operations">
                                            \${step.files.map(file => \`
                                                <div class="file-operation">
                                                    <span class="operation-icon">📄</span>
                                                    <span class="operation-details">\${file}</span>
                                                </div>
                                            \`).join('')}
                                        </div>
                                    \` : ''}
                                </div>
                            </div>
                        \`).join('')}
                    </div>
                </div>
            \`;
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'aiResponse':
                    addMessage(message.text, 'ai', {
                        isAnalysis: message.isAnalysis,
                        hasCode: message.hasCode,
                        isComplete: message.isComplete
                    });
                    break;
                    
                case 'status':
                    const statusDiv = document.createElement('div');
                    statusDiv.className = \`status-container \${message.status}\`;
                    statusDiv.innerHTML = \`
                        <p class="status-message">\${message.text}</p>
                        <div class="progress-indicator"></div>
                    \`;
                    messagesContainer.appendChild(statusDiv);
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    break;
                    
                case 'updateProgress':
                    updateProgress(message.data);
                    break;
                    
                case 'enableInput':
                    messageInput.disabled = false;
                    sendButton.disabled = false;
                    messageInput.focus();
                    break;
                    
                case 'error':
                    addMessage(\`Error: \${message.message}\`, 'error');
                    messageInput.disabled = false;
                    sendButton.disabled = false;
                    break;
            }
        });

        // Initial focus
        messageInput.focus();
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

    public dispose() {
        this.screenshotManager.cleanup();
    }

    private async detectAndExecuteCommands(response: string | null, webview: vscode.Webview): Promise<void> {
        if (!response) return;

        const commandMatches = response.match(/\$\$\$ COMMAND\n([\s\S]*?)\$\$\$ END/g);
        if (!commandMatches) return;

        for (const match of commandMatches) {
            const command = match.replace(/\$\$\$ COMMAND\n/, '').replace(/\$\$\$ END/, '').trim();
            if (!command) continue;

            try {
                const result = await executeCommand(command, {
                    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                    description: 'Executing generated command'
                });

                webview.postMessage({
                    type: 'commandResult',
                    success: true,
                    command,
                    output: result
                });
            } catch (error: any) {
                webview.postMessage({
                    type: 'commandResult',
                    success: false,
                    command,
                    error: error.message
                });
                throw error;
            }
        }
    }

    private async updateContextFiles(webview: vscode.Webview): Promise<void> {
        const contextFiles = await this.contextManager.getContextFiles();
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        
        if (!workspaceRoot) {
            throw new Error('No workspace folder found');
        }

        const relativePaths = contextFiles.map((file: string) => path.relative(workspaceRoot!, file));
        
        webview.postMessage({
            type: 'updateFiles',
            files: relativePaths
        });
    }
} 