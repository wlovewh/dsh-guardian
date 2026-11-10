// Read-only app.asar helper: list/extract/grep files inside the archive.
// usage: node asar.mjs list <dir> | extract <dir> <outDir> | find <substring> | grep <pattern> <fileRegex>
import fs from 'node:fs';
import path from 'node:path';

const archive = 'E:\\CodingAPP\\DeepseekHarness\\resources\\app.asar';
const fd = fs.openSync(archive, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const region = Buffer.alloc(headerSize);
fs.readSync(fd, region, 0, headerSize, 8);
let text = region.toString('utf8');
text = text.slice(text.indexOf('{"files"'));
text = text.slice(0, text.lastIndexOf('}') + 1);
const base = 8 + headerSize;
const root = JSON.parse(text);

function lookup(p) {
  let node = root;
  for (const part of String(p).split('/').filter(Boolean)) {
    if (!node || !node.files || !node.files[part]) return undefined;
    node = node.files[part];
  }
  return node;
}
function readNode(node) {
  const size = Number(node.size || 0);
  const buf = Buffer.alloc(size);
  if (size > 0) fs.readSync(fd, buf, 0, size, base + Number(node.offset));
  return buf;
}
function walk(node, prefix, visit) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix + '/' + name;
    if (child.files) walk(child, p, visit);
    else visit(p, child);
  }
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'list') {
  const node = lookup(a || '');
  if (!node) { console.log('NOT FOUND'); process.exit(1); }
  for (const [name, child] of Object.entries(node.files || {})) {
    console.log((child.files ? 'DIR  ' : 'FILE ') + String(child.size ?? '').padStart(9) + '  ' + name);
  }
} else if (cmd === 'extract') {
  const node = lookup(a);
  if (!node) { console.log('NOT FOUND'); process.exit(1); }
  let count = 0;
  if (node.files) {
    walk(node, '', (p, child) => {
      const target = path.join(b, p);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, readNode(child));
      count++;
    });
  } else {
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(b, readNode(node));
    count = 1;
  }
  console.log('extracted ' + count);
} else if (cmd === 'find') {
  const needle = a.toLowerCase();
  const out = [];
  walk(root, '', (p, child) => { if (p.toLowerCase().includes(needle)) out.push(String(child.size).padStart(9) + '  ' + p); });
  console.log(out.slice(0, 200).join('\n') + '\ntotal ' + out.length);
} else if (cmd === 'grep') {
  const re = new RegExp(a);
  const fileRe = new RegExp(b || '.');
  let hits = 0;
  walk(root, '', (p, child) => {
    if (!fileRe.test(p)) return;
    const body = readNode(child).toString('utf8');
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      console.log(p + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 300));
      if (++hits > 120) { console.log('...truncated'); process.exit(0); }
    }
  });
  console.log('hits ' + hits);
}
fs.closeSync(fd);
