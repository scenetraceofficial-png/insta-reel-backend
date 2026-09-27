const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const execFileAsync = util.promisify(execFile);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/', (req, res) => {
  res.send('⚡ 24/7 Universal Video & Reel Frame Extractor Backend is Running Online!');
});

// Helper: Securely get random timestamps using ffprobe without shell injection
async function getRandomTimestamps(videoPath, count = 3) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath
      ],
      { timeout: 8000 }
    );

    const duration = parseFloat(String(stdout).trim());
    if (isNaN(duration) || duration < 3) {
      return ['00:00:01', '00:00:02', '00:00:03'];
    }

    const timestamps = [];
    const minDiff = duration / (count + 1);

    for (let i = 0; i < count; i++) {
      const segmentStart = (i * minDiff) + 1;
      let segmentEnd = ((i + 1) * minDiff);
      if (segmentEnd > duration - 1) segmentEnd = duration - 1;

      const randomSec = Math.random() * (segmentEnd - segmentStart) + segmentStart;
      const date = new Date(0);
      date.setSeconds(randomSec);
      const timeString = date.toISOString().substring(11, 19); // HH:MM:SS format
      timestamps.push(timeString);
    }
    return timestamps;
  } catch (e) {
    return ['00:00:01', '00:00:03', '00:00:05']; // Safe fallback
  }
}

// Helper: SnapSave Fast Decoder for Instagram Reels (Safe Without eval)
function decodeSnapApp(args) {
  const [h, _u, n, t, e, _r] = args;
  const tNum = Number(t);
  const eNum = Number(e);

  function decode(d, eVal, fVal) {
    const g = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/'.split('');
    const hArr = g.slice(0, eVal);
    const iArr = g.slice(0, fVal);
    let j = d.split('').reverse().reduce((a, b, c) => {
      const idx = hArr.indexOf(b);
      if (idx !== -1) return a + idx * Math.pow(eVal, c);
      return a;
    }, 0);
    let k = '';
    while (j > 0) {
      k = iArr[j % fVal] + k;
      j = Math.floor(j / fVal);
    }
    return k || '0';
  }

  let res = '';
  for (let i = 0, len = h.length; i < len; i++) {
    let s = '';
    while (h[i] !== n[eNum] && i < len) {
      s += h[i];
      i++;
    }
    for (let j = 0; j < n.length; j++) {
      s = s.replace(new RegExp(n[j], 'g'), j.toString());
    }
    res += String.fromCharCode(Number(decode(s, eNum, 10)) - tNum);
  }
  return decodeURIComponent(escape(res));
}

// 1. Instagram Resolver
async function resolveInstagramFast(shortcode) {
  try {
    // Only allow alphanumeric and standard shortcode characters
    if (!/^[A-Za-z0-9_-]+$/.test(shortcode)) return null;

    const target = `https://www.instagram.com/reel/${shortcode}/`;
    const formData = new URLSearchParams();
    formData.append('url', target);

    const res = await fetch('https://snapsave.app/action.php?lang=en', {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'content-type': 'application/x-www-form-urlencoded',
        'origin': 'https://snapsave.app',
        'referer': 'https://snapsave.app/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      body: formData.toString(),
    });

    if (!res.ok) return null;
    const raw = await res.text();
    const splitKey = 'decodeURIComponent(escape(r))}(';
    if (!raw.includes(splitKey)) return null;

    const part1 = raw.split(splitKey)[1];
    if (!part1) return null;

    const lastParen = part1.lastIndexOf('))');
    if (lastParen === -1) return null;

    const argsString = part1.slice(0, lastParen);
    // Safe extraction of parameters without vulnerable eval()
    const parsedArgs = JSON.parse(`[${argsString}]`);
    if (!Array.isArray(parsedArgs) || parsedArgs.length < 6) return null;

    const decoded = decodeSnapApp(parsedArgs);
    const cleanHtml = decoded.replace(/\\/g, '');

    const rapidMatch = cleanHtml.match(/https:\/\/d\.rapidcdn\.app\/v2\?token=[^"'\s]+/i);
    if (rapidMatch) {
      const fullRapidUrl = rapidMatch[0].replace(/&amp;/g, '&');
      const tokenMatch = fullRapidUrl.match(/token=([a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/);
      if (tokenMatch && tokenMatch[1]) {
        try {
          const payloadJson = Buffer.from(tokenMatch[1].split('.')[1], 'base64').toString('utf8');
          const parsed = JSON.parse(payloadJson);
          if (parsed.url && (parsed.url.includes('.mp4') || parsed.url.includes('cdninstagram.com'))) {
            return parsed.url;
          }
        } catch (err) {}
      }
      return fullRapidUrl;
    }

    const mp4Match = cleanHtml.match(/https:\/\/[^"'\s]+?\.mp4[^"'\s]*/i);
    if (mp4Match) return mp4Match[0];
  } catch (err) {}
  return null;
}

// 2. YouTube ID extractor and fast thumbnail fetcher
function extractYouTubeId(url) {
  const m = url.match(/(?:shorts\/|v=|youtu\.be\/|\/embed\/|\/v\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function getYouTubeFrames(videoId) {
  const frameNames = ['hqdefault.jpg', '1.jpg', '2.jpg', '3.jpg'];
  const frames = [];

  for (const name of frameNames) {
    try {
      const imgRes = await fetch(`https://i.ytimg.com/vi/${videoId}/${name}`);
      if (imgRes.ok) {
        const arrayBuf = await imgRes.arrayBuffer();
        const base64 = Buffer.from(arrayBuf).toString('base64');
        frames.push(`data:image/jpeg;base64,${base64}`);
        if (frames.length >= 3) break;
      }
    } catch (e) {}
  }
  return frames;
}

// 3. TikTok Resolver
async function resolveTikTok(url) {
  try {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const json = await res.json();
    if (json && json.data) {
      return {
        streamUrl: json.data.play || json.data.wmplay || null,
        covers: [json.data.cover, json.data.origin_cover].filter(Boolean)
      };
    }
  } catch (e) {}
  return null;
}

// 4. Snapchat Resolver with strict URL validation (Anti-SSRF)
async function resolveSnapchat(url) {
  try {
    const parsed = new URL(url);
    if (!['www.snapchat.com', 'snapchat.com', 'story.snapchat.com'].includes(parsed.hostname)) {
      return null;
    }

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow'
    });
    const html = await res.text();

    const cuMatches = html.match(/"contentUrl":"([^"]+)"/g);
    if (cuMatches && cuMatches.length > 0) {
      const first = cuMatches[0].replace(/"contentUrl":"|"/g, '');
      return first.replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
    }

    const ogMatch = html.match(/<meta property="og:video(?::url)?" content="([^"]+)"/i);
    if (ogMatch && ogMatch[1]) return ogMatch[1].replace(/&amp;/g, '&');

    const cdnMatch = html.match(/https:\/\/(?:bolt-gcdn|cf-st)\.sc-cdn\.net\/[^\s"'<>\\]+/i);
    if (cdnMatch) return cdnMatch[0].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  } catch (e) {}
  return null;
}

// Safe native stream downloader (Replacing vulnerable curl exec)
async function downloadFile(url, destPath) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download video stream, status: ${response.status}`);
  }

  const fileStream = fs.createWriteStream(destPath);
  await pipeline(Readable.fromWeb(response.body), fileStream);
}

// API Endpoint
app.all('/api/extract-frames', async (req, res) => {
  const rawUrl = req.body?.url || req.query?.url;
  if (!rawUrl) {
    return res.status(400).json({ success: false, error: 'URL parameter missing' });
  }

  let inputUrl = String(rawUrl).trim();

  // Validate valid HTTP/HTTPS URL
  try {
    const urlObj = new URL(inputUrl);
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      return res.status(400).json({ success: false, error: 'Invalid URL protocol' });
    }
  } catch (e) {
    return res.status(400).json({ success: false, error: 'Invalid URL provided' });
  }

  // 1. YouTube Quick Check
  const ytId = extractYouTubeId(inputUrl);
  if (ytId) {
    try {
      const ytFrames = await getYouTubeFrames(ytId);
      if (ytFrames.length > 0) {
        return res.json({
          success: true,
          totalFrames: ytFrames.length,
          frames: ytFrames.sort(() => Math.random() - 0.5)
        });
      }
    } catch (e) {}
  }

  const tmpDir = path.join(os.tmpdir(), `extract_${Date.now()}_${Math.random().toString(36).substring(7)}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  try {
    let videoStreamUrl = null;
    let tikTokData = null;

    // 2. Instagram Check
    if (inputUrl.includes('instagram.com') || inputUrl.includes('instagr.am')) {
      const match = inputUrl.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/);
      if (match) {
        videoStreamUrl = await resolveInstagramFast(match[1]);
      }
    }
    // 3. TikTok Check
    else if (inputUrl.includes('tiktok.com')) {
      tikTokData = await resolveTikTok(inputUrl);
      if (tikTokData && tikTokData.streamUrl) {
        videoStreamUrl = tikTokData.streamUrl;
      }
    }
    // 4. Snapchat Check
    else if (inputUrl.includes('snapchat.com')) {
      videoStreamUrl = await resolveSnapchat(inputUrl);
    }

    const framesBase64 = [];
    const localVideoPath = path.join(tmpDir, 'video.mp4');

    if (videoStreamUrl) {
      // Secure download via Fetch Pipeline (No curl exec injection)
      try {
        await downloadFile(videoStreamUrl, localVideoPath);
      } catch (dlErr) {
        console.warn('Native stream download failed:', dlErr.message);
      }
    }

    // Fallback to yt-dlp if no direct stream URL or download failed
    if (!fs.existsSync(localVideoPath) || fs.statSync(localVideoPath).size === 0) {
      try {
        await execFileAsync(
          'yt-dlp',
          [
            '-f', 'b[ext=mp4]/b',
            '--no-playlist',
            '--socket-timeout', '15',
            '-o', localVideoPath,
            inputUrl // Safe: passed as separate argument, cannot execute shell commands
          ],
          { timeout: 35000 }
        );
      } catch (ytErr) {}
    }

    // Extract Frames securely with ffmpeg (Async & Non-Blocking)
    if (fs.existsSync(localVideoPath) && fs.statSync(localVideoPath).size > 0) {
      const timestamps = await getRandomTimestamps(localVideoPath, 3);

      for (let i = 0; i < timestamps.length; i++) {
        const outPath = path.join(tmpDir, `frame_${i + 1}.jpg`);
        try {
          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-ss', timestamps[i],
              '-i', localVideoPath,
              '-vframes', '1',
              '-q:v', '2',
              outPath
            ],
            { timeout: 6000 }
          );

          if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
            const buf = await fsp.readFile(outPath);
            framesBase64.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
          }
        } catch (e) {}
      }
    }

    // TikTok cover image fallback if video frame extraction failed
    if (framesBase64.length === 0 && tikTokData && tikTokData.covers && tikTokData.covers.length > 0) {
      for (const cov of tikTokData.covers) {
        try {
          const r = await fetch(cov);
          if (r.ok) {
            const buf = await r.arrayBuffer();
            framesBase64.push(`data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`);
          }
        } catch (e) {}
      }
    }

    if (framesBase64.length === 0) {
      return res.status(422).json({ success: false, error: 'Could not extract frames from this video/link.' });
    }

    return res.json({
      success: true,
      totalFrames: framesBase64.length,
      frames: framesBase64
    });

  } catch (err) {
    console.error('Extraction error:', err);
    return res.status(500).json({ success: false, error: 'Failed to process video link' });
  } finally {
    // Guaranteed disk cleanup to prevent disk full errors
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
});

app.listen(PORT, () => {
  console.log(`Universal Frame Extractor Server running securely on port ${PORT}`);
});
