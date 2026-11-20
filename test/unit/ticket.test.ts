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
});
