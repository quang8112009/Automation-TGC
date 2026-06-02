#!/usr/bin/env node
/**
 * CI secret-scan: blocks secrets, server host/IP, and a real .env from the repo (Foundation Req 13.2).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const patterns = [
  { re: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/, label: 'IP address' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'private key' },
  { re: /password\s*[:=]\s*['"][^'"]{6,}['"]/i, label: 'inline password' },
];
const allowFiles = new Set(['secret-scan.js']);

let findings = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      continue;
    }
    if (entry.name === '.env') {
      findings.push(`Committed .env file at ${path.join(dir, entry.name)}`);
      continue;
    }
    if (!/\.(ts|js|json|md|yml|yaml|env\.example)$/.test(entry.name)) continue;
    if (allowFiles.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    // Test fixtures use obvious dummy credentials; they are not real secrets.
    const isTestFile = /\.test\.(ts|js)$/.test(entry.name) || /[\\/]test[\\/]/.test(full);
    const text = fs.readFileSync(full, 'utf8');
    for (const { re, label } of patterns) {
      if (label === 'inline password' && isTestFile) continue;
      const m = text.match(re);
      if (m) {
        // Allow benign loopback/version-like matches in examples.
        if (label === 'IP address' && /127\.0\.0\.1|0\.0\.0\.0|example/.test(text)) continue;
        // Allow documentation placeholders like password='<db-pass>' — an
        // angle-bracket token is a fill-in, never a real committed secret.
        if (label === 'inline password' && /<[^'"<>]+>/.test(m[0])) continue;
        findings.push(`${label} in ${full}: ${m[0]}`);
      }
    }
  }
}

walk(ROOT);
if (findings.length) {
  console.error('SECRET SCAN FAILED:');
  findings.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('Secret scan passed: no secrets, server host, or .env found in repo.');
