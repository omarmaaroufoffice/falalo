export const DEFAULT_EXCLUSIONS: string[] = [
    // Node.js
    'node_modules',
    'package-lock.json',
    'yarn.lock',
    
    // Build directories
    'dist',
    'build',
    'out',
    '.next',
    
    // Cache directories
    '.cache',
    '.npm',
    '.yarn',
    
    // Python
    '__pycache__',
    '*.pyc',
    'venv',
    '.venv',
    'env',
    '.env',
    
    // IDE/Editor
    '.vscode',
    '.idea',
    '.vs',
    '*.swp',
    '*.swo',
    
    // Version Control
    '.git',
    '.svn',
    '.hg',
    
    // Logs and temporary files
    'logs',
    '*.log',
    'tmp',
    'temp',
    
    // Test coverage
    'coverage',
    '.nyc_output',
    
    // Documentation
    'docs',
    
    // Media and large files
    '*.jpg',
    '*.jpeg',
    '*.png',
    '*.gif',
    '*.ico',
    '*.pdf',
    '*.zip',
    '*.tar',
    '*.gz',
    
    // Database files
    '*.sqlite',
    '*.db',
    
    // Secrets and credentials
    '.env*',
    '*.pem',
    '*.key',
    'secrets.*',
    
    // OS files
    '.DS_Store',
    'Thumbs.db'
]; 