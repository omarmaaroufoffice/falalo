import * as puppeteer from 'puppeteer';
import sharp from 'sharp';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

export class ScreenshotManager {
    private browser: puppeteer.Browser | null = null;
    private screenshotsDir: string;

    constructor(private extensionPath: string) {
        this.screenshotsDir = path.join(extensionPath, 'screenshots');
        if (!fs.existsSync(this.screenshotsDir)) {
            fs.mkdirSync(this.screenshotsDir, { recursive: true });
        }
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
} 