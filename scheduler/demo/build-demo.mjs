// Builds a single self-contained HTML page of the dashboard with an in-browser fake backend.
// Usage: node demo/build-demo.mjs <output.html>
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(join(root, p), 'utf8');
const out = process.argv[2];
if (!out) throw new Error('Usage: node demo/build-demo.mjs <output.html>');

const [html, css, app, shim, favicon] = await Promise.all([
  read('public/index.html'), read('public/style.css'), read('public/app.js'), read('demo/demo-shim.js'), read('public/favicon.svg'),
]);
const icon = `data:image/svg+xml,${encodeURIComponent(favicon.trim())}`;
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replaceAll('/favicon.svg', icon);

const strip = `
<div class="demo-strip" role="note">
  <span><strong>Demo</strong> · Runs in your browser with sample posts. Nothing is sent to Instagram, and your changes stay on this device.</span>
  <span class="demo-actions">
    <a href="https://github.com/YukeshWorks/Biscuit-collection/tree/claude/instagram-auto-posting-whi15v/scheduler" target="_blank" rel="noopener noreferrer">Source code</a>
    <button type="button" class="btn small ghost" id="demo-reset">Reset demo</button>
  </span>
</div>`;

const demoCss = `
.demo-strip { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; justify-content: space-between;
  padding: .55rem max(16px, env(safe-area-inset-right, 0px)) .55rem max(16px, env(safe-area-inset-left, 0px));
  background: linear-gradient(90deg, #f0a8d426, #aa8cff26); border-bottom: 1px solid var(--line); font-size: .82rem; color: var(--ink); }
.demo-strip strong { color: var(--pink); }
.demo-actions { display: flex; gap: .75rem; align-items: center; }
.demo-actions a { color: var(--violet); }
`;

const page = `<title>BISCUIT Post Scheduler</title>
<link rel="icon" href="${icon}">
<style>
${css}
${demoCss}
</style>
${strip}
${body}
<script>
${shim}
document.getElementById('demo-reset').onclick = () => window.BISCUIT_DEMO_RESET();
</script>
<script type="module">
${app}
</script>
`;
await writeFile(out, page);
console.log(`wrote ${out} (${(page.length / 1024).toFixed(0)} KB)`);
