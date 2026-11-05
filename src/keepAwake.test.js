import { describe, expect, it, vi } from 'vitest';
import { caffeinateArgs, keepAwake } from './keepAwake';

const fakeChild = () => ({ on: vi.fn(), unref: vi.fn() });

describe('keepAwake', () => {
  it('starts caffeinate on macOS, tied to this process', () => {
    const child = fakeChild();
    const start = vi.fn(() => child);
    expect(keepAwake({ platform: 'darwin', pid: 4242, start })).toBe(child);
    expect(start).toHaveBeenCalledWith('caffeinate', ['-ims', '-w', '4242'], { stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalled();
  });

  it('does nothing on other platforms', () => {
    const start = vi.fn();
    expect(keepAwake({ platform: 'linux', start })).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('carries on when caffeinate cannot start', () => {
    const start = vi.fn(() => {
      throw new Error('ENOENT');
    });
    expect(keepAwake({ platform: 'darwin', pid: 1, start })).toBeNull();
  });

  it('builds the caffeinate arguments', () => {
    expect(caffeinateArgs(7)).toEqual(['-ims', '-w', '7']);
  });
});
