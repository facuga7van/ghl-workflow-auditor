// node tools/make-icons.js
//
// Draws the extension icon at every size the Chrome Web Store asks for.
// No dependencies: rasterises into an RGBA buffer and writes the PNG with the
// zlib that ships with node. Checked in as a script rather than as binaries
// alone, so the icon can be changed without hunting for the original file.
//
// The mark is what the tool does: one node branching into two, and one branch
// is wrong. At 16px everything but that survives.

const fs = require("fs"), path = require("path"), zlib = require("zlib");

const BG    = [0x0f, 0x11, 0x15];
const BLUE  = [0x5b, 0x9d, 0xff];
const RED   = [0xf8, 0x51, 0x49];
const DIM   = [0x3a, 0x41, 0x4e];

const SS = 4;   // supersampling: draw big, average down, get free antialiasing

function canvas(n){
  return { n, px: new Float64Array(n * n * 4) };
}
function put(c, x, y, rgb, a){
  if (x < 0 || y < 0 || x >= c.n || y >= c.n) return;
  const i = (y * c.n + x) * 4;
  c.px[i] = rgb[0]; c.px[i+1] = rgb[1]; c.px[i+2] = rgb[2]; c.px[i+3] = a;
}
// Rounded rectangle, filled.
function rrect(c, x, y, w, h, r, rgb){
  for (let yy = Math.floor(y); yy < y + h; yy++)
    for (let xx = Math.floor(x); xx < x + w; xx++){
      const dx = Math.max(x + r - xx - .5, 0, xx + .5 - (x + w - r));
      const dy = Math.max(y + r - yy - .5, 0, yy + .5 - (y + h - r));
      if (dx * dx + dy * dy <= r * r) put(c, xx, yy, rgb, 255);
    }
}
// Thick line segment.
function line(c, x1, y1, x2, y2, w, rgb){
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2);
  for (let i = 0; i <= steps; i++){
    const t = i / steps, cx = x1 + (x2 - x1) * t, cy = y1 + (y2 - y1) * t;
    for (let yy = Math.floor(cy - w/2); yy <= cy + w/2; yy++)
      for (let xx = Math.floor(cx - w/2); xx <= cx + w/2; xx++)
        if (Math.hypot(xx + .5 - cx, yy + .5 - cy) <= w/2) put(c, xx, yy, rgb, 255);
  }
}

function draw(size){
  const n = size * SS, c = canvas(n);
  const u = n / 32;                       // one unit = 1/32 of the icon

  // background plate, so it reads on a light or a dark toolbar
  rrect(c, 0, 0, n, n, 7 * u, BG);

  const nodeW = 9 * u, nodeH = 6 * u, r = 1.6 * u;
  const topX = (n - nodeW) / 2, topY = 4 * u;
  const botY = 21 * u;
  const leftX = 2.5 * u, rightX = n - nodeW - 2.5 * u;

  // the split: parent down to a fork, fork out to each child
  const midY = 14 * u;
  const cx = n / 2;
  line(c, cx, topY + nodeH, cx, midY, 1.5 * u, DIM);
  line(c, leftX + nodeW/2, midY, rightX + nodeW/2, midY, 1.5 * u, DIM);
  line(c, leftX + nodeW/2, midY, leftX + nodeW/2, botY, 1.5 * u, DIM);
  line(c, rightX + nodeW/2, midY, rightX + nodeW/2, botY, 1.5 * u, RED);

  rrect(c, topX, topY, nodeW, nodeH, r, BLUE);
  rrect(c, leftX, botY, nodeW, nodeH, r, BLUE);
  rrect(c, rightX, botY, nodeW, nodeH, r, RED);   // the branch that is broken

  // average the supersampled buffer down to the real size
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++){
    let r2 = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++){
      const i = ((y * SS + sy) * n + (x * SS + sx)) * 4;
      r2 += c.px[i]; g += c.px[i+1]; b += c.px[i+2]; a += c.px[i+3];
    }
    const k = SS * SS, o = (y * size + x) * 4;
    out[o] = Math.round(r2/k); out[o+1] = Math.round(g/k);
    out[o+2] = Math.round(b/k); out[o+3] = Math.round(a/k);
  }
  return out;
}

// ---------- minimal PNG writer ----------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++){
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return buf => {
    let c = -1;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

function png(rgba, size){
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;              // 8-bit, RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++){
    raw[y * (size * 4 + 1)] = 0;         // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, "..", "ext", "icons");
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]){
  const file = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(file, png(draw(size), size));
  console.log(`  ${size}x${size}  ${fs.statSync(file).size} bytes`);
}
console.log("icons written to ext/icons/");
