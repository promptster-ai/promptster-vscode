import { describe, it, expect, vi } from 'vitest';
vi.mock('vscode', () => import('../fakes/vscode'));
import { renderTicket } from '../../src/ui/ticket';
describe('readable ticket', () => {
  it('retains all public source text in collapsed details and escapes markup', () => {
    const html = renderTicket('# Ticket\n- 08:55: eight times normal size\n<script>run()</script>', { id:'INV-907', title:'Incident', specFile:'INV-907.spec' });
    expect(html).toContain('<details><summary>Incident notes &amp; original ticket');
    expect(html).not.toContain('<details open');
    expect(html).toContain('08:55: eight times normal size');
    expect(html).toContain('&lt;script&gt;run()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('carries a policy that blocks scripts and external resources', () => {
    const html = renderTicket('# Ticket', { id:'INV-907', title:'Incident', specFile:'INV-907.spec' });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("form-action 'none'");
  });
  it('renders the markdown a hosted TASK.md uses, escaped, instead of raw markers', () => {
    const md = [
      '# NLX-212: Shrink It Safely', '', '- **Problem:** `custom-org_3C9L-c9b408bf`', '- **Language:** python', '', '---', '',
      'Status: In progress', 'Priority: High', 'You have **30 minutes**. Read **`pr/PR_DESCRIPTION.md`**, not `a **b**`.',
      '', '| Min | Phase |', '|---|---|', '| 0-4 | Kickoff. Write `PLAN.md` |', '| ~12 | Mara\'s **update** <b>arrives</b> |', '',
      'Unclosed **bold and `tick, x*y*z.',
    ].join('\n');
    const html = renderTicket(md, { id:'NLX-212', title:'Shrink', specFile:'NLX-212.spec' });
    expect(html).toContain('<p class="item"><strong>Problem:</strong> <code>custom-org_3C9L-c9b408bf</code></p>');
    expect(html).toContain('<hr>');
    // One source line, one block: line breaks survive.
    expect(html).toContain('<p>Status: In progress</p>\n<p>Priority: High</p>');
    expect(html).toContain('<strong>30 minutes</strong>. Read <strong><code>pr/PR_DESCRIPTION.md</code></strong>, not <code>a **b**</code>.');
    expect(html).toContain('<table><thead><tr><th>Min</th><th>Phase</th></tr></thead><tbody><tr><td>0-4</td><td>Kickoff. Write <code>PLAN.md</code></td></tr><tr><td>~12</td><td>Mara&#39;s <strong>update</strong> &lt;b&gt;arrives&lt;/b&gt;</td></tr></tbody></table>');
    expect(html).toContain('<p>Unclosed **bold and `tick, x*y*z.</p>');
    expect(html).not.toContain('|---|');
  });
  it('keeps table cells, spans and markers the way GFM reads them', () => {
    const render = (md: string) => renderTicket(md, { id:'X-1', title:'T', specFile:'X-1.spec' });
    expect(render('| Cmd | Note |\n|---|---|\n| `a || b` | x \\| y |')).toContain('<td><code>a || b</code></td><td>x | y</td>');
    expect(render('Cmd | Note\n-|-\na | b')).toContain('<thead><tr><th>Cmd</th><th>Note</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody>');
    expect(render("| it`s | x |\n|---|---|\n| 1 | 2 |")).toContain('<th>it`s</th><th>x</th>');
    // A pipe line over a plain rule is not a table.
    expect(render('| just a pipe line\n\n---')).toContain('<p>| just a pipe line</p>\n<hr>');
    expect(render('**foo **bar**')).toContain('**foo <strong>bar</strong>');
    expect(render('``a`b`` and `` `x` ``')).toContain('<code>a`b</code> and <code>`x`</code>');
    expect(render('Title\n---\n\nbody')).toContain('<h3>Title</h3>\n<p>body</p>');
    expect(render('- top\n  - nested\n+ plus')).toContain('<p class="item">top</p>\n<p class="item sub">nested</p>\n<p class="item">plus</p>');
  });
  it('ends a table at a heading or bullet, and unescapes \| inside table code', () => {
    const render = (md: string) => renderTicket(md, { id:'X-1', title:'T', specFile:'X-1.spec' });
    const html = render('A | B\n-|-\n1 | `a\\|b`\n# Next | read | this\n- item | more');
    expect(html).toContain('<tbody><tr><td>1</td><td><code>a|b</code></td></tr></tbody></table>\n<h3>Next | read | this</h3>\n<p class="item">item | more</p>');
  });
});
