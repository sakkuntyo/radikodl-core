const PassThrough = require('stream').PassThrough;
const getInfo = require('./info');
const utils = require('./utils');
const formatUtils = require('./format-utils');
const urlUtils = require('./url-utils');
const sig = require('./sig');
const miniget = require('miniget');
const m3u8stream = require('m3u8stream');
const { parseTimestamp } = require('m3u8stream');


/**
 * @param {string} link
 * @param {!Object} options
 * @returns {ReadableStream}
 */
const ytdl = (link, options) => {
  const stream = createStream(options);
  downloadFromInfoCallback(stream, options);
  return stream;
};
module.exports = ytdl;

ytdl.version = require('../package.json').version;


const createStream = options => {
  const stream = new PassThrough({
    highWaterMark: (options && options.highWaterMark) || 1024 * 512,
  });
  stream._destroy = () => { stream.destroyed = true; };
  return stream;
};


const pipeAndSetEvents = (req, stream, end) => {
  // Forward events from the request to the stream.
  [
    'abort', 'request', 'response', 'error', 'redirect', 'retry', 'reconnect',
  ].forEach(event => {
    req.prependListener(event, stream.emit.bind(stream, event));
  });
  req.pipe(stream, { end });
};


/**
 * Chooses a format to download.
 *
 * @param {stream.Readable} stream
 * @param {Object} info
 * @param {Object} options
 */
//const downloadFromInfoCallback = (stream, info, options) => {
const downloadFromInfoCallback = (stream, options) => {
  options = options || {};

  let format = {
    "mimeType": "video/ts; codecs=\"H.264, aac\"",
    "qualityLabel": "1080p",
    "bitrate": 2500000,
    "audioBitrate": 256,
    "itag": 96,
    "url": "",
    "hasVideo": true,
    "hasAudio": true,
    "container": "ts",
    "codecs": "H.264, aac",
    "videoCodec": "H.264",
    "audioCodec": "aac",
    "isLive": true,
    "isHLS": true,
    "isDashMPD": false
  }

  let contentLength, downloaded = 0;
  const ondata = chunk => {
    downloaded += chunk.length;
    stream.emit('progress', chunk.length, downloaded, contentLength);
  };

  // Download the file in chunks, in this case the default is 10MB,
  // anything over this will cause youtube to throttle the download
  const dlChunkSize = options.dlChunkSize || 1024 * 1024 * 10;
  let req;
  let shouldEnd = true;
  
  options["requestOptions"] = {};
  options.requestOptions["headers"] = {};
  options.requestOptions.headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.101 Safari/537.36";
  options.requestOptions.headers["X-Radiko-Authtoken"] = "73qZyNI3Gg0WMyuLIQDujg";
  if (format.isHLS || format.isDashMPD) {
    req = m3u8stream("http://f-radiko.smartstream.ne.jp/TBS/_definst_/simul-stream.stream/chunklist_w1173022192.m3u8", {
      requestOptions: options.requestOptions
    });

    req.on('progress', (segment, totalSegments) => {
      stream.emit('progress', segment.size, segment.num, totalSegments);
    });
    pipeAndSetEvents(req, stream, shouldEnd);
  } else {
    console.log("reconn? retry?")
    const requestOptions = Object.assign({}, options.requestOptions, {
      maxReconnects: 10,
      maxRetries: 5,
      backoff: { inc: 500, max: 10000 },
    });

    let shouldBeChunked = dlChunkSize !== 0 && (!format.hasAudio || !format.hasVideo);

    if (shouldBeChunked) {
      console.log("shouldBeChunked")
      let start = (options.range && options.range.start) || 0;
      let end = start + dlChunkSize;
      const rangeEnd = options.range && options.range.end;

      contentLength = options.range ?
        (rangeEnd ? rangeEnd + 1 : parseInt(format.contentLength)) - start :
        parseInt(format.contentLength);

      const getNextChunk = () => {
        console.log("getNextChunk")
        if (!rangeEnd && end >= contentLength) end = 0;
        if (rangeEnd && end > rangeEnd) end = rangeEnd;
        shouldEnd = !end || end === rangeEnd;

        requestOptions.headers = Object.assign({}, requestOptions.headers, {
          Range: `bytes=${start}-${end || ''}`,
        });

        req = miniget("http://f-radiko.smartstream.ne.jp/TBS/_definst_/simul-stream.stream/chunklist_w1173022192.m3u8/", requestOptions);
        req.on('data', ondata);
        req.on('end', () => {
          console.log("getNextChunk req end")
          if (stream.destroyed) { return; }
          if (end && end !== rangeEnd) {
            start = end + 1;
            end += dlChunkSize;
            getNextChunk();
          }
        });
        pipeAndSetEvents(req, stream, shouldEnd);
      };
      getNextChunk();
    } else {
      console.log("Audio only and video only formats don't support begin")
      // Audio only and video only formats don't support begin
      if (options.begin) {
        format.url = "http://f-radiko.smartstream.ne.jp/TBS/_definst_/simul-stream.stream/chunklist_w1173022192.m3u8" + `&begin=${parseTimestamp(options.begin)}`;
      }
      if (options.range && (options.range.start || options.range.end)) {
        requestOptions.headers = Object.assign({}, requestOptions.headers, {
          Range: `bytes=${options.range.start || '0'}-${options.range.end || ''}`,
        });
      }
      req = miniget("http://f-radiko.smartstream.ne.jp/TBS/_definst_/simul-stream.stream/chunklist_w1173022192.m3u8", requestOptions);
      req.on('response', res => {
        if (stream.destroyed) { return; }
        contentLength = contentLength || parseInt(res.headers['content-length']);
      });
      req.on('data', ondata);
      pipeAndSetEvents(req, stream, shouldEnd);
    }
  }

  stream._destroy = () => {
    stream.destroyed = true;
    req.destroy();
    req.end();
  };
};


/**
 * Can be used to download video after its `info` is gotten through
 * `ytdl.getInfo()`. In case the user might want to look at the
 * `info` object before deciding to download.
 *
 * @param {Object} info
 * @param {!Object} options
 * @returns {ReadableStream}
 */
//ytdl.downloadFromInfo = (options) => {
//  const stream = createStream(options);
//  /*
//  if (!info.full) {
//    throw Error('Cannot use `ytdl.downloadFromInfo()` when called ' +
//      'with info from `ytdl.getBasicInfo()`');
//  }
//  */
//  setImmediate(() => {
//    downloadFromInfoCallback(stream, options);
//  });
//  return stream;
//};
