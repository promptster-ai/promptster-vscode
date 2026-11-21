import * as vscode from 'vscode';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { showTicket } from './ticket';
import { join, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { timeLeftText } from './timeLeft';
import { readSession, isExpired } from '../config';
import type { PromptsterSession } from '../types';

/** `specFile` is absent for a plain (non-ticket) problem: there is no handoff to open. */
interface WorkspaceBrief { id: string; title: string; specFile?: string }
const SPEC_FILE = /^[a-zA-Z0-9_-]+\.spec$/;
const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const;
/** The terminal the hosted auto-launch opens (src/extension.ts). */
export const AUTO_TERMINAL_NAME = 'Promptster Assessment';

/**
 * The session's live agent terminal for `tool`, if one exists in this window.
 *
 * A terminal created in this window carries its session and tool in
 * `creationOptions.env`. One RESTORED into a new window (the candidate reopened
 * the box from another browser) comes back with its name but without that env,
 * so on a HOSTED session it is matched by name: the view's per-tool name, or
 * the auto-launch's, which always runs the session's preferred tool. Missing it
 * meant the button started a second agent beside the restored one. A hosted box
 * only ever holds one session, so a name cannot belong to another; a local
 * editor can switch sessions with old terminals still open, so it never
 * matches by name.
 */
export function findAgentTerminal(session: Pick<PromptsterSession, 'sessionId' | 'tools' | 'hosted'>, tool: 'claude' | 'codex'): vscode.Terminal | undefined {
  const { sessionId, tools } = session;
  const autoTool = tools.includes('claude') ? 'claude' : 'codex';
  return vscode.window.terminals?.find(candidate => {
    if (candidate.exitStatus) return false;
    const env = (candidate.creationOptions as vscode.TerminalOptions | undefined)?.env;
    if (env?.PROMPTSTER_TERMINAL_SESSION_ID) {
      return env.PROMPTSTER_TERMINAL_SESSION_ID === sessionId && env.PROMPTSTER_TERMINAL_TOOL === tool;
    }
    if (!session.hosted) return false;
    return candidate.name === TOOL_NAMES[tool] || (candidate.name === AUTO_TERMINAL_NAME && tool === autoTool);
  });
}

export function parseWorkspaceBrief(raw: unknown): WorkspaceBrief | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.specFile !== 'string') return null;
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(value.id) || !value.title.trim() || value.title.length > 300 || !SPEC_FILE.test(value.specFile)) return null;
  return { id: value.id, title: value.title, specFile: value.specFile };
}

function briefAt(root: string): WorkspaceBrief | null {
  try { return parseWorkspaceBrief(JSON.parse(readFileSync(join(root, 'assessment.json'), 'utf8'))); }
  catch { return null; }
}

/**
 * The brief for a hosted box, which has no `assessment.json`.
 *
 * Nothing in the hosted lane writes `assessment.json` — not provisioning, not
 * ARM, not `promptster start --seeded` — so gating the view on it alone meant
 * `promptster.assessmentWorkspace` was false on every hosted box and the
 * candidate never saw the submit button. ARM's session already carries the
 * title and problem key; a root-level `<key>.spec` (the ticket-flow stub
 * provisioning seeds) is the handoff when there is exactly one.
 */
export function hostedBrief(root: string, session: PromptsterSession | null): WorkspaceBrief | null {
  if (!session?.hosted) return null;
  const title = session.assessmentTitle?.trim();
  if (!title || title.length > 300) return null;
  const id = session.issueId && /^[a-zA-Z0-9-]{1,80}$/.test(session.issueId) ? session.issueId : '';
  let specs: string[] = [];
  try { specs = readdirSync(root).filter(name => SPEC_FILE.test(name)); } catch { /* no root, no spec */ }
  return specs.length === 1 ? { id, title, specFile: specs[0] } : { id, title };
}

function workspaceBrief(root: string | undefined, session: PromptsterSession | null): WorkspaceBrief | null {
  return root ? briefAt(root) ?? hostedBrief(root, session) : null;
}

/** What `promptster done` leaves out of `git add -A` (promptster-cli gitExcludePathspecs). */
const NOT_SUBMITTED = ['--', '.', ...['TASK.md', '.promptster/', '.claude/settings.local.json', '.claude/commands/explain.md'].map(path => `:(top,exclude)${path}`)];

/**
 * The files the candidate changed, as `promptster done` sees them: the diff
 * against the CLI's base commit (HEAD~1 when the session records none, as the
 * CLI does) plus untracked files, as of now on disk. Null when that can't be
 * known (git fails), so the confirmation says so instead of "no changes".
 */
export async function changedFiles(root: string, base: string | undefined): Promise<string[] | null> {
  base ??= 'HEAD~1';
  const git = (...args: string[]) => new Promise<string[]>((resolve, reject) =>
    execFile('git', ['-C', root, ...args], { timeout: 5_000, maxBuffer: 8 << 20 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout).split('\0').filter(Boolean))));
  try {
    const [diff, untracked] = await Promise.all([
      git('diff', '--name-only', '--relative', '-z', base, ...NOT_SUBMITTED),
      git('ls-files', '--others', '--exclude-standard', '-z', ...NOT_SUBMITTED),
    ]);
    return [...new Set([...diff, ...untracked])].sort();
  } catch {
    return null;
  }
}

/** Unsaved editors on disk under the task root: the ones saving can put into the upload. Untitled buffers can't. */
export function unsavedUnder(taskRoot: string): number {
  return (vscode.workspace.textDocuments ?? []).filter(document => {
    if (!document.isDirty || document.uri.scheme !== 'file') return false;
    const inside = relative(taskRoot, document.uri.fsPath);
    return !!inside && !inside.startsWith('..') && !isAbsolute(inside);
  }).length;
}

/** The submit confirmation's detail: what submitting does, the time left, and what changed. */
export function submitDetail(files: string[] | null, deadlineAt: number | undefined, unsaved = 0, now = Date.now()): string {
  const lines = ["This uploads your workspace as it is now and ends the assessment. You can't undo it or keep working afterwards."];
  if (deadlineAt !== undefined) lines.push(`Time left: ${timeLeftText(deadlineAt - now)}. Your work is submitted automatically when it runs out.`);
  if (files === null) lines.push("Couldn't list your changed files.");
  else if (!files.length) lines.push('No changes found in this workspace.');
  else {
    const shown = files.slice(0, 10).map(file => `  ${file}`);
    if (files.length > 10) shown.push(`  and ${files.length - 10} more`);
    lines.push(`Changed files (${files.length}):\n${shown.join('\n')}`, 'Secret files such as .env and private keys are left out of the upload.');
  }
  if (unsaved) lines.push(`Unsaved changes in ${unsaved} open file${unsaved === 1 ? '' : 's'} will be saved before submitting.`);
  return lines.join('\n\n');
}

/** Open TASK.md rendered. Falls back to the source if the markdown preview is unavailable. */
export async function openTaskMd(root: string): Promise<void> {
  const uri = vscode.Uri.file(join(root, 'TASK.md'));
  if (!existsSync(uri.fsPath)) return;
  try {
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  } catch {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
  }
}

/** Native navigation only. No extra model API, credentials, or teammate transcript export. */
export class AssessmentView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private terminals = new Map<string, vscode.Terminal>();
  /** A submit is awaiting confirmation or saving; a second click must not start another. */
  private submitting = false;
  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
      for (const [key, value] of this.terminals) if (value === terminal) this.terminals.delete(key);
    }));
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    this.context.subscriptions.push(view.webview.onDidReceiveMessage(request => void this.handle(request)));
    this.refresh();
  }
  refresh(): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const session = readSession();
    const brief = workspaceBrief(root, session);
    const ready = !!(brief && session?.consentAccepted && !isExpired(session));
    void vscode.commands.executeCommand('setContext', 'promptster.assessmentWorkspace', ready);
    if (!this.view) return;
    void this.view.webview.postMessage({
      type: 'state', brief: ready ? brief : null, sessionId: ready ? session!.sessionId : null,
      tools: ready ? [...new Set(session!.tools)].map(id => ({ id, name: TOOL_NAMES[id] })) : [],
    });
  }
  trackTool(sessionId: string, tool: 'claude' | 'codex', terminal: vscode.Terminal): void {
    this.terminals.set(`${sessionId}:${tool}`, terminal);
  }
  /**
   * A restore the extension is still waiting on. A click that lands first must
   * wait for it, or it starts a second agent beside the one being restored.
   */
  awaitRestore(restore: Promise<unknown>): void {
    const pending = restore.finally(() => { if (this.pendingRestore === pending) this.pendingRestore = undefined; });
    this.pendingRestore = pending;
  }
  private pendingRestore?: Promise<unknown>;
  private async handle(request: { type?: unknown; action?: unknown; sessionId?: unknown; tool?: unknown }): Promise<void> {
    if (request.type === 'ready') { this.refresh(); return; }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const session = readSession();
    const brief = workspaceBrief(root, session);
    if (!root || !brief || !session?.consentAccepted || isExpired(session) || request.sessionId !== session.sessionId) return;
    try {
      if (request.action === 'ticket') {
        const specFile = brief.specFile;
        if (!specFile) { await openTaskMd(root); return; }
        showTicket(readFileSync(join(root, 'TASK.md'), 'utf8'), { ...brief, specFile });
      } else if (request.action === 'handoff') {
        if (!brief.specFile) return;
        const uri = vscode.Uri.file(join(root, brief.specFile));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
      } else if (request.action === 'tool') {
        const tool = request.tool;
        if ((tool !== 'claude' && tool !== 'codex') || !session.tools.includes(tool)) return;
        const key = `${session.sessionId}:${tool}`;
        let terminal = this.terminals.get(key) ?? findAgentTerminal(session, tool);
        if (!terminal && this.pendingRestore) {
          await this.pendingRestore;
          // The wait can be long enough for the session to end or change.
          const current = readSession();
          if (!current || current.sessionId !== session.sessionId || !current.consentAccepted || isExpired(current) || !current.tools.includes(tool)) return;
          terminal = this.terminals.get(key) ?? findAgentTerminal(current, tool);
        }
        if (!terminal) {
          terminal = vscode.window.createTerminal({ name: TOOL_NAMES[tool], cwd: root, env: { PROMPTSTER_TERMINAL_SESSION_ID: session.sessionId, PROMPTSTER_TERMINAL_TOOL: tool } });
          this.terminals.set(key, terminal);
          terminal.sendText(tool === 'codex' ? 'promptster codex' : 'claude', true);
        }
        terminal.show();
      } else if (request.action === 'submit') {
        // Keep the established CLI upload flow; do not fake completion.
        const key = `${session.sessionId}:submit`;
        let terminal = this.terminals.get(key);
        if (!terminal) {
          if (this.submitting) return;
          this.submitting = true;
          try {
            // `promptster done` submits at once, with no prompt of its own, so this
            // modal is the only confirmation: it must say that, and show what goes.
            // Nothing is saved until the candidate accepts; unsaved editors are counted.
            const taskRoot = session.taskRoot ?? root;
            const unsaved = unsavedUnder(taskRoot);
            const detail = submitDetail(await changedFiles(taskRoot, session.diffBase), session.deadlineAt, unsaved);
            const accepted = await vscode.window.showWarningMessage('Submit your assessment now?', { modal: true, detail }, 'Submit now');
            if (accepted !== 'Submit now') return;
            const current = readSession();
            if (!current?.consentAccepted || current.sessionId !== session.sessionId || isExpired(current)) return;
            // Time ran out while the modal was open: the automatic submit is already running.
            if (current.deadlineAt !== undefined && current.deadlineAt <= Date.now()) {
              void vscode.window.showInformationMessage("Time's up. Your work is being submitted automatically.");
              return;
            }
            if (!await vscode.workspace.saveAll(false)) throw new Error('Some files could not be saved. Save them before submitting.');
            terminal = vscode.window.createTerminal({ name: 'Assessment submission', cwd: root });
            this.terminals.set(key, terminal);
            terminal.sendText('promptster done', true);
          } finally {
            this.submitting = false;
          }
        }
        terminal.show();
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not open assessment action: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function html(): string {
  const nonce = randomBytes(18).toString('hex');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">
  *{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:12px/1.6 var(--vscode-font-family)}main{padding:10px 14px 0}.label{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--vscode-descriptionForeground)}h1{font-size:15px;line-height:1.35;font-weight:600;margin:4px 0 12px}button{font:inherit;text-align:left;cursor:pointer;width:100%;padding:6px 10px;margin:0 0 6px;border-radius:3px;border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);color:var(--vscode-foreground)}button:hover{background:var(--vscode-list-hoverBackground)}button:focus-visible{outline:2px solid var(--vscode-focusBorder)}section{margin:12px 0 0;padding-top:10px;border-top:1px solid var(--vscode-panel-border)}p{color:var(--vscode-descriptionForeground);font-size:11px;margin:4px 0 8px}#content>section:last-child{position:sticky;bottom:0;padding-bottom:8px;background:var(--vscode-sideBar-background)}.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.primary:hover{background:var(--vscode-button-hoverBackground)}[hidden]{display:none!important}
  </style></head><body><main><div id="empty">Open your assessment to begin.</div><div id="content" hidden><div id="key" class="label"></div><h1 id="title"></h1><button id="ticket">Open ticket</button><button id="handoff">Open handoff</button><section><div class="label">Coding tool</div><p>Enabled by the hiring company. Opens in your integrated terminal.</p><div id="tools"></div></section><section><div class="label">Finish your work</div><p>Submitting uploads your work and ends the assessment.</p><button id="submit" class="primary">Submit assessment</button></section></div></main><script nonce="${nonce}">
  const api=acquireVsCodeApi(),el=id=>document.getElementById(id);let sessionId=null;const act=(action,tool)=>api.postMessage({action,tool,sessionId});el('ticket').onclick=()=>act('ticket');el('handoff').onclick=()=>act('handoff');el('submit').onclick=()=>act('submit');window.addEventListener('message',({data})=>{if(data.type!=='state')return;sessionId=data.sessionId;el('content').hidden=!data.brief;el('empty').hidden=!!data.brief;el('tools').replaceChildren();if(!data.brief)return;el('key').textContent=data.brief.id;el('title').textContent=data.brief.title;el('ticket').textContent=data.brief.specFile?'Open ticket':'Open task';el('handoff').hidden=!data.brief.specFile;el('handoff').textContent='Open '+(data.brief.specFile||'');for(const tool of data.tools){const b=document.createElement('button');b.textContent='Open '+tool.name;b.onclick=()=>act('tool',tool.id);el('tools').append(b)}if(!data.tools.length)el('tools').textContent='No coding tool is enabled for this session.'});api.postMessage({type:'ready'});
  </script></body></html>`;
}
