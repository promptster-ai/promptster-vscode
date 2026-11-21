import { describe, expect, it } from 'vitest';
import { isSecretFile, SECRET_FILE_NAMES, PRIVATE_KEY_PREFIXES, SECRET_EXTENSIONS, SECRET_DIR_PREFIXES, ENV_TEMPLATE_SUFFIXES } from '../../src/utils/secretFiles';

// Copied verbatim from promptster-cli fileFilter.go and secret_files_test.go
// (TestIsSecretFile). When the CLI's lists or cases change, update these and
// src/utils/secretFiles.ts together, or the submit confirmation lists files
// the upload leaves out.
const cli = {
  names: ['.npmrc', '.yarnrc', '.netrc', '_netrc', '.pgpass', '.htpasswd', '.dockercfg', '.mcp.json', 'settings.local.json', 'credentials', 'credentials.json', 'service-account.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'secrets.yml', 'secrets.yaml', 'secrets.json', '.git-credentials'],
  keyPrefixes: ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'],
  extensions: ['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'ppk', 'asc', 'gpg', 'kdbx'],
  dirPrefixes: ['.ssh/', '.gnupg/', '.aws/', '.gcloud/'],
  envTemplateSuffixes: ['example', 'sample', 'template', 'dist', 'defaults'],
  secret: ['.npmrc', 'web/.npmrc', '.mcp.json', '.claude/settings.local.json', 'certs/server.PEM', 'tls.key', '.ssh/config', 'home/.ssh/known_hosts', '.aws/config', '.gnupg/x', 'id_ed25519', 'credentials', '.git-credentials', 'id_rsa.bak', 'keys/id_ed25519.old', 'ID_DSA_backup', 'id_ecdsa-2024', '.env', '.env.local', '.env.production.local', 'local.env', 'secrets.yaml'],
  kept: ['main.go', '.env.example', '.env.sample.local', 'example.env', '.claude/settings.json', 'key.go', 'keys/readme.md', 'id_rsa.pub', 'id_ed25519.old.pub', 'my_id_rsa.go', 'src/sshd/main.go', '.pem'],
};

describe('isSecretFile matches promptster-cli', () => {
  it('has the same lists', () => {
    const sorted = (values: Iterable<string>) => [...values].sort();
    expect(sorted(SECRET_FILE_NAMES)).toEqual(sorted(cli.names));
    expect(sorted(PRIVATE_KEY_PREFIXES)).toEqual(sorted(cli.keyPrefixes));
    expect(sorted(SECRET_EXTENSIONS)).toEqual(sorted(cli.extensions));
    expect(sorted(SECRET_DIR_PREFIXES)).toEqual(sorted(cli.dirPrefixes));
    expect(sorted(ENV_TEMPLATE_SUFFIXES)).toEqual(sorted(cli.envTemplateSuffixes));
  });
  it('decides the same cases', () => {
    expect(cli.secret.filter(path => !isSecretFile(path))).toEqual([]);
    expect(cli.kept.filter(path => isSecretFile(path))).toEqual([]);
  });
});
