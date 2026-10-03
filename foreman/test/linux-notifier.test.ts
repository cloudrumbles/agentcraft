import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showDesktopNotification, showLinuxNotification } from '../src/notifier.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const realProcess = process;

beforeEach(() => {
  vi.stubGlobal('process', Object.create(realProcess, { platform: { value: 'linux' } }));
  vi.stubEnv('DISPLAY', ':1');
  vi.stubEnv('WAYLAND_DISPLAY', '');
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockChild() {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

describe('Linux desktop notifications', () => {
  it('uses notify-send argv without a shell, escapes body markup and applies the silent hint', async () => {
    const child = mockChild();
    const result = showDesktopNotification('--title $(touch /tmp/should-not-exist)', '<b>decision</b> & "details"', true);
    expect(spawn).toHaveBeenCalledWith('notify-send', [
      '--app-name', 'AgentCraft', '--icon', 'dialog-information', '--hint', 'boolean:suppress-sound:true',
      '--', '--title $(touch /tmp/should-not-exist)', '&lt;b&gt;decision&lt;/b&gt; &amp; &quot;details&quot;',
    ], { stdio: 'ignore', shell: false });
    child.emit('close', 0);
    expect(await result).toBe(true);
  });

  it('supports Wayland and leaves non-silent notifications to desktop preferences', async () => {
    vi.stubEnv('DISPLAY', '');
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    const child = mockChild();
    const result = showLinuxNotification('title', 'body', false);
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).not.toContain('--hint');
    child.emit('close', 0);
    expect(await result).toBe(true);
  });

  it('does not spawn anything on a headless session or another OS', async () => {
    vi.stubEnv('DISPLAY', '');
    expect(await showLinuxNotification('title', 'body', false)).toBe(false);
    vi.stubGlobal('process', Object.create(realProcess, { platform: { value: 'darwin' } }));
    vi.stubEnv('DISPLAY', ':1');
    expect(await showLinuxNotification('title', 'body', false)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails gracefully when notify-send or the notification service is unavailable', async () => {
    const absent = mockChild();
    const missing = showLinuxNotification('title', 'body', false);
    absent.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect(await missing).toBe(false);
    const noService = mockChild();
    const failed = showLinuxNotification('title', 'body', false);
    noService.emit('close', 1);
    expect(await failed).toBe(false);
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('spawn failed'); });
    expect(await showLinuxNotification('title', 'body', false)).toBe(false);
  });

  it('terminates and resolves a hung helper instead of blocking Foreman', async () => {
    vi.useFakeTimers();
    const child = mockChild();
    const result = showLinuxNotification('title', 'body', false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(await result).toBe(false);
  });
});
