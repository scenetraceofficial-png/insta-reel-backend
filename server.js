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

// SnapSave Decoder for Ultra-Fast Instagram Reels
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

// Universal Resolver (YouTube, TikTok, Facebook, Twitter, Reddit, etc.)
function resolveViaYtDlp(url) {
  try {
    const cmd = `yt-dlp -f "best[ext=mp4]/best" --get-url --no-warnings --no-playlist --socket-timeout 10 "${url}"`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 15000 }).trim();
    if (output && output.startsWith('http')) {
      return output.split('\n')[0].trim();
    }
  } catch (e) {
    console.error('yt-dlp resolve failed:', e.message);
  }
  return null;
}

app.all('/api/extract-frames', async (req, res) => {
  const rawUrl = req.body?.url || req.query?.url;
  if (!rawUrl) {
    return res.status(400).json({ success: false, error: 'URL parameter missing' });
  }

  const inputUrl = String(rawUrl).trim();
  let videoStreamUrl = null;

  try {
    // 1. Agar Instagram Reel / Post hai toh fast SnapSave decoder use karein
    if (inputUrl.includes('instagram.com') || inputUrl.includes('instagr.am')) {
      const match = inputUrl.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/);
      if (match) {
        videoStreamUrl = await resolveInstagramFast(match[1]);
      }
    }

    // 2. Agar Instagram fast decoder se nahi mila, ya YouTube, Facebook, TikTok, Twitter etc. hai
    if (!videoStreamUrl) {
      videoStreamUrl = resolveViaYtDlp(inputUrl);
    }

    // 3. Agar direct mp4 link hai
    if (!videoStreamUrl && (inputUrl.startsWith('http://') || inputUrl.startsWith('https://'))) {
      videoStreamUrl = inputUrl;
    }

    if (!videoStreamUrl) {
      return res.status(404).json({ success: false, error: 'Could not extract direct video stream from this link' });
    }

    // 4. Extract 3 frames using FFmpeg
    const tmpDir = path.join(os.tmpdir(), `frames_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const timestamps = ['00:00:02', '00:00:05', '00:00:08'];
    const framesBase64 = [];

    for (let i = 0; i < timestamps.length; i++) {
      const outPath = path.join(tmpDir, `frame_${i + 1}.jpg`);
      try {
        execSync(`ffmpeg -y -ss ${timestamps[i]} -i "${videoStreamUrl}" -vframes 1 -q:v 2 "${outPath}"`, {
          timeout: 10000,
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
      return res.status(500).json({ success: false, error: 'Frames extraction failed' });
    }

    return res.json({
      success: true,
      totalFrames: framesBase64.length,
      frames: framesBase64
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Universal Server listening on port ${PORT}`);
});
