var http = require('http');
var fs = require('fs');
var pfile = require('./package.json');

const process = require('process');
const M3U8FileParser = require('m3u8-file-parser');
const content = fs.readFileSync('./test.m3u8', { encoding: 'utf-8'});
const axios = require('axios');

const { Jimp, loadFont } = require('jimp');
const { SANS_64_WHITE } = require('jimp/fonts');

var Ffmpeg = require('fluent-ffmpeg');
Ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');

const crypto = require("crypto");

var template = '';
fs.readFile('static/m3u.txt', 'utf8', (err, data) => {
  if (err) {
    console.error(err);
    return;
  }
  template = data;
});

var streams = {
};
var image;
async function generateImage(thumbnail, msg) { //temp
  image = await Jimp.read('static/fallback-thumbnail.jpg');
  image.blur(20, function (err) { if (err) throw err; });
  image.resize({ w:1920, h:1080});
  const fonta = await loadFont("fonts/a.fnt");
  const fontb = await loadFont("fonts/b.fnt");
  const fontc = await loadFont("fonts/c.fnt");

  image.print({font:fonta, x: 40, y: 40, text: "Wahhh~ Sorry"});
  image.print({font:fontb, x: 40, y: 130, text: "Something went wrong while serving this stream"});
  image.print({font:fontb, x: 40, y: 190, text: "This should be fixed soon, please wait"});
  image.print({font:fontc, x: 40, y:1000, text: "This was automatically generated, do not complain to the content creator!"});
  image.print({font:fontc, x: 40, y:1030, text: "vstream-relay v1.0.0: disconnected from neighbouring relay"});

  const id = crypto.randomBytes(16).toString("hex");

  image.write(`cache/${id}.jpg`);
  console.log(`./cache/${id}.jpg`);
  try {
    Ffmpeg(`./cache/${id}.jpg`)
      .inputOptions([
        '-y',
        '-stream_loop 1',
        '-loop 1',
        '-r 1' //fps
      ]).outputOptions([
        '-ss 00:00:00',
        '-to 00:00:04',
        '-c:v libx264',
        '-pix_fmt yuv420p',
        '-muxdelay 0',
        '-muxpreload 0',
        '-b:v 2M',
        '-maxrate 2M',
        '-bufsize 1M',
        '-f mpegts'
      ])
    .output(`./cache/${id}.ts`).on('end', function() {
      console.log('Finished processing');
      fs.readFile(`./cache/${id}.ts`, function (err, data ) {
        streams.test.chunkCache.push({f: id,b: data });
        streams.test.intervalID = setInterval(addToList, 4000);
        console.log("Chunk pushed");
      });
    }).run();
  } catch (e) {
    console.log(e);
  }
}
//generateImage();
setInterval(CleanUp, 5000);
http.createServer(async function (req, res) {
  const url=req.url.substring(1).trim().split('/');
  if (url.length>1) {
    if (streams.hasOwnProperty(url[0])) {
      const before = Date.now();
      switch(url[1]) {
        case '':
          streams[url[0]].accessed=Math.floor(Date.now()/1000);
          res.writeHead(200, {'Access-Control-Allow-Origin': '*'});
          res.write(GenerateM3U8(streams[url[0]]));
          break;
        case 'loading':
          res.writeHead(200, {'Content-Type': 'video/vnd.dlna.mpeg-tts', 'Access-Control-Allow-Origin': '*'});
          //TODO: change this to load from memory instead!
          var data = fs.readFileSync(`static/loading.ts`);
          res.write(data);
          break;
        default:
          if (url[1].length==32) {
            res.writeHead(200, {'Content-Type': 'video/vnd.dlna.mpeg-tts', 'Access-Control-Allow-Origin': '*'});
            if (streams[url[0]].chunks[streams[url[0]].chunks.length-1].f===url[1]) {
              res.write(streams[url[0]].chunks[streams[url[0]].chunks.length-1].d);
              TrackViewers(url[0], req.headers.hasOwnProperty('X-Forwarded-For') ? req.headers['X-Forwarded-For'] : req.socket.remoteAddress);
            } else {
              var _d=streams[url[0]].chunks.find(({f})=>f===url[1]);
              if(typeof(_d)!=='undefined') {
                res.write(_d.d);
                TrackViewers(url[0], req.headers.hasOwnProperty('X-Forwarded-For') ? req.headers['X-Forwarded-For'] : req.socket.remoteAddress);
              }else res.writeHead(404);
            }
          } else res.writeHead(404);
          break;
      }
      const after = Date.now();
      console.log(`Serving for ${url[0]} took ${after-before}ms`);
    } else {
      const before = Date.now();
      //call endpoint
      console.log(`Querying api for "${url[0]}"`);
      const _res = await axios.get(`https://api.ranrom.net/test/query/${url[0]}/`,{validateStatus:false});
      switch (_res.status) {
        case 200:
          if(_res.data.vstream!=null) {
            streams[url[0]] = {
              stream: _res.data.vstream,
              chunks: [],
              isLoading: false,
              isError: false,
              callback: 0,
              m3u8Reader: new M3U8FileParser(),
              sequence: {
                media: 0,
                discontinuity: 0
              },
              markers: [],
              accessed: (Date.now()*1000),
              viewers: []
            };
            await StreamFetchChunkA(url[0]);
            res.writeHead(200, {'Access-Control-Allow-Origin': '*'});
            res.write(GenerateM3U8(streams[url[0]]));
          } else {
            console.log('Not an active stream');
            res.writeHead(404);
          }
          break;
        default:
          console.log('Query failed');
          res.writeHead(404);
          break;
      }
      const after = Date.now();
      console.log(`Stream setup for ${url[0]} took ${after-before}ms`);
    }
  } else {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.write(JSON.stringify({software: pfile.name,version: pfile.version,author:pfile.author,uptime: Math.floor(process.uptime()) }));
  }
  res.end();
}).listen(8081);

async function StreamFetchChunkA(key) {
  if(!streams.hasOwnProperty(key))return;
  try {
    var stream = streams[key];
    if (!stream.isError) {
      const beforeA = Date.now();
      const res = await axios.get(`${stream.stream}/stream`, { validateStatus:false });
      const durationA = Date.now()-beforeA;
      if (res.status == 200) {
        if (typeof(res.data) === 'string') {
          stream.m3u8Reader.reset();
          stream.m3u8Reader.read(res.data);
          var data = stream.m3u8Reader.getResult();
          if (data.segments.length > 0) {
            const beforeB = Date.now();
            const _res = await axios({method:'get',url:`${stream.stream}/${data.segments[data.segments.length-1].url}`,responseType:'arraybuffer', validateStatus:false});
            const durationB = Date.now()-beforeB;
            if(_res.status == 200) {
              var id = crypto.randomBytes(16).toString("hex");
              stream.chunks.push({f:`${id}`,d: Buffer.from(_res.data), t: (data.segments[data.segments.length-1].inf.duration)}); //res.data
              if(stream.chunks.length>4) stream.chunks.shift();
              if(stream.markers.length>1) {
                if (stream.markers[0].endsWith('#EXT-X-DISCONTINUITY')) stream.sequence.discontinuity++;
                stream.sequence.media++;
                stream.markers.shift();
              }
              if(stream.chunks.length>1) {
                var chunk = stream.chunks[stream.chunks.length-2]; //Get previous chunk
                stream.markers.push(`\n#EXTINF:${chunk.t},\n${chunk.f}`);
                stream.callback = setTimeout(() => StreamFetchChunkA(key),(data.segments[data.segments.length-1].inf.duration*1000)-(durationA+durationB));
              } else {
                stream.markers.push('\n#EXTINF:4.000000,\nloading\n#EXT-X-DISCONTINUITY');
                stream.callback = setTimeout(() => StreamFetchChunkA(key),4000 - (durationA+durationB));
              }
            } else {
              console.log(_res);
            }
          } else {
            stream.markers.push('\n#EXTINF:4.000000,\nloading');
            stream.callback = setTimeout(() => StreamFetchChunkA(key),4000 - durationA);
          }
        } else console.log(`Expected type string, got ${typeof(res.data)}`);
      } else { //Assume the stream is ended
        console.log('b');
      }
    }
  } catch(e) {
    console.log(e);
  }
}

function GenerateM3U8(stream) {
  var str = template;
  str = str.replace('{0}', stream.sequence.media);
  str = str.replace('{1}', stream.sequence.discontinuity);
  stream.markers.forEach((marker) => str += marker);
  return str;
}
function CleanUp() {
  var t = Math.floor(Date.now()/1000);
  var _t = (t - (Math.floor(t / 86400) * 86400));
  Object.keys(streams).forEach((key) => {
    if ((t-streams[key].accessed) >= 20) {
      console.log(`The stream "${key}" hasn't been accessed within 20 seconds, removing from cache list`);
      delete streams[key];
    } else if (Object.keys(streams[key].viewers).length > 0) {
      Object.keys(streams[key].viewers).forEach((v) => {
        if ((_t - streams[key].viewers[v].t) >= 10) delete streams[key].viewers[v];
      });
      console.log(`${key} has ${Object.keys(streams[key].viewers).length} viewers`);
    }
  });
}

function TrackViewers(key, ip) {
  var _t = Math.floor(Date.now() / 1000); //ms to s
  var t = (_t - (Math.floor(_t / 86400) * 86400)); //Only want total hour seconds of day
  if (streams[key].viewers.hasOwnProperty(ip))
    streams[key].viewers[ip].t=t;
  else streams[key].viewers[ip]={t:t};
}
