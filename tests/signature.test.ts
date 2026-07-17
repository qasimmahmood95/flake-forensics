import { describe, expect, it } from 'vitest';
import { normalizeErrorMessage, topApplicationFrame, computeSignature } from '../src/signature.js';

describe('normalizeErrorMessage', () => {
  it('replaces durations, ports and numbers with placeholders', () => {
    const a = normalizeErrorMessage('TimeoutError: locator.click: Timeout 15000ms exceeded.');
    const b = normalizeErrorMessage('TimeoutError: locator.click: Timeout 30000ms exceeded.');
    expect(a).toBe(b);
    expect(a).toContain('<DURATION>');
  });

  it('unifies addresses with different ports', () => {
    const a = normalizeErrorMessage('Error: connect ECONNREFUSED 127.0.0.1:34567');
    const b = normalizeErrorMessage('Error: connect ECONNREFUSED 127.0.0.1:49152');
    expect(a).toBe(b);
    expect(a).toBe('Error: connect ECONNREFUSED <ADDR>');
  });

  it('replaces uuids and long hex ids', () => {
    const msg = normalizeErrorMessage(
      'Error: order 8b171a04-9d5e-4a6f-9d1c-0e1f2a3b4c5d not found (trace deadbeefcafe1234)',
    );
    expect(msg).toContain('<UUID>');
    expect(msg).toContain('<HEX>');
  });

  it('collapses URLs before address/number rules can shred them', () => {
    const a = normalizeErrorMessage('Error: GET http://localhost:3000/api/v2/items?page=4 failed');
    const b = normalizeErrorMessage('Error: GET http://localhost:3999/api/v2/items?page=9 failed');
    expect(a).toBe(b);
    expect(a).toContain('<URL>');
  });

  it('replaces Expected/Received values with <VAL> but keeps the assertion shape', () => {
    const a = normalizeErrorMessage(
      'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 401\nReceived: 200',
    );
    const b = normalizeErrorMessage(
      'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 503\nReceived: 418',
    );
    expect(a).toBe(b);
    expect(a).toContain('Expected: <VAL>');
    expect(a).toContain('Received: <VAL>');
  });

  it('drops everything from "Call log:" onward', () => {
    const msg = normalizeErrorMessage(
      'TimeoutError: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator("#a")\n  - attempt #7',
    );
    expect(msg).not.toContain('waiting for');
    expect(msg).not.toContain('attempt');
  });

  it('keeps quoted selectors but normalises numbers inside them', () => {
    const a = normalizeErrorMessage("Error: element locator('#row-42') not visible");
    const b = normalizeErrorMessage("Error: element locator('#row-97') not visible");
    expect(a).toBe(b);
    expect(a).toContain("locator('#row-<N>')");
  });

  it('strips ANSI colour codes', () => {
    const esc = String.fromCharCode(0x1b);
    const msg = normalizeErrorMessage(`${esc}[31mError:${esc}[0m boom`);
    expect(msg).toBe('Error: boom');
  });

  it('replaces multi-segment paths', () => {
    const msg = normalizeErrorMessage('Error: ENOENT /home/runner/work/app/uploads/file.png missing');
    expect(msg).toContain('<PATH>');
    expect(msg).not.toContain('/home/runner');
  });

  it('handles an empty message', () => {
    expect(normalizeErrorMessage('')).toBe('<empty-message>');
  });
});

describe('topApplicationFrame', () => {
  const stack = [
    'TimeoutError: locator.click: Timeout 15000ms exceeded.',
    '    at Timeout._onTimeout (/repo/node_modules/playwright-core/lib/utils/timers.js:52:9)',
    '    at node:internal/timers:589:17',
    '    at applyDiscount (/home/runner/work/webshop/webshop/tests/e2e/cart.spec.ts:42:18)',
    '    at /home/runner/work/webshop/webshop/tests/e2e/cart.spec.ts:12:3',
  ].join('\n');

  it('skips node_modules, node internals and playwright frames', () => {
    expect(topApplicationFrame(stack)).toBe('tests/e2e/cart.spec.ts#applyDiscount');
  });

  it('drops line and column numbers (they shift across commits)', () => {
    const moved = stack.replace('cart.spec.ts:42:18', 'cart.spec.ts:99:1');
    expect(topApplicationFrame(moved)).toBe(topApplicationFrame(stack));
  });

  it('handles Windows-style paths', () => {
    const winStack =
      'Error: boom\n    at helper (C:\\ci\\work\\repo\\tests\\utils\\db.ts:10:5)';
    expect(topApplicationFrame(winStack)).toBe('tests/utils/db.ts#helper');
  });

  it('returns <no-stack> when nothing usable exists', () => {
    expect(topApplicationFrame(undefined)).toBe('<no-stack>');
    expect(topApplicationFrame('Error: no frames here')).toBe('<no-stack>');
    expect(
      topApplicationFrame('Error: x\n    at f (/repo/node_modules/lib/index.js:1:1)'),
    ).toBe('<no-stack>');
  });

  it('falls back to anonymous frames', () => {
    const anon = 'Error: x\n    at /home/ci/tests/e2e/a.spec.ts:5:1';
    expect(topApplicationFrame(anon)).toBe('tests/e2e/a.spec.ts#<anonymous>');
  });
});

describe('computeSignature', () => {
  it('gives the same id to failures differing only in volatile tokens', () => {
    const a = computeSignature({
      message: 'Error: apiRequest failed: connect ECONNREFUSED 127.0.0.1:34567',
      stack: 'Error: x\n    at apiRequest (/repo/tests/helpers/api.ts:17:3)',
    });
    const b = computeSignature({
      message: 'Error: apiRequest failed: connect ECONNREFUSED 127.0.0.1:49999',
      stack: 'Error: x\n    at apiRequest (/repo/tests/helpers/api.ts:17:12)',
    });
    expect(a.id).toBe(b.id);
  });

  it('separates identical messages thrown from different frames', () => {
    const a = computeSignature({
      message: 'Error: kaboom',
      stack: 'Error: kaboom\n    at f (/repo/tests/a.spec.ts:1:1)',
    });
    const b = computeSignature({
      message: 'Error: kaboom',
      stack: 'Error: kaboom\n    at f (/repo/tests/b.spec.ts:1:1)',
    });
    expect(a.id).not.toBe(b.id);
  });
});
