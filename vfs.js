/** Experimental virtual file system thing
 * it doesn't really work with the sync FS api
 * untested
 */
const MAX_FILE_SIZE = 1024 * 1024 * 10 // 10MB

class CachedFile {
  constructor (cache, path, { maxFileSize = MAX_FILE_SIZE }) {
    this.cache = cache
    // TODO auto-allocate new buffer when it fills
    this.buffer = []
    this.position = 0
    this.path = path
    // lock here? only for writing; should probably split readable and writable for that
  }

  close () {}
}

class Readable extends CachedFile {
  read (size, cb) {
    const r = this.buffer.slice(this.position, this.position + size)
    this.position += size
    return cb(r)
  }
}

class Writable extends CachedFile {
  write (chunk, encoding, cb) {
    this.buffer = [...this.buffer, ...chunk]
    this.position += chunk.length
  }

  end () {
    // push to cache
    // unlock
  }
}

class LockAndCacheVfs {
  constructor ({ cache, maxFileSize = MAX_FILE_SIZE }) {
    this.cache = cache
    this.maxFileSize = maxFileSize
  }

  existsSync (path) {
    // cache has key?
    // or just preload value
    return this.cache.keys(path)
  }

  mkdirSync (path) { return true }

  writeFileSync (path, data) {
    const f = new Writable(this.cache, path)
    f.write(data)
    f.end()
  }

  createWriteStream (path) {
    return new Readable(this.cache, path)
  }

  createReadStream (path) {}

  readFileSync (path, encoding) {}

  readFile (path, encoding, cb) {}
}

module.exports = LockAndCacheVfs
