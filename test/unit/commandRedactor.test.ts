import { describe, it, expect } from 'vitest';
import { redactCommand } from '../../src/utils/commandRedactor';

describe('redactCommand', () => {
  describe('program + subcommand parsing', () => {
    it('extracts program from simple command', () => {
      const result = redactCommand('ls');
      expect(result.program).toBe('ls');
      expect(result.subcommand).toBeUndefined();
      expect(result.tokenCount).toBe(1);
      expect(result.display).toBe('ls');
    });

    it('extracts program + subcommand for git', () => {
      const result = redactCommand('git push origin main');
      expect(result.program).toBe('git');
      expect(result.subcommand).toBe('push');
      expect(result.tokenCount).toBe(4);
      expect(result.display).toBe('git push');
    });

    it('extracts program + subcommand for pnpm', () => {
      const result = redactCommand('pnpm install --frozen-lockfile');
      expect(result.program).toBe('pnpm');
      expect(result.subcommand).toBe('install');
      expect(result.hasFlags).toBe(true);
    });

    it('does not treat a flag as a subcommand', () => {
      const result = redactCommand('node --version');
      expect(result.program).toBe('node');
      expect(result.subcommand).toBeUndefined();
      expect(result.hasFlags).toBe(true);
    });

    it('skips leading env-var assignments to find program', () => {
      const result = redactCommand('DEBUG=1 NODE_ENV=test pnpm test');
      expect(result.program).toBe('pnpm');
      expect(result.subcommand).toBe('test');
    });

    it('handles extra whitespace', () => {
      const result = redactCommand('  git    status  ');
      expect(result.program).toBe('git');
      expect(result.subcommand).toBe('status');
      expect(result.tokenCount).toBe(2);
    });

    it('returns empty program for empty input', () => {
      const result = redactCommand('');
      expect(result.program).toBe('');
      expect(result.tokenCount).toBe(0);
      expect(result.hasFlags).toBe(false);
      expect(result.hadPotentialSecret).toBe(false);
      expect(result.display).toBe('<empty>');
    });
  });

  describe('display field is always safe for canonical command field', () => {
    it('never contains flag values', () => {
      const result = redactCommand('npm publish --token=npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(result.display).toBe('npm publish');
      expect(result.display).not.toContain('token');
      expect(result.display).not.toContain('xxxx');
    });

    it('never contains URLs or positional args', () => {
      const result = redactCommand('curl https://api.example.com/v1/users');
      expect(result.display).toBe('curl');
      expect(result.display).not.toContain('example.com');
    });

    it('never contains secret-looking env-var values', () => {
      const result = redactCommand('TOKEN=abc123xyz ./deploy.sh prod');
      expect(result.display).toBe('./deploy.sh prod');
      expect(result.display).not.toContain('abc123xyz');
    });

    it('is non-empty even for blank input', () => {
      expect(redactCommand('').display.length).toBeGreaterThan(0);
      expect(redactCommand('   ').display.length).toBeGreaterThan(0);
    });
  });

  describe('secret detection', () => {
    it('flags --token flag', () => {
      const result = redactCommand('curl --token abc123def456 https://api.example.com');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('flags --token=value form', () => {
      const result = redactCommand('npm publish --token=npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('flags --api-key', () => {
      const result = redactCommand('mytool --api-key sk_live_abc');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('flags --password', () => {
      const result = redactCommand('mysql --password=hunter2');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('flags Authorization header', () => {
      const result = redactCommand('curl -H "Authorization: Bearer eyJhbGciOi"');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('flags TOKEN= env-var-style', () => {
      const result = redactCommand('TOKEN=secretvalue ./deploy.sh');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('flags long opaque blobs as likely secrets', () => {
      const result = redactCommand('echo eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('does NOT flag short alphanumeric strings', () => {
      const result = redactCommand('git checkout abc123');
      expect(result.hadPotentialSecret).toBe(false);
    });

    it('does NOT flag plain commands', () => {
      const result = redactCommand('pnpm test --reporter=verbose');
      expect(result.hadPotentialSecret).toBe(false);
    });

    it('does NOT flag --key when it is not a secret flag (e.g. ssh-keygen -t rsa)', () => {
      // ssh-keygen -t is fine; --key is the secret-y one
      const result = redactCommand('ssh-keygen -t rsa');
      expect(result.hadPotentialSecret).toBe(false);
    });
  });

  describe('never leaks raw command', () => {
    it('returned object has no field containing the raw command text', () => {
      const raw = 'curl -H "Authorization: Bearer SECRETxyz123" https://api.example.com';
      const result = redactCommand(raw);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('SECRETxyz123');
      expect(serialized).not.toContain('Bearer');
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('api.example.com');
    });
  });

  describe('credentials never reach display, program or subcommand', () => {
    const leaks: Array<[string, string]> = [
      ['echo sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', 'sk-ant'],
      ['echo ghp_abcdefghijklmnop', 'ghp_'],
      ['echo hunter2', 'hunter2'],
      ['export GITHUB_TOKEN', 'GITHUB_TOKEN'],
      ['printf AKIAABCDEFGHIJKLMNOP', 'AKIA'],
      ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_'],
      ['sk-proj-abc123', 'sk-proj'],
      ['mytool A1b2C3d4E5f6G7h8I9j0K1', 'A1b2C3'],
      ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalr'],
      ['/bin/echo hunter2', 'hunter2'],
      ['ECHO hunter2', 'hunter2'],
      ['PASSWORD="correct horse battery" ./run', 'horse'],
      ['"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.AbCdEf1234567890"', 'eyJ'],
      ["'sk-proj-abc123'", 'sk-proj'],
    ];
    it.each(leaks)('%s', (raw, secret) => {
      const result = redactCommand(raw);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.display.length).toBeGreaterThan(0);
    });

    it('marks a pasted key as a secret and shows a placeholder', () => {
      const result = redactCommand('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
      expect(result.display).toBe('<redacted>');
      expect(result.hadPotentialSecret).toBe(true);
    });

    it('still shows ordinary programs, paths and subcommands', () => {
      expect(redactCommand('sudo python3 x.py').display).toBe('sudo python3');
      expect(redactCommand('pnpm test:e2e').display).toBe('pnpm test:e2e');
      expect(redactCommand('x86_64-linux-gnu-gcc main.c').display).toBe('x86_64-linux-gnu-gcc');
      expect(redactCommand('pnpm build:android-release-2024').display).toBe('pnpm build:android-release-2024');
      expect(redactCommand('PASSWORD="a b c" ./run go').display).toBe('./run go');
      expect(redactCommand('./scripts/deploy-production-environment-now.sh prod').display).toBe(
        './scripts/deploy-production-environment-now.sh prod',
      );
    });
  });

  describe('secret detection: nearby variants', () => {
    it.each([
      'OPENAI_API_KEY=sk-short node x',
      'export DB_PASSWORD=hunter2',
      'export GITHUB_TOKEN=abc',
      'env AWS_SECRET_ACCESS_KEY=abc aws s3 ls',
      'psql --db-password=hunter2',
      'tool --client-secret abc',
      'mysql -phunter2 app',
      'PGPASSWORD=hunter2 psql',
      'sshpass -p hunter2 ssh host',
      'docker login -u me -p hunter2 ghcr.io',
      'redis-cli -a hunter2 ping',
      'curl -u admin:hunter2 https://x',
      'curl --user=admin:hunter2 https://x',
      'curl -H "Proxy-Authorization: Basic YWRtaW46aHVudGVy" x',
      'curl -H "X-Auth-Token: abc" x',
      'curl -H "Private-Token: abc" x',
      'http GET x "Bearer abcdef123"',
      'tool --api-key abc',
      'git clone https://user:tok@github.com/a/b',
      'curl "https://x/api?access_token=abc"',
      'curl "https://x/api?a=1&api_key=abc"',
      'curl "https://bucket.s3/x?X-Amz-Signature=abc"',
    ])('flags %s', (raw) => {
      expect(redactCommand(raw).hadPotentialSecret).toBe(true);
    });

    it.each([
      'mysql -P 3306 -h db',
      'mysql -u root -p mydb',
      'tool --sort-key name',
      'git commit -m "basic example"',
      'docker run -p 8080:80 nginx',
      'mkdir -p src/lib',
      'docker login --password-stdin ghcr.io',
      'curl https://example.com/a?page=2',
      'git push origin main',
      'cd ~/keyboard-layouts',
    ])('does not flag %s', (raw) => {
      expect(redactCommand(raw).hadPotentialSecret).toBe(false);
    });
  });
});
