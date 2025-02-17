import * as vscode from 'vscode';
import { OpenAI } from 'openai';
import type { Fetch } from 'openai/core';
import { LogManager } from '../logManager';

export let model: OpenAI;

export async function initializeOpenAI(context: vscode.ExtensionContext): Promise<OpenAI> {
    const logger = LogManager.getInstance();
    
    try {
        const config = vscode.workspace.getConfiguration('falalo');
        const apiKey = config.get<string>('openAIApiKey');
        
        if (!apiKey) {
            const message = 'OpenAI API key not configured. Please set falalo.openAIApiKey in settings.';
            vscode.window.showErrorMessage(message);
            throw new Error(message);
        }

        logger.log('Initializing OpenAI client...', { type: 'info' });

        model = new OpenAI({
            apiKey: apiKey,
            baseURL: "https://api.openai.com/v1",
            defaultHeaders: {
                'Authorization': `Bearer ${apiKey}`
            },
            maxRetries: 3,
            timeout: 30000,
            fetch: globalThis.fetch as unknown as Fetch
        });

        // Test the connection with a very simple request
        logger.log('Testing OpenAI connection...', { type: 'info' });
        const testResponse = await model.chat.completions.create({
            model: 'o3-mini',
            messages: [{ role: 'user', content: 'test' }],
            reasoning_effort: 'medium',
            store: true
        });

        if (!testResponse.choices || testResponse.choices.length === 0) {
            throw new Error('Failed to connect to OpenAI API - No response received');
        }

        logger.log('OpenAI client initialized successfully', { type: 'info' });
        return model;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.logError(error, 'OpenAI initialization');
        vscode.window.showErrorMessage(`Failed to initialize OpenAI: ${errorMessage}`);
        throw error;
    }
} 