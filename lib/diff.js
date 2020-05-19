const fs = require('fs')
const { EOL } = require('os')
const { promisify } = require('util')
const ansi = require('ansi-styles')
const Arborist = require('@npmcli/arborist')
const jsDiff = require('diff')
const pacote = require('pacote')
const Mimer = require('mimer')
const tar = require('tar')
const packlist = require('npm-packlist')
const rpj = require('read-package-json-fast')

const npm = require('./npm.js')
const usageUtil = require('./utils/usage.js')
const output = require('./utils/output.js')

const usage = usageUtil(
  'diff',
  'npm diff',
  'npm diff <spec-a> [<spec-b>]'
)

const completion = (opts, cb) => {
  const argv = opts.conf.argv.remain
  switch (argv[2]) {
    case 'diff':
      return cb(null, [])
    default:
      return cb(new Error(argv[2] + ' not recognized'))
  }
}

const cmd = (args, cb) => diff(args).then(() => cb()).catch(cb)

let mime
const getMime = () => {
  if (mime) return mime

  mime = new Mimer()
  mime.set([
    'authors',
    'changes',
    'editorconfig',
    'eslintignore',
    'eslintrc',
    'nyrc',
    'npmignore',
    'license',
    'makefile',
    'md',
    'markdown',
    'patents',
    'readme',
    'ts',
    'yml',
    'yaml',
    'flow'
  ], 'text/plain')

  return mime
}

const diffFileType = filename => {
  const mime = getMime()
  return [
    'application/javascript',
    'application/json',
    'text/css',
    'text/html',
    'text/plain'
  ].some(i => i === mime.get(filename.toLowerCase()))
}

const isChangelog = filename =>
  /^package\/(changelog|CHANGELOG)/.test(filename)

const untar = ({ files, item, prefix, opts, refs }) =>
  new Promise((resolve, reject) => {
    const count = {
      queued: 0,
      read: 0
    }
    tar.list({
      filter: async (path, entry) => {
        if (
          entry.type !== 'File' ||
          (opts.changelog && !isChangelog(path))
        ) return

        const key = path.replace(/^[^/]+\/?/, '')
        files.add(key)
        count.queued++

        entry.setEncoding('utf8')
        let content

        try {
          content = await entry.concat()
        } catch (e) {
          return reject(Object.assign(
            new Error('failed to read files'),
            { code: 'EDIFFUNTAR' }
          ))
        }

        refs.set(`${prefix}${key}`, {
          content,
          mode: `100${entry.mode.toString(8)}`
        })
        count.read++

        if (count.queued === count.read) resolve()
      }
    })
      .on('error', reject)
      .end(item)
  })

const colorizeDiff = ({ res, headerLength }) => {
  const colors = {
    charsRemoved: ansi.bgRed,
    charsAdded: ansi.bgGreen,
    removed: ansi.red,
    added: ansi.green,
    header: ansi.yellow,
    section: ansi.magenta
  }
  const colorize = (str, colorId) => {
    var { open, close } = colors[colorId]
    // avoid highlighting the "\n" (would highlight till the end of the line)
    return str.replace(/[^\n\r]+/g, open + '$&' + close)
  }

  // this RegExp will include all the `\n` chars into the lines, easier to join
  const lines = res.split(/^/m)

  const start = colorize(lines.slice(0, headerLength || 2).join(''), 'header')
  const end = lines.slice(headerLength || 2).join('')
    .replace(/^-.*/gm, colorize('$&', 'removed'))
    .replace(/^\+.*/gm, colorize('$&', 'added'))
    .replace(/^@@.+@@/gm, colorize('$&', 'section'))

  return start + end
}

const printDiff = ({ files, opts, refs, versions }) => {
  for (const filename of files.values()) {
    const names = {
      a: `a/${filename}`,
      b: `b/${filename}`
    }

    let fileMode = ''
    const filenames = {
      a: refs.get(names.a),
      b: refs.get(names.b)
    }
    const contents = {
      a: filenames.a && filenames.a.content,
      b: filenames.b && filenames.b.content
    }
    const modes = {
      a: filenames.a && filenames.a.mode,
      b: filenames.b && filenames.b.mode
    }

    if (contents.a === contents.b) continue

    let res = ''
    let headerLength = 0
    const header = str => {
      headerLength++
      res += `${str}${EOL}`
    }

    // manually build a git diff-compatible header
    header(`diff --git ${names.a} ${names.b}`)
    if (modes.a === modes.b) {
      fileMode = filenames.a.mode
    } else {
      if (modes.a && modes.b) {
        header(`old mode ${modes.a}`)
        header(`new mode ${modes.b}`)
      } else if (modes.a && !modes.b) {
        header(`deleted file mode ${modes.a}`)
      } else if (!modes.a && modes.b) {
        header(`new file mode ${modes.b}`)
      }
    }
    header(`index ${versions.a}..${versions.b} ${fileMode}`)

    if (diffFileType(filename)) {
      res += jsDiff.createTwoFilesPatch(
        names.a,
        names.b,
        contents.a || '',
        contents.b || '',
        '',
        '',
        { context: 3 }
      ).replace(
        '===================================================================\n',
        ''
      )
      headerLength += 2
    } else {
      header(`--- ${names.a}`)
      header(`+++ ${names.b}`)
    }

    output(
      opts.color
        ? colorizeDiff({ res, headerLength })
        : res
    )
  }
}

const readPackageFiles = async ({ files, prefix, refs }) => {
  const readFile = promisify(fs.readFile)
  const stat = promisify(fs.stat)
  const filenames = await packlist({ path: npm.prefix })
  const read = await Promise.all(
    filenames.map(filename => Promise.all([
      filename,
      readFile(filename, { encoding: 'utf8' }),
      stat(filename)
    ]))
  )

  for (const [filename, content, stat] of read) {
    files.add(filename)
    refs.set(`${prefix}${filename}`, {
      content,
      mode: stat.mode.toString(8)
    })
  }
}

const diffSelf = async () => {
  const opts = npm.flatOptions
  const files = new Set()
  const refs = new Map()

  await readPackageFiles({
    files,
    refs,
    prefix: 'b/'
  })

  const { name } = await rpj(`${npm.prefix}/package.json`)
  let aManifest = await pacote.manifest(`${name}@${opts.tag || 'latest'}`)

  const versions = {
    a: aManifest.version,
    b: 'current'
  }

  const a = await pacote.tarball(aManifest._resolved)
  await untar({
    files,
    opts,
    refs,
    prefix: 'a/',
    item: a
  })

  printDiff({
    files,
    opts,
    refs,
    versions
  })
}

const diffComparison = async (specs) => {
  const opts = npm.flatOptions
  const files = new Set()
  const refs = new Map()

  let aManifest = await pacote.manifest(specs.a)
  let bManifest

  // when using a single argument the spec to compare from is going to be
  // figured out from reading arborist.loadActual inventory and finding the
  // first package match for the same name
  if (!specs.b) {
    const arb = new Arborist({ ...opts, path: npm.prefix })
    const actualTree = await arb.loadActual()
    const node = actualTree.inventory
      .query('name', aManifest.name)
      .values().next().value

    if (!node || !node.name || !node.package || !node.package.version) {
      const err = new TypeError('could not find something to compare against')
      err.code = 'EDIFFCOMPARE'
      throw err
    }

    bManifest = aManifest
    specs.b = specs.a
    specs.a = `${node.name}@${node.package.version}`
    aManifest = await pacote.manifest(specs.a)
  } else {
    bManifest = await pacote.manifest(specs.b)
  }

  const versions = {
    a: aManifest.version,
    b: bManifest.version
  }

  // fetches tarball using pacote
  const [a, b] = await Promise.all([
    pacote.tarball(aManifest._resolved),
    pacote.tarball(bManifest._resolved)
  ])

  // read all files
  // populates `files` and `refs`
  await Promise.all([
    untar({
      files,
      opts,
      refs,
      prefix: 'a/',
      item: a
    }),
    untar({
      files,
      opts,
      refs,
      prefix: 'b/',
      item: b
    })
  ])

  printDiff({
    files,
    opts,
    refs,
    versions
  })
}

const diff = (args) => {
  const specs = {
    a: args[0],
    b: args[1]
  }

  // when using no arguments we're going to compare
  // the current package files with its latest published tarball
  if (!specs.a) {
    return diffSelf(specs)

  // otherwise we're going to be comparing files from two tarballs
  } else {
    return diffComparison(specs)
  }
}

module.exports = Object.assign(cmd, { usage, completion })
