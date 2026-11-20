import * as vscode from 'vscode';

const escape = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * Inline markdown, on escaped text: `code` spans (any backtick run, closed by
 * one of the same length), then **bold** outside them. Anything else,
 * unmatched markers included, stays literal.
 */
function inline(text: string): string {
  const code: string[] = [];
  const keep = (html: string) => `\0${code.push(html) - 1}\0`;
  return escape(text.replace(/\0/g, ''))
    .replace(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _run: string, span: string) => keep(`<code>${/^ .*[^ ].* $/.test(span) ? span.slice(1, -1) : span}</code>`))
    .replace(/\\\|/g, '|')
    .replace(/\*\*(?=\S)((?:(?!\*\*).)+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/\0(\d+)\0/g, (_, n: string) => code[Number(n)]);
}

/** A table row's cells: split on `|`, but not an escaped `\|` (kept as `|`, code spans included) or one inside a code span. */
function cells(row: string): string[] {
  const out = [''];
  let tick = 0;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '`') {
      let run = 1;
      while (row[i + run] === '`') run++;
      // A run opens a span only if a run of the same length closes it later.
      if (tick === run) tick = 0;
      else if (!tick && new RegExp(`(?<!\`)\`{${run}}(?!\`)`).test(row.slice(i + run))) tick = run;
      out[out.length - 1] += row.slice(i, i + run);
      i += run - 1;
    } else if (c === '\\' && row[i + 1] === '|') { out[out.length - 1] += '|'; i++; }
    else if (c === '|' && !tick) out.push('');
    else out[out.length - 1] += c;
  }
  if (!out[0].trim()) out.shift();
  if (out.length && !out[out.length - 1].trim()) out.pop();
  return out.map(cell => cell.trim());
}

/** A blank line, heading, bullet, quote or rule ends a table, even when it holds a `|`. */
const ENDS_TABLE = /^\s*$|^#{1,6} |^\s*[-*+] |^\s*>|^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTable = (head: string, rule = ''): boolean =>
  head.includes('|') && rule.includes('|') && TABLE_RULE.test(rule) && cells(head).length === cells(rule).length;

/**
 * One block per source line (line breaks kept), plus headings (ATX and
 * setext), rules, bullets and pipe tables.
 */
function blocks(lines: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const last = out[out.length - 1];
    if (isTable(line, lines[i + 1])) {
      const width = cells(line).length;
      const row = (tag: string, text: string) => `<tr>${cells(text).slice(0, width).map(cell => `<${tag}>${inline(cell)}</${tag}>`).join('')}</tr>`;
      const rows: string[] = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && !ENDS_TABLE.test(lines[i]); i++) rows.push(row('td', lines[i]));
      i--;
      out.push(`<table><thead>${row('th', line)}</thead><tbody>${rows.join('')}</tbody></table>`);
    } else if (/^\s*(=+|-+)\s*$/.test(line) && lines[i - 1]?.trim() && last?.startsWith('<p>')) {
      out[out.length - 1] = `<h3>${last.slice(3, -4)}</h3>`;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) out.push('<hr>');
    else if (/^#{1,6} /.test(line)) out.push(`<h3>${inline(line.replace(/^#+ /, ''))}</h3>`);
    else if (/^\s*[-*+] /.test(line)) out.push(`<p class="item${/^\s{2,}/.test(line) ? ' sub' : ''}">${inline(line.replace(/^\s*[-*+] /, ''))}</p>`);
    else out.push(`<p>${inline(line)}</p>`);
  }
  return out.join('\n');
}

/** Only public ticket text is rendered. Markdown HTML is displayed as text. */
export function renderTicket(markdown: string, brief: { id: string; title: string; specFile: string }): string {
  const inventory = brief.id.toLowerCase() === 'inv-907';
  const content = blocks(markdown.split(/\r?\n/));
  const intro = inventory ? `<h1>Can the inventory launch go ahead?</h1>
    <p class="lead">Stores are seeing stale or incorrect stock. The largest customer’s dashboard is slow. The launch team needs a decision before stores open.</p>
    <section class="assignment"><h2>Your task</h2><p>Investigate with your teammates and coding assistant. Write the smallest safe mitigation, repair and verification plan in <strong>${escape(brief.specFile)}</strong>.</p></section>
    <details><summary>Incident notes &amp; original ticket</summary><div class="notes">${content}</div></details>
    <details><summary>Before you submit</summary><ul><li>Preserve incoming inventory updates.</li><li>Define the customer-facing scope and communication.</li><li>Separate evidence, agreed decisions and unresolved checks.</li><li>Explain what would justify resuming the launch.</li></ul></details>
    <p class="footnote">This is an investigation and handoff. You won’t execute production changes here. Your handoff and teammate conversations receive human review.</p>`
    : `<h1>${escape(brief.title)}</h1><div class="notes">${content}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(brief.id)} · Ticket</title><style>
    :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background,#faf9f6);color:var(--vscode-editor-foreground,#242333);font:16px/1.65 var(--vscode-font-family,'Segoe UI',sans-serif)}main{max-width:740px;margin:0 auto;padding:clamp(28px,6vw,64px) clamp(22px,5vw,48px)}.eyebrow{font-size:12px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--vscode-descriptionForeground,#686572);margin:0 0 14px}h1{font-size:clamp(26px,3vw,36px);line-height:1.2;letter-spacing:-.025em;font-weight:650;margin:0 0 22px}h2{font-size:17px;margin:0 0 8px}h3{font-size:16px;line-height:1.5;margin:20px 0 10px}.lead{font-size:18px;line-height:1.65;margin:0 0 30px}.assignment{padding:22px 0 28px;border-top:1px solid var(--vscode-panel-border,#dfdcd5)}p{margin:0 0 14px}.assignment p{margin:0}strong{font-weight:650}details{border-top:1px solid var(--vscode-panel-border,#dfdcd5)}summary{padding:16px 0;cursor:pointer;font-size:15px;font-weight:600}summary:focus-visible{outline:2px solid var(--vscode-focusBorder,#d87505);outline-offset:4px}.notes,ul{font-size:15px;line-height:1.7;margin:0 0 24px;overflow-wrap:anywhere}.item{padding-left:18px;position:relative}.item:before{content:'•';position:absolute;left:0}.item.sub{margin-left:18px}li{margin:0 0 9px}code{font-family:var(--vscode-editor-font-family,monospace);font-size:.9em;padding:1px 5px;border-radius:3px;background:var(--vscode-textCodeBlock-background,rgba(127,127,127,.15))}table{border-collapse:collapse;width:100%;margin:0 0 16px}th,td{border:1px solid var(--vscode-panel-border,#dfdcd5);padding:6px 10px;text-align:left;vertical-align:top}hr{border:0;border-top:1px solid var(--vscode-panel-border,#dfdcd5);margin:20px 0}.footnote{font-size:13px;line-height:1.6;margin:28px 0 0;color:var(--vscode-descriptionForeground,#686572)}@media(prefers-color-scheme:dark){body{background:var(--vscode-editor-background,#1d1c22);color:var(--vscode-editor-foreground,#eeeae2)}.eyebrow,.footnote{color:var(--vscode-descriptionForeground,#bbb5c1)}}
    </style></head><body><main><p class="eyebrow">${escape(brief.id)} · Ticket</p>${intro}</main></body></html>`;
}

let panel: vscode.WebviewPanel | undefined;

/**
 * Show the ticket in a webview panel. Nothing is written to disk: a TASK.html
 * in the candidate's repo was staged by the CLI's snapshot and submitted as if
 * they wrote it. One panel, re-rendered from the current TASK.md on each open.
 * No scripts, no local resources, and a `default-src 'none'` policy.
 */
export function showTicket(markdown: string, brief: { id: string; title: string; specFile: string }): void {
  if (!panel) {
    panel = vscode.window.createWebviewPanel('promptster.ticket', 'Ticket', vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [] });
    panel.onDidDispose(() => { panel = undefined; });
  }
  panel.title = brief.id ? `${brief.id} · Ticket` : 'Ticket';
  panel.webview.html = renderTicket(markdown, brief);
  panel.reveal();
}
