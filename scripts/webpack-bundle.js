#!/usr/bin/env node

const BB = require('bluebird')

const CopyWebpackPlugin = require('copy-webpack-plugin')
const WebpackNodeExternals = require('webpack-node-externals')
const npmBundled = require('npm-bundled')
const path = require('path')
const pkg = require('../package.json')
const webpack = require('webpack')

if (require.main === module) {
  BB.fromNode(cb => bundler().run(cb))
    .then(stats => {
      console.log(stats.toString({
        chunks: false,
        colors: true
      }))
    })
}

module.exports = bundler
function bundler (opts) {
  opts = opts || {}
  const dest = path.join(
    __dirname, '..', 'release', `${pkg.name}-${pkg.version}`
  )
  const bundled = npmBundled.sync({path: path.join(__dirname, '..')})
  const excludedDeps = [
    'cross-spawn',
    'encoding',
    'update-notifier',
    'worker-farm',
    'yargs'
  ]
  return webpack({
    context: path.join(__dirname, '..'),
    // devtool: 'source-map',
    target: 'node',
    node: {
      __dirname: false,
      __filename: false
    },
    module: {
      rules: [
        { test: /.js$/, loader: 'shebang-loader' }
      ]
    },
    mode: opts.mode || process.env.NODE_ENV || 'production',
    externals: [
      WebpackNodeExternals({
        whitelist: bundled.filter(dep => !excludedDeps.find(x => dep === x))
      })
    ],
    plugins: [
      new webpack.BannerPlugin({
        banner: '#!/usr/bin/env node',
        raw: true,
        exclude: /worker/
      }),
      new CopyWebpackPlugin([
        'package.json',
        {
          from: { glob: path.join(__dirname, '..', 'bin/+(npm|npm.cmd|node-gyp-bin|npx|npx.cmd)') },
          to: dest + '/'
        }
      ])
    ],
    entry: Object.assign({
      'lib/npm.js': require.resolve('../lib/npm.js'),
      'lib/install/action/extract-worker.js': require.resolve('../lib/install/action/extract-worker.js'),
      'bin/npm-cli.js': require.resolve('../bin/npm-cli.js'),
      'bin/npx-cli.js': require.resolve('../bin/npx-cli.js'),
      'node_modules/update-notifier/index.js': require.resolve('update-notifier/index.js')
    }),
    output: {
      filename: '[name]',
      libraryTarget: 'commonjs2',
      path: dest
    }
  })
}
