module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are not allowed',
      from: {},
      to: {
        circular: true
      }
    }
  ],
  options: {
    doNotFollow: {
      dependencyTypes: [
        'npm-dev',
        'npm-optional',
        'npm-peer',
        'npm-bundled'
      ]
    },
    includeOnly: '^(src|node_modules/@types/vscode|node_modules/vscode)',
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.json'
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js', '.json']
    },
    reporterOptions: {
      text: {
        highlightFocused: true
      },
      dot: {
        collapsePattern: 'node_modules/[^/]+',
        theme: {
          graph: { rankdir: 'LR', splines: 'ortho' },
          modules: [
            {
              criteria: { source: '^src/extension\\.ts$' },
              attributes: { fillcolor: '#ffcccc', style: 'filled' }
            },
            {
              criteria: { source: '^src/screenshot\\.ts$' },
              attributes: { fillcolor: '#ccffcc', style: 'filled' }
            },
            {
              criteria: { source: '^src/fileOrganizer\\.ts$' },
              attributes: { fillcolor: '#cccfff', style: 'filled' }
            }
          ],
          dependencies: [
            {
              criteria: { "dependencyTypes": ["vscode"] },
              attributes: { color: "red", fontcolor: "red" }
            },
            {
              criteria: { "dependencyTypes": ["npm"] },
              attributes: { color: "green", fontcolor: "green" }
            }
          ]
        }
      }
    }
  }
}; 