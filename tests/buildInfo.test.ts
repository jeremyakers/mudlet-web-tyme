// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDefine } from '../buildInfo';

vi.mock('node:fs', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:fs')>(),
    existsSync: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:child_process')>(),
    execFileSync: vi.fn(),
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('SOURCE_COMMIT', '');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockReturnValue(Buffer.from('1234567\n'));
});
afterEach(() => vi.unstubAllEnvs());

describe('buildDefine source identity', () => {
    it('prefers the first seven SOURCE_COMMIT characters over checkout HEAD', () => {
        vi.stubEnv('SOURCE_COMMIT', 'abcdef0123456789');
        expect(buildDefine().__GIT_COMMIT__).toBe('"abcdef0"');
        expect(execFileSync).not.toHaveBeenCalled();
    });

    it('does not inherit an enclosing checkout HEAD when the source has no .git', () => {
        vi.mocked(existsSync).mockReturnValue(false);
        expect(buildDefine().__GIT_COMMIT__).toBe('""');
        expect(existsSync).toHaveBeenCalledWith(new URL('../.git', import.meta.url));
        expect(execFileSync).not.toHaveBeenCalled();
    });

    it('retains the trimmed Git identity for a checkout with its own .git', () => {
        expect(buildDefine().__GIT_COMMIT__).toBe('"1234567"');
        expect(execFileSync).toHaveBeenCalledWith('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: fileURLToPath(new URL('../', import.meta.url)),
            stdio: ['ignore', 'pipe', 'ignore'],
        });
    });

    it('retains an empty identity when Git cannot answer', () => {
        vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('Git unavailable'); });
        expect(buildDefine().__GIT_COMMIT__).toBe('""');
    });
});
