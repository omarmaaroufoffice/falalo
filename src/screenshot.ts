import * as puppeteer from 'puppeteer';
import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { OpenAI } from 'openai';

export class ScreenshotManager {
    private browser: puppeteer.Browser | null = null;
    private screenshotsDir: string;
    private model: OpenAI | null = null;

    constructor(private extensionPath: string, model?: OpenAI) {
        this.screenshotsDir = path.join(extensionPath, 'screenshots');
        if (!fs.existsSync(this.screenshotsDir)) {
            fs.mkdirSync(this.screenshotsDir, { recursive: true });
        }
        this.model = model || null;
        console.log('Screenshots directory:', this.screenshotsDir);
    }

    private async initBrowser() {
        try {
            if (!this.browser) {
                console.log('Initializing browser...');
                this.browser = await puppeteer.launch({
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu'
                    ]
                });
                console.log('Browser initialized successfully');
            }
            return this.browser;
        } catch (error) {
            console.error('Error initializing browser:', error);
            throw error;
        }
    }

    public async takeScreenshot(url: string): Promise<string> {
        let page: puppeteer.Page | null = null;
        try {
            console.log('Taking screenshot of URL:', url);
            const browser = await this.initBrowser();
            page = await browser.newPage();
            
            console.log('Setting viewport...');
            await page.setViewport({ width: 1280, height: 800 });
            
            console.log('Navigating to URL...');
            await page.goto(url, { 
                waitUntil: 'networkidle0',
                timeout: 30000 
            });
            
            console.log('Waiting for content to load...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const screenshotPath = path.join(this.screenshotsDir, `screenshot-${timestamp}.png`);
            console.log('Taking screenshot to path:', screenshotPath);
            
            await page.screenshot({ 
                path: screenshotPath, 
                fullPage: true,
                type: 'png',
                omitBackground: true
            });
            
            console.log('Screenshot taken successfully');
            
            await this.optimizeScreenshot(screenshotPath);
            return screenshotPath;
        } catch (error) {
            console.error('Error taking screenshot:', error);
            throw error;
        } finally {
            if (page) {
                try {
                    await page.close();
                    console.log('Page closed successfully');
                } catch (error) {
                    console.error('Error closing page:', error);
                }
            }
        }
    }

    private async optimizeScreenshot(filePath: string): Promise<void> {
        try {
            console.log('Optimizing screenshot:', filePath);
            const image = sharp(filePath);
            const metadata = await image.metadata();
            
            if (metadata.width && metadata.width > 800) {
                const optimizedPath = filePath.replace('.png', '-optimized.png');
                await image
                    .resize(800, null, { fit: 'contain' })
                    .png({ quality: 90 })
                    .toFile(optimizedPath);
                
                fs.renameSync(optimizedPath, filePath);
                console.log('Screenshot optimized successfully');
            }
        } catch (error) {
            console.error('Error optimizing screenshot:', error);
            throw error;
        }
    }

    public async cleanup() {
        if (this.browser) {
            try {
                await this.browser.close();
                this.browser = null;
                console.log('Browser closed successfully');
            } catch (error) {
                console.error('Error cleaning up browser:', error);
            }
        }
    }

    public getScreenshotHtml(screenshotPath: string, webview: vscode.Webview): string {
        const fileName = path.basename(screenshotPath);
        const timestamp = fileName.replace('screenshot-', '').replace(/\.[^/.]+$/, '');
        const screenshotUri = webview.asWebviewUri(vscode.Uri.file(screenshotPath));
        
        return `
            <div class="screenshot-container">
                <img src="${screenshotUri}" alt="Screenshot" class="screenshot-image" />
                <div class="screenshot-info">
                    <span class="screenshot-timestamp">Screenshot taken at: ${timestamp}</span>
                </div>
            </div>
        `;
    }

    public async analyzeScreenshot(screenshotPath: string, originalUrl: string): Promise<{
        analysis: string;
        suggestions: string[];
        actions: { description: string; code?: string }[];
    }> {
        if (!this.model) {
            throw new Error('OpenAI model not initialized');
        }

        try {
            // Read the screenshot metadata
            const metadata = await sharp(screenshotPath).metadata();

            // Get the directory structure using tree command
            let codeStructure = '';
            try {
                const { execSync } = require('child_process');
                codeStructure = execSync(
                    `tree -I 'node_modules|venv|__pycache__|.git' -a "${path.dirname(originalUrl)}"`,
                    { encoding: 'utf-8' }
                );
            } catch (error) {
                console.warn('Could not get directory structure:', error);
                codeStructure = 'Directory structure not available';
            }
            
            const systemPrompt = `You are an expert UI/UX analyst and web developer with a commitment to delivering comprehensive, 
            production-ready solutions. When analyzing the screenshot of ${originalUrl} with dimensions ${metadata.width}x${metadata.height},
            you must provide EXTENSIVE, THOROUGH, and COMPLETE analysis with DETAILED code implementations.

            CURRENT PROJECT STRUCTURE:
            \`\`\`
            ${codeStructure}
            \`\`\`

            Focus on these areas with maximum detail:
            1. Visual hierarchy and layout
               - Analyze every aspect of visual design
               - Provide specific measurements and spacing recommendations
               - Include complete CSS implementations
               - Ensure code fits within existing project structure
            
            2. User experience issues
               - Conduct deep analysis of user flows
               - Identify all potential friction points
               - Provide complete solutions with interactive components
               - Maintain consistency with existing codebase
            
            3. Accessibility compliance
               - Perform comprehensive WCAG 2.1 analysis
               - Check all success criteria
               - Include complete ARIA implementations
               - Integrate with existing accessibility features
            
            4. Performance optimization
               - Analyze loading performance
               - Identify optimization opportunities
               - Provide complete optimization code
               - Consider existing performance patterns
            
            5. Mobile responsiveness
               - Check all breakpoints
               - Analyze touch interactions
               - Provide complete responsive implementations
               - Match existing responsive design patterns
            
            6. Browser compatibility
               - Test across all major browsers
               - Identify compatibility issues
               - Include cross-browser solutions
               - Align with current browser support
            
            7. Best practices implementation
               - Security best practices
               - SEO optimization
               - Complete semantic markup
               - Follow existing project conventions
            
            8. Code Structure and Organization
               - Follow existing project structure
               - Maintain consistent file organization
               - Use appropriate file naming conventions
               - Create necessary subdirectories
               - Update relevant configuration files
            
            IMPORTANT GUIDELINES:
            - NEVER provide placeholder code or incomplete solutions
            - ALWAYS include full, production-ready code implementations
            - Include extensive CSS with proper naming conventions
            - Provide complete JavaScript functionality
            - Include error handling and edge cases
            - Add detailed comments explaining the code
            - Consider all possible user scenarios
            - Provide thorough testing strategies
            - Include performance monitoring code
            - Add documentation for maintenance
            - Follow existing project structure
            - Create all necessary files in appropriate locations
            - Update configuration files as needed
            - Include file paths relative to project root

            Your analysis must be actionable and complete, leaving no aspects unexplored.
            When suggesting file changes, ALWAYS specify the full path relative to the project root.`;

            const response = await this.model.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Analyze this screenshot and provide a COMPLETE and THOROUGH response including:
                        1. Comprehensive analysis of all aspects
                        2. Detailed list of issues and concerns with severity levels
                        3. Complete, production-ready solutions for each issue
                        4. Extensive code implementations including:
                           - Full HTML structure with semantic markup
                           - Complete CSS with responsive design
                           - JavaScript functionality with error handling
                           - Accessibility implementations
                           - Performance optimization code
                           - Testing and monitoring code
                           - File structure updates and new files
                           - Configuration changes
                        5. Implementation guidelines and best practices
                        6. Maintenance and documentation requirements
                        7. File structure modifications:
                           - New file locations
                           - Directory structure updates
                           - Configuration file changes
                           - Asset organization
                        
                        DO NOT skip any details or provide placeholder solutions.
                        ENSURE all code is complete and production-ready.
                        INCLUDE extensive comments and documentation.
                        SPECIFY full file paths for all changes.` }
                ],
            });

            const analysis = response.choices[0]?.message?.content || '';
            
            // Enhanced parsing of the analysis to extract structured information
            const suggestions: string[] = [];
            const actions: { description: string; code?: string }[] = [];

            // Extract suggestions and actions from the analysis with improved parsing
            const sections = analysis.split('\n\n');
            for (const section of sections) {
                if (section.toLowerCase().includes('suggestion:')) {
                    suggestions.push(section.replace(/^suggestion:\s*/i, '').trim());
                } else if (section.toLowerCase().includes('action:')) {
                    const actionMatch = section.match(/action:\s*(.*?)(?:\ncode:\s*```(?:\w+)?\n([\s\S]*?)```)?/i);
                    if (actionMatch) {
                        const [_, description, code] = actionMatch;
                        actions.push({
                            description: description.trim(),
                            code: code ? code.trim() : undefined
                        });
                    }
                } else if (section.includes('```')) {
                    // Capture any code blocks as potential actions
                    const codeMatch = section.match(/(?:.*?)```(?:\w+)?\n([\s\S]*?)```/);
                    if (codeMatch) {
                        const precedingText = section.split('```')[0].trim();
                        actions.push({
                            description: precedingText || 'Implementation',
                            code: codeMatch[1].trim()
                        });
                    }
                }
            }

            // Parse file paths and create directories if needed
            const filePathRegex = /(?:^|\n)(?:create|update|modify)?\s*file:\s*([^\n]+)/gi;
            let match;
            while ((match = filePathRegex.exec(analysis)) !== null) {
                const filePath = match[1].trim();
                if (filePath) {
                    const fullPath = path.join(path.dirname(originalUrl), filePath);
                    const directory = path.dirname(fullPath);
                    
                    // Create directory if it doesn't exist
                    if (!fs.existsSync(directory)) {
                        fs.mkdirSync(directory, { recursive: true });
                    }
                }
            }

            return {
                analysis,
                suggestions,
                actions
            };
        } catch (error) {
            console.error('Error analyzing screenshot:', error);
            throw error;
        }
    }

    public async implementSuggestedActions(actions: { description: string; code?: string }[], webview: vscode.Webview): Promise<void> {
        for (const action of actions) {
            try {
                if (action.code) {
                    // Create a temporary file with the suggested code
                    const tempFile = path.join(this.screenshotsDir, `improvement-${Date.now()}.js`);
                    await fs.promises.writeFile(tempFile, action.code);

                    // Show the changes in a diff view
                    const uri = vscode.Uri.file(tempFile);
                    await vscode.commands.executeCommand('vscode.diff', uri, uri, `Suggested Improvement: ${action.description}`);

                    // Clean up temp file
                    await fs.promises.unlink(tempFile);
                }

                webview.postMessage({
                    type: 'status',
                    text: `Implementing improvement: ${action.description}`,
                    status: 'info'
                });
            } catch (error) {
                console.error(`Error implementing action: ${action.description}`, error);
                webview.postMessage({
                    type: 'status',
                    text: `Error implementing improvement: ${error instanceof Error ? error.message : 'Unknown error'}`,
                    status: 'error'
                });
            }
        }
    }
} 