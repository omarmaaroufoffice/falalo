import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { OpenAI } from 'openai';
import { ContextConfig } from '../interfaces/types';

export class ContextManager {
    private contextFiles: Set<string> = new Set();
    private readonly maxContextSize = 1000000; // 1MB
    private readonly maxFileSize = 100000; // 100KB

    constructor(
        private readonly model: OpenAI,
        private readonly workspaceRoot: string
    ) {}

    public async addToContext(filePath: string): Promise<void> {
        if (!this.isValidFile(filePath)) {
            throw new Error(`Invalid file path: ${filePath}`);
        }

        const stats = fs.statSync(filePath);
        if (stats.size > this.maxFileSize) {
            throw new Error(`File too large (>${this.maxFileSize / 1000}KB): ${filePath}`);
        }

        const totalSize = await this.getCurrentContextSize();
        if (totalSize + stats.size > this.maxContextSize) {
            throw new Error('Context size limit exceeded. Remove some files first.');
        }

        this.contextFiles.add(filePath);
    }

    public async removeFromContext(filePath: string): Promise<void> {
        this.contextFiles.delete(filePath);
    }

    public async getContextFiles(): Promise<string[]> {
        return Array.from(this.contextFiles);
    }

    public async clearContext(): Promise<void> {
        this.contextFiles.clear();
    }

    private async getCurrentContextSize(): Promise<number> {
        let totalSize = 0;
        for (const file of this.contextFiles) {
            try {
                const stats = fs.statSync(file);
                totalSize += stats.size;
            } catch (error) {
                console.warn(`Error getting file size for ${file}:`, error);
            }
        }
        return totalSize;
    }

    private isValidFile(filePath: string): boolean {
        if (!fs.existsSync(filePath)) {
            return false;
        }

        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
            return false;
        }

        const relativePath = path.relative(this.workspaceRoot, filePath);
        return !this.isExcluded(relativePath);
    }
    private isExcluded(relativePath: string): boolean {
        const DEFAULT_EXCLUSIONS = [
            'node_modules',
            '.git',
            'dist',
            'build',
            '.DS_Store',
            '.*\\.log$',  // Fixed regex pattern for log files
            '.*\\.lock$',  // Fixed regex pattern for lock files
            '^\\.',       // Fixed regex pattern for hidden files/directories
            '^__.*__$'    // Fixed regex pattern for Python special directories
        ];

        return DEFAULT_EXCLUSIONS.some((pattern: string) => {
            if (pattern.startsWith('^') || pattern.endsWith('$')) {
                // Regex pattern
                try {
                    const regex = new RegExp(pattern);
                    return regex.test(relativePath);
                } catch (error) {
                    console.warn(`Invalid regex pattern: ${pattern}`, error);
                    return false;
                }
            } else {
                // Simple glob pattern
                const parts = relativePath.split(path.sep);
                return parts.some(part => part === pattern);
            }
        });
    }

    public async getContextSummary(): Promise<string> {
        const files = await this.getContextFiles();
        if (files.length === 0) {
            return 'No files in context.';
        }

        const fileContents = await Promise.all(files.map(async file => {
            try {
                const relativePath = path.relative(this.workspaceRoot, file);
                const content = fs.readFileSync(file, 'utf-8');
                return `File: ${relativePath}\n\n${content}\n`;
            } catch (error) {
                console.warn(`Error reading file ${file}:`, error);
                return '';
            }
        }));

        const contextContent = fileContents.join('\n---\n');
        const completion = await this.model.chat.completions.create({
            model: 'o3-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are an expert code analyst. Provide a concise summary of the following codebase context.'
                },
                {
                    role: 'user',
                    content: contextContent
                }
            ],
            reasoning_effort: 'high',
            max_completion_tokens: 100000,
            store: true
        });

        return completion.choices[0]?.message?.content || 'Failed to generate context summary.';
    }

    public async analyzeContext(query: string): Promise<string> {
        const files = await this.getContextFiles();
        if (files.length === 0) {
            return 'No files in context to analyze.';
        }

        const fileContents = await Promise.all(files.map(async file => {
            try {
                const relativePath = path.relative(this.workspaceRoot, file);
                const content = fs.readFileSync(file, 'utf-8');
                return `File: ${relativePath}\n\n${content}\n`;
            } catch (error) {
                console.warn(`Error reading file ${file}:`, error);
                return '';
            }
        }));

        const contextContent = fileContents.join('\n---\n');
        const completion = await this.model.chat.completions.create({
            model: 'o3-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are an expert code analyst. Analyze the following codebase context in response to the user query.'
                },
                {
                    role: 'user',
                    content: `Context:\n${contextContent}\n\nQuery: ${query}`
                }
            ],
            reasoning_effort: 'high',
            max_completion_tokens: 100000,
            store: true
        });

        return completion.choices[0]?.message?.content || 'Failed to analyze context.';
    }
} 