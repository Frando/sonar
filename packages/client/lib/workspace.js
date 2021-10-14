const randombytes = require('randombytes')
const EventSource = require('eventsource')
const { EventEmitter } = require('events')

const sonarFetch = require('./fetch')
const Collection = require('./collection')
const Bots = require('./bots')

const Logger = require('@arsonar/common/log')

const {
  DEFAULT_ENDPOINT,
  DEFAULT_WORKSPACE
} = require('./constants')

function defaultWorkspace () {
  return (process && process.env && process.env.WORKSPACE) || DEFAULT_WORKSPACE
}

class Workspace extends EventEmitter {
  /**
   * A Sonar workspace. Provides methods to open collection under this endpoint.
   *
   * @constructor
   * @param {object} [opts] - Optional options.
   * @param {string} [opts.url=http://localhost:9191/api/v1/default] - The API endpoint to talk to.
   * @param {string} [opts.accessCode] - An access code to login at the endpoint.
   * @param {string} [opts.token] - A JSON web token to authorize to the endpoint.
   * @param {string} [opts.name] - The name of this client.
   */
  constructor (opts = {}) {
    super()
    if (opts.endpoint) {
      const workspace = opts.workspace || defaultWorkspace()
      const endpoint = opts.endpoint || DEFAULT_ENDPOINT
      this.endpoint = `${endpoint}/${workspace}`
    } else if (opts.url) {
      this.endpoint = opts.url
      // TODO: deprecate, ue only URL.
    } else {
      this.endpoint = DEFAULT_ENDPOINT
    }
    if (this.endpoint.endsWith('/')) {
      this.endpoint = this.endpoint.substring(0, this.endpoint.length - 1)
    }

    this._collections = new Map()
    this._id = opts.id || randombytes(16).toString('hex')
    this._token = opts.token
    this._accessCode = opts.accessCode
    this._eventSources = []

    this.log = opts.log || new Logger()
    this.bots = new Bots(this)
  }

  /**
   * Closes the client.
   *
   * @async
   * @return {Promise<void>}
   */
  async close () {
    for (const eventSource of this._eventSources) {
      eventSource.close()
    }
    for (const collection of this._collections.values()) {
      collection.close()
    }
  }

  async open () {
    if (this.opened) return
    if (!this._openPromise) this._openPromise = this._open()
    await this._openPromise
  }

  async _open () {
    await this._login()
    this.opened = true
  }

  // TODO: Support re-logins
  async _login () {
    if (this._accessCode && !this._token) {
      const res = await this.fetch('/login', { params: { code: this._accessCode }, method: 'POST', opening: true })
      const token = res.token
      this._token = token
    }
  }

  /**
   * Get a list of all collections available on this endpoint.
   *
   * @async
   * @return {Promise.<object[]>} Promise that resolves to an array of collection info objects.
   */
  async listCollections () {
    const info = await this.fetch('/')
    return info.collections
  }

  /**
   * Creates a collection with name name on the Sonar server. The name may not contain whitespaces. opts is an optional object with:
   *
   * @async
   * @param {string} name - Name of the new collection, may not contain whitespaces.
   * @param {object} [opts] - Optional options object.
   * @param {string} [opts.key] - Hex string of an existing collection. Will then sync this collection instead of creating a new, empty collection.
   * @param {string} [opts.alias] - When setting key, alias is required and is your nick name within this collection.
   * @return {Promise<Collection>} The created collection.
   */
  async createCollection (name, opts = {}) {
    opts.name = name
    await this.fetch('/collection', {
      method: 'POST',
      body: opts
    })
    const collection = await this.openCollection(name, { reset: true })
    return collection
  }

  // TODO: Move to Collection.update()?
  // TODO: info == config?
  /**
   * Updates the config of a collection.
   *
   * @async
   * @param {string} name - Name of the collection.
   * @param {object} info - [TODO:description]
   * @param {boolean} info.share - Controls whether a collection is shared via p2p.
   * @return {Promise<void>}
   */
  async updateCollection (name, info) {
    return this.fetch('/collection/' + name, {
      method: 'PATCH',
      body: info
    })
  }

  /**
   * Returns a Collection object for a given key or name of a collection.
   *
   * @async
   * @param {string} keyOrName - Key or name of the collection to open/return.
   * @return {Promise<Collection>}
   */
  async openCollection (keyOrName, opts = {}) {
    if (this._collections.has(keyOrName)) {
      const collection = this._collections.get(keyOrName)
      if (!collection.opened) await collection.open(opts.reset)
      return collection
    }

    const collection = new Collection(this, keyOrName)
    collection.on('open', () => this.emit('collection-open', collection))
    this._collections.set(keyOrName, collection)
    // This will throw if the collection does not exist.
    try {
      await collection.open(opts.reset)
      this._collections.set(collection.name, collection)
      this._collections.set(collection.key, collection)
      return collection
    } catch (err) {
      this._collections.delete(keyOrName)
      throw err
    }
  }

  getCollection (keyOrName) {
    return this._collections.get(keyOrName)
  }

  getAuthHeaders (opts = {}) {
    const headers = {}
    const token = this._token || opts.token
    if (token) {
      headers.authorization = 'Bearer ' + token
    }
    return headers
  }

  getHeaders (opts = {}) {
    return this.getAuthHeaders()
  }

  /**
   * Fetch a resource.
   *
   * This is a wrapper around the fetch web API. It should be API compatible to fetch,
   * with the following changes:
   *
   * @async
   * @param {string} [opts.requestType='json'] Request encoding and content type.
   *   Supported values are 'json' and 'binary'
   * @param {string} [opts.responseType='text'] Response encoding. If the response
   *    has a JSON content type, will always be set to 'json'.
   *    Supported values are 'text', 'binary' and 'stream'.
   * @param {object} [opts.params] Query string parameters (will be encoded correctly).
   *
   * @return {Promise<object>} If the response has a JSON content type header, the
   *    decoded JSON will be returned. if opts.responseType is 'binary' or 'text',
   *    the response will be returned as a buffer or text.
   *
   * TODO: Rethink the default responseType cascade.
   */
  async fetch (url, opts = {}) {
    if (!this.opened && !opts.opening) {
      await this.open()
    }
    if (!opts.endpoint && this.endpoint) {
      opts.endpoint = this.endpoint
    }
    if (!opts.headers) opts.headers = {}
    opts.headers = {
      ...opts.headers,
      ...this.getAuthHeaders(opts)
    }
    opts.log = message => this.log.debug({ message, name: 'fetch' })
    return sonarFetch(url, opts)
  }

  createEventSource (path, opts = {}) {
    if (!opts.endpoint && this.endpoint) opts.endpoint = this.endpoint
    opts.headers = Object.assign(opts.headers || {}, this.getHeaders(opts))
    let url = (opts.endpoint || '') + path
    url = new URL(url)
    if (this._token || opts.token) {
      url.searchParams.set('token', this._token || opts.token)
    }
    const eventSource = new EventSource(url.toString(), opts)
    eventSource.addEventListener('message', message => {
      try {
        const event = JSON.parse(message.data)
        if (opts.onmessage) opts.onmessage(event)
      } catch (e) {}
    })
    eventSource.addEventListener('error', err => {
      // TODO: Where do these errors go?
      // TODO: After a couple of fails die.
      if (opts.onerror) opts.onerror(err)
      else console.error('Event source error', err)
    })
    this._eventSources.push(eventSource)
    return eventSource
  }
}

module.exports = Workspace
