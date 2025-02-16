"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = __importStar(require("vscode"));
const generative_ai_1 = require("@google/generative-ai");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const glob_1 = require("glob");
const minimatch_1 = require("minimatch");
// Add context management class
class ContextManager {
    constructor(workspaceRoot) {
        this.onContextUpdated = [];
        this.DEFAULT_MAX_FILES = 500; // Increased from 50 to 500
        this.DEFAULT_EXCLUSIONS = ['node_modules', '.git', 'out', 'dist', '*.vsix'];
        this.workspaceRoot = workspaceRoot;
        this.config = {
            inclusions: vscode.workspace.getConfiguration('falalo').get('contextInclusions') || [],
            exclusions: vscode.workspace.getConfiguration('falalo').get('contextExclusions') || this.DEFAULT_EXCLUSIONS,
            maxFiles: vscode.workspace.getConfiguration('falalo').get('maxContextFiles') || this.DEFAULT_MAX_FILES
        };
        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('falalo')) {
                this.updateConfig();
            }
        });
    }
    async updateConfig() {
        this.config = {
            inclusions: vscode.workspace.getConfiguration('falalo').get('contextInclusions') || [],
            exclusions: vscode.workspace.getConfiguration('falalo').get('contextExclusions') || this.DEFAULT_EXCLUSIONS,
            maxFiles: vscode.workspace.getConfiguration('falalo').get('maxContextFiles') || this.DEFAULT_MAX_FILES
        };
        await this.notifyContextUpdated();
    }
    onDidUpdateContext(callback) {
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
    async notifyContextUpdated() {
        const files = await this.getContextFiles();
        console.log(`Context updated with ${files.length} files`);
        for (const callback of this.onContextUpdated) {
            try {
                await callback();
            }
            catch (error) {
                console.error('Error in context update callback:', error);
            }
        }
    }
    async addToContext(resourcePath) {
        try {
            const relativePath = path.relative(this.workspaceRoot, resourcePath);
            // Check if file exists
            try {
                await fs.promises.access(resourcePath, fs.constants.R_OK);
            }
            catch {
                throw new Error(`File ${relativePath} does not exist or is not readable`);
            }
            const config = vscode.workspace.getConfiguration('falalo');
            const inclusions = config.get('contextInclusions');
            if (!inclusions.includes(relativePath)) {
                inclusions.push(relativePath);
                await config.update('contextInclusions', inclusions, vscode.ConfigurationTarget.Workspace);
                this.config.inclusions = inclusions;
                vscode.window.showInformationMessage(`Added ${relativePath} to AI chat context`);
                await this.notifyContextUpdated();
            }
        }
        catch (error) {
            console.error('Error adding to context:', error);
            vscode.window.showErrorMessage(`Failed to add file to context: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        }
    }
    async removeFromContext(resourcePath) {
        try {
            const relativePath = path.relative(this.workspaceRoot, resourcePath);
            const config = vscode.workspace.getConfiguration('falalo');
            const inclusions = config.get('contextInclusions');
            const index = inclusions.indexOf(relativePath);
            if (index !== -1) {
                inclusions.splice(index, 1);
                await config.update('contextInclusions', inclusions, vscode.ConfigurationTarget.Workspace);
                this.config.inclusions = inclusions;
                vscode.window.showInformationMessage(`Removed ${relativePath} from AI chat context`);
                await this.notifyContextUpdated();
            }
        }
        catch (error) {
            console.error('Error removing from context:', error);
            vscode.window.showErrorMessage(`Failed to remove file from context: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        }
    }
    async getContextFiles() {
        try {
            const files = [];
            const seenFiles = new Set();
            // Add explicitly included files first
            for (const pattern of this.config.inclusions) {
                try {
                    const matches = await this.globAsync(pattern);
                    for (const match of matches) {
                        if (!seenFiles.has(match)) {
                            files.push(match);
                            seenFiles.add(match);
                        }
                    }
                }
                catch (error) {
                    console.error(`Error globbing pattern ${pattern}:`, error);
                }
            }
            // Remove excluded files
            const filteredFiles = files.filter(file => {
                return !this.config.exclusions.some(exclusion => (0, minimatch_1.minimatch)(file, exclusion, { matchBase: true }));
            });
            // Ensure all paths exist and are readable
            const existingFiles = await Promise.all(filteredFiles.map(async (file) => {
                const fullPath = path.join(this.workspaceRoot, file);
                try {
                    const stats = await fs.promises.stat(fullPath);
                    if (!stats.isFile()) {
                        return null;
                    }
                    // Check if file is readable
                    await fs.promises.access(fullPath, fs.constants.R_OK);
                    return file;
                }
                catch {
                    return null;
                }
            }));
            // Remove nulls and limit to max files
            return existingFiles
                .filter((file) => file !== null)
                .slice(0, this.config.maxFiles);
        }
        catch (error) {
            console.error('Error getting context files:', error);
            return [];
        }
    }
    async globAsync(pattern) {
        return (0, glob_1.glob)(pattern, {
            cwd: this.workspaceRoot,
            nodir: true,
            dot: true, // Include dotfiles
            ignore: this.config.exclusions
        });
    }
    async showContextItems() {
        const files = await this.getContextFiles();
        const panel = vscode.window.createWebviewPanel('contextItems', 'AI Chat Context Items', vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true
        });
        const fileListHtml = files.map(file => `<li class="file-item" data-path="${file}">
				<span>📄 ${file}</span>
				<button class="remove-button" onclick="removeFile('${file}')">Remove</button>
			</li>`).join('\n');
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
					${fileListHtml}
				</ul>

				<script>
					const vscode = acquireVsCodeApi();
					const dropZone = document.getElementById('dropZone');
					const fileList = document.getElementById('fileList');

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

					// Handle dropped files
					dropZone.addEventListener('drop', handleDrop, false);

					function handleDrop(e) {
						const dt = e.dataTransfer;
						const files = dt.files;

						handleFiles(files);
					}

					function handleFiles(files) {
						[...files].forEach(file => {
							vscode.postMessage({
								type: 'addFile',
								path: file.path
							});
						});
					}

					// Remove file handler
					window.removeFile = function(path) {
						vscode.postMessage({
							type: 'removeFile',
							path: path
						});
					};

					// Listen for messages from the extension
					window.addEventListener('message', event => {
						const message = event.data;
						if (message.type === 'updateFiles') {
							const files = message.files;
							const maxFiles = message.maxFiles;
							
							fileList.innerHTML = files.map(file => 
								'<li class="file-item" data-path="' + file + '">' +
								'<span>📄 ' + file + '</span>' +
								'<button class="remove-button" onclick="removeFile(\'' + file + '\')">Remove</button>' +
								'</li>'
							).join('\\n');

							document.querySelector('.file-count').textContent = 
								files.length + ' / ' + maxFiles + ' files';
						}
					});
				</script>
			</body>
			</html>
		`;
        // Handle messages from the webview
        panel.webview.onDidReceiveMessage(async (message) => {
            try {
                switch (message.type) {
                    case 'addFile':
                        if (message.path) {
                            await this.addToContext(message.path);
                            // Update the file list
                            const updatedFiles = await this.getContextFiles();
                            panel.webview.postMessage({
                                type: 'updateFiles',
                                files: updatedFiles,
                                maxFiles: this.config.maxFiles
                            });
                        }
                        break;
                    case 'removeFile':
                        if (message.path) {
                            await this.removeFromContext(message.path);
                            // Update the file list
                            const remainingFiles = await this.getContextFiles();
                            panel.webview.postMessage({
                                type: 'updateFiles',
                                files: remainingFiles,
                                maxFiles: this.config.maxFiles
                            });
                        }
                        break;
                }
            }
            catch (error) {
                vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        });
    }
}
// Initialize Gemini API with error handling
let model; // Make model mutable
// Add initializeGeminiAPI function
async function initializeGeminiAPI(context) {
    const genAI = new generative_ai_1.GoogleGenerativeAI("AIzaSyBb0tP7X8uDuiZGid-GnxfR0bbDay4HDk0");
    return genAI.getGenerativeModel({
        model: "gemini-2.0-flash",
        generationConfig: {
            temperature: 0.7,
            topP: 0.8,
            topK: 40,
        }
    });
}
// Task Planning Prompt
const TASK_PLANNING_PROMPT = `You are a task planning AI. Analyze the user's request and break it down into steps.

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
            "description": "string",
            "files": ["file/paths"],
            "dependencies": [step numbers]
        }
    ]
}

Example - for "Create a React todo app", respond with exactly (no backticks, no formatting):
{
    "totalSteps": 3,
    "steps": [
        {
            "description": "Set up project structure and dependencies",
            "files": ["package.json", "README.md"],
            "dependencies": []
        },
        {
            "description": "Create React components",
            "files": ["src/components/TodoList.js", "src/components/TodoItem.js"],
            "dependencies": [1]
        }
    ]
}`;
// Store active task plans
let activeTaskPlans = new Map();
// Helper function to create folders
async function createFolderStructure(folderPath) {
    try {
        await fs.promises.mkdir(folderPath, { recursive: true });
        console.log(`Created folder structure: ${folderPath}`);
    }
    catch (error) {
        console.error(`Error creating folder structure ${folderPath}:`, error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        throw new Error(`Failed to create folder structure: ${errorMessage}`);
    }
}
// Enhanced system prompt with command execution
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

4. For folder creation, use:
   $$$ FOLDER_CREATE path/to/folder

5. For command execution, use:
   $$$ COMMAND_EXEC
   {
     "command": "npm install react",
     "cwd": "./project",
     "isBackground": false,
     "description": "Installing React dependencies"
   }
   $$$ COMMAND_END

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

Example:
I'll create a React project and install dependencies.

$$$ FOLDER_CREATE my-react-app

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

$$$ FILE_CREATE my-react-app/src/App.js
import React from 'react';
// ... rest of the code ...
$$$ FILE_END`;
// Add this function after the imports
async function openInBrowser(filePath) {
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
    }
    catch (error) {
        console.error('Error opening file in browser:', error);
        throw error;
    }
}
// Update the executeCommands function to handle open commands
async function executeCommands(commands, workspaceRoot) {
    const results = [];
    const commandArray = Array.isArray(commands) ? commands : [commands];
    // Get the extension's directory path
    const extensionPath = vscode.extensions.getExtension('falalo')?.extensionPath || workspaceRoot;
    console.log('Extension path:', extensionPath);
    for (const cmd of commandArray) {
        try {
            // Validate command before execution
            if (!cmd.command || typeof cmd.command !== 'string') {
                throw new Error('Invalid command format');
            }
            // Sanitize and validate the command
            const sanitizedCommand = cmd.command.trim();
            if (!sanitizedCommand) {
                throw new Error('Empty command');
            }
            // Use the extension path as the default working directory
            const cwd = cmd.cwd ? path.resolve(extensionPath, cmd.cwd) : extensionPath;
            // Validate the working directory exists
            try {
                await fs.promises.access(cwd, fs.constants.R_OK | fs.constants.X_OK);
            }
            catch (error) {
                throw new Error(`Invalid working directory: ${cwd}`);
            }
            console.log('Executing command in directory:', cwd);
            // Create the execution options with improved error handling
            const options = {
                cwd,
                shell: true,
                env: {
                    ...process.env,
                    FORCE_COLOR: '1',
                    PYTHONIOENCODING: 'utf-8',
                    LANG: 'en_US.UTF-8'
                },
                maxBuffer: 1024 * 1024 * 10 // 10MB buffer
            };
            // Execute the command
            const description = cmd.description || sanitizedCommand;
            console.log(`Executing command: ${description}`);
            if (cmd.isBackground) {
                const childProcess = require('child_process').spawn(sanitizedCommand, [], {
                    ...options,
                    detached: true,
                    stdio: 'ignore'
                });
                childProcess.unref();
                results.push(`Started background process: ${description}`);
            }
            else {
                try {
                    // For synchronous processes with improved error capture
                    const output = require('child_process').execSync(sanitizedCommand, options);
                    const result = output.toString('utf-8').trim();
                    console.log(`Command output: ${result}`);
                    results.push(`✅ ${description}`);
                    if (result) {
                        // Try to parse JSON if the output looks like JSON
                        if (result.trim().startsWith('{') || result.trim().startsWith('[')) {
                            try {
                                const jsonResult = JSON.parse(result);
                                results.push(`Output: ${JSON.stringify(jsonResult, null, 2)}`);
                            }
                            catch (jsonError) {
                                // If JSON parsing fails, just output the raw result
                                results.push(`Output: ${result}`);
                            }
                        }
                        else {
                            results.push(`Output: ${result}`);
                        }
                    }
                }
                catch (cmdError) {
                    const errorOutput = cmdError.stderr?.toString('utf-8') || cmdError.message;
                    console.error(`Command failed: ${sanitizedCommand}\nError: ${errorOutput}`);
                    // Special handling for Python errors
                    if (sanitizedCommand.includes('python') || sanitizedCommand.includes('python3')) {
                        const pythonError = handlePythonError(errorOutput);
                        if (pythonError) {
                            throw new Error(`Python error: ${pythonError}`);
                        }
                    }
                    // Check for npm dependency conflict error
                    if (sanitizedCommand.startsWith('npm') && errorOutput.includes('ERESOLVE')) {
                        console.log('Detected npm dependency conflict, retrying with --legacy-peer-deps');
                        results.push(`⚠️ Dependency conflict detected, retrying with --legacy-peer-deps`);
                        try {
                            const modifiedCommand = sanitizedCommand.includes('npm install')
                                ? `${sanitizedCommand} --legacy-peer-deps`
                                : sanitizedCommand;
                            const retryOutput = require('child_process').execSync(modifiedCommand, options);
                            const retryResult = retryOutput.toString('utf-8').trim();
                            results.push(`✅ Command succeeded with --legacy-peer-deps`);
                            if (retryResult) {
                                results.push(`Output: ${retryResult}`);
                            }
                            continue;
                        }
                        catch (retryError) {
                            throw new Error(`NPM install failed: ${retryError.message}`);
                        }
                    }
                    throw new Error(`Command execution failed: ${errorOutput}`);
                }
            }
        }
        catch (error) {
            console.error(`Error executing command: ${cmd.command}`, error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            throw new Error(`Failed to execute command "${cmd.command}": ${errorMessage}`);
        }
    }
    return results;
}
// Helper function to handle Python-specific errors
function handlePythonError(errorOutput) {
    // Common Python error patterns
    const syntaxErrorMatch = errorOutput.match(/SyntaxError: (.*)/);
    const indentationErrorMatch = errorOutput.match(/IndentationError: (.*)/);
    const importErrorMatch = errorOutput.match(/ImportError: (.*)/);
    const fileNotFoundMatch = errorOutput.match(/FileNotFoundError: (.*)/);
    if (syntaxErrorMatch) {
        return `Syntax error: ${syntaxErrorMatch[1]}`;
    }
    else if (indentationErrorMatch) {
        return `Indentation error: ${indentationErrorMatch[1]}`;
    }
    else if (importErrorMatch) {
        return `Import error: ${importErrorMatch[1]}`;
    }
    else if (fileNotFoundMatch) {
        return `File not found: ${fileNotFoundMatch[1]}`;
    }
    return null;
}
// Enhanced handleFileOperations function with command execution
async function handleFileOperations(content, workspaceRoot) {
    const createdItems = [];
    const contextManager = new ContextManager(workspaceRoot);
    // Folder creation regex
    const folderRegex = /\$\$\$ FOLDER_CREATE (.*?)(?=\$\$\$|\n|$)/g;
    // File creation regex
    const fileCreateRegex = /\$\$\$ FILE_CREATE (.*?)\n([\s\S]*?)\$\$\$ FILE_END/g;
    // File modification regex
    const fileModifyStartRegex = /\$\$\$ FILE_MODIFY (.*?)\n/g;
    const fileModifyEndRegex = /\$\$\$ FILE_END/;
    const replaceBlockRegex = /### REPLACE_BLOCK_START (.*?)\n([\s\S]*?)### REPLACE_BLOCK_END\s*### NEW_BLOCK_START \1\n([\s\S]*?)### NEW_BLOCK_END/g;
    const insertAfterRegex = /### INSERT_AFTER line:"([^"]*?)"\n([\s\S]*?)### INSERT_END/g;
    const insertBeforeRegex = /### INSERT_BEFORE line:"([^"]*?)"\n([\s\S]*?)### INSERT_END/g;
    // New command execution regex
    const commandExecRegex = /\$\$\$ COMMAND_EXEC\n([\s\S]*?)\$\$\$ COMMAND_END/g;
    // Handle command execution
    let commandMatch;
    while ((commandMatch = commandExecRegex.exec(content)) !== null) {
        try {
            const commandJson = commandMatch[1].trim();
            const commands = JSON.parse(commandJson);
            const results = await executeCommands(commands, workspaceRoot);
            createdItems.push(...results);
        }
        catch (error) {
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
        }
        catch (error) {
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
        }
        catch (error) {
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
            if (!endMatch || typeof endMatch.index === 'undefined')
                continue;
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
        }
        catch (error) {
            console.error(`Error modifying file ${fullPath}:`, error);
            throw new Error(`Failed to modify file ${relativePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    return createdItems;
}
// Update getWorkspaceContext function
async function getWorkspaceContext(contextManager) {
    let context = '';
    try {
        // Get context files from the manager
        const contextFiles = await contextManager.getContextFiles();
        if (contextFiles.length > 0) {
            context += '### Workspace Context Files ###\n\n';
            let filesProcessed = 0;
            for (const file of contextFiles) {
                try {
                    const fullPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, file);
                    const content = await fs.promises.readFile(fullPath, 'utf8');
                    // Add file content with clear separation and metadata
                    context += `=== START FILE: ${file} ===\n`;
                    context += `Language: ${path.extname(file).slice(1) || 'text'}\n`;
                    context += `Path: ${fullPath}\n`;
                    context += `Content:\n\`\`\`${path.extname(file).slice(1) || ''}\n${content}\n\`\`\`\n`;
                    context += `=== END FILE: ${file} ===\n\n`;
                    filesProcessed++;
                }
                catch (error) {
                    console.error(`Error reading file ${file}:`, error);
                    context += `Error reading file ${file}: ${error instanceof Error ? error.message : 'Unknown error'}\n\n`;
                }
            }
            context += `Total context files processed: ${filesProcessed}\n\n`;
        }
        else {
            context += 'No workspace context files available.\n\n';
        }
        // Get current file context if any
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            const document = activeEditor.document;
            const relativePath = vscode.workspace.asRelativePath(document.uri);
            context += '### Currently Active File ###\n\n';
            context += `=== START FILE: ${relativePath} (ACTIVE) ===\n`;
            context += `Language: ${document.languageId}\n`;
            context += `Path: ${document.uri.fsPath}\n`;
            context += `Content:\n\`\`\`${document.languageId}\n${document.getText()}\n\`\`\`\n`;
            context += `=== END FILE: ${relativePath} ===\n\n`;
        }
        return context;
    }
    catch (error) {
        console.error('Error getting workspace context:', error);
        return `Error: Failed to get workspace context: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
}
// Function to validate task plan structure
function validateTaskPlan(plan) {
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
async function evaluateRequest(request) {
    try {
        const planningChat = model.startChat({
            generationConfig: {
                temperature: 0.3,
                topP: 0.8,
                topK: 40,
            }
        });
        // Add more explicit instructions to the prompt
        const result = await planningChat.sendMessage(`${TASK_PLANNING_PROMPT}\n\nAnalyze this request and respond with ONLY a valid JSON object. Remember:\n1. NO markdown\n2. NO code blocks\n3. NO backticks\n4. NO explanation text\nRequest: ${request}`);
        if (!result || !result.response) {
            throw new Error('Failed to generate task plan');
        }
        const rawText = result.response.text().trim();
        console.log('Raw response:', rawText); // Debug log
        // Clean up the response to ensure it's valid JSON
        let planText = rawText
            .replace(/^```json\s*/, '') // Remove leading ```json
            .replace(/```$/, '') // Remove trailing ```
            .replace(/^`/, '') // Remove single backticks
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
                steps: plan.steps.map((step) => ({
                    ...step,
                    status: 'pending'
                })),
                originalRequest: request
            };
        }
        catch (parseError) {
            console.error('JSON Parse Error. Raw text:', planText);
            console.error('Parse error details:', parseError);
            throw new Error('Failed to parse task plan: ' + (parseError instanceof Error ? parseError.message : 'Invalid JSON'));
        }
    }
    catch (error) {
        console.error('Error in task planning:', error);
        throw new Error('Failed to plan tasks: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
}
// Function to update chat panel with task progress
function updateTaskProgress(webview, taskPlan) {
    const progressHtml = `
		<div class="task-progress">
			<div class="progress-header">
				Progress: Step ${taskPlan.currentStep + 1} of ${taskPlan.totalSteps}
			</div>
			<div class="steps-list">
				${taskPlan.steps.map((step, index) => `
					<div class="step ${step.status}">
						<div class="step-number">${index + 1}</div>
						<div class="step-description">${step.description}</div>
						${step.files ? `
							<div class="step-files">
								Files: ${step.files.join(', ')}
							</div>
						` : ''}
					</div>
				`).join('')}
			</div>
		</div>
	`;
    webview.postMessage({
        type: 'updateProgress',
        html: progressHtml
    });
}
// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
async function activate(context) {
    console.log('Extension "falalo" is now active!');
    try {
        // Initialize the model with OAuth2
        model = await initializeGeminiAPI(context);
    }
    catch (error) {
        console.error('Failed to initialize Gemini API:', error);
        vscode.window.showErrorMessage('Failed to initialize AI: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
    // Store chat history and panel
    let chatHistory = [];
    let chatPanel;
    // Initialize context manager
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('Please open a workspace folder first');
        return;
    }
    // Since we've checked workspaceRoot is defined, we can safely assert its type
    const contextManager = new ContextManager(workspaceRoot);
    // Function to update context files in webview
    async function updateWebviewContext() {
        if (chatPanel) {
            const files = await contextManager.getContextFiles();
            const fileDetails = await Promise.all(files.map(async (file) => {
                const fullPath = path.join(workspaceRoot, file);
                try {
                    const stats = await fs.promises.stat(fullPath);
                    const content = await fs.promises.readFile(fullPath, 'utf8');
                    const preview = content.slice(0, 500) + (content.length > 500 ? '...' : '');
                    const size = stats.size < 1024 ? `${stats.size} B` :
                        stats.size < 1024 * 1024 ? `${(stats.size / 1024).toFixed(1)} KB` :
                            `${(stats.size / 1024 / 1024).toFixed(1)} MB`;
                    return {
                        path: file,
                        name: path.basename(file),
                        size,
                        preview
                    };
                }
                catch (error) {
                    console.error(`Error reading file ${file}:`, error);
                    return null;
                }
            }));
            chatPanel.webview.postMessage({
                type: 'updateContext',
                files: fileDetails.filter((file) => file !== null)
            });
        }
    }
    // Register context management commands
    const includeCommand = vscode.commands.registerCommand('falalo.includeInContext', async (resource) => {
        if (resource) {
            await contextManager.addToContext(resource.fsPath);
            await updateWebviewContext();
        }
    });
    const excludeCommand = vscode.commands.registerCommand('falalo.excludeFromContext', async (resource) => {
        if (resource) {
            await contextManager.removeFromContext(resource.fsPath);
            await updateWebviewContext();
        }
    });
    // Register the chat command
    const chatCommand = vscode.commands.registerCommand('falalo.startChat', async () => {
        try {
            if (!vscode.workspace.workspaceFolders) {
                throw new Error('Please open a workspace folder first');
            }
            if (chatPanel) {
                chatPanel.reveal(vscode.ViewColumn.Beside);
                return;
            }
            chatPanel = vscode.window.createWebviewPanel('aiChat', 'AI Chat', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
            chatPanel.webview.html = getChatWebviewContent();
            // Initialize context files in webview
            await updateWebviewContext();
            // Handle panel disposal
            chatPanel.onDidDispose(() => {
                chatPanel = undefined;
                chatHistory = [];
            }, null, context.subscriptions);
            // Make panel persistent
            chatPanel.onDidChangeViewState((e) => {
                if (e.webviewPanel.visible) {
                    e.webviewPanel.webview.html = getChatWebviewContent();
                    updateWebviewContext();
                }
            });
            // Listen for context updates
            const contextUpdateDisposable = contextManager.onDidUpdateContext(async () => {
                if (chatPanel) {
                    await updateWebviewContext();
                    chatPanel.webview.postMessage({
                        type: 'status',
                        text: 'Context updated'
                    });
                }
            });
            // Add the disposable to the extension's subscriptions
            context.subscriptions.push(contextUpdateDisposable);
            // Update message handler to handle context-related messages
            chatPanel.webview.onDidReceiveMessage(async (message) => {
                if (message.type === 'excludeFile' && typeof message.path === 'string') {
                    const fullPath = path.join(workspaceRoot, message.path);
                    await contextManager.removeFromContext(fullPath);
                    await updateWebviewContext();
                }
                else if (message.type === 'userMessage' && chatPanel) {
                    try {
                        console.log('Received user message:', message.text);
                        // Get context using context manager
                        const context = await getWorkspaceContext(contextManager);
                        console.log('Context files loaded:', context.split('=== File:').length - 1);
                        // First, evaluate and plan the tasks
                        chatPanel.webview.postMessage({
                            type: 'status',
                            text: 'Analyzing request and planning tasks...'
                        });
                        const taskPlan = await evaluateRequest(message.text);
                        const chatId = Date.now().toString();
                        activeTaskPlans.set(chatId, taskPlan);
                        // Show initial task plan
                        updateTaskProgress(chatPanel.webview, taskPlan);
                        // Process each step
                        while (taskPlan.currentStep < taskPlan.totalSteps) {
                            const currentStep = taskPlan.steps[taskPlan.currentStep];
                            currentStep.status = 'in-progress';
                            updateTaskProgress(chatPanel.webview, taskPlan);
                            // Update system prompt with current context
                            const contextPrompt = `${SYSTEM_PROMPT}\n\nWorkspace Context:\n${context}\n\nCurrent Task Context:
Step ${taskPlan.currentStep + 1} of ${taskPlan.totalSteps}
Current Step: ${currentStep.description}
Files to Create/Modify: ${currentStep.files?.join(', ') || 'None'}
Previous Steps: ${taskPlan.steps
                                .slice(0, taskPlan.currentStep)
                                .map(s => s.description)
                                .join(', ')}`;
                            // Process the step
                            chatPanel?.webview.postMessage({
                                type: 'status',
                                text: `Processing step ${taskPlan.currentStep + 1}: ${currentStep.description}`
                            });
                            const chat = model.startChat({
                                history: chatHistory,
                                generationConfig: {
                                    temperature: 0.7,
                                    topP: 0.8,
                                    topK: 40,
                                }
                            });
                            const result = await chat.sendMessage(contextPrompt + `\n\nComplete this step: ${currentStep.description}`);
                            if (!result || !result.response) {
                                throw new Error('Empty response from AI');
                            }
                            const response = result.response.text();
                            const createdFiles = await handleFileOperations(response, workspaceRoot);
                            // Update task status
                            currentStep.status = 'completed';
                            if (createdFiles.length > 0) {
                                currentStep.files = createdFiles;
                            }
                            // Process and display response
                            let processedResponse = processResponseWithCodeBlocks(response);
                            if (createdFiles.length > 0) {
                                processedResponse = `<div class="success-message">Step ${taskPlan.currentStep + 1} completed: Created/Updated files:\n${createdFiles.join('\n')}</div>\n\n${processedResponse}`;
                            }
                            chatHistory.push({ role: 'user', parts: [{ text: currentStep.description }] }, { role: 'model', parts: [{ text: response }] });
                            chatPanel?.webview.postMessage({
                                type: 'aiResponse',
                                text: processedResponse,
                                hasCode: response.includes('@@@') || response.includes('FILE_START')
                            });
                            // Move to next step
                            taskPlan.currentStep++;
                            updateTaskProgress(chatPanel.webview, taskPlan);
                            // Add a small delay between steps
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                        // Final completion message
                        chatPanel?.webview.postMessage({
                            type: 'aiResponse',
                            text: `<div class="success-message">✨ All tasks completed! The project has been set up according to your request.</div>`,
                            isComplete: true
                        });
                    }
                    catch (error) {
                        console.error('Detailed AI Error:', error);
                        chatPanel?.webview.postMessage({ type: 'status', text: '' });
                        const errorMessage = error?.message || 'Unknown error occurred';
                        vscode.window.showErrorMessage(`Error: ${errorMessage}`);
                        chatPanel?.webview.postMessage({
                            type: 'aiResponse',
                            text: `<div class="error-message">Error: ${errorMessage}</div>`,
                            isError: true
                        });
                    }
                }
            });
        }
        catch (error) {
            console.error('Extension Error:', error);
            vscode.window.showErrorMessage(`Failed to start chat: ${error?.message || 'Unknown error'}`);
        }
    });
    // Add all commands to subscriptions
    context.subscriptions.push(chatCommand, includeCommand, excludeCommand);
}
// Update processResponseWithCodeBlocks to handle new code block markers
function processResponseWithCodeBlocks(response) {
    try {
        // Sanitize the response text
        const sanitizedResponse = response.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
        // Split by code block markers
        const parts = sanitizedResponse.split(/(&&&\s*CODE_BLOCK_START.*?&&&\s*CODE_BLOCK_END)/gs);
        let processedParts = [];
        for (let part of parts) {
            if (!part.trim())
                continue;
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
            }
            else {
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
    }
    catch (error) {
        console.error('Error processing response:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        return `<div class="error-message">Error processing response: ${errorMessage}</div>`;
    }
}
function getChatWebviewContent() {
    return `<!DOCTYPE html>
	<html>
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<style>
				body {
					margin: 0;
					padding: 15px;
					background: var(--vscode-editor-background);
					color: var(--vscode-editor-foreground);
					font-family: var(--vscode-font-family);
				}
				.main-container {
					display: flex;
					height: 100vh;
					gap: 20px;
				}
				.chat-container {
					flex: 2;
					display: flex;
					flex-direction: column;
					max-width: 800px;
				}
				.context-container {
					flex: 1;
					min-width: 300px;
					border-left: 1px solid var(--vscode-input-border);
					padding-left: 20px;
					display: flex;
					flex-direction: column;
				}
				.context-header {
					display: flex;
					justify-content: space-between;
					align-items: center;
					margin-bottom: 15px;
				}
				.context-title {
					font-size: 1.1em;
					font-weight: bold;
				}
				.file-count {
					font-size: 0.9em;
					color: var(--vscode-descriptionForeground);
				}
				.search-container {
					position: sticky;
					top: 0;
					z-index: 100;
					background: var(--vscode-editor-background);
					padding: 10px 0;
					margin-bottom: 10px;
					border-bottom: 1px solid var(--vscode-input-border);
				}
				.search-input {
					width: 100%;
					padding: 8px 12px;
					font-size: 14px;
					background: var(--vscode-input-background);
					color: var(--vscode-input-foreground);
					border: 1px solid var(--vscode-input-border);
					border-radius: 4px;
				}
				.filter-container {
					margin: 10px 0;
					padding: 10px;
					background: var(--vscode-editor-inactiveSelectionBackground);
					border-radius: 6px;
				}
				.filter-label {
					display: block;
					margin-bottom: 8px;
					font-weight: bold;
				}
				.filter-buttons {
					display: flex;
					gap: 8px;
					flex-wrap: wrap;
				}
				.filter-btn {
					padding: 4px 8px;
					background: var(--vscode-button-secondaryBackground);
					color: var(--vscode-button-secondaryForeground);
					border: none;
					border-radius: 4px;
					cursor: pointer;
					font-size: 12px;
					transition: background-color 0.2s;
				}
				.filter-btn:hover {
					background: var(--vscode-button-secondaryHoverBackground);
				}
				.filter-btn.active {
					background: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
				}
				.file-grid {
					flex: 1;
					overflow-y: auto;
					display: flex;
					flex-direction: column;
					gap: 10px;
				}
				.file-card {
					background: var(--vscode-editor-inactiveSelectionBackground);
					border-radius: 6px;
					padding: 10px;
					transition: transform 0.2s, box-shadow 0.2s;
				}
				.file-card:hover {
					transform: translateY(-2px);
					box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
				}
				.file-header {
					display: flex;
					align-items: center;
					gap: 8px;
					margin-bottom: 8px;
				}
				.file-name {
					font-weight: bold;
					flex: 1;
					word-break: break-all;
				}
				.file-type {
					font-size: 11px;
					padding: 2px 6px;
					background: var(--vscode-badge-background);
					color: var(--vscode-badge-foreground);
					border-radius: 3px;
				}
				.file-info {
					font-size: 11px;
					color: var(--vscode-descriptionForeground);
					margin: 4px 0;
				}
				.file-path {
					display: block;
					word-break: break-all;
					margin-bottom: 4px;
				}
				.file-actions {
					display: flex;
					gap: 6px;
					margin-top: 8px;
				}
				.btn {
					flex: 1;
					padding: 4px 8px;
					border: none;
					border-radius: 4px;
					cursor: pointer;
					font-size: 11px;
					transition: opacity 0.2s;
				}
				.btn:hover {
					opacity: 0.9;
				}
				.btn-primary {
					background: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
				}
				.btn-secondary {
					background: var(--vscode-button-secondaryBackground);
					color: var(--vscode-button-secondaryForeground);
				}
				.file-preview-container {
					display: none;
					margin-top: 8px;
					background: var(--vscode-editor-background);
					border: 1px solid var(--vscode-input-border);
					border-radius: 4px;
				}
				.file-preview-container.show {
					display: block;
				}
				.file-preview {
					margin: 0;
					padding: 8px;
					max-height: 150px;
					overflow-y: auto;
					font-family: var(--vscode-editor-font-family);
					font-size: 11px;
					white-space: pre-wrap;
					word-break: break-all;
				}
				.messages {
					flex: 1;
					overflow-y: auto;
					margin-bottom: 15px;
					padding: 10px;
				}
				.message {
					margin: 10px 0;
					padding: 10px;
					border-radius: 5px;
					overflow-x: auto;
				}
				.user-message {
					background: var(--vscode-input-background);
					margin-left: 20%;
				}
				.ai-message {
					background: var(--vscode-editor-inactiveSelectionBackground);
					margin-right: 20%;
				}
				.input-container {
					display: flex;
					gap: 10px;
					padding: 10px;
					background: var(--vscode-editor-background);
					border-top: 1px solid var(--vscode-input-border);
				}
				input {
					flex: 1;
					padding: 8px;
					border: 1px solid var(--vscode-input-border);
					background: var(--vscode-input-background);
					color: var(--vscode-input-foreground);
					border-radius: 4px;
				}
				.status-message {
					position: fixed;
					bottom: 60px;
					left: 50%;
					transform: translateX(-50%);
					padding: 8px 16px;
					background: var(--vscode-editorWidget-background);
					border-radius: 4px;
					font-size: 12px;
					opacity: 0;
					transition: opacity 0.3s;
				}
				.status-message.visible {
					opacity: 1;
				}
			</style>
		</head>
		<body>
			<div class="main-container">
				<div class="chat-container">
					<div id="messages" class="messages"></div>
					<div id="status" class="status-message"></div>
					<div class="input-container">
						<input type="text" id="messageInput" placeholder="Type your message...">
						<button id="sendButton" class="btn btn-primary">Send</button>
					</div>
				</div>
				
				<div class="context-container">
					<div class="context-header">
						<span class="context-title">Context Files</span>
						<span class="file-count" id="fileCount">0 files</span>
					</div>
					
					<div class="search-container">
						<input type="text" id="searchInput" class="search-input" placeholder="Search files by name or path...">
					</div>

					<div class="filter-container">
						<span class="filter-label">Filter by type:</span>
						<div class="filter-buttons" id="filterButtons">
							<button class="filter-btn active" data-type="all">All</button>
						</div>
					</div>

					<div class="file-grid" id="fileGrid"></div>
				</div>
			</div>

			<script>
				const vscode = acquireVsCodeApi();
				const messagesDiv = document.getElementById('messages');
				const messageInput = document.getElementById('messageInput');
				const sendButton = document.getElementById('sendButton');
				const statusDiv = document.getElementById('status');
				const searchInput = document.getElementById('searchInput');
				const filterButtons = document.getElementById('filterButtons');
				const fileGrid = document.getElementById('fileGrid');
				const fileCountDisplay = document.getElementById('fileCount');

				function updateStatus(text) {
					statusDiv.textContent = text;
					statusDiv.className = text ? 'status-message visible' : 'status-message';
				}

				function addMessage(content, isUser) {
					const messageDiv = document.createElement('div');
					messageDiv.className = 'message ' + (isUser ? 'user-message' : 'ai-message');
					
					if (isUser) {
						messageDiv.textContent = content;
					} else {
						messageDiv.innerHTML = content;
					}
					
					messagesDiv.appendChild(messageDiv);
					messagesDiv.scrollTop = messagesDiv.scrollHeight;
				}

				function sendMessage() {
					const text = messageInput.value.trim();
					if (text) {
						addMessage(text, true);
						messageInput.value = '';
						messageInput.disabled = true;
						sendButton.disabled = true;
						vscode.postMessage({
							type: 'userMessage',
							text: text
						});
					}
				}

				function updateContextFiles(files) {
					// Update file count
					fileCountDisplay.textContent = \`\${files.length} files\`;

					// Get unique file types for filter buttons
					const fileTypes = new Set(files.map(file => {
						const ext = file.path.split('.').pop() || 'other';
						return ext.toLowerCase();
					}));

					// Update filter buttons
					const filterButtonsHtml = ['<button class="filter-btn active" data-type="all">All</button>'];
					fileTypes.forEach(type => {
						filterButtonsHtml.push(\`<button class="filter-btn" data-type="\${type}">\${type}</button>\`);
					});
					filterButtons.innerHTML = filterButtonsHtml.join('');

					// Update file grid
					fileGrid.innerHTML = files.map(file => \`
						<div class="file-card" data-path="\${file.path}" data-type="\${file.path.split('.').pop() || 'other'}">
							<div class="file-header">
								<span class="file-icon">📄</span>
								<span class="file-name">\${file.name}</span>
								<span class="file-type">\${file.path.split('.').pop() || 'file'}</span>
							</div>
							<div class="file-info">
								<span class="file-path">\${file.path}</span>
								<span class="file-size">\${file.size}</span>
							</div>
							<div class="file-actions">
								<button class="btn btn-primary preview-btn">Preview</button>
								<button class="btn btn-secondary exclude-btn">Exclude</button>
							</div>
							<div class="file-preview-container">
								<pre class="file-preview">\${file.preview || ''}</pre>
							</div>
						</div>
					\`).join('');

					// Add event listeners for preview buttons
					document.querySelectorAll('.preview-btn').forEach(btn => {
						btn.addEventListener('click', () => {
							const card = btn.closest('.file-card');
							const previewContainer = card.querySelector('.file-preview-container');
							const isShown = previewContainer.classList.contains('show');
							
							// Hide all other previews
							document.querySelectorAll('.file-preview-container.show').forEach(container => {
								if (container !== previewContainer) {
									container.classList.remove('show');
									container.closest('.file-card').querySelector('.preview-btn').textContent = 'Preview';
								}
							});

							previewContainer.classList.toggle('show');
							btn.textContent = isShown ? 'Preview' : 'Hide';
						});
					});

					// Add event listeners for exclude buttons
					document.querySelectorAll('.exclude-btn').forEach(btn => {
						btn.addEventListener('click', () => {
							const card = btn.closest('.file-card');
							const filePath = card.dataset.path;
							vscode.postMessage({
								type: 'excludeFile',
								path: filePath
							});
							card.style.display = 'none';
						});
					});
				}

				// Search functionality
				searchInput.addEventListener('input', (e) => {
					const searchTerm = e.target.value.toLowerCase();
					document.querySelectorAll('.file-card').forEach(card => {
						const fileName = card.querySelector('.file-name').textContent.toLowerCase();
						const filePath = card.querySelector('.file-path').textContent.toLowerCase();
						card.style.display = 
							fileName.includes(searchTerm) || filePath.includes(searchTerm) 
								? 'block' 
								: 'none';
					});
				});

				// Filter functionality
				filterButtons.addEventListener('click', (e) => {
					if (e.target.classList.contains('filter-btn')) {
						filterButtons.querySelectorAll('.filter-btn').forEach(btn => {
							btn.classList.remove('active');
						});
						e.target.classList.add('active');

						const selectedType = e.target.dataset.type;
						document.querySelectorAll('.file-card').forEach(card => {
							card.style.display = 
								selectedType === 'all' || card.dataset.type === selectedType 
									? 'block' 
									: 'none';
						});
					}
				});

				sendButton.addEventListener('click', sendMessage);
				messageInput.addEventListener('keypress', (e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						sendMessage();
					}
				});

				window.addEventListener('message', event => {
					const message = event.data;
					switch (message.type) {
						case 'aiResponse':
							addMessage(message.text, false);
							messageInput.disabled = false;
							sendButton.disabled = false;
							messageInput.focus();
							break;
						case 'status':
							updateStatus(message.text);
							break;
						case 'updateContext':
							updateContextFiles(message.files);
							break;
					}
				});
			</script>
		</body>
	</html>`;
}
// This method is called when your extension is deactivated
function deactivate() { }
//# sourceMappingURL=extension.js.map