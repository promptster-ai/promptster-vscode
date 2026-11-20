import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import * as config from '../../src/config';
import { fromJson } from '../../src/config';
vi.mock('vscode', () => import('../fakes/vscode'));
import { state, resetState } from '../fakes/vscode';
import { AssessmentView, parseWorkspaceBrief, hostedBrief, changedFiles, submitDetail } from '../../src/ui/assessment';
let root: string;
const session = fromJson({apiUrl:'https://api.example.test',sessionToken:'test',sessionId:'s1',tools:['codex'],consentAccepted:true,noSelfEvict:true},'.promptster/session.json')!;
let receive: (request: unknown) => Promise<void>;
function view() {
  const instance = new AssessmentView({subscriptions:[]} as never);
  instance.resolveWebviewView({webview:{options:{},html:'',postMessage:vi.fn(),onDidReceiveMessage:(fn: typeof receive)=>{receive=fn;return {dispose(){}}}}} as never);
  return instance;
}
beforeEach(()=>{vi.restoreAllMocks();resetState();root=mkdtempSync(join(tmpdir(),'assessment-view-'));state.workspaceRoot=root;writeFileSync(join(root,'assessment.json'),JSON.stringify({id:'INV-907',title:'Inventory incident',specFile:'INV-907.spec'}));vi.spyOn(config,'readSession').mockReturnValue(session)});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
describe('native assessment actions',()=>{
  it('shows the ticket in a webview panel and writes nothing into the repo', async () => {
    const source = '# Ticket\n\nOriginal notes <script>bad()</script>';
    writeFileSync(join(root, 'TASK.md'), source);
    const before = readdirSync(root).sort();
    view(); await receive({ action: 'ticket', sessionId: 's1' });
    expect(state.panels).toHaveLength(1);
    expect(state.panels[0]).toMatchObject({ viewType: 'promptster.ticket', title: 'INV-907 · Ticket', options: { enableScripts: false, localResourceRoots: [] } });
    expect(state.panels[0].webview.html).toContain('&lt;script&gt;');
    expect(readdirSync(root).sort()).toEqual(before);
    expect(readFileSync(join(root, 'TASK.md'), 'utf8')).toBe(source);
    // A second click re-renders the same panel from the current TASK.md.
    writeFileSync(join(root, 'TASK.md'), '# Ticket\n\nUpdated');
    await receive({ action: 'ticket', sessionId: 's1' });
    expect(state.panels).toHaveLength(1);
    expect(state.panels[0].webview.html).toContain('Updated');
    expect(state.panels[0].revealed).toBe(2);
    // Closed, the next click opens a fresh one.
    state.panels[0].dispose();
    await receive({ action: 'ticket', sessionId: 's1' });
    expect(state.panels).toHaveLength(2);
  });
  it('launches the permitted native tool once, then focuses its terminal',async()=>{view();await receive({action:'tool',tool:'codex',sessionId:'s1'});await receive({action:'tool',tool:'codex',sessionId:'s1'});expect(state.terminals).toHaveLength(1);expect(state.terminals[0].commands).toEqual(['promptster codex']);expect(state.terminals[0].shown).toBe(true)});
  it('focuses the agent terminal launched by the existing session lifecycle', async () => {
    const instance = view();
    const terminal = { show: vi.fn(), sendText: vi.fn() };
    instance.trackTool('s1', 'codex', terminal as never);
    await receive({ action: 'tool', tool: 'codex', sessionId: 's1' });
    expect(terminal.show).toHaveBeenCalledOnce();
    expect(terminal.sendText).not.toHaveBeenCalled();
    expect(state.terminals).toHaveLength(0);
  });
  it('does not submit if consent changes while confirmation is open', async () => {
    view();
    const window = vscode.window as unknown as Record<string, unknown>;
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const previous = [window.showWarningMessage, workspace.saveAll];
    window.showWarningMessage = vi.fn(async () => {
      vi.spyOn(config, 'readSession').mockReturnValue({ ...session, consentAccepted: false });
      return 'Submit now';
    });
    workspace.saveAll = vi.fn(async () => true);
    try {
      await receive({ action: 'submit', sessionId: 's1' });
      // The view does not await its handler: let the flow run past the modal.
      await vi.waitFor(() => expect(window.showWarningMessage).toHaveBeenCalled());
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(state.terminals).toHaveLength(0);
    } finally {
      if (previous[0] === undefined) delete window.showWarningMessage; else window.showWarningMessage = previous[0];
      if (previous[1] === undefined) delete workspace.saveAll; else workspace.saveAll = previous[1];
    }
  });
  // `promptster done` submits with no prompt of its own: the modal is the only
  // confirmation, so it must say it submits now and show what goes.
  it('says submitting is final and lists what changed since the base commit', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
    git('init', '-q'); writeFileSync(join(root, '.gitignore'), 'ignored/\n'); writeFileSync(join(root, 'a.py'), 'a\n'); writeFileSync(join(root, 'same.py'), 's\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'a.py'), 'changed\n'); writeFileSync(join(root, 'committed.py'), 'c\n'); git('add', 'committed.py'); git('commit', '-qm', 'agent commit');
    writeFileSync(join(root, 'new.py'), 'n\n'); mkdirSync(join(root, '.promptster')); writeFileSync(join(root, '.promptster', 'session.json'), '{}'); mkdirSync(join(root, 'ignored')); writeFileSync(join(root, 'ignored', 'x'), 'x');
    vi.spyOn(config, 'readSession').mockReturnValue(fromJson({ apiUrl: 'https://api.example.test', sessionToken: 'test', sessionId: 's1', tools: ['codex'], consentAccepted: true, diffBaseCommit: base, repoCommit: 'deadbeef', startedAt: new Date().toISOString(), timeLimitMinutes: 30 }, '.promptster/session.json')!);
    const window = vscode.window as unknown as Record<string, unknown>;
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const previous = [window.showWarningMessage, workspace.saveAll];
    const confirm = vi.fn(async (..._args: unknown[]) => undefined);
    window.showWarningMessage = confirm;
    workspace.saveAll = vi.fn(async () => true);
    try {
      view(); await receive({ action: 'submit', sessionId: 's1' });
      await vi.waitFor(() => expect(confirm).toHaveBeenCalled(), { timeout: 10_000 });
      const [message, options, button] = confirm.mock.calls[0] as [string, { modal: boolean; detail: string }, string];
      expect(message).toBe('Submit your assessment now?');
      expect(button).toBe('Submit now');
      expect(options.modal).toBe(true);
      expect(options.detail).toContain("can't undo it");
      expect(options.detail).toMatch(/Time left: \d+:\d\d\./);
      expect(options.detail).toContain('Changed files (3):\n  a.py\n  committed.py\n  new.py');
      expect(options.detail).not.toContain('ignored');
      expect(options.detail).not.toContain('.promptster');
      // Cancelling saves nothing.
      expect(workspace.saveAll).not.toHaveBeenCalled();
      // Cancelled: nothing runs.
      expect(state.terminals).toHaveLength(0);
    } finally {
      if (previous[0] === undefined) delete window.showWarningMessage; else window.showWarningMessage = previous[0];
      if (previous[1] === undefined) delete workspace.saveAll; else workspace.saveAll = previous[1];
    }
  }, 20_000);
  it('does not start a second submit once time has run out', async () => {
    vi.spyOn(config, 'readSession').mockReturnValue({ ...session, deadlineAt: Date.now() - 1_000 });
    const window = vscode.window as unknown as Record<string, unknown>;
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const previous = [window.showWarningMessage, workspace.saveAll];
    window.showWarningMessage = vi.fn(async () => 'Submit now');
    workspace.saveAll = vi.fn(async () => true);
    const told = vi.spyOn(vscode.window, 'showInformationMessage');
    try {
      view(); await receive({ action: 'submit', sessionId: 's1' });
      await vi.waitFor(() => expect(told).toHaveBeenCalledWith("Time's up. Your work is being submitted automatically."), { timeout: 10_000 });
      expect(state.terminals).toHaveLength(0);
    } finally {
      if (previous[0] === undefined) delete window.showWarningMessage; else window.showWarningMessage = previous[0];
      if (previous[1] === undefined) delete workspace.saveAll; else workspace.saveAll = previous[1];
    }
  }, 20_000);
  it('never reports an unknown change list as no changes', async () => {
    expect(await changedFiles(root, undefined)).toBeNull(); // not a git repo, so no HEAD~1 either
    expect(await changedFiles(root, 'abcdef1')).toBeNull();
    expect(submitDetail(null, undefined)).toContain("Couldn't list your changed files.");
    expect(submitDetail(null, undefined)).not.toContain('Time left');
    expect(submitDetail([], undefined)).toContain('No changes found in this workspace.');
    expect(submitDetail([], undefined, 2)).toContain('Unsaved changes in 2 open files will be saved and submitted.');
    const many = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}`);
    expect(submitDetail(many, undefined)).toContain('Changed files (12):\n  f00');
    expect(submitDetail(many, undefined)).toContain('  f09\n  and 2 more');
  });
  it('opens one submission flow for a double-click', async () => {
    view();
    const window = vscode.window as unknown as Record<string, unknown>;
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const previous = [window.showWarningMessage, workspace.saveAll];
    window.showWarningMessage = vi.fn(async () => 'Submit now');
    workspace.saveAll = vi.fn(async () => true);
    try {
      await Promise.all([receive({ action: 'submit', sessionId: 's1' }), receive({ action: 'submit', sessionId: 's1' })]);
      await vi.waitFor(() => expect(state.terminals).toHaveLength(1));
      expect(state.terminals[0].commands).toEqual(['promptster done']);
      expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    } finally {
      if (previous[0] === undefined) delete window.showWarningMessage; else window.showWarningMessage = previous[0];
      if (previous[1] === undefined) delete workspace.saveAll; else workspace.saveAll = previous[1];
    }
  });
  it('focuses an agent terminal restored into a new window, which has its name but not its env', async () => {
    const window = vscode.window as unknown as { terminals?: unknown[] };
    const restored = { name: 'Promptster Assessment', creationOptions: {}, show: vi.fn(), sendText: vi.fn() };
    window.terminals = [restored];
    try {
      view(); await receive({ action: 'tool', tool: 'codex', sessionId: 's1' });
      expect(restored.show).toHaveBeenCalledOnce();
      expect(restored.sendText).not.toHaveBeenCalled();
      expect(state.terminals).toHaveLength(0);
    } finally { delete window.terminals; }
  });
  it('does not take the auto-launch terminal for a tool it never ran', async () => {
    const window = vscode.window as unknown as { terminals?: unknown[] };
    const restored = { name: 'Promptster Assessment', creationOptions: {}, show: vi.fn(), sendText: vi.fn() };
    window.terminals = [restored];
    vi.spyOn(config, 'readSession').mockReturnValue({ ...session, tools: ['claude', 'codex'] });
    try {
      view(); await receive({ action: 'tool', tool: 'codex', sessionId: 's1' });
      expect(restored.show).not.toHaveBeenCalled();
      expect(state.terminals).toEqual([{ name: 'Codex', shown: true, commands: ['promptster codex'] }]);
    } finally { delete window.terminals; }
  });
  it('never matches a terminal by name on a local session, which can outlive its session', async () => {
    const window = vscode.window as unknown as { terminals?: unknown[] };
    const stale = { name: 'Codex', creationOptions: {}, show: vi.fn(), sendText: vi.fn() };
    window.terminals = [stale];
    vi.spyOn(config, 'readSession').mockReturnValue({ ...session, hosted: false });
    try {
      view(); await receive({ action: 'tool', tool: 'codex', sessionId: 's1' });
      expect(stale.show).not.toHaveBeenCalled();
      expect(state.terminals).toHaveLength(1);
    } finally { delete window.terminals; }
  });
  it('a click during a pending restore waits for it instead of starting a second agent', async () => {
    const instance = view();
    let restore!: () => void;
    const restored = { show: vi.fn(), sendText: vi.fn() };
    instance.awaitRestore(new Promise<void>(resolve => { restore = () => { instance.trackTool('s1', 'codex', restored as never); resolve(); }; }));
    const click = receive({ action: 'tool', tool: 'codex', sessionId: 's1' });
    restore();
    await click;
    await new Promise(resolve => setTimeout(resolve, 0)); // the view runs handlers fire-and-forget
    expect(restored.show).toHaveBeenCalledOnce();
    expect(restored.sendText).not.toHaveBeenCalled();
    expect(state.terminals).toHaveLength(0);
  });
  it('launches nothing if the session ended during the restore wait', async () => {
    const instance = view();
    let finish!: () => void;
    instance.awaitRestore(new Promise<void>(resolve => { finish = resolve; }));
    const click = receive({ action: 'tool', tool: 'codex', sessionId: 's1' });
    vi.spyOn(config, 'readSession').mockReturnValue({ ...session, expiresAt: '2020-01-01T00:00:00Z' });
    finish();
    await click;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(state.terminals).toHaveLength(0);
  });
  it('rejects unassigned tools, shell text and stale session messages',async()=>{view();await receive({action:'tool',tool:'claude',sessionId:'s1'});await receive({action:'tool',tool:'codex; bad-command',sessionId:'s1'});await receive({action:'tool',tool:'codex',sessionId:'previous'});expect(state.terminals).toHaveLength(0)});
  it('rechecks consent and expiry when an action arrives',async()=>{view();vi.spyOn(config,'readSession').mockReturnValue({...session,consentAccepted:false});await receive({action:'tool',tool:'codex',sessionId:'s1'});vi.spyOn(config,'readSession').mockReturnValue({...session,expiresAt:'2020-01-01T00:00:00Z'});await receive({action:'tool',tool:'codex',sessionId:'s1'});expect(state.terminals).toHaveLength(0)});
  it('does not launch without an assessment workspace',async()=>{rmSync(join(root,'assessment.json'));view();await receive({action:'tool',tool:'codex',sessionId:'s1'});expect(state.terminals).toHaveLength(0)});
  it('rejects handoff paths outside the root and projects only public fields',()=>{expect(parseWorkspaceBrief({id:'INV-907',title:'test',specFile:'../secrets.spec'})).toBeNull();expect(parseWorkspaceBrief({id:'INV-907',title:'test',specFile:'INV-907.spec',hidden:'secret'})).toEqual({id:'INV-907',title:'test',specFile:'INV-907.spec'})});
});
describe('hosted box without assessment.json',()=>{
  // Nothing in the hosted lane writes assessment.json, so a live box never set
  // promptster.assessmentWorkspace and the submit button never appeared.
  const hosted = fromJson({apiUrl:'https://api.example.test',sessionToken:'test',sessionId:'s1',tools:['claude'],consentAccepted:true,noSelfEvict:true,assessmentTitle:'Fix the exporter',issueId:'tf-react-spectrum-8696'},'.promptster/session.json')!;
  beforeEach(()=>{rmSync(join(root,'assessment.json'));vi.spyOn(config,'readSession').mockReturnValue(hosted)});
  it('derives the brief from the ARM session and shows the view',()=>{
    const ctx = vi.spyOn(vscode.commands,'executeCommand');
    expect(hostedBrief(root,hosted)).toEqual({id:'tf-react-spectrum-8696',title:'Fix the exporter'});
    view();
    expect(ctx).toHaveBeenCalledWith('setContext','promptster.assessmentWorkspace',true);
  });
  it('picks up a lone ticket-flow spec stub as the handoff',()=>{
    writeFileSync(join(root,'ENG-2841.spec'),'# ENG-2841\n');
    expect(hostedBrief(root,hosted)).toEqual({id:'tf-react-spectrum-8696',title:'Fix the exporter',specFile:'ENG-2841.spec'});
  });
  it('stays hidden for a laptop session, or one with no title',()=>{
    expect(hostedBrief(root,{...hosted,hosted:false})).toBeNull();
    expect(hostedBrief(root,{...hosted,assessmentTitle:undefined})).toBeNull();
  });
  it('opens TASK.md instead of rendering a ticket',async()=>{
    writeFileSync(join(root,'TASK.md'),'# Task');
    const open = vi.spyOn(vscode.commands,'executeCommand');
    view(); await receive({action:'ticket',sessionId:'s1'});
    expect(open).toHaveBeenCalledWith('markdown.showPreview',expect.objectContaining({fsPath:join(root,'TASK.md')}));
    expect(existsSync(join(root,'TASK.html'))).toBe(false);
  });
});
describe('submit stays reachable', () => {
  // At 1440x900 the Assessment view got a third of the sidebar (~250px) and
  // clipped "Open Claude Code" and the whole Finish section below the fold.
  it('gives Assessment more of the sidebar than Teammates and pins the Finish section', () => {
    const views = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')).contributes.views.promptster as Array<{ id: string; initialSize: number }>;
    const size = (id: string) => views.find(v => v.id === id)!.initialSize;
    // Its content needs ~390px of the ~760px the two views share at 900px tall.
    const share = size('promptster.assessment') / (size('promptster.assessment') + size('promptster.teammates'));
    expect(share).toBeGreaterThanOrEqual(0.55);
    const source = readFileSync(join(__dirname, '../../src/ui/assessment.ts'), 'utf8');
    expect(source).toContain('#content>section:last-child{position:sticky;bottom:0;');
    expect(source).toMatch(/<section><div class="label">Finish your work<\/div>.*?<\/section><\/div><\/main>/);
  });
});
