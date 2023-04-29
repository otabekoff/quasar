
import parseArgs from 'minimist'

const argv = parseArgs(process.argv.slice(2), {
  alias: {
    p: 'port',
    H: 'hostname',
    g: 'gzip',
    s: 'silent',
    colors: 'colors',
    o: 'open',
    c: 'cache',
    cors: 'cors',
    m: 'micro',
    history: 'history',
    i: 'index',
    https: 'https',
    C: 'cert',
    K: 'key',
    P: 'proxy',
    h: 'help'
  },
  boolean: [ 'g', 'https', 'colors', 'history', 'h', 'cors' ],
  string: [ 'H', 'C', 'K', 'i' ],
  default: {
    p: process.env.PORT || 4000,
    H: process.env.HOSTNAME || '0.0.0.0',
    g: true,
    c: 24 * 60 * 60,
    m: 1,
    i: 'index.html',
    colors: true
  }
})

if (argv.help) {
  console.log(`
  Description
    Start a HTTP(S) server on a folder.

  Usage
    $ quasar serve [path]
    $ quasar serve . # serve current folder

    If you serve a SSR folder built with the CLI then
    control is yielded to /index.js and params have no effect.

  Options
    --port, -p              Port to use (default: 4000)
    --hostname, -H          Address to use (default: 0.0.0.0)
    --gzip, -g              Compress content (default: true)
    --silent, -s            Suppress log message
    --colors                Log messages with colors (default: true)
    --open, -o              Open browser window after starting
    --cache, -c <number>    Cache time (max-age) in seconds;
                            Does not apply to /service-worker.js
                            (default: 86400 - 24 hours)
    --micro, -m <seconds>   Use micro-cache (default: 1 second)

    --history               Use history api fallback;
                              All requests fallback to /index.html,
                              unless using "--index" parameter
    --index, -i <file>      History mode (only!) index url path
                              (default: index.html)

    --https                 Enable HTTPS
    --cert, -C [path]       Path to SSL cert file (Optional)
    --key, -K [path]        Path to SSL key file (Optional)
    --proxy <file.js>       Proxy specific requests defined in file;
                            File must export Array ({ path, rule })
                            See example below. "rule" is defined at:
                            https://github.com/chimurai/http-proxy-middleware
    --cors                  Enable CORS for all requests
    --help, -h              Displays this message

  Proxy file example
    module.exports = [
      {
        path: '/api',
        rule: { target: 'http://www.example.org' }
      }
    ]
    --> will be transformed into app.use(path, httpProxyMiddleware(rule))
  `)
  process.exit(0)
}

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

const root = getAbsolutePath(argv._[ 0 ] || '.')
const resolve = p => path.resolve(root, p)

function getAbsolutePath (pathParam) {
  return path.isAbsolute(pathParam)
    ? pathParam
    : path.join(process.cwd(), pathParam)
}

const pkgFile = resolve('package.json')
const indexFile = resolve('index.js')

let ssrDetected = false

if (existsSync(pkgFile) && existsSync(indexFile)) {
  const pkg = JSON.parse(
    readFileSync(pkgFile, 'utf8')
  )

  if (pkg.quasar && pkg.quasar.ssr) {
    console.log('Quasar SSR folder detected.')
    console.log('Yielding control to its own webserver.')
    console.log()
    ssrDetected = true

    import(indexFile)
  }
}

if (ssrDetected === false) {
  if (!argv.colors) {
    process.env.FORCE_COLOR = '0'
  }

  const { default: express } = await import('express')
  const { green, gray, red } = await import('kolorist')

  const resolvedIndex = resolve(argv.index)
  const microCacheSeconds = argv.micro
    ? parseInt(argv.micro, 10)
    : false

  const serve = (path, cache) => {
    const opts = {
      maxAge: cache ? parseInt(argv.cache, 10) * 1000 : 0,
      setHeaders (res, path) {
        if (res.req.method === 'GET' && path === resolvedIndex) {
          res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
          res.set('Pragma', 'no-cache')
          res.set('Expires', '0')
          res.set('Surrogate-Control', 'no-store')
        }
      }
    }

    if (argv.history !== true) {
      opts.index = argv.index
    }

    return express.static(resolve(path), opts)
  }

  const app = express()

  if (argv.cors) {
    const { default: cors } = await import('cors')
    app.use(cors())
  }

  if (!argv.silent) {
    app.get('*', (req, _, next) => {
      console.log(
        `GET ${ green(req.url) } ${ gray('[' + req.ip + ']') } ${ new Date() }`
      )
      next()
    })
  }

  if (argv.gzip) {
    const { default: compression } = await import('compression')
    app.use(compression({ threshold: 0 }))
  }

  const serviceWorkerFile = resolve('service-worker.js')
  if (existsSync(serviceWorkerFile)) {
    app.use('/service-worker.js', serve('service-worker.js'))
  }

  if (argv.proxy) {
    let file = argv.proxy = getAbsolutePath(argv.proxy)
    if (!existsSync(file)) {
      console.error('Proxy definition file not found! ' + file)
      process.exit(1)
    }
    file = await import(file)

    const { createProxyMiddleware } = await import('http-proxy-middleware')

    ;(file.default || file).forEach(entry => {
      app.use(entry.path, createProxyMiddleware(entry.rule))
    })
  }

  if (argv.history) {
    const { default: history } = await import('connect-history-api-fallback')
    app.use(
      history({
        index: argv.index.startsWith('/')
          ? argv.index
          : '/' + argv.index
      })
    )
  }

  app.use('/', serve('.', true))

  if (microCacheSeconds) {
    const { default: microcache } = await import('route-cache')
    app.use(
      microcache.cacheSeconds(
        microCacheSeconds,
        req => req.originalUrl
      )
    )
  }

  app.get('*', (req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.status(404).send('404 | Page Not Found')
    if (!argv.silent) {
      console.log(red(`  404 on ${ req.url }`))
    }
  })

  const getHostname = host => {
    return host === '0.0.0.0'
      ? 'localhost'
      : host
  }

  const server = await getServer(app)
  server.listen(argv.port, argv.hostname, async () => {
    const url = `http${ argv.https ? 's' : '' }://${ getHostname(argv.hostname) }:${ argv.port }`
    const { version } = await import('../version.js')

    const info = [
      [ 'Quasar CLI', `v${ version }` ],
      [ 'Listening at', url ],
      [ 'Web server root', root ],
      argv.https ? [ 'HTTPS', 'enabled' ] : '',
      argv.gzip ? [ 'Gzip', 'enabled' ] : '',
      [ 'Cache (max-age)', argv.cache || 'disabled' ],
      microCacheSeconds ? [ 'Micro-cache', microCacheSeconds + 's' ] : '',
      argv.history ? [ 'History mode', 'enabled' ] : '',
      [ 'Index file', argv.index ],
      argv.cors ? [ 'CORS', 'enabled' ] : '',
      argv.proxy ? [ 'Proxy definitions', argv.proxy ] : ''
    ]
    .filter(msg => msg)
    .map(msg => ' ' + msg[ 0 ].padEnd(20, '.') + ' ' + green(msg[ 1 ]))

    console.log('\n' + info.join('\n') + '\n')

    if (argv.open) {
      const { isMinimalTerminal } = await import('../is-minimal-terminal.js')
      if (!isMinimalTerminal) {
        const { default: open } = await import('open')
        open(url, { url: true })
      }
    }
  })

  const getServer = async app => {
    if (!argv.https) {
      return app
    }

    let fakeCert, key, cert

    if (argv.key && argv.cert) {
      key = getAbsolutePath(argv.key)
      cert = getAbsolutePath(argv.cert)

      if (existsSync(key)) {
        key = readFileSync(key)
      }
      else {
        console.error('SSL key file not found!' + key)
        process.exit(1)
      }

      if (existsSync(cert)) {
        cert = readFileSync(cert)
      }
      else {
        console.error('SSL cert file not found!' + cert)
        process.exit(1)
      }
    }
    else {
      // Use a self-signed certificate if no certificate was configured.
      // Cycle certs every 24 hours
      const certPath = new URL('../../ssl-server.pem', import.meta.url)
      let certExists = existsSync(certPath)

      if (certExists) {
        const certStat = statSync(certPath)
        const certTtl = 1000 * 60 * 60 * 24
        const now = new Date()

        // cert is more than 30 days old
        if ((now - certStat.ctime) / certTtl > 30) {
          console.log(' SSL Certificate is more than 30 days old. Removing.')
          const { removeSync } = await import('fs-extra')
          removeSync(certPath)
          certExists = false
        }
      }

      if (!certExists) {
        console.log(' Generating self signed SSL Certificate...')
        console.log(' DO NOT use this self-signed certificate in production!')

        const selfsigned = await import('selfsigned')
        const pems = selfsigned.generate(
          [ { name: 'commonName', value: 'localhost' } ],
          {
            algorithm: 'sha256',
            days: 30,
            keySize: 2048,
            extensions: [ {
              name: 'basicConstraints',
              cA: true
            }, {
              name: 'keyUsage',
              keyCertSign: true,
              digitalSignature: true,
              nonRepudiation: true,
              keyEncipherment: true,
              dataEncipherment: true
            }, {
              name: 'subjectAltName',
              altNames: [
                {
                  // type 2 is DNS
                  type: 2,
                  value: 'localhost'
                },
                {
                  type: 2,
                  value: 'localhost.localdomain'
                },
                {
                  type: 2,
                  value: 'lvh.me'
                },
                {
                  type: 2,
                  value: '*.lvh.me'
                },
                {
                  type: 2,
                  value: '[::1]'
                },
                {
                  // type 7 is IP
                  type: 7,
                  ip: '127.0.0.1'
                },
                {
                  type: 7,
                  ip: 'fe80::1'
                }
              ]
            } ]
          }
        )

        try {
          writeFileSync(certPath, pems.private + pems.cert, { encoding: 'utf-8' })
        }
        catch (err) {
          console.error(' Cannot write certificate file ' + certPath)
          console.error(' Aborting...')
          process.exit(1)
        }
      }

      fakeCert = readFileSync(certPath)
    }

    const https = await import('node:https')
    return https.createServer({
      key: key || fakeCert,
      cert: cert || fakeCert
    }, app)
  }
}
