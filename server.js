const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send('⚡ 24/7 Universal Video & Reel Frame Extractor Backend is Running Online!');
});

// SnapSave Fast Decoder for Instagram Reels
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
    while (h[i] !== n[eNum]) {
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

async function resolveInstagramFast(shortcode) {
  try {
    const target = 'https://www.instagram.com/reel/' + shortcode + '/';
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
    const part1 = raw.split('decodeURIComponent(escape(r))}(')[1];
    if (!part1) return null;
    const lastParen = part1.lastIndexOf('))');
    if (lastParen === -1) return null;
    const args = eval('[' + part1.slice(0, lastParen) + ']');
    if (!args || args.length < 6) return null;
    const decoded = decodeSnapApp(args);
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

// 1. YouTube Frame Extractor
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

// 2. TikTok Direct Resolver (Tikwm)
async function resolveTikTok(url) {
  try {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    const json = await res.json();
    if (json && json.data && json.data.play) {
      return json.data.play;
    }
  } catch (e) {}
  return null;
}

// 3. Snapchat Spotlight / Stories Resolver
async function resolveSnapchat(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow'
    });
    const html = await res.text();
    // Check og:video
    const ogMatch = html.match(/<meta property="og:video(?::url)?" content="([^"]+)"/i);
    if (ogMatch && ogMatch[1]) return ogMatch[1];

    // Check media urls in Next.js page state
    const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
    if (nextMatch) {
      const mp4Match = nextMatch[1].match(/https:\/\/[^"'\s]+\.mp4[^"'\s]*/i);
      if (mp4Match) return mp4Match[0];
      const cdnMatch = nextMatch[1].match(/https:\/\/cf-st\.sc-cdn\.net\/d\/[^"'\s\\]+/i);
      if (cdnMatch) return cdnMatch[0].replace(/\\u0026/g, '&');
    }
  } catch (e) {}
  return null;
}

app.all('/api/extract-frames', async (req, res) => {
  const rawUrl = req.body?.url || req.query?.url;
  if (!rawUrl) {
    return res.status(400).json({ success: false, error: 'URL parameter missing' });
  }

  const inputUrl = String(rawUrl).trim();

  // 1. YouTube Shorts & Videos Check
  const ytId = extractYouTubeId(inputUrl);
  if (ytId) {
    try {
      const ytFrames = await getYouTubeFrames(ytId);
      if (ytFrames.length > 0) {
        return res.json({
          success: true,
          totalFrames: ytFrames.length,
          frames: ytFrames
        });
      }
    } catch (e) {}
  }

  const tmpDir = path.join(os.tmpdir(), `extract_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const localVideoPath = path.join(tmpDir, 'video.mp4');

  try {
    let videoStreamUrl = null;

    // 2. Instagram Check
    if (inputUrl.includes('instagram.com') || inputUrl.includes('instagr.am')) {
      const match = inputUrl.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/);
      if (match) {
        videoStreamUrl = await resolveInstagramFast(match[1]);
      }
    }
    // 3. TikTok Check
    else if (inputUrl.includes('tiktok.com')) {
      videoStreamUrl = await resolveTikTok(inputUrl);
    }
    // 4. Snapchat Check
    else if (inputUrl.includes('snapchat.com')) {
      videoStreamUrl = await resolveSnapchat(inputUrl);
    }

    // 5. Download media to local temp storage
    if (videoStreamUrl) {
      execSync(`curl -s -L -A "Mozilla/5.0" "${videoStreamUrl}" -o "${localVideoPath}"`, { timeout: 25000 });
    } else {
      // Facebook & generic media
      const ytdlpCmd = `yt-dlp -f "b[ext=mp4]/b" --no-playlist --socket-timeout 10 -o "${localVideoPath}" "${inputUrl}"`;
      execSync(ytdlpCmd, { timeout: 30000, stdio: 'ignore' });
    }

    if (!fs.existsSync(localVideoPath) || fs.statSync(localVideoPath).size === 0) {
      throw new Error('Could not download video file from URL');
    }

    // 6. Extract 3 frames via FFmpeg
    const timestamps = ['00:00:01', '00:00:03', '00:00:05'];
    const framesBase64 = [];

    for (let i = 0; i < timestamps.length; i++) {
      const outPath = path.join(tmpDir, `frame_${i + 1}.jpg`);
      try {
        execSync(`ffmpeg -y -ss ${timestamps[i]} -i "${localVideoPath}" -vframes 1 -q:v 2 "${outPath}"`, {
          timeout: 5000,
          stdio: 'ignore'
        });
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
          const buf = fs.readFileSync(outPath);
          framesBase64.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
        }
      } catch (err) {}
    }

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

    if (framesBase64.length === 0) {
      return res.status(500).json({ success: false, error: 'Failed to extract frames from video' });
    }

    return res.json({
      success: true,
      totalFrames: framesBase64.length,
      frames: framesBase64
    });

  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    return res.status(500).json({ success: false, error: err.message || 'Processing error' });
  }
});

app.listen(PORT, () => {
  console.log(`Universal Server listening on port ${PORT}`);
});
