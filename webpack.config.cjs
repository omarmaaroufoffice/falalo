const path = require('path');

module.exports = {
  target: 'node',
  mode: 'production',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode',
    'agentkeepalive': 'commonjs agentkeepalive',
    'form-data': 'commonjs form-data',
    'abort-controller': 'commonjs abort-controller',
    'sharp': 'commonjs sharp'
  },
  resolve: {
    extensions: ['.ts', '.js'],
    fallback: {
      "http": false,
      "https": false,
      "url": false,
      "util": false,
      "stream": false,
      "crypto": false
    },
    alias: {
      '@img/sharp-darwin-arm64': path.resolve(__dirname, 'node_modules/@img/sharp-darwin-arm64'),
      '@img/sharp-libvips-dev': path.resolve(__dirname, 'node_modules/@img/sharp-libvips-dev')
    }
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/
      }
    ]
  }
}; 