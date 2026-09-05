# Ghostery Url Parser

A Fast implementation of url parsing, mostly API-compatible with the standard URL class while
being on average 2-3 times faster. Evaluation of URL components is lazy, so this implementation
should be fast for all read use-cases.

Known differences to standard URL:
 * Parameters returned via `URL.searchParams.entries()` are decoded only with
   `decodeURIComponent`. This differs to standards parsing in some subtle ways.
 * You can iterate a URL parameters array directly via `URL.searchParams.params`. This is around
   20% faster than using an iterator.
 * Parameter strings (`;` sepearated key/value pairs) are parsed, and accessible via `URL.parameters`.
 * Domain parsing with [tldts](https://github.com/remusao/tldts) is built in. The `URL.domainInfo` attribute returns output from tldts'
   `parseHost` method.
 * Hostname validation is not done on initial parse. The `isValidHost()` method is provided for
   this purpose.
 * All URLs with a valid authority are given an `origin`, regardless of the protocol scheme. This differs from the [standard](https://url.spec.whatwg.org/#origin) that only does so for a set of known schemes.

## Install

```bash
npm install @ghostery/url-parser
```

## Usage

```javascript
const parsed = new URL('https://www.example.com');
parsed.hostname // == 'www.example.com'
```

## Performance

We benchmark against a list of 250,000 URLs collected from popular sites, as previously used in our
[adblocker benchmark](https://whotracks.me/blog/adblockers_performance_study.html). We compare
two use-cases:
 1. `URL` object creation: `new URL(url)`
 2. Query string parsing: `new URL(url).searchParams.entries()`

We compare to a reference implementation on each platform:
 * Node: `URL` class from the `url` library
 * Firefox: `window.URL`
 * Chrome: `window.URL`
 * Safari: `window.URL`

| Environment | Use case | Reference: urls/s | Ghostery parser: urls/s | Speedup |
| --- | --- | --: | --: | --- |
| Node 11 | `new URL()` | `149,514` | `1,577,711` | _10.5x faster_
| Node 11 | `searchParams` | `140,544` | `198,340` | _1.4x faster_
| Firefox 69 | `new URL()` | `268,066` | `1,043,877` | _3.9x faster_
| Firefox 69 | `searchParams` | `119,207` | `354,793` | _3.0x faster_
| Chrome 75 | `new URL()` | `366,294` | `1,721,903` | _4.7x faster_
| Chrome 75 | `searchParams` | `144,309` | `283,956` | _2.0x faster_
| Safari 12 |  `new URL()` | `656,930` | `1,525,078` | _2.3x faster_
| Safari 12 | `searchParams` | `264,481` | `437,738` | _1.7x faster_

All benchmarks were run on a Mid 2015 Macbook Pro, 2.5 GHz Intel Core i7, 16GB.

## License

[Mozilla Public License 2.0](./LICENSE)
