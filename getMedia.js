const http = require('http')
const https = require('https')
const querystring = require('querystring')
const url = require('url')

const backoff = require('@ambassify/backoff-strategies')
const jimp = require('jimp')
const metascraper = require('metascraper')
const NodeCache = require('node-cache')
const pcc = require('parse-cache-control')
const underscore = require('underscore')

const getPublisherFromMedia = (mediaURL, options, callback) => {
  let providers

  if (typeof options === 'function') {
    callback = options
    options = {}
  }

  if (!options.ruleset) options.ruleset = module.exports.ruleset
  if (typeof options.roundtrip !== 'undefined') {
    if (typeof options.roundtrip !== 'function') throw new Error('invalid roundtrip option (must be a function)')
  } else if (options.debugP) options.roundtrip = roundTrip
  else throw new Error('security audit requires options.roundtrip for non-debug use')

  providers = underscore.filter(options.ruleset, (rule) => {
    const schemes = rule.schemes

    if (!schemes.length) return (mediaURL.indexOf(rule.domain) !== -1)

    for (let scheme in schemes) if (mediaURL.match(new RegExp(scheme.replace(/\*/g, '(.*)'), 'i'))) return true
  })

  getPublisherFromProviders(providers, mediaURL, options, null, callback)
}

const getPublisherFromProviders = (providers, mediaURL, options, firstErr, callback) => {
  const provider = underscore.first(providers)
  let parts, resolver

  const done = (err) => {
    setTimeout(() => callback(firstErr || err, null), 0)
  }

  if (!provider) return done()

  resolver = resolvers[provider.provider_name]
  if (!resolver) return done(new Error('no resolver for ' + provider.provider_name))

  parts = url.parse(provider.url + '?' + querystring.stringify({ format: 'json', url: mediaURL }))
  retryTrip({
    server: parts.protocol + '//' + parts.host,
    path: parts.path,
    timeout: options.timeout
  }, options, (err, response, payload) => {
    if (err) return next(providers, mediaURL, options, firstErr || err, callback)

    resolver(providers, mediaURL, options, payload, firstErr, callback)
  })
}

const resolvers = {
  YouTube: (providers, mediaURL, options, payload, firstErr, callback) => {
    const provider = underscore.first(providers)
    const parts = url.parse(payload.author_url)
    const paths = parts.pathname.split('/')

    if (paths.length !== 3) throw new Error('invalid author_url: ' + payload.author_url)

    cachedTrip({
      server: parts.protocol + '//' + parts.host,
      path: parts.path,
      rawP: true,
      timeout: options.timeout
    }, options, (err, response, body) => {
      if (err) return next(providers, mediaURL, options, firstErr || err, callback)

      metascraper.scrapeHtml(body).then((result) => {
        const publisherInfo = {
          publisher: 'youtube#channel:' + paths[2],
          publisherURL: payload.author_url + '/videos',
          faviconName: result.title || payload.author_name,
          faviconURL: result.image || payload.thumbnail_url,
//        publisherName: result.author || payload.title,
          providerName: provider.provider_name
        }

        getFaviconForPublisher(publisherInfo, options, callback)
      }).catch((err) => {
        next(providers, mediaURL, options, firstErr || err, callback)
      })
    })
  }
}

const next = (providers, mediaURL, options, firstErr, callback) => {
  getPublisherFromProviders(underscore.rest(providers), mediaURL, options, firstErr, callback)
}

const getFaviconForPublisher = (publisherInfo, options, callback) => {
  let parts

  if (!publisherInfo.faviconURL) return callback(null, publisherInfo)

  parts = url.parse(publisherInfo.faviconURL)
  cachedTrip({
    server: parts.protocol + '//' + parts.host,
    path: parts.path,
    binaryP: true,
    timeout: options.timeout
  }, options, (err, response, body) => {
    if (err) return callback(err)

    jimp.read(body, (err, image) => {
      const bitmap = image && image.bitmap

      if (err) return callback(err)

      const dataURL = (err, base64) => {
        if (err) return callback(err)

        publisherInfo.faviconURL = base64
        getPropertiesForPublisher(publisherInfo, options, callback)
      }

      if ((bitmap.width <= 32) || (bitmap.height <= 32)) return image.getBase64(jimp.AUTO, dataURL)

      image.resize(32, 32).getBase64(jimp.AUTO, dataURL)
    })
  })
}

const getPropertiesForPublisher = (publisherInfo, options, callback) => {
  const servers = {
    staging: {
      v2: 'https://ledger-staging.mercury.basicattentiontoken.org'
    },
    production: {
      v2: 'https://ledger.mercury.basicattentiontoken.org'
    }
  }

  retryTrip({
    server: servers[options.environment || 'production'][options.version || 'v2'],
    path: '/v3/publisher/identity?' + querystring.stringify({ publisher: publisherInfo.publisher }),
    timeout: options.timeout
  }, options, (err, response, payload) => {
    if (!err) publisherInfo.properties = payload.properties

    callback(null, publisherInfo)
  })
}

const cachedTrip = (params, options, callback, retry) => {
  const cache = module.exports.cache
  const data = cache && cache.get('url:' + params.server + params.path)

  if (data) return setTimeout(() => { callback(null, null, data) }, 0)

  retryTrip(params, options, (err, response, body) => {
    let cacheInfo, ttl

    if ((cache) && (!err)) {
      cacheInfo = pcc(response.headers['cache-control'])
      if (cacheInfo) {
        if (!(cacheInfo.private || cacheInfo['no-cache'] || cacheInfo['no-store'])) ttl = cacheInfo['max-age']
      } else if (response.headers['expires']) ttl = new Date(response.headers['expires']).getTime() - underscore.now()

      cache.set('url:' + params.server + params.path, body, ttl || (60 * 60 * 1000))
    }

    callback(err, response, body)
  })
}

const retryTrip = (params, options, callback, retry) => {
  let method

  const loser = (reason) => { setTimeout(() => { callback(new Error(reason)) }, 0) }
  const rangeP = (n, min, max) => { return ((min <= n) && (n <= max) && (n === parseInt(n, 10))) }

  if (!retry) {
    retry = underscore.defaults(options.backoff || {}, {
      algorithm: 'binaryExponential', delay: 5 * 1000, retries: 3, tries: 0
    })
    if (!rangeP(retry.delay, 1, 30 * 1000)) return loser('invalid backoff delay')
    if (!rangeP(retry.retries, 0, 10)) return loser('invalid backoff retries')
    if (!rangeP(retry.tries, 0, retry.retries - 1)) return loser('invalid backoff tries')
  }
  method = retry.method || backoff[retry.algorithm]
  if (typeof method !== 'function') return loser('invalid backoff algorithm')
  method = method(retry.delay)

  options.roundtrip(params, options, (err, response, payload) => {
    const code = Math.floor(response.statusCode / 100)

    if ((!err) || (code !== 5) || (retry.retries-- < 0)) return callback(err, response, payload)

    return setTimeout(() => { retryTrip(params, options, callback, retry) }, method(++retry.tries))
  })
}

const roundTrip = (params, options, callback) => {
  let request, timeoutP
  const encoding = params.binaryP ? 'binary' : 'utf8'
  const parts = url.parse(params.server)
  const client = parts.protocol === 'https:' ? https : http

  params = underscore.defaults(underscore.extend(underscore.pick(parts, 'protocol', 'hostname', 'port'), params),
                               { method: params.payload ? 'POST' : 'GET' })
  if (params.binaryP) params.rawP = true
  if (options.debugP) console.log('\nparams=' + JSON.stringify(params, null, 2))

  request = client.request(underscore.omit(params, [ 'payload', 'timeout', 'binaryP', 'rawP' ]), (response) => {
    const chunks = []
    let body = ''

    if (timeoutP) return
    response.on('data', (chunk) => {
      if (typeof chunk === 'string') chunk = Buffer.from(chunk, encoding)
      chunks.push(chunk)
    }).on('end', () => {
      let payload

      if (params.timeout) request.setTimeout(0)

      body = Buffer.concat(chunks)
      if (options.verboseP) {
        console.log('>>> HTTP/' + response.httpVersionMajor + '.' + response.httpVersionMinor + ' ' + response.statusCode +
                   ' ' + (response.statusMessage || ''))
        underscore.keys(response.headers).forEach(function (header) {
          console.log('>>> ' + header + ': ' + response.headers[header])
        })
        console.log('>>> ' + (params.rawP ? '...' : body.toString() || '').split('\n').join('\n>>> '))
      }
      if (Math.floor(response.statusCode / 100) !== 2) {
        return callback(new Error('HTTP response ' + response.statusCode), response)
      }

      try {
        payload = params.rawP ? body : (response.statusCode !== 204) ? JSON.parse(body) : null
      } catch (err) {
        return callback(err, response)
      }

      try {
        callback(null, response, payload)
      } catch (err0) {
        if (options.verboseP) console.log('callback: ' + err0.toString() + '\n' + err0.stack)
      }
    }).setEncoding(encoding)
  }).on('error', (err) => {
    callback(err)
  }).on('timeout', () => {
    timeoutP = true
    callback(new Error('timeout'))
  })
  if (params.payload) request.write(JSON.stringify(params.payload))
  request.end()
  if (params.timeout) request.setTimeout(params.timeout)

  if (!options.verboseP) return

  console.log('<<< ' + params.method + ' ' + params.protocol + '//' + params.hostname + (params.path || ''))
  console.log('<<<')
  if (params.payload) console.log('<<< ' + JSON.stringify(params.payload, null, 2).split('\n').join('\n<<< '))
}

module.exports = {
  getPublisherFromMedia: getPublisherFromMedia,
  ruleset: require('./media/providers.json'),
  cache: new NodeCache()
}