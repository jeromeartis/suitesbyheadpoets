// Runs automatically after every `npm install` (see package.json's "postinstall").
//
// sharp and node-cron are pinned below their latest majors in package.json because
// newer releases of both require Node 20+, and this project still targets Node 18.
// Running `npm install sharp` or `npm install node-cron` on their own (no version)
// always grabs latest and silently overwrites that pin, which then crashes the
// server on startup. This script re-detects that drift every time dependencies are
// installed and quietly fixes it, instead of waiting for the server to crash.
//
// None of this is needed once the project moves to Node 20+ — at that point, drop
// this script, the postinstall hook, and the version pins in package.json.

const { execSync } = require('child_process');

const PINS = {
  sharp: '0.32.6',
  'node-cron': '3.0.3'
};

const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor >= 20) {
  // Newer Node — the pins (and this whole script) are no longer necessary.
  process.exit(0);
}

// Compares the actually-installed version against the pin, rather than just
// checking whether require() throws — node-cron's incompatible major doesn't
// crash on load the way sharp's does, so "does it load" isn't a reliable signal.
function installedVersion(pkg) {
  try {
    return require(`${pkg}/package.json`).version;
  } catch {
    return null;
  }
}

const toFix = Object.keys(PINS).filter((pkg) => installedVersion(pkg) !== PINS[pkg]);
if (!toFix.length) process.exit(0);

const args = toFix.map((pkg) => `${pkg}@${PINS[pkg]}`).join(' ');
console.warn(`[verify-native-deps] ${toFix.join(', ')} incompatible with Node ${process.versions.node} — reinstalling pinned version(s): ${args}`);
execSync(`npm install ${args} --no-audit --no-fund`, { stdio: 'inherit', cwd: __dirname + '/..' });
