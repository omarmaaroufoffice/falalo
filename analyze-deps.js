const fs = require('fs');
const path = require('path');

function analyzeDependencies() {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    
    const allDependencies = {
        dependencies: packageJson.dependencies || {},
        devDependencies: packageJson.devDependencies || {},
        peerDependencies: packageJson.peerDependencies || {},
        optionalDependencies: packageJson.optionalDependencies || {}
    };

    const output = {
        timestamp: new Date().toISOString(),
        summary: {
            totalDependencies: Object.keys(allDependencies.dependencies).length,
            totalDevDependencies: Object.keys(allDependencies.devDependencies).length,
            totalPeerDependencies: Object.keys(allDependencies.peerDependencies).length,
            totalOptionalDependencies: Object.keys(allDependencies.optionalDependencies).length,
            grand_total: Object.keys(allDependencies.dependencies).length + 
                        Object.keys(allDependencies.devDependencies).length +
                        Object.keys(allDependencies.peerDependencies).length +
                        Object.keys(allDependencies.optionalDependencies).length
        },
        dependencies: {
            production: Object.entries(allDependencies.dependencies)
                .map(([name, version]) => ({ name, version }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            development: Object.entries(allDependencies.devDependencies)
                .map(([name, version]) => ({ name, version }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            peer: Object.entries(allDependencies.peerDependencies)
                .map(([name, version]) => ({ name, version }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            optional: Object.entries(allDependencies.optionalDependencies)
                .map(([name, version]) => ({ name, version }))
                .sort((a, b) => a.name.localeCompare(b.name))
        }
    };

    // Create a detailed analysis file
    fs.writeFileSync(
        'dependency-analysis.json',
        JSON.stringify(output, null, 2)
    );

    // Create a more readable markdown summary
    const markdownContent = `# Dependency Analysis Report
Generated on: ${output.summary.timestamp}

## Summary
- Total Production Dependencies: ${output.summary.totalDependencies}
- Total Development Dependencies: ${output.summary.totalDevDependencies}
- Total Peer Dependencies: ${output.summary.totalPeerDependencies}
- Total Optional Dependencies: ${output.summary.totalOptionalDependencies}
- Grand Total: ${output.summary.grand_total}

## Production Dependencies
${output.dependencies.production.map(d => `- ${d.name}: ${d.version}`).join('\n')}

## Development Dependencies
${output.dependencies.development.map(d => `- ${d.name}: ${d.version}`).join('\n')}

${output.dependencies.peer.length ? `## Peer Dependencies
${output.dependencies.peer.map(d => `- ${d.name}: ${d.version}`).join('\n')}` : ''}

${output.dependencies.optional.length ? `## Optional Dependencies
${output.dependencies.optional.map(d => `- ${d.name}: ${d.version}`).join('\n')}` : ''}
`;

    fs.writeFileSync('dependency-analysis.md', markdownContent);
    
    console.log('Analysis complete. Check dependency-analysis.json and dependency-analysis.md for results.');
}

analyzeDependencies(); 