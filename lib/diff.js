const Arborist = require('@npmcli/arborist')
const jsDiff = require('diff')
const pacote = require('pacote')
const Mimer = require('mimer')
const tar = require('tar')

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

const diff = async (args) => {
  const opts = npm.flatOptions
  const files = new Set()
  const refs = new Map()
  const versions = {}
  const specs = {
    a: args[0],
    b: args[1]
  }

  let aManifest = await pacote.manifest(specs.a)
  let bManifest

  if (!specs.b) {
    const arb = new Arborist({ ...opts, path: npm.prefix })
    const actualTree = await arb.loadActual()
    const node = actualTree.inventory
      .query('name', aManifest.name)
      .values().next().value

    if (!node || !node.name || !node.package || !node.package.version) {
      const err = new TypeError('could not find something to compare against')
      err.code = 'EDIFF'
      throw err
    }

    bManifest = aManifest
    specs.b = specs.a
    specs.a = `${node.name}@${node.package.version}`
    aManifest = await pacote.manifest(specs.a)
  } else {
    bManifest = pacote.manifest(specs.b)
  }

  versions.a = aManifest.version
  versions.b = bManifest.version

  const [a, b] = await Promise.all([
    pacote.tarball(aManifest._resolved),
    pacote.tarball(bManifest._resolved)
  ])

  const untar = prefix => tar.list({
    filter: async (path, entry) => {
      if (
        entry.type !== 'File' ||
        (opts.changelog && !isChangelog(path))
      ) return

      const key = path.replace(/^[^/]+\/?/, '')
      entry.setEncoding('utf8')
      const { mode } = entry
      const content = await entry.concat()
      files.add(key)
      refs.set(`${prefix}${key}`, {
        content,
        mode
      })
    }
  })

  untar('a/').end(a)
  untar('b/').end(b)

  const sleep = require('util').promisify(setTimeout)
  await sleep(1000)

  for (const filename of files.values()) {
    const names = {
      a: `a/${filename}`,
      b: `b/${filename}`
    }

    let fileMode = ''
    const files = {
      a: refs.get(names.a),
      b: refs.get(names.b)
    }
    const contents = {
      a: files.a && files.a.content,
      b: files.b && files.b.content
    }
    const modes = {
      a: files.a && files.a.mode,
      b: files.b && files.b.mode
    }

    if (contents.a === contents.b) continue

    let res
    if (diffFileType(filename)) {
      res = jsDiff.createTwoFilesPatch(
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
    } else {
      res = `--- ${names.a}\n+++ ${names.b}`
    }

    output(`diff --git ${names.a} ${names.b}`)

    if (modes.a === modes.b) {
      fileMode = ` 100${files.a.mode}`
    } else {
      if (modes.a) output(`old mode 100${modes.a}`)
      if (modes.b) output(`new mode 100${modes.b}`)
    }

    output(`index ${versions.a} ${versions.b}${fileMode}`)
    output(res)
  }
}

module.exports = Object.assign(cmd, { usage, completion })
