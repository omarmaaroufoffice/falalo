import * as path from 'path';
import * as fs from 'fs';

export function validatePath(filePath: string): boolean {
    try {
        // Check if path exists
        if (!fs.existsSync(filePath)) {
            return false;
        }
        
        // Get absolute path
        const absolutePath = path.resolve(filePath);
        
        // Check if path is within workspace
        const workspaceRoot = process.cwd();
        const relativePath = path.relative(workspaceRoot, absolutePath);
        return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
    } catch (error) {
        console.error('Error validating path:', error);
        return false;
    }
}

export function sanitizeCommand(command: string): string | null {
    try {
        // Remove any potentially dangerous characters or sequences
        const sanitized = command
            .replace(/[;&|`$]/g, '') // Remove shell special characters
            .replace(/\.\./g, '') // Remove parent directory references
            .trim();
            
        return sanitized || null;
    } catch (error) {
        console.error('Error sanitizing command:', error);
        return null;
    }
}

export function formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

export function cleanAIResponse(response: string): string {
    try {
        // Remove markdown code block markers if present
        response = response.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        
        // Trim whitespace
        response = response.trim();
        
        return response;
    } catch (error) {
        console.error('Error cleaning AI response:', error);
        return response;
    }
}

export function getFileExtension(filePath: string): string {
    const ext = path.extname(filePath);
    return ext ? ext.slice(1) : '';
}

export function isTextFile(filePath: string): boolean {
    const textExtensions = [
        'txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'ts', 'jsx', 'tsx',
        'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'go', 'rs',
        'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'yml', 'yaml', 'toml',
        'ini', 'cfg', 'conf', 'properties', 'gradle', 'pom', 'sql', 'graphql',
        'vue', 'svelte', 'dart', 'lua', 'r', 'pl', 'pm', 'f90', 'f95', 'f03',
        'proto', 'cmake', 'make', 'dockerfile', 'gitignore', 'env'
    ];

    const extension = getFileExtension(filePath).toLowerCase();
    return textExtensions.includes(extension);
}

export function isImageFile(filePath: string): boolean {
    const imageExtensions = [
        'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp', 'svg', 'ico'
    ];

    const extension = getFileExtension(filePath).toLowerCase();
    return imageExtensions.includes(extension);
}

export function isBinaryFile(filePath: string): boolean {
    const binaryExtensions = [
        'exe', 'dll', 'so', 'dylib', 'bin', 'obj', 'class', 'jar', 'war',
        'ear', 'zip', 'tar', 'gz', '7z', 'rar', 'pdf', 'doc', 'docx', 'xls',
        'xlsx', 'ppt', 'pptx', 'iso', 'img', 'db', 'sqlite', 'pyc', 'pyo',
        'pyd', 'o', 'a', 'lib', 'mo', 'deb', 'rpm', 'pkg', 'dmg'
    ];

    const extension = getFileExtension(filePath).toLowerCase();
    return binaryExtensions.includes(extension);
}

export function isHiddenFile(filePath: string): boolean {
    const basename = path.basename(filePath);
    return basename.startsWith('.');
}

export function isSystemFile(filePath: string): boolean {
    const systemPatterns = [
        /^\.git\//,
        /^\.svn\//,
        /^\.hg\//,
        /^\.DS_Store$/,
        /^Thumbs\.db$/,
        /^desktop\.ini$/
    ];

    return systemPatterns.some(pattern => pattern.test(filePath));
}

export function isTestFile(filePath: string): boolean {
    const testPatterns = [
        /test\.[jt]sx?$/,
        /spec\.[jt]sx?$/,
        /__tests__/,
        /__mocks__/,
        /\.test\./,
        /\.spec\./
    ];

    return testPatterns.some(pattern => pattern.test(filePath));
}

export function isConfigFile(filePath: string): boolean {
    const configPatterns = [
        /\.config\./,
        /\.conf$/,
        /\.ini$/,
        /\.env/,
        /\.json$/,
        /\.ya?ml$/,
        /\.toml$/,
        /\.xml$/
    ];

    return configPatterns.some(pattern => pattern.test(filePath));
}

export function isDependencyFile(filePath: string): boolean {
    const dependencyFiles = [
        'package.json',
        'package-lock.json',
        'yarn.lock',
        'requirements.txt',
        'Pipfile',
        'Pipfile.lock',
        'poetry.lock',
        'Gemfile',
        'Gemfile.lock',
        'pom.xml',
        'build.gradle',
        'build.sbt',
        'cargo.toml',
        'cargo.lock'
    ];

    return dependencyFiles.includes(path.basename(filePath));
} 