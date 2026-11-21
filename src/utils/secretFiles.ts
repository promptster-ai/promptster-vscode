/**
 * Files that can carry a credential, which `promptster done` leaves out of the
 * upload. A port of promptster-cli fileFilter.go (excludedSecretFileNames,
 * cliOnlyPrivateKeyPrefixes, excludedSecretExtensions,
 * excludedSecretDirPrefixes, envTemplateSuffixes, isSecretFile), rule for
 * rule; test/unit/secretFiles.test.ts holds the Go test's cases. Change both
 * together.
 */
export const SECRET_FILE_NAMES = new Set([
  '.npmrc', '.yarnrc', '.netrc', '_netrc', '.pgpass', '.htpasswd', '.dockercfg',
  '.mcp.json', 'settings.local.json', 'credentials', 'credentials.json', 'service-account.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'secrets.yml', 'secrets.yaml', 'secrets.json',
  '.git-credentials',
]);
export const PRIVATE_KEY_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
export const SECRET_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'ppk', 'asc', 'gpg', 'kdbx']);
export const SECRET_DIR_PREFIXES = ['.ssh/', '.gnupg/', '.aws/', '.gcloud/'];
export const ENV_TEMPLATE_SUFFIXES = ['example', 'sample', 'template', 'dist', 'defaults'];

/** Whether a repo-relative path (`/`-separated) names a credential file. */
export function isSecretFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (SECRET_DIR_PREFIXES.some(prefix => lower.startsWith(prefix) || lower.includes(`/${prefix}`))) return true;
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (!base) return false;
  if (SECRET_FILE_NAMES.has(base)) return true;
  if (!base.endsWith('.pub') && PRIVATE_KEY_PREFIXES.some(prefix => base.startsWith(prefix))) return true;
  const dot = base.lastIndexOf('.');
  if (dot > 0 && SECRET_EXTENSIONS.has(base.slice(dot + 1))) return true;
  // `.env`, `.env.local`, `.env.production.local`, but not `.env.example`.
  if (base === '.env' || base.startsWith('.env.')) {
    return !ENV_TEMPLATE_SUFFIXES.some(s => base === `.env.${s}` || base.endsWith(`.${s}`) || base.startsWith(`.env.${s}.`));
  }
  // `local.env`, `prod.env`: the same file with the parts swapped.
  if (base.endsWith('.env')) return !ENV_TEMPLATE_SUFFIXES.some(s => base === `${s}.env`);
  return false;
}
