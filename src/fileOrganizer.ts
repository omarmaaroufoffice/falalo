import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface FileInfo {
    path: string;
    name: string;
    extension: string;
    size: number;
    createdDate: Date;
    modifiedDate: Date;
    type: string;
}

export interface OrganizeOptions {
    by: 'type' | 'date' | 'size' | 'name';
    order: 'asc' | 'desc';
    createFolders: boolean;
    includePatterns?: string[];
    excludePatterns?: string[];
    minSize?: number;
    maxSize?: number;
    dateRange?: {
        start: Date;
        end: Date;
    };
}

export class FileOrganizer {
    private readonly typeCategories: { [key: string]: string[] } = {
        'Images': ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp'],
        'Documents': ['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.md', '.csv', '.xls', '.xlsx'],
        'Audio': ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'],
        'Video': ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm'],
        'Archives': ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'],
        'Code': ['.js', '.ts', '.py', '.java', '.cpp', '.c', '.h', '.cs', '.php', '.html', '.css', '.scss', '.json', '.xml'],
        'Executables': ['.exe', '.msi', '.app', '.dmg', '.sh', '.bat', '.cmd'],
    };

    constructor(private workspaceRoot: string) {}

    public async organizeFiles(options: OrganizeOptions): Promise<{ success: boolean; message: string; organized: FileInfo[] }> {
        try {
            // Get all files in the workspace
            const files = await this.getAllFiles(options);
            
            if (files.length === 0) {
                return { success: true, message: 'No files found matching the criteria.', organized: [] };
            }

            // Sort files based on options
            const sortedFiles = this.sortFiles(files, options);

            if (options.createFolders) {
                await this.createOrganizedFolders(sortedFiles, options);
            }

            return {
                success: true,
                message: `Successfully organized ${sortedFiles.length} files.`,
                organized: sortedFiles
            };
        } catch (error) {
            console.error('Error organizing files:', error);
            return {
                success: false,
                message: `Failed to organize files: ${error instanceof Error ? error.message : 'Unknown error'}`,
                organized: []
            };
        }
    }

    private async getAllFiles(options: OrganizeOptions): Promise<FileInfo[]> {
        const files: FileInfo[] = [];
        const processDirectory = async (dirPath: string) => {
            const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                
                if (entry.isDirectory()) {
                    await processDirectory(fullPath);
                    continue;
                }

                // Check if file matches include/exclude patterns
                if (!this.shouldIncludeFile(fullPath, options)) {
                    continue;
                }

                const stats = await fs.promises.stat(fullPath);
                const fileInfo: FileInfo = {
                    path: fullPath,
                    name: entry.name,
                    extension: path.extname(entry.name).toLowerCase(),
                    size: stats.size,
                    createdDate: stats.birthtime,
                    modifiedDate: stats.mtime,
                    type: this.getFileType(entry.name)
                };

                // Apply size filters
                if (options.minSize && stats.size < options.minSize) continue;
                if (options.maxSize && stats.size > options.maxSize) continue;

                // Apply date filters
                if (options.dateRange) {
                    if (stats.mtime < options.dateRange.start || stats.mtime > options.dateRange.end) {
                        continue;
                    }
                }

                files.push(fileInfo);
            }
        };

        await processDirectory(this.workspaceRoot);
        return files;
    }

    private shouldIncludeFile(filePath: string, options: OrganizeOptions): boolean {
        const relativePath = path.relative(this.workspaceRoot, filePath);

        // Check exclude patterns
        if (options.excludePatterns) {
            for (const pattern of options.excludePatterns) {
                if (this.matchGlobPattern(relativePath, pattern)) {
                    return false;
                }
            }
        }

        // Check include patterns
        if (options.includePatterns && options.includePatterns.length > 0) {
            return options.includePatterns.some(pattern => 
                this.matchGlobPattern(relativePath, pattern)
            );
        }

        return true;
    }

    private matchGlobPattern(filePath: string, pattern: string): boolean {
        const normalizedPath = filePath.replace(/\\/g, '/');
        return new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(normalizedPath);
    }

    private getFileType(fileName: string): string {
        const extension = path.extname(fileName).toLowerCase();
        
        for (const [category, extensions] of Object.entries(this.typeCategories)) {
            if (extensions.includes(extension)) {
                return category;
            }
        }
        
        return 'Other';
    }

    private sortFiles(files: FileInfo[], options: OrganizeOptions): FileInfo[] {
        return files.sort((a, b) => {
            let comparison = 0;
            
            switch (options.by) {
                case 'type':
                    comparison = a.type.localeCompare(b.type);
                    break;
                case 'date':
                    comparison = a.modifiedDate.getTime() - b.modifiedDate.getTime();
                    break;
                case 'size':
                    comparison = a.size - b.size;
                    break;
                case 'name':
                    comparison = a.name.localeCompare(b.name);
                    break;
            }
            
            return options.order === 'asc' ? comparison : -comparison;
        });
    }

    private async createOrganizedFolders(files: FileInfo[], options: OrganizeOptions): Promise<void> {
        const organizedFiles = new Map<string, FileInfo[]>();

        // Group files by category
        for (const file of files) {
            let category = '';
            switch (options.by) {
                case 'type':
                    category = file.type;
                    break;
                case 'date':
                    category = this.getDateCategory(file.modifiedDate);
                    break;
                case 'size':
                    category = this.getSizeCategory(file.size);
                    break;
                case 'name':
                    category = file.name[0].toUpperCase();
                    break;
            }

            if (!organizedFiles.has(category)) {
                organizedFiles.set(category, []);
            }
            organizedFiles.get(category)?.push(file);
        }

        // Create folders and move files
        for (const [category, categoryFiles] of organizedFiles) {
            const categoryPath = path.join(this.workspaceRoot, 'Organized', category);
            await fs.promises.mkdir(categoryPath, { recursive: true });

            for (const file of categoryFiles) {
                const newPath = path.join(categoryPath, path.basename(file.path));
                await fs.promises.rename(file.path, newPath);
            }
        }
    }

    private getDateCategory(date: Date): string {
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const daysDiff = Math.floor(diff / (1000 * 60 * 60 * 24));

        if (daysDiff < 7) return 'Last Week';
        if (daysDiff < 30) return 'Last Month';
        if (daysDiff < 90) return 'Last 3 Months';
        if (daysDiff < 365) return 'Last Year';
        return 'Older';
    }

    private getSizeCategory(size: number): string {
        const kb = 1024;
        const mb = kb * 1024;
        const gb = mb * 1024;

        if (size < kb) return 'Tiny (< 1KB)';
        if (size < mb) return 'Small (< 1MB)';
        if (size < 10 * mb) return 'Medium (1-10MB)';
        if (size < 100 * mb) return 'Large (10-100MB)';
        if (size < gb) return 'Very Large (100MB-1GB)';
        return 'Huge (> 1GB)';
    }
} 