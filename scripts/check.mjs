// Checks the plugin before it ships: manifests parse, every skill has valid
// frontmatter, relative links resolve, and no example teaches a known
// mistake. Run: node scripts/check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const fail = (file, msg) => problems.push(`${path.relative(root, file)}: ${msg}`);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(file, `invalid JSON (${e.message})`); return null; }
}

const marketplace = readJson(path.join(root, '.claude-plugin/marketplace.json'));
for (const p of marketplace?.plugins || []) {
  const dir = path.join(root, p.source);
  const manifest = readJson(path.join(dir, '.claude-plugin/plugin.json'));
  if (manifest && manifest.name !== p.name) fail(path.join(dir, '.claude-plugin/plugin.json'), `name "${manifest.name}" != marketplace entry "${p.name}"`);

  const skillsDir = path.join(dir, 'skills');
  for (const name of fs.readdirSync(skillsDir)) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(file)) { fail(path.join(skillsDir, name), 'no SKILL.md'); continue; }
    const text = fs.readFileSync(file, 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!fm) { fail(file, 'no frontmatter'); continue; }
    const field = (k) => (new RegExp(`^${k}:\s*(.+)$`, 'm').exec(fm[1]) || [])[1]?.trim();
    if (field('name') !== name) fail(file, `frontmatter name "${field('name')}" must equal the folder name "${name}"`);
    const desc = field('description') || '';
    if (!desc) fail(file, 'missing description');
    if (desc.length > 1024) fail(file, `description is ${desc.length} chars (max 1024)`);
  }
}

// Every .md under plugins/: relative links resolve; no known-bad patterns.
const BAD = [
  [/client_secret\s*[:=]\s*["'`]?(?:vars\.|\$|process\.env|os\.environ|config\()/i, 'client secret in a request body (INFRA token endpoint needs HTTP Basic)'],
  [/['"]client_secret['"]\s*(=>|:)\s*(?!\s|env\()/, 'client secret in a request body (INFRA token endpoint needs HTTP Basic)'],
  [/(NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC)_INFRA_(CLIENT|WEBHOOK)_SECRET/, 'secret exposed through a public env prefix'],
  [/code_challenge_method['"]?\s*[:=,]\s*['"]plain/i, 'plain PKCE'],
];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.md')) {
      const text = fs.readFileSync(full, 'utf8');
      for (const [, target] of text.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)) {
        if (!fs.existsSync(path.resolve(path.dirname(full), target.split('#')[0]))) fail(full, `broken link ${target}`);
      }
      text.split('\n').forEach((line, i) => {
        for (const [re, why] of BAD) if (re.test(line)) fail(full, `line ${i + 1}: ${why}`);
      });
    }
  }
}
walk(path.join(root, 'plugins'));

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('infra-skills: all checks passed');
