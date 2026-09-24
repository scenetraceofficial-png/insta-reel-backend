const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health Check route
app.get('/', (req, res) => {
  res.send('⚡ 24/7 Instagram & Video Frame Extractor Backend is Running Online!');
});

// SnapSave Decoder Helper
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

// 1. Instagram Direct MP4 Resolver
async function resolveInstagramMp4(shortcode) {
  try {
    const target = `https://www.instagram.com/reel/${shortcode}/`;
    const formData = new URLSearchParams();
    formData.append('url', target);

    const resp = await fetch('https://snapsave.app/action.php?lang=en', {
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://snapsave.app/',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const body = await resp.text();
    const snapMatch = body.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\}\(([\s\S]*?)\)\)/);
    if (snapMatch && snapMatch[1]) {
      const argsRaw = snapMatch[1];
      const parsedArgs = JSON.parse(`[${argsRaw}]`);
      const unpacked = decodeSnapApp(parsedArgs);
      const downloadMatches = [...unpacked.matchAll(/href="([^"]+)"/g)];
      for (const m of downloadMatches) {
        if (m[1] && m[1].startsWith('http') && m[1].includes('.mp4')) {
          return m[1];
        }
      }
    }
  } catch (e) {
    console.error('SnapSave Error:', e.message);
  }

  // EEInstagram Fallback
  try {
    const eeRes = await fetch(`https://eeinstagram.com/reel/${shortcode}/`, {
      headers: { 'User-Agent': 'TelegramBot (like TwitterBot)' },
    });
    const html = await eeRes.text();
    const ogMatch = html.match(/<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i);
    if (ogMatch && ogMatch[1] && ogMatch[1].includes('.mp4')) {
      return ogMatch[1];
    }
  } catch (e) {
    console.error('EEInstagram Error:', e.message);
  }
  return null;
}

// 2. MAIN FLUTTER API: Extract 3 Random Frames
app.all('/api/extract-frames', async (req, res) => {
  const rawUrl = req.body?.url || req.query?.url;
  if (!rawUrl) {
    return res.status(400).json({ success: false, error: 'URL parameter missing' });
  }

  const inputUrl = String(rawUrl).trim();
  let videoStreamUrl = inputUrl;

  try {
    // Agar Instagram URL hai toh direct CDN MP4 nikaalo
    if (inputUrl.includes('instagram.com') || inputUrl.includes('instagr.am')) {
      const match = inputUrl.match(/\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/);
      if (!match) {
        return res.status(400).json({ success: false, error: 'Invalid Instagram URL' });
      }
      const shortcode = match[1];
      const direct = await resolveInstagramMp4(shortcode);
      if (!direct) {
        return res.status(404).json({ success: false, error: 'Could not extract direct video stream' });
      }
      videoStreamUrl = direct;
    }

    // Temporary folder for frames
    const tmpDir = path.join(os.tmpdir(), `frames_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // 3 Random/spaced timestamps (2s, 5s, 8s)
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
      } catch (err) {
        console.error(`Frame ${i + 1} capture error:`, err.message);
      }
    }

    // Clean up temp files
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
  console.log(`Server listening on port ${PORT}`);
});
