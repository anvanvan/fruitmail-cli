/**
 * Regression test for F27: every third-party GitHub Action used in
 * .github/workflows/*.yml must be pinned to a full commit SHA (never a
 * mutable tag like @v6), since the release job holds npm OIDC, GH_TOKEN and
 * TAP_TOKEN in scope.
 */
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOWS_DIR = path.resolve(__dirname, '../.github/workflows');

describe('GitHub Actions are pinned to commit SHAs (F27)', () => {
    const workflowFiles = fs.existsSync(WORKFLOWS_DIR)
        ? fs.readdirSync(WORKFLOWS_DIR).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
        : [];

    it('found at least one workflow file to check', () => {
        expect(workflowFiles.length).toBeGreaterThan(0);
    });

    it.each(workflowFiles)('%s pins every `uses:` action to a 40-char commit SHA', (file) => {
        const content = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
        const usesLines = content.match(/^\s*uses:\s*\S+/gm) ?? [];
        expect(usesLines.length).toBeGreaterThan(0);
        for (const line of usesLines) {
            const ref = line.replace(/^\s*uses:\s*/, '').trim();
            const [, sha] = ref.split('@');
            expect(sha).toBeDefined();
            expect(sha).toMatch(/^[0-9a-f]{40}$/);
        }
    });
});
