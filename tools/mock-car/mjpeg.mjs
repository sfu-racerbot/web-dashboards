// A fake camera: a never-ending multipart/x-mixed-replace response of
// JPEG frames, the same shape usb_cam_stream's /stream sends. Each frame is
// drawn and encoded on the fly (a moving bar and a frame counter in
// blocks), so a frozen feed is obvious at a glance.

import jpeg from 'jpeg-js';

const BOUNDARY = 'mockcarframe';
const TIERS = { preview: { width: 320, height: 180, fps: 10 }, full: { width: 640, height: 360, fps: 15 } };

function drawFrame(width, height, n) {
  const data = Buffer.alloc(width * height * 4);
  const bar = Math.floor(((n * 4) % width));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4;
      const onBar = Math.abs(x - bar) < 6;
      data[k] = onBar ? 61 : 10 + Math.floor((x / width) * 30);
      data[k + 1] = onBar ? 220 : 16 + Math.floor((y / height) * 30);
      data[k + 2] = onBar ? 255 : 28;
      data[k + 3] = 255;
    }
  }
  // Frame counter as 12 binary blocks along the top.
  for (let bit = 0; bit < 12; bit++) {
    const on = (n >> bit) & 1;
    for (let y = 8; y < 20; y++) {
      for (let x = 8 + bit * 16; x < 20 + bit * 16; x++) {
        const k = (y * width + x) * 4;
        data[k] = on ? 43 : 60; data[k + 1] = on ? 245 : 60; data[k + 2] = on ? 138 : 60;
      }
    }
  }
  return jpeg.encode({ data, width, height }, 70).data;
}

export class MjpegSource {
  constructor() {
    this.clients = 0;
    this.frames = 0;
    this.since = Date.now();
  }

  get fps() {
    const secs = (Date.now() - this.since) / 1000;
    const fps = secs > 0 ? this.frames / secs : 0;
    this.frames = 0;
    this.since = Date.now();
    return fps;
  }

  serve(req, res, tierName) {
    const tier = TIERS[tierName] || TIERS.preview;
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-cache, private',
      Pragma: 'no-cache',
    });
    this.clients++;
    let n = 0;
    const timer = setInterval(() => {
      const frame = drawFrame(tier.width, tier.height, n++);
      res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
      res.write(frame);
      res.write('\r\n');
      this.frames++;
    }, 1000 / tier.fps);
    const stop = () => {
      clearInterval(timer);
      this.clients = Math.max(0, this.clients - 1);
    };
    req.on('close', stop);
  }
}
