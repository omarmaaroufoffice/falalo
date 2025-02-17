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
    private logger: LogManager;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly model: OpenAI,
        private readonly contextManager: ContextManager
    ) {
        this.screenshotManager = new ScreenshotManager(extensionUri.fsPath);
        this.logger = LogManager.getInstance();
        this.logger.log('ChatViewProvider initialized', { type: 'info' });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this.logger.log('Resolving webview view...', { type: 'info' });
        
        try {
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
                this.logger.log(`Creating CSS directory: ${mediaPath}`, { type: 'info' });
                fs.mkdirSync(mediaPath, { recursive: true });
            }

            // Set up webview content
            this.logger.log('Setting up webview content...', { type: 'info' });
            webviewView.webview.html = this.getWebviewContent(webviewView.webview);
            
            // Set up message listener
            this.setWebviewMessageListener(webviewView.webview);
            
            this.logger.log('Webview view resolved successfully', { type: 'info' });
        } catch (error) {
            this.logger.logError(error, 'Failed to resolve webview view');
            throw error;
        }
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
        this.logger.log('Setting up webview message listener...', { type: 'info' });
        
        webview.onDidReceiveMessage(async message => {
            this.logger.log(`Received message from webview: ${JSON.stringify(message)}`, { type: 'info' });
            
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
                    default:
                        this.logger.log(`Unknown message type: ${message.type}`, { type: 'error' });
                }
            } catch (error) {
                this.logger.logError(error, 'Message handler error');
                this.handleError(error, webview);
            }
        });
    }

    private async handleUserMessage(message: string, webview: vscode.Webview) {
        this.logger.log(`Processing user message: ${message}`, { type: 'info' });
        
        try {
            // Disable input while processing
            webview.postMessage({
                type: 'enableInput',
                enabled: false
            });

            webview.postMessage({
                type: 'status',
                text: 'Processing your request...',
                status: 'info'
            });

            // Add user message to UI
            webview.postMessage({
                type: 'message',
                text: message,
                role: 'user'
            });

            this.logger.log('Sending request to OpenAI...', { type: 'info' });
            
            // Create completion with o3-mini model
            const completion = await this.model.chat.completions.create({
                model: 'o3-mini',
                messages: [
                    {
                        role: 'system',
                        content: SYSTEM_PROMPT
                    },
                    {
                        role: 'user',
                        content: message
                    }
                ],
                reasoning_effort: 'medium',
                store: true
            });

            this.logger.log('Received response from OpenAI', { type: 'info' });

            const response = completion.choices[0]?.message?.content;
            if (!response) {
                throw new Error('No response from AI');
            }

            // Send response to webview
            webview.postMessage({
                type: 'message',
                text: response,
                role: 'assistant'
            });

            // Update token usage
            this.updateTokenUsageFromCompletion(completion);

        } catch (error) {
            this.logger.logError(error, 'Chat error');
            this.handleError(error, webview);
        } finally {
            // Re-enable input
            webview.postMessage({
                type: 'enableInput',
                enabled: true
            });
            webview.postMessage({
                type: 'status',
                text: '',
                status: 'info'
            });
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
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        this.logger.logError(error, 'Chat error');
        
        webview.postMessage({
            type: 'status',
            text: 'An error occurred',
            status: 'error'
        });
        
        webview.postMessage({
            type: 'message',
            text: `Error: ${errorMessage}`,
            role: 'error'
        });
        
        webview.postMessage({
            type: 'enableInput',
            enabled: true
        });
        
        vscode.window.showErrorMessage(`Chat error: ${errorMessage}`);
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
                reasoning_effort: "medium",
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
                model: 'o3-mini',
                messages: [
                    { role: 'system', content: 'You are an expert code analyst providing detailed summaries and implementation strategies.' },
                    { role: 'user', content: prompt }
                ],
                reasoning_effort: 'medium',
                store: true
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
        this.logger.log('Generating webview content...', { type: 'info' });
        
        try {
            const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'css', 'style.css'));
            const nonce = this.getNonce();

            const html = `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https:; font-src ${webview.cspSource};">
                <style>
                    body {
                        padding: 0;
                        margin: 0;
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                        line-height: 1.5;
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                    }
                    .chat-container {
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                        padding: 1rem;
                    }
                    .messages {
                        flex: 1;
                        overflow-y: auto;
                        padding: 1rem;
                        margin-bottom: 1rem;
                    }
                    .message {
                        margin-bottom: 1rem;
                        padding: 0.5rem 1rem;
                        border-radius: 4px;
                    }
                    .user-message {
                        background-color: var(--vscode-textBlockQuote-background);
                        color: var(--vscode-foreground);
                    }
                    .assistant-message {
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        color: var(--vscode-foreground);
                    }
                    .error-message {
                        background-color: var(--vscode-errorForeground);
                        color: var(--vscode-foreground);
                        padding: 0.5rem 1rem;
                        margin: 0.5rem 0;
                        border-radius: 4px;
                    }
                    .status {
                        padding: 0.5rem;
                        margin: 0.5rem 0;
                        border-radius: 4px;
                        background-color: var(--vscode-textBlockQuote-background);
                    }
                    .input-container {
                        display: flex;
                        gap: 0.5rem;
                        padding: 1rem;
                        background-color: var(--vscode-editor-background);
                    }
                    #messageInput {
                        flex: 1;
                        padding: 0.5rem;
                        border: 1px solid var(--vscode-input-border);
                        background-color: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border-radius: 4px;
                    }
                    #sendButton {
                        padding: 0.5rem 1rem;
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                    }
                    #sendButton:disabled {
                        opacity: 0.5;
                        cursor: not-allowed;
                    }
                </style>
                <title>AI Chat</title>
            </head>
            <body>
                <div class="chat-container">
                    <div id="messages" class="messages"></div>
                    <div id="status" class="status"></div>
                    <div class="input-container">
                        <input type="text" id="messageInput" placeholder="Type your message..." />
                        <button id="sendButton">Send</button>
                    </div>
                </div>

                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    const messagesContainer = document.getElementById('messages');
                    const messageInput = document.getElementById('messageInput');
                    const sendButton = document.getElementById('sendButton');
                    const statusDiv = document.getElementById('status');

                    // Initialize state
                    const state = vscode.getState() || { messages: [] };
                    updateMessages();

                    // Handle input events
                    messageInput.addEventListener('keypress', (e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            sendMessage();
                        }
                    });

                    sendButton.addEventListener('click', sendMessage);

                    function sendMessage() {
                        const message = messageInput.value.trim();
                        if (message) {
                            messageInput.disabled = true;
                            sendButton.disabled = true;

                            vscode.postMessage({
                                type: 'userMessage',
                                text: message
                            });

                            messageInput.value = '';
                        }
                    }

                    function addMessage(text, role) {
                        if (!text || !role) return;
                        
                        const messageDiv = document.createElement('div');
                        messageDiv.className = \`message \${role}-message\`;
                        messageDiv.textContent = text;
                        
                        messagesContainer.appendChild(messageDiv);
                        messagesContainer.scrollTop = messagesContainer.scrollHeight;

                        state.messages.push({ text, role });
                        vscode.setState(state);
                    }

                    function updateMessages() {
                        messagesContainer.innerHTML = '';
                        state.messages.forEach(msg => {
                            if (msg && msg.text && msg.role) {
                                addMessage(msg.text, msg.role);
                            }
                        });
                    }

                    // Handle messages from extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        
                        switch (message.type) {
                            case 'message':
                                if (message.text && message.role) {
                                    addMessage(message.text, message.role);
                                }
                                break;
                                
                            case 'status':
                                statusDiv.textContent = message.text || '';
                                statusDiv.className = \`status \${message.status || ''}\`;
                                break;
                                
                            case 'enableInput':
                                messageInput.disabled = !message.enabled;
                                sendButton.disabled = !message.enabled;
                                if (message.enabled) {
                                    messageInput.focus();
                                }
                                break;
                        }
                    });

                    // Initial focus
                    messageInput.focus();
                </script>
            </body>
            </html>`;

            this.logger.log('Webview content generated successfully', { type: 'info' });
            return html;
        } catch (error) {
            this.logger.logError(error, 'Failed to generate webview content');
            throw error;
        }
    }

    private getNonce(): string {
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