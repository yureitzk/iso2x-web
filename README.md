# <img src="./img/logo.png" height="26" alt="Logo"> iso2x-web

A browser-based tool for converting Xbox ISO images into multiple formats,
including
[Games on Demand (GOD)](https://en.wikipedia.org/wiki/Xbox_Games_Store#Games_on_Demand),
[extracted (XeX)](https://free60.org/System-Software/Formats/XEX/),
[ZArchive (ZAR)](https://github.com/Exzap/ZArchive),
[Cerbios Compressed Image (CCI)](https://github.com/Team-Resurgent/Repackinator),
[Compressed ISO (CISO) and XISO](https://consolemods.org/wiki/Xbox:Playing_Game_Backups)
formats powered by [iso2x](https://github.com/yureitzk/iso2x).

Mostly an experiment to see if streams can work for something more serious, and
the results got mixed - see [Limitations](#limitations) to read more on that.

Live version - https://yureitzk.github.io/iso2x-web/

## Features

- convert multiple ISO images simultaneously, with per-item and bulk actions
- multiple output formats: GoD, XISO, CISO, CCI, ZAR and extracted (XEX)
- convert multiple ISO images simultaneously
- [notifications](https://developer.mozilla.org/en-US/docs/Web/API/Notification)
  when a conversion finishes
- [wake lock](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/wakeLock)
  lock keeps your display on during long conversions
- installable as a PWA for offline use

## Limitations

Currently, the tool only supports a streaming-based approach. While this
provides better browser compatibility, it may not be the most effective solution
in all cases. There are also browser-level limitations that prevent the tool
from being usable in a number of environments.

A better approach would likely be to add a second backend based on the
[File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access),
especially now that it is also
[supported by mobile browsers](https://github.com/cs-util-com/FileSystemAccessOnAndroid)
such as Chrome. This would provide an alternative to the streaming-based
approach and could help address some of the limitations described above.

Relevant links:

- https://bugzilla.mozilla.org/show_bug.cgi?id=1976880
- https://stackoverflow.com/questions/54410645/streaming-a-large-file-client-side-with-javascript
- https://github.com/K1rakishou/Fuck-Storage-Access-Framework
- https://github.com/jimmywarting/StreamSaver.js/discussions/228
- https://issues.chromium.org/issues/40589165
- https://github.com/w3c/ServiceWorker/issues/1398
- https://chromium.googlesource.com/chromium/src/+/0ed3759febd90b426ff631435548b2515a073d53/chrome/browser/download/download_request_limiter.h
- https://chromium.googlesource.com/chromium/src/+/0ed3759febd90b426ff631435548b2515a073d53/base/allocator/partition_allocator/PartitionAlloc.md

## Requirements

Running and building requires `npm` and `Node.js`.

## Building

```sh
npm install
npm run build
# If you want to run a debug version
npm run dev
```

### `.env`

```conf
BASE_PATH="/"
PORT=5173
```

- `BASE_PATH` - the path where the app is served from
- `PORT` - the port the dev server listens on

### Docker

A `Dockerfile` and `docker/nginx.conf.template` are included for running the
built app behind Nginx.

`BASE_PATH` is baked into the app at **build time** (it's compiled into the
asset URLs by Vite), so it must be set via `--build-arg`. `PORT` is resolved at
**container start**, so it can be changed freely without rebuilding the image.

```sh
export $(grep -v '^#' .env | xargs)

# Build (BASE_PATH is fixed into this image)
docker build --build-arg BASE_PATH="$BASE_PATH" -t iso2x-web .

# Run (PORT can be anything, any time, without rebuilding)
docker run -e PORT="$PORT" -p "$PORT:$PORT" iso2x-web
```

To build a version for self-hosting at the site root, override `BASE_PATH` at
build time:

```sh
docker build --build-arg BASE_PATH="/" -t iso2x-web:root .
```

## TODO

- better STFS support
- [File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
  backend, for browsers that support it

## Resources

- File streaming was inspired by
  [StreamSaver.js](https://github.com/jimmywarting/StreamSaver.js)
- The COEP workaround needed for the
  [hidden-iframe download trick](https://lists.whatwg.org/pipermail/whatwg-whatwg.org/2013-February/081219.html)
  is adapted from
  [coi-serviceworker](https://github.com/kairi003/coi-serviceworker/)

## License

[MIT](./LICENSE)
