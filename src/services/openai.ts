import * as vscode from 'vscode';
import { OpenAI } from 'openai';
import type { Fetch } from 'openai/core';

export let model: OpenAI;

export async function initializeOpenAI(context: vscode.ExtensionContext): Promise<OpenAI> {
    const config = vscode.workspace.getConfiguration('falalo');
    const apiKey = config.get<string>('openAIApiKey') || '';
    
    if (!apiKey) {
        throw new Error('OpenAI API key not configured. Please set falalo.openAIApiKey in settings.');
    }
    
    model = new OpenAI({
        apiKey,
        baseURL: "https://api.openai.com/v1",
        defaultHeaders: {
            'Authorization': `Bearer ${apiKey}`,
            'OpenAI-Beta': 'assistants=v1'
        },
        fetch: globalThis.fetch as unknown as Fetch
    });
    
    return model;
} 