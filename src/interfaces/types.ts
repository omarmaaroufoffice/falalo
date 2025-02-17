import * as vscode from 'vscode';

export interface TaskStep {
    id: number;
    description: string;
    status: 'pending' | 'in-progress' | 'completed' | 'failed';
    files: string[];
    dependencies: number[];
    code?: string;
    command?: string;
}

export interface TaskPlan {
    steps: TaskStep[];
    currentStep: number;
    totalSteps: number;
    request: string;
    originalRequest: string;
    description: string;
    estimatedTime: string;
}

export interface FilePathInfo {
    absolutePath: string;
    relativePath: string;
    exists: boolean;
    isDirectory: boolean;
    size?: number;
    modifiedTime?: Date;
}

export interface CommandExecution {
    command: string;
    cwd?: string;
    isBackground: boolean;
    description: string;
}

export interface ContextConfig {
    maxContextSize: number;
    maxFileSize: number;
    excludePatterns: string[];
    includePatterns: string[];
}

export interface CodeReviewResult {
    issues: CodeIssue[];
    suggestions: CodeSuggestion[];
    metrics: CodeMetrics;
}

export interface CodeIssue {
    type: 'error' | 'warning' | 'info';
    message: string;
    file?: string;
    line?: number;
    column?: number;
    code?: string;
    severity: number;
    source?: string;
}

export interface CodeSuggestion {
    description: string;
    file?: string;
    line?: number;
    oldCode?: string;
    newCode?: string;
    rationale?: string;
    impact?: 'high' | 'medium' | 'low';
}

export interface CodeMetrics {
    complexity: number;
    maintainability: number;
    testCoverage?: number;
    linesOfCode: number;
    duplicateCode?: number;
    technicalDebt?: number;
}

export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cost: number;
}

export interface AutoContextResult {
    relevantFiles: string[];
    summary: string;
    confidence: number;
}

export interface CodeSummary {
    content: string;
    language: string;
    path: string;
    overview: string;
    contextAnalysis: string;
    suggestedApproach: string;
    timestamp: string;
}

export interface FileOperation {
    type: 'create' | 'update' | 'delete';
    path: string;
    content?: string;
}

export interface CommandOptions {
    commands: string[];
    description?: string;
    cwd?: string;
    maxRetries?: number;
}

export interface LogOptions {
    type?: 'info' | 'error' | 'ai';
    context?: string;
} 