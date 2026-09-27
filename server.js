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

// Prevent browser/proxy caching.
// Important because every request should generate fresh random frames.
app.use((req, res, next) => {
  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.get('/', (req, res) => {
  res.send(
    '⚡ 24/7 Universal Video & Reel Frame Extractor Backend is Running Online!'
  );
});

/* ============================================================
   RANDOM FRAME MEMORY
   ============================================================

   We remember recently selected timestamps for each URL.

   Example:

   Request 1:
   4.2s, 9.8s, 20.1s

   Request 2:
   6.4s, 11.7s, 18.9s

   Request 3:
   Different timestamps again.

   Memory is intentionally in RAM.
   It resets when the server restarts.
============================================================ */

const recentFrameSelections = new Map();

// Number of old timestamps remembered per video.
const MAX_HISTORY_PER_VIDEO = 12;

// Don't reuse a timestamp if it is within this distance
// from a recently used timestamp.
const MIN_REPEAT_DISTANCE_SECONDS = 1.0;


/* ============================================================
   URL KEY
============================================================ */

function getVideoKey(url) {
  try {
    const u = new URL(url);

    // Remove fragment because #something should not create
    // a completely different video key.
    u.hash = '';

    return u.toString();
  } catch {
    return String(url).trim();
  }
}


/* ============================================================
   REMEMBER USED TIMESTAMPS
============================================================ */

function rememberFrameTimes(videoKey, times) {
  const oldTimes = recentFrameSelections.get(videoKey) || [];

  const newTimes = times
    .map(Number)
    .filter(Number.isFinite);

  const merged = oldTimes.concat(newTimes);

  recentFrameSelections.set(
    videoKey,
    merged.slice(-MAX_HISTORY_PER_VIDEO)
  );
}


/* ============================================================
   CHECK DISTANCE
============================================================ */

function isTooClose(value, values, minDistance) {
  return values.some((v) => {
    return Math.abs(value - v) < minDistance;
  });
}


/* ============================================================
   RANDOM TIMESTAMP GENERATOR
============================================================ */

function chooseRandomTimestamps(
  duration,
  count = 3,
  videoKey = ''
) {
  let d = Number(duration);

  // If duration cannot be detected,
  // assume a 30-second video temporarily.
  if (!Number.isFinite(d) || d <= 0) {
    d = 30;
  }

  /*
     Avoid exact first/last frame.

     Example:
     30 sec video

     Start ≈ 0.5 sec
     End   ≈ 29.5 sec
  */

  const start = Math.min(
    0.5,
    Math.max(0, d * 0.05)
  );

  const end = Math.max(
    start,
    d - Math.min(0.5, d * 0.05)
  );

  const previous =
    recentFrameSelections.get(videoKey) || [];

  const selected = [];

  /*
     Keep frames reasonably separated.

     For a long video:
     around 3 sec minimum distance.

     For short videos:
     automatically reduce the distance.
  */

  const minGap = Math.min(
    3.0,
    Math.max(0.35, d / 7)
  );

  /*
     Try up to 500 random candidates.
  */

  for (
    let attempt = 0;
    attempt < 500 && selected.length < count;
    attempt++
  ) {
    const range = Math.max(
      0,
      end - start
    );

    const candidate =
      start + Math.random() * range;

    // Don't select two almost identical frames
    // in the same request.
    if (
      d >= 2 &&
      isTooClose(
        candidate,
        selected,
        minGap
      )
    ) {
      continue;
    }

    /*
       Avoid timestamps used in previous requests.

       Only apply strong history filtering to
       normal-length videos.
    */

    if (
      d >= 6 &&
      isTooClose(
        candidate,
        previous,
        MIN_REPEAT_DISTANCE_SECONDS
      )
    ) {
      continue;
    }

    selected.push(candidate);
  }

  /*
     Fallback.

     This is mainly for extremely short videos
     where there simply aren't enough unique
     timestamps available.
  */

  if (selected.length < count) {
    selected.length = 0;

    if (d <= 1.2) {
      /*
         Very short video.

         Three completely different moments
         are mathematically impossible.

         So use slightly different positions.
      */

      for (let i = 0; i < count; i++) {
        const timestamp = Math.min(
          Math.max(
            0,
            d * 0.15 +
              i * d * 0.25
          ),
          Math.max(0, d - 0.05)
        );

        selected.push(timestamp);
      }
    } else {
      /*
         Backup positions:
         approximately 18%, 50%, 82%.

         Add a small random jitter so
         repeated requests don't always
         return exactly these positions.
      */

      const offsets = [
        0.18,
        0.50,
        0.82
      ];

      const jitter =
        (Math.random() - 0.5) *
        Math.min(0.15, d * 0.03);

      for (const offset of offsets) {
        const timestamp = Math.min(
          end,
          Math.max(
            start,
            d * offset + jitter
          )
        );

        selected.push(timestamp);
      }

      // Shuffle fallback timestamps.
      for (
        let i = selected.length - 1;
        i > 0;
        i--
      ) {
        const j =
          Math.floor(
            Math.random() * (i + 1)
          );

        [
          selected[i],
          selected[j]
        ] = [
          selected[j],
          selected[i]
        ];
      }
    }
  }

  // Save selected timestamps.
  rememberFrameTimes(
    videoKey,
    selected
  );

  return selected;
}


/* ============================================================
   FORMAT TIMESTAMP
============================================================ */

function formatSeconds(seconds) {
  return Math.max(
    0,
    Number(seconds) || 0
  ).toFixed(3);
}


/* ============================================================
   GET LOCAL VIDEO DURATION
============================================================ */

function getLocalDuration(videoPath) {
  try {
    const output = execSync(
      `ffprobe -v error ` +
      `-show_entries format=duration ` +
      `-of default=noprint_wrappers=1:nokey=1 ` +
      `"${videoPath}"`,
      {
        timeout: 10000,
        encoding: 'utf8',
        stdio: [
          'ignore',
          'pipe',
          'ignore'
        ]
      }
    ).trim();

    const duration = Number(output);

    if (
      Number.isFinite(duration) &&
      duration > 0
    ) {
      return duration;
    }

    return null;
  } catch {
    return null;
  }
}


/* ============================================================
   GET REMOTE VIDEO DURATION
============================================================ */

function getRemoteDuration(videoUrl) {
  try {
    const output = execSync(
      `ffprobe -v error ` +
      `-rw_timeout 12000000 ` +
      `-show_entries format=duration ` +
      `-of default=noprint_wrappers=1:nokey=1 ` +
      `-headers "User-Agent: Mozilla/5.0\\r\\n" ` +
      `"${videoUrl}"`,
      {
        timeout: 15000,
        encoding: 'utf8',
        stdio: [
          'ignore',
          'pipe',
          'ignore'
        ]
      }
    ).trim();

    const duration = Number(output);

    if (
      Number.isFinite(duration) &&
      duration > 0
    ) {
      return duration;
    }

    return null;
  } catch {
    return null;
  }
}


/* ============================================================
   EXTRACT ONE FRAME
============================================================ */

function extractFrameAt(
  input,
  timestamp,
  outputPath,
  isRemote = false
) {
  const ss = formatSeconds(timestamp);

  const inputOptions = isRemote
    ? `-headers "User-Agent: Mozilla/5.0\\r\\n" -rw_timeout 12000000`
    : '';

  const command =
    `ffmpeg -y -hide_banner -loglevel error ` +
    `${inputOptions} ` +
    `-ss ${ss} ` +
    `-i "${input}" ` +
    `-frames:v 1 ` +
    `-q:v 2 ` +
    `"${outputPath}"`;

  execSync(command, {
    timeout: 12000,
    stdio: 'ignore'
  });

  return (
    fs.existsSync(outputPath) &&
    fs.statSync(outputPath).size > 0
  );
}


/* ============================================================
   IMAGE -> BASE64
============================================================ */

function readImageBase64(filePath) {
  return (
    'data:image/jpeg;base64,' +
    fs
      .readFileSync(filePath)
      .toString('base64')
  );
}


/* ============================================================
   INSTAGRAM SNAP SAVE DECODER
============================================================ */

function decodeSnapApp(args) {
  const [
    h,
    _u,
    n,
    t,
    e,
    _r
  ] = args;

  const tNum = Number(t);
  const eNum = Number(e);

  function decode(
    d,
    eVal,
    fVal
  ) {
    const g =
      '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/'
        .split('');

    const hArr =
      g.slice(0, eVal);

    const iArr =
      g.slice(0, fVal);

    let j =
      d
        .split('')
        .reverse()
        .reduce(
          (a, b, c) => {
            const idx =
              hArr.indexOf(b);

            if (idx !== -1) {
              return (
                a +
                idx *
                  Math.pow(
                    eVal,
                    c
                  )
              );
            }

            return a;
          },
          0
        );

    let k = '';

    while (j > 0) {
      k =
        iArr[j % fVal] +
        k;

      j =
        Math.floor(
          j / fVal
        );
    }

    return k || '0';
  }

  let result = '';

  for (
    let i = 0,
    len = h.length;
    i < len;
    i++
  ) {
    let s = '';

    while (
      h[i] !== n[eNum]
    ) {
      s += h[i];
      i++;
    }

    for (
      let j = 0;
      j < n.length;
      j++
    ) {
      s =
        s.replace(
          new RegExp(
            n[j],
            'g'
          ),
          j.toString()
        );
    }

    result +=
      String.fromCharCode(
        Number(
          decode(
            s,
            eNum,
            10
          )
        ) - tNum
      );
  }

  return decodeURIComponent(
    escape(result)
  );
}


/* ============================================================
   RESOLVE INSTAGRAM
============================================================ */

async function resolveInstagramFast(
  shortcode
) {
  try {
    const target =
      'https://www.instagram.com/reel/' +
      shortcode +
      '/';

    const formData =
      new URLSearchParams();

    formData.append(
      'url',
      target
    );

    const response =
      await fetch(
        'https://snapsave.app/action.php?lang=en',
        {
          method: 'POST',

          headers: {
            accept: '*/*',

            'content-type':
              'application/x-www-form-urlencoded',

            origin:
              'https://snapsave.app',

            referer:
              'https://snapsave.app/',

            'user-agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
          },

          body:
            formData.toString()
        }
      );

    if (!response.ok) {
      return null;
    }

    const raw =
      await response.text();

    const part1 =
      raw.split(
        'decodeURIComponent(escape(r))}('
      )[1];

    if (!part1) {
      return null;
    }

    const lastParen =
      part1.lastIndexOf('))');

    if (lastParen === -1) {
      return null;
    }

    const args =
      eval(
        '[' +
        part1.slice(
          0,
          lastParen
        ) +
        ']'
      );

    if (
      !args ||
      args.length < 6
    ) {
      return null;
    }

    const decoded =
      decodeSnapApp(args);

    const cleanHtml =
      decoded.replace(
        /\\/g,
        ''
      );

    const rapidMatch =
      cleanHtml.match(
        /https:\/\/d\.rapidcdn\.app\/v2\?token=[^"'\s]+/i
      );

    if (rapidMatch) {
      const fullRapidUrl =
        rapidMatch[0]
          .replace(
            /&amp;/g,
            '&'
          );

      const tokenMatch =
        fullRapidUrl.match(
          /token=([a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)/
        );

      if (
        tokenMatch &&
        tokenMatch[1]
      ) {
        try {
          const payloadJson =
            Buffer.from(
              tokenMatch[1]
                .split('.')[1],
              'base64'
            ).toString('utf8');

          const parsed =
            JSON.parse(
              payloadJson
            );

          if (
            parsed.url &&
            (
              parsed.url.includes('.mp4') ||
              parsed.url.includes(
                'cdninstagram.com'
              )
            )
          ) {
            return parsed.url;
          }
        } catch {}
      }

      return fullRapidUrl;
    }

    const mp4Match =
      cleanHtml.match(
        /https:\/\/[^"'\s]+?\.mp4[^"'\s]*/i
      );

    if (mp4Match) {
      return mp4Match[0];
    }
  } catch {}

  return null;
}


/* ============================================================
   YOUTUBE ID
============================================================ */

function extractYouTubeId(url) {
  const match =
    url.match(
      /(?:shorts\/|v=|youtu\.be\/|\/embed\/|\/v\/)([a-zA-Z0-9_-]{11})/
    );

  return match
    ? match[1]
    : null;
}


/* ============================================================
   DOWNLOAD YOUTUBE VIDEO
============================================================ */

function downloadYouTubeVideo(
  videoId,
  outputPath
) {
  const url =
    `https://www.youtube.com/watch?v=${videoId}`;

  const command =
    `yt-dlp ` +
    `-f "b[ext=mp4]/best[ext=mp4]/best" ` +
    `--no-playlist ` +
    `--socket-timeout 15 ` +
    `-o "${outputPath}" ` +
    `"${url}"`;

  execSync(
    command,
    {
      timeout: 45000,
      stdio: 'ignore'
    }
  );

  return (
    fs.existsSync(outputPath) &&
    fs.statSync(outputPath).size > 0
  );
}


/* ============================================================
   TIKTOK
============================================================ */

async function resolveTikTok(url) {
  try {
    const response =
      await fetch(
        `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

    const json =
      await response.json();

    if (
      json &&
      json.data
    ) {
      return {
        streamUrl:
          json.data.play ||
          json.data.wmplay ||
          null,

        covers: [
          json.data.cover,
          json.data.origin_cover
        ].filter(Boolean)
      };
    }
  } catch {}

  return null;
}


/* ============================================================
   SNAPCHAT
============================================================ */

async function resolveSnapchat(url) {
  try {
    const response =
      await fetch(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',

            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },

          redirect: 'follow'
        }
      );

    const html =
      await response.text();

    const contentMatches =
      html.match(
        /"contentUrl":"([^"]+)"/g
      );

    if (
      contentMatches &&
      contentMatches.length > 0
    ) {
      const first =
        contentMatches[0]
          .replace(
            /"contentUrl":"|"/g,
            ''
          );

      return first
        .replace(
          /\\u0026/g,
          '&'
        )
        .replace(
          /&amp;/g,
          '&'
        );
    }

    const ogMatch =
      html.match(
        /<meta property="og:video(?::url)?" content="([^"]+)"/i
      );

    if (
      ogMatch &&
      ogMatch[1]
    ) {
      return ogMatch[1]
        .replace(
          /&amp;/g,
          '&'
        );
    }

    const cdnMatch =
      html.match(
        /https:\/\/(?:bolt-gcdn|cf-st)\.sc-cdn\.net\/[^\s"'<>\\]+/i
      );

    if (cdnMatch) {
      return cdnMatch[0]
        .replace(
          /\\u0026/g,
          '&'
        )
        .replace(
          /&amp;/g,
          '&'
        );
    }
  } catch {}

  return null;
}


/* ============================================================
   MAIN API
============================================================ */

app.all(
  '/api/extract-frames',
  async (req, res) => {
    const rawUrl =
      req.body?.url ||
      req.query?.url;

    if (!rawUrl) {
      return res.status(400).json({
        success: false,
        error:
          'URL parameter missing'
      });
    }

    const inputUrl =
      String(rawUrl).trim();

    const videoKey =
      getVideoKey(inputUrl);

    /*
       Unique request folder.

       This also prevents two simultaneous
       requests from overwriting each other's
       frame files.
    */

    const requestId =
      `${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 10)}`;

    const tmpDir =
      path.join(
        os.tmpdir(),
        `extract_${requestId}`
      );

    fs.mkdirSync(
      tmpDir,
      {
        recursive: true
      }
    );

    const framesBase64 = [];

    let tikTokData = null;

    try {

      /* ======================================================
         YOUTUBE
      ====================================================== */

      const ytId =
        extractYouTubeId(
          inputUrl
        );

      if (ytId) {
        const localVideoPath =
          path.join(
            tmpDir,
            'youtube.mp4'
          );

        try {
          const downloaded =
            downloadYouTubeVideo(
              ytId,
              localVideoPath
            );

          if (downloaded) {
            const duration =
              getLocalDuration(
                localVideoPath
              );

            const timestamps =
              chooseRandomTimestamps(
                duration || 30,
                3,
                videoKey
              );

            for (
              let i = 0;
              i < timestamps.length;
              i++
            ) {
              const outputPath =
                path.join(
                  tmpDir,
                  `youtube_${i + 1}.jpg`
                );

              try {
                const extracted =
                  extractFrameAt(
                    localVideoPath,
                    timestamps[i],
                    outputPath
                  );

                if (extracted) {
                  framesBase64.push(
                    readImageBase64(
                      outputPath
                    )
                  );
                }
              } catch {}
            }

            if (
              framesBase64.length > 0
            ) {
              return res.json({
                success: true,

                totalFrames:
                  framesBase64.length,

                frames:
                  framesBase64,

                randomized: true,

                timestamps:
                  timestamps
                    .slice(
                      0,
                      framesBase64.length
                    )
                    .map(
                      formatSeconds
                    )
              });
            }
          }
        } catch {}

        /*
           Last fallback.

           NOTE:
           These are YouTube thumbnails,
           not truly random video frames.

           This fallback only happens when
           yt-dlp cannot download the video.
        */

        try {
          const fallbackNames = [
            'hqdefault.jpg',
            '1.jpg',
            '2.jpg',
            '3.jpg'
          ];

          for (
            const name of fallbackNames
          ) {
            const imageResponse =
              await fetch(
                `https://i.ytimg.com/vi/${ytId}/${name}`
              );

            if (
              imageResponse.ok
            ) {
              const arrayBuffer =
                await imageResponse.arrayBuffer();

              framesBase64.push(
                'data:image/jpeg;base64,' +
                Buffer
                  .from(arrayBuffer)
                  .toString(
                    'base64'
                  )
              );

              if (
                framesBase64.length >= 3
              ) {
                break;
              }
            }
          }
        } catch {}

        if (
          framesBase64.length === 0
        ) {
          return res.status(500).json({
            success: false,
            error:
              'Failed to extract YouTube frames'
          });
        }

        return res.json({
          success: true,

          totalFrames:
            framesBase64.length,

          frames:
            framesBase64,

          randomized: false,

          warning:
            'YouTube video download failed, so thumbnail fallback was used.'
        });
      }


      /* ======================================================
         RESOLVE VIDEO URL
      ====================================================== */

      let videoStreamUrl =
        null;


      /* ======================================================
         INSTAGRAM
      ====================================================== */

      if (
        inputUrl.includes(
          'instagram.com'
        ) ||
        inputUrl.includes(
          'instagr.am'
        )
      ) {
        const match =
          inputUrl.match(
            /\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/
          );

        if (match) {
          videoStreamUrl =
            await resolveInstagramFast(
              match[1]
            );
        }
      }


      /* ======================================================
         TIKTOK
      ====================================================== */

      else if (
        inputUrl.includes(
          'tiktok.com'
        )
      ) {
        tikTokData =
          await resolveTikTok(
            inputUrl
          );

        if (
          tikTokData &&
          tikTokData.streamUrl
        ) {
          videoStreamUrl =
            tikTokData.streamUrl;
        }
      }


      /* ======================================================
         SNAPCHAT
      ====================================================== */

      else if (
        inputUrl.includes(
          'snapchat.com'
        )
      ) {
        videoStreamUrl =
          await resolveSnapchat(
            inputUrl
          );
      }


      /* ======================================================
         DIRECT VIDEO STREAM
      ====================================================== */

      if (videoStreamUrl) {

        /*
           First try to discover the exact
           video duration remotely.
        */

        let duration =
          getRemoteDuration(
            videoStreamUrl
          );


        /*
           If remote ffprobe doesn't work,
           download the video and inspect it
           locally.
        */

        if (!duration) {
          const localVideoPath =
            path.join(
              tmpDir,
              'downloaded.mp4'
            );

          try {
            execSync(
              `curl -s -L --max-time 30 ` +
              `-A "Mozilla/5.0" ` +
              `"${videoStreamUrl}" ` +
              `-o "${localVideoPath}"`,
              {
                timeout: 35000,
                stdio: 'ignore'
              }
            );

            if (
              fs.existsSync(
                localVideoPath
              ) &&
              fs.statSync(
                localVideoPath
              ).size > 0
            ) {
              duration =
                getLocalDuration(
                  localVideoPath
                );

              /*
                 Exact local extraction.
              */

              if (duration) {
                const timestamps =
                  chooseRandomTimestamps(
                    duration,
                    3,
                    videoKey
                  );

                for (
                  let i = 0;
                  i < timestamps.length;
                  i++
                ) {
                  const outputPath =
                    path.join(
                      tmpDir,
                      `download_${i + 1}.jpg`
                    );

                  try {
                    const extracted =
                      extractFrameAt(
                        localVideoPath,
                        timestamps[i],
                        outputPath
                      );

                    if (extracted) {
                      framesBase64.push(
                        readImageBase64(
                          outputPath
                        )
                      );
                    }
                  } catch {}
                }

                if (
                  framesBase64.length > 0
                ) {
                  return res.json({
                    success: true,

                    totalFrames:
                      framesBase64.length,

                    frames:
                      framesBase64,

                    randomized: true,

                    timestamps:
                      timestamps
                        .slice(
                          0,
                          framesBase64.length
                        )
                        .map(
                          formatSeconds
                        )
                  });
                }
              }
            }
          } catch {}
        }


        /*
           If duration was successfully
           detected remotely, randomly select
           three timestamps.
        */

        const timestamps =
          chooseRandomTimestamps(
            duration || 30,
            3,
            videoKey
          );


        /*
           Extract each random frame
           directly from remote stream.
        */

        for (
          let i = 0;
          i < timestamps.length;
          i++
        ) {
          const outputPath =
            path.join(
              tmpDir,
              `remote_${i + 1}.jpg`
            );

          try {
            const extracted =
              extractFrameAt(
                videoStreamUrl,
                timestamps[i],
                outputPath,
                true
              );

            if (extracted) {
              framesBase64.push(
                readImageBase64(
                  outputPath
                )
              );
            }
          } catch {}
        }


        if (
          framesBase64.length > 0
        ) {
          return res.json({
            success: true,

            totalFrames:
              framesBase64.length,

            frames:
              framesBase64,

            randomized: true,

            timestamps:
              timestamps
                .slice(
                  0,
                  framesBase64.length
                )
                .map(
                  formatSeconds
                )
          });
        }
      }


      /* ======================================================
         GENERIC / FACEBOOK / OTHER
      ====================================================== */

      const localVideoPath =
        path.join(
          tmpDir,
          'video.mp4'
        );

      const ytdlpCommand =
        `yt-dlp ` +
        `-f "b[ext=mp4]/best[ext=mp4]/best" ` +
        `--no-playlist ` +
        `--socket-timeout 15 ` +
        `-o "${localVideoPath}" ` +
        `"${inputUrl}"`;

      execSync(
        ytdlpCommand,
        {
          timeout: 45000,
          stdio: 'ignore'
        }
      );


      if (
        fs.existsSync(
          localVideoPath
        ) &&
        fs.statSync(
          localVideoPath
        ).size > 0
      ) {
        const duration =
          getLocalDuration(
            localVideoPath
          );

        /*
           THIS IS THE MAIN FIX.

           Old code:
             1 second
             3 seconds
             5 seconds

           New code:
             random timestamp
             random timestamp
             random timestamp
        */

        const timestamps =
          chooseRandomTimestamps(
            duration || 30,
            3,
            videoKey
          );


        for (
          let i = 0;
          i < timestamps.length;
          i++
        ) {
          const outputPath =
            path.join(
              tmpDir,
              `frame_${i + 1}.jpg`
            );

          try {
            const extracted =
              extractFrameAt(
                localVideoPath,
                timestamps[i],
                outputPath
              );

            if (extracted) {
              framesBase64.push(
                readImageBase64(
                  outputPath
                )
              );
            }
          } catch {}
        }


        if (
          framesBase64.length > 0
        ) {
          return res.json({
            success: true,

            totalFrames:
              framesBase64.length,

            frames:
              framesBase64,

            randomized: true,

            timestamps:
              timestamps
                .slice(
                  0,
                  framesBase64.length
                )
                .map(
                  formatSeconds
                )
          });
        }
      }


      /* ======================================================
         TIKTOK COVER FALLBACK
      ====================================================== */

      if (
        framesBase64.length === 0 &&
        tikTokData &&
        Array.isArray(
          tikTokData.covers
        ) &&
        tikTokData.covers.length > 0
      ) {
        for (
          const cover
          of tikTokData.covers
        ) {
          try {
            const imageResponse =
              await fetch(
                cover
              );

            if (
              imageResponse.ok
            ) {
              const buffer =
                await imageResponse.arrayBuffer();

              framesBase64.push(
                'data:image/jpeg;base64,' +
                Buffer
                  .from(buffer)
                  .toString(
                    'base64'
                  )
              );
            }
          } catch {}
        }
      }


      /* ======================================================
         FINAL RESPONSE
      ====================================================== */

      if (
        framesBase64.length === 0
      ) {
        return res.status(500).json({
          success: false,

          error:
            'Failed to extract frames from video'
        });
      }

      return res.json({
        success: true,

        totalFrames:
          framesBase64.length,

        frames:
          framesBase64,

        randomized:
          true
      });

    } catch (err) {

      return res.status(500).json({
        success: false,

        error:
          err.message ||
          'Processing error'
      });

    } finally {

      /*
         Always remove temporary files.
      */

      try {
        fs.rmSync(
          tmpDir,
          {
            recursive: true,
            force: true
          }
        );
      } catch {}
    }
  }
);


/* ============================================================
   START SERVER
============================================================ */

app.listen(
  PORT,
  () => {
    console.log(
      `Universal Server listening on port ${PORT}`
    );
  }
);
