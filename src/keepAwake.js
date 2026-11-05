const { spawn } = require('child_process');

// Arguments for macOS caffeinate: no idle sleep (-i), no disk sleep (-m), no system sleep on
// mains power (-s), and quit when this process ends (-w), so a run can't freeze mid-sweep.
const caffeinateArgs = pid => ['-ims', '-w', String(pid)];

// Keeps the Mac awake for as long as this process runs. Does nothing on other platforms.
// Closing the lid still sleeps a laptop on battery.
const keepAwake = ({ platform = process.platform, pid = process.pid, start = spawn } = {}) => {
  if (platform !== 'darwin') return null;
  try {
    const child = start('caffeinate', caffeinateArgs(pid), { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return child;
  } catch {
    return null;
  }
};

module.exports = { caffeinateArgs, keepAwake };
