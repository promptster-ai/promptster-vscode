import * as vscode from 'vscode';

export function showConsentDetails(context: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    'promptsterConsent',
    'Promptster — Captured Signals',
    vscode.ViewColumn.One,
    { enableScripts: false },
  );

  panel.webview.html = getConsentHtml();
}

function getConsentHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Promptster — What We Capture</title>
  <style>
    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 24px;
      line-height: 1.6;
    }
    h1 { font-size: 1.5em; margin-bottom: 8px; }
    h2 { font-size: 1.1em; margin-top: 24px; margin-bottom: 8px; color: var(--vscode-textLink-foreground); }
    .signal {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 8px;
    }
    .signal strong { display: block; margin-bottom: 4px; }
    .signal em { opacity: 0.7; font-size: 0.9em; }
    .not-captured {
      background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1));
      border-radius: 6px;
      padding: 12px 16px;
      margin-bottom: 8px;
    }
    .not-captured strong { display: block; margin-bottom: 4px; }
  </style>
</head>
<body>
  <h1>Promptster Assessment — Captured Signals</h1>
  <p>This page describes what <strong>this editor extension</strong> captures. It is one part of a Promptster session, not all of it.</p>

  <div class="signal">
    <strong>Captured elsewhere in your session</strong>
    <em>Your prompts to the AI tool, its responses and tool calls, code changes as diffs, full terminal command lines with their exit codes, and the output of commands the AI runs are captured by the rest of Promptster's session capture (its CLI hooks and AI proxy), not by this extension. The consent notice you accepted before starting describes what the session records.</em>
  </div>

  <h2>What this extension captures</h2>

  <div class="signal">
    <strong>File navigation</strong>
    <em>Which files you open and how long you view them. File paths (relative to workspace), language, line count.</em>
  </div>

  <div class="signal">
    <strong>Scroll depth</strong>
    <em>Where you are in a file: each time you scroll, the last line in view, that as a percentage of the file, and the file's line count. Not the text on those lines.</em>
  </div>

  <div class="signal">
    <strong>Edit patterns</strong>
    <em>For each burst of typing: characters typed, how long it took, and which lines it touched. For each paste: its size in characters and lines, never its text. Keystroke-interval timing only if you enabled cadence checks when the session started.</em>
  </div>

  <div class="signal">
    <strong>Idle periods</strong>
    <em>When there has been no activity in the editor for 60 seconds, how much longer it lasted after that, the file you were last in, and whether your last action was an edit or navigation. Not whether the editor window has focus.</em>
  </div>

  <div class="signal">
    <strong>Diagnostics</strong>
    <em>When you resolve errors/warnings (count only). Not the error messages themselves.</em>
  </div>

  <div class="signal">
    <strong>Terminal commands</strong>
    <em>For commands you run in the integrated terminal, wherever its current directory is: the program name and the word after it when that is a plain word (e.g. <code>git push</code>, <code>cd src</code>), how many words the command had, whether it had flags or looked like it contained a secret, its exit code and duration. This extension does not send the rest of the command line or its output.</em>
  </div>

  <div class="signal">
    <strong>File lifecycle</strong>
    <em>When files are created or deleted in the workspace. File path only.</em>
  </div>

  <h2>What this extension does NOT capture</h2>

  <div class="not-captured">
    <strong>Not captured by this extension:</strong>
    <em>File contents, source code, diffs, clipboard text, terminal output, AI prompt text, diagnostic messages, URLs, window focus or whether you switched to another application, screenshots, or anything outside your workspace (apart from the terminal commands above).</em>
  </div>

</body>
</html>`;
}
