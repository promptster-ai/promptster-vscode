/**
 * Redact a terminal command line into a structured, secret-safe summary.
 *
 * We never send the raw command line — it commonly contains API keys, bearer
 * tokens, passwords, or other credentials. Instead we extract just enough
 * signal (program, subcommand, arg count, flag presence) to know *what kind*
 * of command ran without leaking the values.
 */

export interface RedactedCommand {
  /**
   * Secret-safe string suitable for the canonical `data.command` field.
   * Format: `program` or `program subcommand`. Never contains flag values
   * or arbitrary arg text — only the program and (if present) subcommand.
   */
  display: string;
  /** First non-env-var token (e.g. "git", "pnpm", "curl"). */
  program: string;
  /** Second token if it is a positional subcommand (e.g. "push", "install"). */
  subcommand?: string;
  /** Total whitespace-separated tokens including the program. */
  tokenCount: number;
  /** Whether any flag (-x or --xyz) is present. */
  hasFlags: boolean;
  /** Whether the command line contained anything that looks like a secret. */
  hadPotentialSecret: boolean;
}

const ENV_PREFIX = /^[A-Z_][A-Z0-9_]*=/i;

const SECRET_FLAG_NAMES = [
  'token',
  'api-key',
  'apikey',
  'api_key',
  'key',
  'password',
  'pass',
  'pw',
  'secret',
  'bearer',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'private-key',
  'access-key',
  'access_token',
  'refresh_token',
];

const NAMES = SECRET_FLAG_NAMES.join('|');

/**
 * Names specific enough to count as a secret inside a longer name. Short ones
 * (`key`, `pass`, `auth`) are not: `--sort-key`, `--skip-auth`.
 */
const LONG_NAMES = 'password|passwd|secret|token|api-?key|api_key|credentials?|private-key|access-key';

/** `--token x`, `--password=x`, and compound names: `--db-password`, `--client-secret`. */
const SECRET_FLAG_PATTERN = new RegExp(
  `(?:^|\\s)-{1,2}(?:(?:${NAMES})|(?:[A-Za-z0-9]+[-_])+(?:${LONG_NAMES}))(?:[\\s=]|$)`,
  'i',
);

/** A header that carries a credential. */
const SECRET_HEADER_PATTERN =
  /\b(?:(?:Proxy-)?Authorization|X-API-Key|X-Api-Token|X-Auth-Token|X-Access-Token|Private-Token|Api-Key|Cookie|Set-Cookie)\s*:/i;

/** A bearer token on its own (httpie, wget). Case-sensitive, so prose doesn't match. */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/;

/**
 * `TOKEN=x`, a secret word as any `_` segment (`OPENAI_API_KEY=`,
 * `DB_PASSWORD=`), and a long one ending a segment (`PGPASSWORD=`).
 */
const SECRET_ENV_PATTERN = new RegExp(
  `(?:^|[\\s;&|(])(?:[A-Za-z0-9]+_)*(?:${NAMES}|pwd|[A-Za-z0-9]*(?:password|passwd|secret|token))(?:_[A-Za-z0-9]+)*=`,
  'i',
);

/** Credentials in a URL: `https://user:pass@host`, `?access_token=`, `&sig=`. */
const SECRET_URL_PATTERN = new RegExp(
  `://[^/\\s:@]+:[^/\\s@]+@|[?&](?:[A-Za-z0-9]+[-_])*(?:${NAMES}|passwd|sig|signature)=`,
  'i',
);

/**
 * Short password flags whose meaning depends on the program: `mysql -phunter2`,
 * `sshpass -p x`, `docker login -p x`, `redis-cli -a x`, `curl -u user:pass`.
 * Case-sensitive on purpose: `mysql -P 3306` is a port. `mysql -p db` (with a
 * space) prompts for the password, and `db` is the database.
 */
const SECRET_SHORT_FLAG_PATTERN =
  /(?:^|[\s;&|(])(?:(?:mysql|mysqldump|mysqladmin|mariadb)\b[^;&|]*\s-p\S|sshpass\b[^;&|]*\s-p\s*\S|(?:docker|podman|nerdctl|helm)\s+(?:registry\s+)?login\b[^;&|]*\s-p\s+\S|redis-cli\b[^;&|]*\s-a\s+\S|(?:curl|wget)\b[^;&|]*\s(?:-u|--user|--proxy-user)[\s=]+\S*:)/;

/** Long opaque blob (likely a token/key) — 30+ chars of base64-y alphabet. */
const OPAQUE_BLOB_PATTERN = /[A-Za-z0-9+/_=-]{30,}/;

/** Well-known credential prefixes (OpenAI/Anthropic/Stripe, GitHub, GitLab, Slack, AWS, Google, npm, JWT, Hugging Face). */
const KNOWN_SECRET_PREFIX =
  /^(?:sk|pk|rk)[-_]|^gh[pousr]_|^github_pat_|^glpat-|^xox[abprs]-|^A[KS]IA[A-Z0-9]|^AIza|^npm_|^eyJ|^hf_/;

/** Programs whose next word is data, not a subcommand (`echo hunter2`). */
const DATA_ARG_PROGRAMS = new Set(['echo', 'printf', 'print', 'export', 'set', 'setenv', 'read', 'eval']);

/** Would this single token leak a credential if shown? */
function tokenLooksSecret(raw: string): boolean {
  // Shell quotes are not part of the word: `"eyJ…"` is still a JWT.
  const t = raw.replace(/^['"]+|['"]+$/g, '');
  if (KNOWN_SECRET_PREFIX.test(t)) return true;
  // A path from somewhere or a dotted name (`./deploy.sh`, `~/bin/x`) is not a
  // key. A bare `/` is no proof: base64 keys (AWS secret keys) carry them.
  if (/^(?:\.{0,2}\/|~)/.test(t) || t.includes('.')) return false;
  // Digits plus both cases over 16+ chars is a key (`wJalrXUtnFEMI/K7MDENG…`);
  // names and target triples are one case (`x86_64-linux-gnu-gcc`).
  if (t.length >= 16 && /\d/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t)) return true;
  // A 30+ char run with digits (hex keys); long hyphenated words have none.
  return OPAQUE_BLOB_PATTERN.test(t) && /\d/.test(t);
}

/**
 * Index of the first token after the leading `NAME=value` assignments. A
 * quoted value can hold spaces (`PASSWORD="correct horse" ./run`), so the
 * words up to its closing quote are part of it, not the program.
 */
function skipAssignments(tokens: string[]): number {
  let i = 0;
  while (i < tokens.length && ENV_PREFIX.test(tokens[i])) {
    const value = tokens[i].slice(tokens[i].indexOf('=') + 1);
    const quote = value[0];
    i++;
    if ((quote === '"' || quote === "'") && !(value.length > 1 && value.endsWith(quote))) {
      while (i < tokens.length && !tokens[i].endsWith(quote)) i++;
      i++; // the token that closes the quote
    }
  }
  return Math.min(i, tokens.length);
}

export function redactCommand(raw: string): RedactedCommand {
  const trimmed = raw.trim();
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);

  const programIndex = skipAssignments(tokens);

  // A key pasted at the prompt is its own "program": never echo it back.
  const programRaw = tokens[programIndex] ?? '';
  const program = programRaw && tokenLooksSecret(programRaw) ? '<redacted>' : programRaw;
  const subcommandRaw = tokens[programIndex + 1];
  // A subcommand must look like a simple word — alphanumeric plus -, _, :
  // (the colon allows things like `cargo test:foo`). URLs, file paths, JSON,
  // and positional args won't match, so they never leak into `display`. A
  // word-shaped token can still be a credential (`echo sk-ant-…`, `ghp_…`), so
  // it must not look like one, and `echo`/`export` arguments are data.
  const subcommand =
    subcommandRaw &&
    program !== '<redacted>' &&
    !DATA_ARG_PROGRAMS.has((program.split('/').pop() ?? '').toLowerCase()) &&
    /^[A-Za-z][A-Za-z0-9_:-]*$/.test(subcommandRaw) &&
    !tokenLooksSecret(subcommandRaw)
      ? subcommandRaw
      : undefined;

  const hasFlags = tokens.some((t) => t.startsWith('-'));

  const hadPotentialSecret =
    SECRET_FLAG_PATTERN.test(trimmed) ||
    SECRET_HEADER_PATTERN.test(trimmed) ||
    BEARER_PATTERN.test(trimmed) ||
    SECRET_ENV_PATTERN.test(trimmed) ||
    SECRET_URL_PATTERN.test(trimmed) ||
    SECRET_SHORT_FLAG_PATTERN.test(trimmed) ||
    OPAQUE_BLOB_PATTERN.test(trimmed) ||
    program === '<redacted>';

  const display = subcommand ? `${program} ${subcommand}` : program || '<empty>';

  return {
    display,
    program,
    subcommand,
    tokenCount: tokens.length,
    hasFlags,
    hadPotentialSecret,
  };
}
